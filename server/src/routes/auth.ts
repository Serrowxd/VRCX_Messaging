import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { 
    generateTokens, 
    refreshAccessToken, 
    validateVRCXAuth, 
    authenticate, 
    revokeSession, 
    revokeAllSessions,
    hashPassword,
    verifyPassword
} from '../middleware/auth';
import { validate, authSchemas } from '../middleware/validation';
import { rateLimiters } from '../middleware/rateLimiter';
import { query } from '../database/connection';
import { logAudit, logSecurityEvent } from '../utils/logger';
import { AuthenticationError, ValidationError } from '../middleware/errorHandler';

interface AuthRequest extends FastifyRequest {
    user?: {
        userId: string;
        deviceId: number;
        sessionId: string;
    };
}

export default async function authRoutes(app: FastifyInstance) {
    /**
     * VRCX Authentication - Primary auth method
     */
    app.post('/vrcx', {
        schema: {
            tags: ['auth'],
            summary: 'Authenticate with VRCX token',
            body: authSchemas.vrcxAuth,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        accessToken: { type: 'string' },
                        refreshToken: { type: 'string' },
                        expiresIn: { type: 'number' },
                        userId: { type: 'string' },
                        username: { type: 'string' }
                    }
                }
            }
        },
        preHandler: [
            rateLimiters.auth.middleware(),
            validate(authSchemas.vrcxAuth)
        ]
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { vrcxToken, deviceId } = request.body as any;
        
        // Validate VRCX token
        const vrcxUser = await validateVRCXAuth(vrcxToken);
        
        if (!vrcxUser) {
            logSecurityEvent('VRCX authentication failed', {
                ip: request.ip,
                deviceId
            });
            throw new AuthenticationError('Invalid VRCX token');
        }
        
        // Generate JWT tokens
        const tokens = await generateTokens(vrcxUser.userId, deviceId || 1);
        
        logAudit('User authenticated via VRCX', vrcxUser.userId, {
            deviceId,
            sessionId: tokens.sessionId,
            ip: request.ip
        });
        
        return {
            ...tokens,
            userId: vrcxUser.userId,
            username: vrcxUser.username
        };
    });

    /**
     * Standard login (backup method)
     */
    app.post('/login', {
        schema: {
            tags: ['auth'],
            summary: 'Login with username and password',
            body: authSchemas.login,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        accessToken: { type: 'string' },
                        refreshToken: { type: 'string' },
                        expiresIn: { type: 'number' },
                        userId: { type: 'string' }
                    }
                }
            }
        },
        preHandler: [
            rateLimiters.auth.middleware(),
            validate(authSchemas.login)
        ]
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { username, password, deviceId } = request.body as any;
        
        // Get user from database
        const result = await query(
            `SELECT user_id, username, password_hash 
             FROM users 
             WHERE username = $1 AND active = true`,
            [username]
        );
        
        if (result.rows.length === 0) {
            logSecurityEvent('Login failed - user not found', {
                username,
                ip: request.ip
            });
            throw new AuthenticationError('Invalid credentials');
        }
        
        const user = result.rows[0];
        
        // Verify password
        const validPassword = await verifyPassword(user.password_hash, password);
        
        if (!validPassword) {
            logSecurityEvent('Login failed - invalid password', {
                username,
                userId: user.user_id,
                ip: request.ip
            });
            throw new AuthenticationError('Invalid credentials');
        }
        
        // Generate tokens
        const tokens = await generateTokens(user.user_id, deviceId || 1);
        
        logAudit('User logged in', user.user_id, {
            username,
            deviceId,
            sessionId: tokens.sessionId,
            ip: request.ip
        });
        
        return {
            ...tokens,
            userId: user.user_id
        };
    });

    /**
     * Refresh access token
     */
    app.post('/refresh', {
        schema: {
            tags: ['auth'],
            summary: 'Refresh access token',
            body: authSchemas.refreshToken,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        accessToken: { type: 'string' },
                        expiresIn: { type: 'number' }
                    }
                }
            }
        },
        preHandler: [
            rateLimiters.standard.middleware(),
            validate(authSchemas.refreshToken)
        ]
    }, async (request: FastifyRequest, reply: FastifyReply) => {
        const { refreshToken } = request.body as any;
        
        try {
            const result = await refreshAccessToken(refreshToken);
            
            logAudit('Token refreshed', 'system', {
                ip: request.ip
            });
            
            return result;
        } catch (error) {
            logSecurityEvent('Token refresh failed', {
                error: error instanceof Error ? error.message : 'Unknown error',
                ip: request.ip
            });
            throw new AuthenticationError('Invalid refresh token');
        }
    });

    /**
     * Logout current session
     */
    app.post('/logout', {
        schema: {
            tags: ['auth'],
            summary: 'Logout current session',
            security: [{ Bearer: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId, sessionId } = request.user!;
        
        await revokeSession(sessionId, userId);
        
        logAudit('User logged out', userId, {
            sessionId,
            ip: request.ip
        });
        
        return {
            message: 'Logged out successfully'
        };
    });

    /**
     * Logout all sessions
     */
    app.post('/logout-all', {
        schema: {
            tags: ['auth'],
            summary: 'Logout all sessions for current user',
            security: [{ Bearer: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        sessionsRevoked: { type: 'number' }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        
        await revokeAllSessions(userId);
        
        logAudit('All sessions revoked', userId, {
            ip: request.ip
        });
        
        return {
            message: 'All sessions logged out successfully',
            sessionsRevoked: 0 // Would need to track this
        };
    });

    /**
     * Get current session info
     */
    app.get('/session', {
        schema: {
            tags: ['auth'],
            summary: 'Get current session information',
            security: [{ Bearer: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        userId: { type: 'string' },
                        deviceId: { type: 'number' },
                        sessionId: { type: 'string' },
                        createdAt: { type: 'string' },
                        lastActivity: { type: 'string' }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId, sessionId, deviceId } = request.user!;
        
        const result = await query(
            `SELECT created_at, last_activity 
             FROM sessions 
             WHERE id = $1`,
            [sessionId]
        );
        
        if (result.rows.length === 0) {
            throw new AuthenticationError('Session not found');
        }
        
        return {
            userId,
            deviceId,
            sessionId,
            createdAt: result.rows[0].created_at,
            lastActivity: result.rows[0].last_activity
        };
    });

    /**
     * List active sessions
     */
    app.get('/sessions', {
        schema: {
            tags: ['auth'],
            summary: 'List all active sessions for current user',
            security: [{ Bearer: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        sessions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    sessionId: { type: 'string' },
                                    deviceId: { type: 'number' },
                                    createdAt: { type: 'string' },
                                    lastActivity: { type: 'string' },
                                    current: { type: 'boolean' }
                                }
                            }
                        }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId, sessionId: currentSessionId } = request.user!;
        
        const result = await query(
            `SELECT id, device_id, created_at, last_activity 
             FROM sessions 
             WHERE user_id = $1 
             AND expires_at > NOW() 
             AND revoked_at IS NULL
             ORDER BY last_activity DESC`,
            [userId]
        );
        
        const sessions = result.rows.map(row => ({
            sessionId: row.id,
            deviceId: row.device_id,
            createdAt: row.created_at,
            lastActivity: row.last_activity,
            current: row.id === currentSessionId
        }));
        
        return { sessions };
    });

    /**
     * Revoke specific session
     */
    app.delete('/sessions/:sessionId', {
        schema: {
            tags: ['auth'],
            summary: 'Revoke a specific session',
            security: [{ Bearer: [] }],
            params: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string' }
                },
                required: ['sessionId']
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        const { sessionId } = request.params as any;
        
        // Verify session belongs to user
        const result = await query(
            `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`,
            [sessionId, userId]
        );
        
        if (result.rows.length === 0) {
            throw new ValidationError('Session not found');
        }
        
        await revokeSession(sessionId, userId);
        
        logAudit('Session revoked', userId, {
            revokedSessionId: sessionId,
            ip: request.ip
        });
        
        return {
            message: 'Session revoked successfully'
        };
    });
}