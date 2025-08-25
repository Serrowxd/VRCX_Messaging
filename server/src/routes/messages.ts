import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth';
import { validate, messageSchemas } from '../middleware/validation';
import { rateLimiters } from '../middleware/rateLimiter';
import { query } from '../database/connection';
import { logMessage } from '../utils/logger';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';

interface AuthRequest extends FastifyRequest {
    user?: {
        userId: string;
        deviceId: number;
        sessionId: string;
    };
}

export default async function messageRoutes(app: FastifyInstance) {
    /**
     * Send encrypted message
     */
    app.post('/send', {
        schema: {
            tags: ['messages'],
            summary: 'Send an encrypted message',
            security: [{ Bearer: [] }],
            body: messageSchemas.sendMessage,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        messageId: { type: 'string' },
                        conversationId: { type: 'string' },
                        timestamp: { type: 'string' }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            rateLimiters.messaging.middleware(),
            validate(messageSchemas.sendMessage)
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        const { recipientId, conversationId, encryptedContent, metadata } = request.body as any;
        
        // Placeholder for actual message sending logic
        logMessage('send', 'placeholder', {
            senderId: userId,
            recipientId,
            conversationId
        });
        
        return {
            messageId: 'msg_' + Date.now(),
            conversationId: conversationId || 'conv_' + Date.now(),
            timestamp: new Date().toISOString()
        };
    });

    /**
     * Get conversation messages
     */
    app.get('/conversation/:conversationId', {
        schema: {
            tags: ['messages'],
            summary: 'Get messages for a conversation',
            security: [{ Bearer: [] }],
            params: {
                type: 'object',
                properties: {
                    conversationId: { type: 'string', format: 'uuid' }
                },
                required: ['conversationId']
            },
            querystring: messageSchemas.getMessages,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        messages: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    messageId: { type: 'string' },
                                    senderId: { type: 'string' },
                                    encryptedContent: { type: 'string' },
                                    metadata: { type: 'object' },
                                    timestamp: { type: 'string' },
                                    readAt: { type: ['string', 'null'] }
                                }
                            }
                        },
                        hasMore: { type: 'boolean' },
                        cursor: { type: ['string', 'null'] }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            rateLimiters.standard.middleware()
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        const { conversationId } = request.params as any;
        const { limit = 20, cursor, since, until } = request.query as any;
        
        // Placeholder response
        return {
            messages: [],
            hasMore: false,
            cursor: null
        };
    });

    /**
     * Get all conversations
     */
    app.get('/conversations', {
        schema: {
            tags: ['messages'],
            summary: 'Get all conversations for the user',
            security: [{ Bearer: [] }],
            querystring: {
                type: 'object',
                properties: {
                    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
                    offset: { type: 'integer', minimum: 0, default: 0 },
                    unreadOnly: { type: 'boolean', default: false },
                    archived: { type: 'boolean', default: false }
                }
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        conversations: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    conversationId: { type: 'string' },
                                    participantId: { type: 'string' },
                                    participantUsername: { type: 'string' },
                                    lastMessage: {
                                        type: 'object',
                                        properties: {
                                            messageId: { type: 'string' },
                                            preview: { type: 'string' },
                                            timestamp: { type: 'string' }
                                        }
                                    },
                                    unreadCount: { type: 'integer' },
                                    archived: { type: 'boolean' },
                                    muted: { type: 'boolean' }
                                }
                            }
                        },
                        total: { type: 'integer' }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            rateLimiters.standard.middleware()
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        const { limit = 20, offset = 0, unreadOnly, archived } = request.query as any;
        
        // Placeholder response
        return {
            conversations: [],
            total: 0
        };
    });

    /**
     * Mark messages as read
     */
    app.put('/read', {
        schema: {
            tags: ['messages'],
            summary: 'Mark messages as read',
            security: [{ Bearer: [] }],
            body: messageSchemas.markAsRead,
            response: {
                200: {
                    type: 'object',
                    properties: {
                        updated: { type: 'integer' }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            validate(messageSchemas.markAsRead)
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        const { messageIds, readAt } = request.body as any;
        
        // Placeholder
        logMessage('read', messageIds[0], {
            userId,
            count: messageIds.length
        });
        
        return {
            updated: messageIds.length
        };
    });

    /**
     * Delete message
     */
    app.delete('/:messageId', {
        schema: {
            tags: ['messages'],
            summary: 'Delete a message',
            security: [{ Bearer: [] }],
            params: {
                type: 'object',
                properties: {
                    messageId: { type: 'string', format: 'uuid' }
                },
                required: ['messageId']
            },
            querystring: {
                type: 'object',
                properties: {
                    deleteForEveryone: { type: 'boolean', default: false }
                }
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
        const { messageId } = request.params as any;
        const { deleteForEveryone } = request.query as any;
        
        logMessage('delete', messageId, {
            userId,
            deleteForEveryone
        });
        
        return {
            message: 'Message deleted successfully'
        };
    });

    /**
     * Search messages
     */
    app.get('/search', {
        schema: {
            tags: ['messages'],
            summary: 'Search messages',
            security: [{ Bearer: [] }],
            querystring: {
                type: 'object',
                properties: {
                    query: { type: 'string', minLength: 1, maxLength: 100 },
                    conversationId: { type: 'string', format: 'uuid', nullable: true },
                    limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
                    offset: { type: 'integer', minimum: 0, default: 0 }
                },
                required: ['query']
            },
            response: {
                200: {
                    type: 'object',
                    properties: {
                        results: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    messageId: { type: 'string' },
                                    conversationId: { type: 'string' },
                                    snippet: { type: 'string' },
                                    timestamp: { type: 'string' }
                                }
                            }
                        },
                        total: { type: 'integer' }
                    }
                }
            }
        },
        preHandler: [
            authenticate,
            rateLimiters.search.middleware()
        ]
    }, async (request: AuthRequest, reply: FastifyReply) => {
        const { userId } = request.user!;
        const { query, conversationId, limit = 20, offset = 0 } = request.query as any;
        
        // Placeholder
        return {
            results: [],
            total: 0
        };
    });
}