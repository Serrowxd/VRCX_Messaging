import { FastifyRequest, FastifyReply } from 'fastify';
import { getRedis } from '../database/connection';
import { createHash } from 'crypto';

interface RateLimitOptions {
    max: number;              // Maximum number of requests
    window: number;           // Time window in milliseconds
    keyGenerator?: (req: FastifyRequest) => string;  // Custom key generator
    skipSuccessfulRequests?: boolean;  // Don't count successful requests
    skipFailedRequests?: boolean;      // Don't count failed requests
    message?: string;         // Custom error message
}

interface RateLimitInfo {
    limit: number;
    remaining: number;
    reset: Date;
}

/**
 * Rate limiting middleware using Redis
 * Implements sliding window counter algorithm for accurate rate limiting
 */
export class RateLimiter {
    private redis = getRedis();
    private defaultOptions: RateLimitOptions = {
        max: 100,
        window: 60000, // 1 minute
        message: 'Too many requests, please try again later'
    };

    /**
     * Create rate limiter with custom options
     */
    constructor(options?: Partial<RateLimitOptions>) {
        this.defaultOptions = { ...this.defaultOptions, ...options };
    }

    /**
     * Rate limiting middleware factory
     */
    public middleware(options?: Partial<RateLimitOptions>) {
        const opts = { ...this.defaultOptions, ...options };
        
        return async (request: FastifyRequest, reply: FastifyReply) => {
            // Generate rate limit key
            const key = this.generateKey(request, opts.keyGenerator);
            
            // Check and update rate limit
            const limitInfo = await this.checkRateLimit(key, opts);
            
            // Set rate limit headers
            reply.header('X-RateLimit-Limit', limitInfo.limit.toString());
            reply.header('X-RateLimit-Remaining', limitInfo.remaining.toString());
            reply.header('X-RateLimit-Reset', limitInfo.reset.toISOString());
            reply.header('Retry-After', Math.ceil((limitInfo.reset.getTime() - Date.now()) / 1000).toString());
            
            // Check if limit exceeded
            if (limitInfo.remaining < 0) {
                return reply.status(429).send({
                    error: opts.message,
                    code: 'RATE_LIMIT_EXCEEDED',
                    retryAfter: limitInfo.reset.toISOString()
                });
            }
        };
    }

    /**
     * Generate rate limit key based on request
     */
    private generateKey(request: FastifyRequest, customGenerator?: (req: FastifyRequest) => string): string {
        if (customGenerator) {
            return `ratelimit:${customGenerator(request)}`;
        }

        // Default: Use IP address and path
        const ip = request.ip || request.socket.remoteAddress || 'unknown';
        const path = request.routerPath || request.url;
        const hash = createHash('md5').update(`${ip}:${path}`).digest('hex');
        
        return `ratelimit:${hash}`;
    }

    /**
     * Check and update rate limit using sliding window
     */
    private async checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitInfo> {
        const now = Date.now();
        const window = options.window;
        const max = options.max;
        const windowStart = now - window;

        // Use Redis pipeline for atomic operations
        const pipeline = this.redis.pipeline();
        
        // Remove old entries outside the window
        pipeline.zRemRangeByScore(key, '-inf', windowStart.toString());
        
        // Add current request
        pipeline.zAdd(key, { score: now, member: `${now}:${Math.random()}` });
        
        // Count requests in current window
        pipeline.zCard(key);
        
        // Set expiry for cleanup
        pipeline.expire(key, Math.ceil(window / 1000));
        
        // Execute pipeline
        const results = await pipeline.exec();
        
        // Get count from results (3rd command - zCard)
        const count = results?.[2]?.[1] as number || 0;
        
        const remaining = max - count;
        const reset = new Date(now + window);
        
        return {
            limit: max,
            remaining,
            reset
        };
    }

    /**
     * Rate limiter for specific user actions
     */
    public async userActionLimit(
        userId: string,
        action: string,
        max: number = 10,
        window: number = 60000
    ): Promise<boolean> {
        const key = `ratelimit:user:${userId}:${action}`;
        const limitInfo = await this.checkRateLimit(key, { max, window });
        return limitInfo.remaining >= 0;
    }

    /**
     * Global rate limiter (for DDoS protection)
     */
    public async globalLimit(
        identifier: string,
        max: number = 1000,
        window: number = 60000
    ): Promise<boolean> {
        const key = `ratelimit:global:${identifier}`;
        const limitInfo = await this.checkRateLimit(key, { max, window });
        return limitInfo.remaining >= 0;
    }

    /**
     * Reset rate limit for a specific key
     */
    public async reset(key: string): Promise<void> {
        await this.redis.del(`ratelimit:${key}`);
    }

