import winston from 'winston';
import { FastifyRequest, FastifyReply } from 'fastify';
import path from 'path';
import fs from 'fs';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Custom log levels
const customLevels = {
    levels: {
        error: 0,
        warn: 1,
        info: 2,
        http: 3,
        debug: 4,
        trace: 5
    },
    colors: {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        http: 'magenta',
        debug: 'blue',
        trace: 'grey'
    }
};

// Add colors to winston
winston.addColors(customLevels.colors);

// Custom format for structured logging
const structuredFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json(),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        const log = {
            timestamp,
            level,
            message,
            ...metadata
        };
        
        // Remove empty metadata
        Object.keys(log).forEach(key => {
            if (log[key] === undefined || log[key] === null || log[key] === '') {
                delete log[key];
            }
        });
        
        return JSON.stringify(log);
    })
);

// Console format for development
const consoleFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, ...metadata }) => {
        let log = `${timestamp} [${level}]: ${message}`;
        
        // Add metadata if present
        if (Object.keys(metadata).length > 0 && metadata.constructor === Object) {
            // Filter out internal winston properties
            const cleanMetadata = Object.entries(metadata)
                .filter(([key]) => !key.startsWith('Symbol'))
                .reduce((acc, [key, value]) => ({ ...acc, [key]: value }), {});
            
            if (Object.keys(cleanMetadata).length > 0) {
                log += ` ${JSON.stringify(cleanMetadata, null, 2)}`;
            }
        }
        
        return log;
    })
);

// Create logger instance
const logger = winston.createLogger({
    levels: customLevels.levels,
    level: process.env.LOG_LEVEL || 'info',
    format: structuredFormat,
    defaultMeta: {
        service: 'vrcx-messaging',
        environment: process.env.NODE_ENV || 'development'
    },
    transports: [
        // Error logs
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            maxsize: 10485760, // 10MB
            maxFiles: 5,
            tailable: true
        }),
        // Combined logs
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            maxsize: 10485760, // 10MB
            maxFiles: 10,
            tailable: true
        })
    ],
    // Handle uncaught exceptions
    exceptionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'exceptions.log'),
            maxsize: 10485760,
            maxFiles: 5
        })
    ],
    // Handle unhandled promise rejections
    rejectionHandlers: [
        new winston.transports.File({
            filename: path.join(logsDir, 'rejections.log'),
            maxsize: 10485760,
            maxFiles: 5
        })
    ]
});

// Add console transport for development
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: consoleFormat,
        handleExceptions: true,
        handleRejections: true
    }));
}

/**
 * HTTP request logger middleware
 */
export function httpLogger(request: FastifyRequest, reply: FastifyReply, next: () => void) {
    const start = Date.now();
    
    // Log request
    logger.http('Incoming request', {
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        requestId: request.id
    });
    
    // Log response
    reply.addHook('onResponse', (req, res, done) => {
        const duration = Date.now() - start;
        
        logger.http('Request completed', {
            method: req.method,
            url: req.url,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
            requestId: req.id
        });
        
        // Log slow requests
        if (duration > 1000) {
            logger.warn('Slow request detected', {
                method: req.method,
                url: req.url,
                duration: `${duration}ms`,
                requestId: req.id
            });
        }
        
        done();
    });
    
    next();
}

/**
 * Security event logger
 */
export function logSecurityEvent(event: string, details: any) {
    logger.warn(`Security Event: ${event}`, {
        type: 'security',
        event,
        ...details,
        timestamp: new Date().toISOString()
    });
}

/**
 * Audit logger for important actions
 */
export function logAudit(action: string, userId: string, details: any) {
    logger.info(`Audit: ${action}`, {
        type: 'audit',
        action,
        userId,
        ...details,
        timestamp: new Date().toISOString()
    });
}

/**
 * Performance logger
 */
export function logPerformance(operation: string, duration: number, metadata?: any) {
    const level = duration > 1000 ? 'warn' : 'debug';
    
    logger[level](`Performance: ${operation}`, {
        type: 'performance',
        operation,
        duration: `${duration}ms`,
        ...metadata
    });
}

/**
 * Error logger with context
 */
export function logError(error: Error, context?: any) {
    logger.error(error.message, {
        type: 'error',
        stack: error.stack,
        name: error.name,
        ...context
    });
}

/**
 * Message logger for debugging message flow
 */
export function logMessage(action: string, messageId: string, metadata?: any) {
    logger.debug(`Message ${action}`, {
        type: 'message',
        action,
        messageId,
        ...metadata
    });
}

/**
 * WebSocket event logger
 */
export function logWebSocket(event: string, socketId: string, metadata?: any) {
    logger.debug(`WebSocket: ${event}`, {
        type: 'websocket',
        event,
        socketId,
        ...metadata
    });
}

/**
 * Database query logger
 */
export function logQuery(query: string, duration: number, rowCount?: number) {
    const level = duration > 1000 ? 'warn' : 'trace';
    
    logger[level]('Database query', {
        type: 'database',
        query: query.substring(0, 200), // Truncate long queries
        duration: `${duration}ms`,
        rowCount
    });
}

/**
 * Cache operation logger
 */
export function logCache(operation: string, key: string, hit: boolean) {
    logger.trace(`Cache ${operation}`, {
        type: 'cache',
        operation,
        key,
        hit
    });
}

/**
 * Create child logger with additional context
 */
export function createChildLogger(metadata: any) {
    return logger.child(metadata);
}

/**
 * Stream for piping other logs
 */
export const logStream = {
    write: (message: string) => {
        logger.info(message.trim());
    }
};

/**
 * Log rotation check
 */
export function checkLogRotation() {
    const maxSize = 52428800; // 50MB total for all logs
    let totalSize = 0;
    
    try {
        const files = fs.readdirSync(logsDir);
        
        for (const file of files) {
            if (file.endsWith('.log')) {
                const stats = fs.statSync(path.join(logsDir, file));
                totalSize += stats.size;
            }
        }
        
        if (totalSize > maxSize) {
            logger.warn('Log files exceeding maximum size', {
                totalSize: `${(totalSize / 1048576).toFixed(2)}MB`,
                maxSize: `${(maxSize / 1048576).toFixed(2)}MB`
            });
        }
    } catch (error) {
        logger.error('Failed to check log rotation', { error });
    }
}

// Schedule log rotation check every hour
if (process.env.NODE_ENV === 'production') {
    setInterval(checkLogRotation, 3600000);
}

export default logger;