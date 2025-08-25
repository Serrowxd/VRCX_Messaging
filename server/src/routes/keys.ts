import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth';
import { validate, keyExchangeSchemas } from '../middleware/validation';
import { rateLimiters } from '../middleware/rateLimiter';
import { query } from '../database/connection';
import { logAudit } from '../utils/logger';
import { NotFoundError, ValidationError, ConflictError } from '../middleware/errorHandler';

interface AuthRequest extends FastifyRequest {
    user?: {
        userId: string;
        deviceId: number;
        sessionId: string;
    };
}

export default async function keyExchangeRoutes(app: FastifyInstance) {
    /**
     * Upload key bundle
     */
    app.post('/upload', {
        schema: {
            tags: ['keys'],
            summary: 'Upload encryption keys for key exchange',
            security: [{ Bearer: [] }],
            body: keyExchangeSchemas.uploadKeys,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        keysStored: { type: 'integer' }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            rateLimiters.keyExchange.middleware(),
            validate(keyExchangeSchemas.uploadKeys)
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        const { 
            identityKey, 
            signedPreKey, 
            oneTimePreKeys, 
            deviceId, 
            registrationId 
        } = request.body as any;
        
        // Store keys in database (placeholder)
        logAudit('Keys uploaded', userId, {
            deviceId,
            registrationId,
            oneTimePreKeysCount: oneTimePreKeys.length
        });
        
        return {
            message: 'Keys uploaded successfully',
            keysStored: oneTimePreKeys.length + 1
        };
    });

    /**
     * Get user's key bundle
     */
    app.get('/:userId/bundle', {
        schema: {
            tags: ['keys'],
            summary: 'Get key bundle for establishing encrypted session',
            security: [{ Bearer: [] }],
            params: {
                type: 'object',
                properties: {
                    userId: { type: 'string', format: 'uuid' }
                },
                required: ['userId']
            },
            querystring: {
                type: 'object',
                properties: {
                    deviceId: { type: 'integer', minimum: 1, nullable: true }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        identityKey: { type: 'string' },
                        signedPreKey: {
                            type: 'object',
                            properties: {
                                keyId: { type: 'integer' },
                                publicKey: { type: 'string' },
                                signature: { type: 'string' }
                            }
                        },
                        oneTimePreKey: {
                            type: 'object',
                            nullable: true,
                            properties: {
                                keyId: { type: 'integer' },
                                publicKey: { type: 'string' }
                            }
                        },
                        registrationId: { type: 'integer' },
                        deviceId: { type: 'integer' }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            rateLimiters.keyExchange.middleware()
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const requestingUserId = request.user!.userId;
        const { userId } = request.params as any;
        const { deviceId } = request.query as any;
        
        // Get key bundle from database (placeholder)
        logAudit('Key bundle retrieved', requestingUserId, {
            targetUserId: userId,
            deviceId
        });
        
        // Placeholder response
        return {
            identityKey: 'base64_identity_key',
            signedPreKey: {
                keyId: 1,
                publicKey: 'base64_signed_prekey',
                signature: 'base64_signature'
            },
            oneTimePreKey: {
                keyId: 1,
                publicKey: 'base64_onetime_prekey'
            },
            registrationId: 12345,
            deviceId: deviceId || 1
        };
    });

    /**
     * Rotate keys
     */
    app.post('/rotate', {
        schema: {
            tags: ['keys'],
            summary: 'Rotate encryption keys',
            security: [{ Bearer: [] }],
            body: keyExchangeSchemas.rotateKeys,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        message: { type: 'string' },
                        signedPreKeyRotated: { type: 'boolean' },
                        oneTimePreKeysAdded: { type: 'integer' }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            rateLimiters.keyExchange.middleware(),
            validate(keyExchangeSchemas.rotateKeys)
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId, deviceId } = request.user!;
        const { signedPreKey, oneTimePreKeys } = request.body as any;
        
        logAudit('Keys rotated', userId, {
            deviceId,
            signedPreKeyRotated: !!signedPreKey,
            oneTimePreKeysAdded: oneTimePreKeys?.length || 0
        });
        
        return {
            message: 'Keys rotated successfully',
            signedPreKeyRotated: !!signedPreKey,
            oneTimePreKeysAdded: oneTimePreKeys?.length || 0
        };
    });

    /**
     * Get remaining prekey count
     */
    app.get('/count', {
        schema: {
            tags: ['keys'],
            summary: 'Get remaining one-time prekey count',
            security: [{ Bearer: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        count: { type: 'integer' },
                        minimum: { type: 'integer' },
                        shouldReplenish: { type: 'boolean' }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId, deviceId } = request.user!;
        
        // Get count from database (placeholder)
        const count = 50; // Placeholder
        const minimum = 20;
        
        return {
            count,
            minimum,
            shouldReplenish: count < minimum
        };
    });

    /**
     * Verify key
     */
    app.post('/verify', {
        schema: {
            tags: ['keys'],
            summary: 'Verify a user\'s identity key',
            security: [{ Bearer: [] }],
            body: {
                type: 'object',
                properties: {
                    userId: { type: 'string', format: 'uuid' },
                    identityKey: { type: 'string', format: 'base64' },
                    deviceId: { type: 'integer', minimum: 1 }
                },
                required: ['userId', 'identityKey']
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        verified: { type: 'boolean' },
                        trustLevel: { type: 'string', enum: ['untrusted', 'trusted', 'verified'] }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const verifyingUserId = request.user!.userId;
        const { userId, identityKey, deviceId } = request.body as any;
        
        // Verify key (placeholder)
        logAudit('Key verification', verifyingUserId, {
            targetUserId: userId,
            deviceId
        });
        
        return {
            verified: true,
            trustLevel: 'trusted'
        };
    });

    /**
     * Get trusted keys
     */
    app.get('/trusted', {
        schema: {
            tags: ['keys'],
            summary: 'Get list of trusted identity keys',
            security: [{ Bearer: [] }],
            response: {
                200: {
                    type: 'object',
                    properties: {
                        trustedKeys: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    userId: { type: 'string' },
                                    deviceId: { type: 'integer' },
                                    identityKey: { type: 'string' },
                                    trustLevel: { type: 'string' },
                                    verifiedAt: { type: 'string' }
                                }
                            }
                        }
                    }
                }
            }
        },
        preHandler: [authenticate]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        
        // Get trusted keys from database (placeholder)
        return {
            trustedKeys: []
        };
    });

    /**
     * Revoke device keys
     */
    app.delete('/device/:deviceId', {
        schema: {
            tags: ['keys'],
            summary: 'Revoke keys for a specific device',
            security: [{ Bearer: [] }],
            params: {
                type: 'object',
                properties: {
                    deviceId: { type: 'integer', minimum: 1 }
                },
                required: ['deviceId']
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
        const { deviceId } = request.params as any;
        
        logAudit('Device keys revoked', userId, {
            revokedDeviceId: deviceId
        });
        
        return {
            message: 'Device keys revoked successfully'
        };
    });
}