    /**
     * Get current rate limit status without incrementing
     */
    public async getStatus(key: string, options: RateLimitOptions): Promise<RateLimitInfo> {
        const now = Date.now();
        const window = options.window;
        const max = options.max;
        const windowStart = now - window;
        
        // Count requests in current window
        const count = await this.redis.zCount(
            `ratelimit:${key}`,
            windowStart.toString(),
            '+inf'
        );
        
        return {
            limit: max,
            remaining: max - count,
            reset: new Date(now + window)
        };
    }
}

/**
 * Pre-configured rate limiters for different endpoints
 */
export const rateLimiters = {
    // Standard API endpoints - 100 requests per minute
    standard: new RateLimiter({
        max: 100,
        window: 60000
    }),
    
    // Authentication endpoints - 5 attempts per 15 minutes
    auth: new RateLimiter({
        max: 5,
        window: 900000,
        message: 'Too many authentication attempts'
    }),
    
    // Message sending - 30 messages per minute
    messaging: new RateLimiter({
        max: 30,
        window: 60000,
        message: 'Message rate limit exceeded'
    }),
    
    // Key exchange - 10 requests per hour
    keyExchange: new RateLimiter({
        max: 10,
        window: 3600000,
        message: 'Key exchange rate limit exceeded'
    }),
    
    // Search operations - 20 per minute
    search: new RateLimiter({
        max: 20,
        window: 60000,
        message: 'Search rate limit exceeded'
    }),
    
    // File operations - 10 per minute
    files: new RateLimiter({
        max: 10,
        window: 60000,
        message: 'File operation rate limit exceeded'
    })
};

/**
 * IP-based rate limiter for DDoS protection
 */
export function ipRateLimiter(max: number = 1000, window: number = 60000) {
    const limiter = new RateLimiter({ max, window });
    
    return limiter.middleware({
        keyGenerator: (req) => {
            const ip = req.ip || req.socket.remoteAddress || 'unknown';
            return `ip:${ip}`;
        }
    });
}

/**
 * User-based rate limiter (requires authentication)
 */
export function userRateLimiter(max: number = 100, window: number = 60000) {
    const limiter = new RateLimiter({ max, window });
    
    return limiter.middleware({
        keyGenerator: (req) => {
            const user = (req as any).user;
            if (!user?.userId) {
                // Fallback to IP if not authenticated
                const ip = req.ip || req.socket.remoteAddress || 'unknown';
                return `ip:${ip}`;
            }
            return `user:${user.userId}`;
        }
    });
}

/**
 * Combined rate limiter (checks both IP and user limits)
 */
export function combinedRateLimiter(
    ipMax: number = 1000,
    userMax: number = 100,
    window: number = 60000
) {
    const ipLimiter = new RateLimiter({ max: ipMax, window });
    const userLimiter = new RateLimiter({ max: userMax, window });
    
    return async (request: FastifyRequest, reply: FastifyReply) => {
        // Check IP limit
        const ipKey = `ip:${request.ip || request.socket.remoteAddress || 'unknown'}`;
        const ipLimit = await ipLimiter.checkRateLimit(ipKey, { max: ipMax, window });
        
        if (ipLimit.remaining < 0) {
            return reply.status(429).send({
                error: 'IP rate limit exceeded',
                code: 'IP_RATE_LIMIT_EXCEEDED',
                retryAfter: ipLimit.reset.toISOString()
            });
        }
        
        // Check user limit if authenticated
        const user = (request as any).user;
        if (user?.userId) {
            const userKey = `user:${user.userId}`;
            const userLimit = await userLimiter.checkRateLimit(userKey, { max: userMax, window });
            
            if (userLimit.remaining < 0) {
                return reply.status(429).send({
                    error: 'User rate limit exceeded',
                    code: 'USER_RATE_LIMIT_EXCEEDED',
                    retryAfter: userLimit.reset.toISOString()
                });
            }
            
            // Set most restrictive headers
            reply.header('X-RateLimit-Limit', Math.min(ipLimit.limit, userLimit.limit).toString());
            reply.header('X-RateLimit-Remaining', Math.min(ipLimit.remaining, userLimit.remaining).toString());
            reply.header('X-RateLimit-Reset', 
                new Date(Math.max(ipLimit.reset.getTime(), userLimit.reset.getTime())).toISOString()
            );
        } else {
            // Only IP headers
            reply.header('X-RateLimit-Limit', ipLimit.limit.toString());
            reply.header('X-RateLimit-Remaining', ipLimit.remaining.toString());
            reply.header('X-RateLimit-Reset', ipLimit.reset.toISOString());
        }
    };
}

export default {
    RateLimiter,
    rateLimiters,
    ipRateLimiter,
    userRateLimiter,
    combinedRateLimiter
};