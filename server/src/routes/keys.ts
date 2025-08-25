import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth';
import { validate, keyExchangeSchemas } from '../middleware/validation';
import { rateLimiters } from '../middleware/rateLimiter';
import { keyService } from '../services/keyService';
import { 
    UploadKeysRequest, 
    RotateKeysRequest, 
    VerifyKeyRequest 
} from '../models/keys';
import { logger } from '../utils/logger';

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
        const uploadRequest = request.body as UploadKeysRequest;
        
        try {
            const result = await keyService.uploadKeyBundle(userId, uploadRequest);
            
            return {
                message: 'Keys uploaded successfully',
                keysStored: result.keysStored
            };
        } catch (error) {
            logger.error('Failed to upload keys', { userId, error });
            throw error;
        }
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
        
        try {
            const bundle = await keyService.getKeyBundle(userId, deviceId);
            
            logger.info('Key bundle retrieved', {
                requestingUserId,
                targetUserId: userId,
                deviceId: bundle.deviceId,
                hasOneTimeKey: !!bundle.oneTimePreKey
            });
            
            return bundle;
        } catch (error) {
            logger.error('Failed to get key bundle', { requestingUserId, targetUserId: userId, error });
            throw error;
        }
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
        const rotateRequest = request.body as RotateKeysRequest;
        
        try {
            const result = await keyService.rotateKeys(userId, deviceId, rotateRequest);
            
            return {
                message: 'Keys rotated successfully',
                signedPreKeyRotated: result.signedPreKeyRotated,
                oneTimePreKeysAdded: result.oneTimePreKeysAdded
            };
        } catch (error) {
            logger.error('Failed to rotate keys', { userId, deviceId, error });
            throw error;
        }
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
        const { userId } = request.user!;
        
        try {
            const keyCount = await keyService.getKeyCountInfo(userId);
            return keyCount;
        } catch (error) {
            logger.error('Failed to get key count', { userId, error });
            throw error;
        }
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
        const verifyRequest = request.body as VerifyKeyRequest;
        
        try {
            const result = await keyService.verifyIdentityKey(verifyingUserId, verifyRequest);
            return result;
        } catch (error) {
            logger.error('Failed to verify key', { verifyingUserId, targetUserId: verifyRequest.userId, error });
            throw error;
        }
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
        
        try {
            const trustedKeys = await keyService.getTrustedKeys(userId);
            return { trustedKeys };
        } catch (error) {
            logger.error('Failed to get trusted keys', { userId, error });
            throw error;
        }
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
        
        try {
            await keyService.revokeDeviceKeys(userId, parseInt(deviceId, 10));
            
            return {
                message: 'Device keys revoked successfully'
            };
        } catch (error) {
            logger.error('Failed to revoke device keys', { userId, deviceId, error });
            throw error;
        }
    });
}