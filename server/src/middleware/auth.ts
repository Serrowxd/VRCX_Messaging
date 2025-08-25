import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { query } from '../database/connection';
import { createHash, randomBytes } from 'crypto';
import argon2 from 'argon2';

interface JWTPayload {
    userId: string;
    deviceId: number;
    sessionId: string;
    type: 'access' | 'refresh';
    iat?: number;
    exp?: number;
}

interface AuthenticatedRequest extends FastifyRequest {
    user?: {
        userId: string;
        deviceId: number;
        sessionId: string;
    };
}

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || JWT_SECRET + '-refresh';
const ACCESS_TOKEN_EXPIRY = process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m';
const REFRESH_TOKEN_EXPIRY = process.env.JWT_REFRESH_TOKEN_EXPIRY || '7d';

/**
 * Generate JWT tokens (access and refresh)
 */
export async function generateTokens(userId: string, deviceId: number): Promise<{
    accessToken: string;
    refreshToken: string;
    sessionId: string;
    expiresIn: number;
}> {
    const sessionId = randomBytes(16).toString('hex');
    
    // Create access token with RS256 algorithm
    const accessToken = jwt.sign(
        {
            userId,
            deviceId,
            sessionId,
            type: 'access'
        } as JWTPayload,
        JWT_SECRET,
        {
            algorithm: 'HS256', // Using HS256 for simplicity, switch to RS256 with keypair in production
            expiresIn: ACCESS_TOKEN_EXPIRY
        }
    );
    
    // Create refresh token
    const refreshToken = jwt.sign(
        {
            userId,
            deviceId,
            sessionId,
            type: 'refresh'
        } as JWTPayload,
        JWT_REFRESH_SECRET,
        {
            algorithm: 'HS256',
            expiresIn: REFRESH_TOKEN_EXPIRY
        }
    );
    
    // Store refresh token in database
    const hashedRefreshToken = createHash('sha256').update(refreshToken).digest('hex');
    await query(
        `INSERT INTO sessions (id, user_id, device_id, refresh_token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '7 days', NOW())
         ON CONFLICT (id) DO UPDATE SET 
            refresh_token_hash = $4,
            expires_at = NOW() + INTERVAL '7 days',
            last_activity = NOW()`,
        [sessionId, userId, deviceId, hashedRefreshToken]
    );
    
    return {
        accessToken,
        refreshToken,
        sessionId,
        expiresIn: 900 // 15 minutes in seconds
    };
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token: string, type: 'access' | 'refresh' = 'access'): JWTPayload {
    const secret = type === 'access' ? JWT_SECRET : JWT_REFRESH_SECRET;
    
    try {
        const decoded = jwt.verify(token, secret, {
            algorithms: ['HS256']
        }) as JWTPayload;
        
        if (decoded.type !== type) {
            throw new Error(`Invalid token type: expected ${type}, got ${decoded.type}`);
        }
        
        return decoded;
    } catch (error) {
        if (error instanceof jwt.TokenExpiredError) {
            throw new Error('Token has expired');
        } else if (error instanceof jwt.JsonWebTokenError) {
            throw new Error('Invalid token');
        }
        throw error;
    }
}

/**
 * Refresh access token using refresh token
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
    accessToken: string;
    expiresIn: number;
}> {
    // Verify refresh token
    const payload = verifyToken(refreshToken, 'refresh');
    
    // Check if refresh token exists in database and is valid
    const hashedRefreshToken = createHash('sha256').update(refreshToken).digest('hex');
    const result = await query(
        `SELECT * FROM sessions 
         WHERE id = $1 
         AND user_id = $2 
         AND refresh_token_hash = $3 
         AND expires_at > NOW()
         AND (revoked_at IS NULL OR revoked_at > NOW())`,
        [payload.sessionId, payload.userId, hashedRefreshToken]
    );
    
    if (result.rows.length === 0) {
        throw new Error('Invalid or expired refresh token');
    }
    
    // Update session last activity
    await query(
        `UPDATE sessions SET last_activity = NOW() WHERE id = $1`,
        [payload.sessionId]
    );
    
    // Generate new access token
    const accessToken = jwt.sign(
        {
            userId: payload.userId,
            deviceId: payload.deviceId,
            sessionId: payload.sessionId,
            type: 'access'
        } as JWTPayload,
        JWT_SECRET,
        {
            algorithm: 'HS256',
            expiresIn: ACCESS_TOKEN_EXPIRY
        }
    );
    
    return {
        accessToken,
        expiresIn: 900 // 15 minutes in seconds
    };
}

/**
 * Authentication middleware for protected routes
 */
