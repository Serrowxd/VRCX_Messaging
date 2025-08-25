import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import logger, { logError, logSecurityEvent } from '../utils/logger';
import { query } from '../database/connection';

/**
 * Custom error classes for better error handling
 */
export class AppError extends Error {
    public readonly statusCode: number;
    public readonly code: string;
    public readonly isOperational: boolean;
    public readonly details?: any;

    constructor(
        message: string,
        statusCode: number = 500,
        code: string = 'INTERNAL_ERROR',
        isOperational: boolean = true,
        details?: any
    ) {
        super(message);
        this.statusCode = statusCode;
        this.code = code;
        this.isOperational = isOperational;
        this.details = details;

        Object.setPrototypeOf(this, AppError.prototype);
        Error.captureStackTrace(this, this.constructor);
    }
}

export class ValidationError extends AppError {
    constructor(message: string, details?: any) {
        super(message, 400, 'VALIDATION_ERROR', true, details);
    }
}

export class AuthenticationError extends AppError {
    constructor(message: string = 'Authentication failed') {
        super(message, 401, 'AUTH_ERROR', true);
    }
}

export class AuthorizationError extends AppError {
    constructor(message: string = 'Insufficient permissions') {
        super(message, 403, 'FORBIDDEN', true);
    }
}

export class NotFoundError extends AppError {
    constructor(resource: string = 'Resource') {
        super(`${resource} not found`, 404, 'NOT_FOUND', true);
    }
}

export class ConflictError extends AppError {
    constructor(message: string) {
        super(message, 409, 'CONFLICT', true);
    }
}

export class RateLimitError extends AppError {
    constructor(retryAfter?: number) {
        super('Rate limit exceeded', 429, 'RATE_LIMIT', true, { retryAfter });
    }
}

export class ExternalServiceError extends AppError {
    constructor(service: string, originalError?: any) {
        super(
            `External service error: ${service}`,
            503,
            'SERVICE_UNAVAILABLE',
            false,
            { service, originalError }
        );
    }
}

/**
 * Error response formatter
 */
interface ErrorResponse {
    error: {
        message: string;
        code: string;
        statusCode: number;
        requestId?: string;
        timestamp: string;
        details?: any;
    };
}

/**
 * Format error for response
 */
function formatError(
    error: AppError | FastifyError | Error,
    requestId?: string
): ErrorResponse {
    const statusCode = (error as any).statusCode || 500;
    const code = (error as any).code || 'INTERNAL_ERROR';
    const details = (error as any).details;

    // Don't expose internal errors in production
    const message = process.env.NODE_ENV === 'production' && statusCode >= 500
        ? 'An internal error occurred'
        : error.message;

    return {
        error: {
            message,
            code,
            statusCode,
            requestId,
            timestamp: new Date().toISOString(),
            ...(details && { details })
        }
    };
}

/**
 * Global error handler middleware
 */
export async function errorHandler(
    error: FastifyError | AppError | Error,
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    // Log the error
    logError(error, {
        method: request.method,
        url: request.url,
        params: request.params,
        query: request.query,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        requestId: request.id,
        userId: (request as any).user?.userId
    });

    // Track error in database for monitoring
    if (process.env.NODE_ENV === 'production') {
        try {
            await query(
                `INSERT INTO error_logs (
                    error_type, error_message, error_code, 
                    status_code, request_id, user_id, 
                    url, method, ip_address, user_agent,
                    stack_trace, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
                [
                    error.name,
                    error.message,
                    (error as any).code || 'UNKNOWN',
                    (error as any).statusCode || 500,
                    request.id,
                    (request as any).user?.userId || null,
                    request.url,
                    request.method,
                    request.ip,
                    request.headers['user-agent'],
                    error.stack
                ]
            );
        } catch (dbError) {
            logger.error('Failed to log error to database', { error: dbError });
        }
    }

    // Check if error is operational
    const isOperational = (error as AppError).isOperational ?? false;

    // Log security events
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
        logSecurityEvent('Authentication/Authorization Failure', {
            ip: request.ip,
            url: request.url,
            method: request.method,
            userId: (request as any).user?.userId,
            error: error.message
        });
    }

    // Handle non-operational errors (programming errors)
    if (!isOperational) {
        // In production, notify monitoring service
        if (process.env.NODE_ENV === 'production') {
            // Here you would send to Sentry, DataDog, etc.
            logger.error('Non-operational error detected', {
                error: error.message,
                stack: error.stack,
                requestId: request.id
            });
        }
    }

    // Send error response
    const statusCode = (error as any).statusCode || 500;
    const errorResponse = formatError(error, request.id);

    // Add retry-after header for rate limit errors
    if (error instanceof RateLimitError && error.details?.retryAfter) {
        reply.header('Retry-After', error.details.retryAfter.toString());
    }

    reply.status(statusCode).send(errorResponse);
}

/**
 * Not found handler for undefined routes
 */
export async function notFoundHandler(
    request: FastifyRequest,
    reply: FastifyReply
): Promise<void> {
    const error = new NotFoundError('Endpoint');
    
    logger.warn('404 Not Found', {
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers['user-agent']
    });

    const errorResponse = formatError(error, request.id);
    reply.status(404).send(errorResponse);
}

/**
 * Async error wrapper for route handlers
 */
export function asyncHandler(fn: Function) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        try {
            await fn(request, reply);
        } catch (error) {
            errorHandler(error as Error, request, reply);
        }
    };
}

/**
 * Validation error handler for schema validation
 */
export function validationErrorHandler(
    errors: any[],
    request: FastifyRequest,
    reply: FastifyReply
): void {
    const formattedErrors = errors.map(err => ({
        field: err.instancePath || err.dataPath,
        message: err.message,
        params: err.params
    }));

    const error = new ValidationError(
        'Request validation failed',
        { errors: formattedErrors }
    );

    errorHandler(error, request, reply);
}

/**
 * Database error handler
 */
export function handleDatabaseError(error: any): AppError {
    // PostgreSQL error codes
    const pgErrorCodes: { [key: string]: () => AppError } = {
        '23505': () => new ConflictError('Duplicate entry'),
        '23503': () => new ValidationError('Foreign key constraint violation'),
        '23502': () => new ValidationError('Required field missing'),
        '22P02': () => new ValidationError('Invalid input syntax'),
        '42P01': () => new AppError('Database table does not exist', 500, 'DB_ERROR'),
        '08006': () => new ExternalServiceError('Database connection lost'),
        '08003': () => new ExternalServiceError('Database connection does not exist'),
        '57P03': () => new ExternalServiceError('Database is shutting down')
    };

    const errorCode = error.code;
    if (errorCode && pgErrorCodes[errorCode]) {
        return pgErrorCodes[errorCode]();
    }

    // Generic database error
    return new AppError(
        'Database operation failed',
        500,
        'DB_ERROR',
        false,
        { originalError: error.message }
    );
}

/**
 * WebSocket error handler
 */
export function handleWebSocketError(error: any, socketId: string): void {
    logger.error('WebSocket error', {
        socketId,
        error: error.message,
        stack: error.stack
    });

    // You might want to disconnect the socket or send an error message
}

/**
 * Process error handlers
 */
export function setupProcessErrorHandlers(): void {
    process.on('uncaughtException', (error: Error) => {
        logger.error('Uncaught Exception', {
            error: error.message,
            stack: error.stack
        });

        // Give time to log before exiting
        setTimeout(() => {
            process.exit(1);
        }, 1000);
    });

    process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
        logger.error('Unhandled Rejection', {
            reason: reason?.message || reason,
            stack: reason?.stack,
            promise
        });
    });

    process.on('SIGTERM', () => {
        logger.info('SIGTERM received, shutting down gracefully');
        // Graceful shutdown logic here
    });

    process.on('SIGINT', () => {
        logger.info('SIGINT received, shutting down gracefully');
        // Graceful shutdown logic here
    });
}

export default {
    AppError,
    ValidationError,
    AuthenticationError,
    AuthorizationError,
    NotFoundError,
    ConflictError,
    RateLimitError,
    ExternalServiceError,
    errorHandler,
    notFoundHandler,
    asyncHandler,
    validationErrorHandler,
    handleDatabaseError,
    handleWebSocketError,
    setupProcessErrorHandlers
};