export async function authenticate(
    request: AuthenticatedRequest,
    reply: FastifyReply
): Promise<void> {
    try {
        // Extract token from Authorization header
        const authHeader = request.headers.authorization;
        if (!authHeader) {
            return reply.status(401).send({
                error: 'Authentication required',
                code: 'AUTH_REQUIRED'
            });
        }
        
        const [bearer, token] = authHeader.split(' ');
        if (bearer !== 'Bearer' || !token) {
            return reply.status(401).send({
                error: 'Invalid authorization header format',
                code: 'INVALID_AUTH_HEADER'
            });
        }
        
        // Verify token
        const payload = verifyToken(token, 'access');
        
        // Check if session is still valid in database
        const result = await query(
            `SELECT * FROM sessions 
             WHERE id = $1 
             AND user_id = $2 
             AND expires_at > NOW()
             AND (revoked_at IS NULL OR revoked_at > NOW())`,
            [payload.sessionId, payload.userId]
        );
        
        if (result.rows.length === 0) {
            return reply.status(401).send({
                error: 'Session expired or revoked',
                code: 'SESSION_INVALID'
            });
        }
        
        // Update session activity
        await query(
            `UPDATE sessions SET last_activity = NOW() WHERE id = $1`,
            [payload.sessionId]
        );
        
        // Attach user info to request
        request.user = {
            userId: payload.userId,
            deviceId: payload.deviceId,
            sessionId: payload.sessionId
        };
        
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Authentication failed';
        
        if (message === 'Token has expired') {
            return reply.status(401).send({
                error: 'Access token expired',
                code: 'TOKEN_EXPIRED'
            });
        }
        
        return reply.status(401).send({
            error: message,
            code: 'AUTH_FAILED'
        });
    }
}

/**
 * Optional authentication middleware (doesn't fail if no token)
 */
export async function optionalAuthenticate(
    request: AuthenticatedRequest,
    reply: FastifyReply
): Promise<void> {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
        return; // No authentication provided, continue without user context
    }
    
    try {
        await authenticate(request, reply);
    } catch {
        // Authentication failed but it's optional, continue without user context
        return;
    }
}

/**
 * Revoke a session (logout)
 */
export async function revokeSession(sessionId: string, userId: string): Promise<void> {
    await query(
        `UPDATE sessions 
         SET revoked_at = NOW() 
         WHERE id = $1 AND user_id = $2`,
        [sessionId, userId]
    );
}

/**
 * Revoke all sessions for a user (logout from all devices)
 */
export async function revokeAllSessions(userId: string): Promise<void> {
    await query(
        `UPDATE sessions 
         SET revoked_at = NOW() 
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId]
    );
}

/**
 * Clean up expired sessions
 */
export async function cleanupExpiredSessions(): Promise<number> {
    const result = await query(
        `DELETE FROM sessions 
         WHERE expires_at < NOW() 
         OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '1 day')
         RETURNING id`
    );
    
    return result.rowCount || 0;
}

/**
 * Validate VRCX authentication token
 */
export async function validateVRCXAuth(vrcxToken: string): Promise<{
    userId: string;
    username: string;
} | null> {
    // This would integrate with VRCX's existing auth system
    // For now, we'll create a placeholder that validates against our users table
    
    try {
        // In production, this would verify the VRCX token with their auth system
        // For MVP, we'll check if the token matches a user in our database
        const result = await query(
            `SELECT user_id, username FROM users 
             WHERE auth_token = $1 AND active = true`,
            [vrcxToken]
        );
        
        if (result.rows.length === 0) {
            return null;
        }
        
        return {
            userId: result.rows[0].user_id,
            username: result.rows[0].username
        };
    } catch {
        return null;
    }
}

/**
 * Hash password using Argon2
 */
export async function hashPassword(password: string): Promise<string> {
    return argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4
    });
}

/**
 * Verify password against hash
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
}

export default {
    generateTokens,
    verifyToken,
    refreshAccessToken,
    authenticate,
    optionalAuthenticate,
    revokeSession,
    revokeAllSessions,
    cleanupExpiredSessions,
    validateVRCXAuth,
    hashPassword,
    verifyPassword
};