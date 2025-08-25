import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authenticate } from '../middleware/auth';
import { validate, messageSchemas } from '../middleware/validation';
import { rateLimiters } from '../middleware/rateLimiter';
import { MessageService } from '../services/messageService';
import { messageQueueService } from '../services/messageQueue';
import { query } from '../database/connection';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';
import crypto from 'crypto';

interface AuthRequest extends FastifyRequest {
    user?: {
        userId: string;
        deviceId: number;
        sessionId: string;
    };
}

// Initialize message service
const messageService = new MessageService();

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
        const { userId, deviceId } = request.user!;
        const { recipientId, conversationId, encryptedContent, metadata } = request.body as any;
        
        try {
            // Validate recipient exists
            const recipientCheck = await query(
                'SELECT id FROM users WHERE id = $1',
                [recipientId]
            );
            
            if (recipientCheck.rows.length === 0) {
                throw new NotFoundError('Recipient not found');
            }
            
            // Ensure metadata includes device ID
            const enrichedMetadata = {
                ...metadata,
                deviceId,
                timestamp: Date.now(),
                version: 1
            };
            
            // Send message through service
            const message = await messageService.sendMessage(
                userId,
                recipientId,
                encryptedContent,
                enrichedMetadata,
                conversationId
            );
            
            // Queue for real-time delivery
            await messageQueueService.queueMessage({
                messageId: message.id,
                recipientId,
                senderId: userId,
                conversationId: message.conversation_id,
                encryptedContent,
                metadata: enrichedMetadata
            });
            
            logger.info('Message sent successfully', {
                messageId: message.id,
                senderId: userId,
                recipientId,
                conversationId: message.conversation_id
            });
            
            return {
                messageId: message.id,
                conversationId: message.conversation_id,
                timestamp: message.created_at.toISOString()
            };
            
        } catch (error) {
            logger.error('Failed to send message', {
                error,
                senderId: userId,
                recipientId
            });
            throw error;
        }
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
        
        try {
            // Parse dates if provided
            const sinceDate = since ? new Date(since) : undefined;
            const untilDate = until ? new Date(until) : undefined;
            
            // Get messages from service
            const result = await messageService.getConversationMessages(
                userId,
                conversationId,
                Math.min(limit, 100), // Cap at 100 messages per request
                cursor,
                sinceDate,
                untilDate
            );
            
            // Transform messages for response (exclude sensitive server-side data)
            const messages = result.messages.map(msg => ({
                messageId: msg.id,
                senderId: msg.sender_id,
                encryptedContent: msg.encrypted_content,
                metadata: typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata,
                timestamp: msg.created_at.toISOString(),
                readAt: msg.read_at ? msg.read_at.toISOString() : null,
                status: msg.status
            }));
            
            return {
                messages,
                hasMore: result.hasMore,
                cursor: result.cursor
            };
            
        } catch (error) {
            logger.error('Failed to get conversation messages', {
                error,
                userId,
                conversationId
            });
            throw error;
        }
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
        
        try {
            // Get conversations from service
            const result = await messageService.getConversations(
                userId,
                Math.min(limit, 100), // Cap at 100 conversations per request
                offset,
                unreadOnly || false,
                archived || false
            );
            
            // Transform conversations for response
            const conversations = result.conversations.map(conv => ({
                conversationId: conv.id,
                participantId: conv.participant_id,
                participantUsername: conv.participant_username,
                lastMessage: conv.last_message ? {
                    messageId: conv.last_message.id,
                    preview: conv.last_message.preview,
                    timestamp: conv.last_message.timestamp.toISOString()
                } : null,
                unreadCount: conv.unread_count,
                archived: conv.archived,
                muted: conv.muted,
                createdAt: conv.created_at.toISOString(),
                updatedAt: conv.updated_at.toISOString()
            }));
            
            return {
                conversations,
                total: result.total
            };
            
        } catch (error) {
            logger.error('Failed to get conversations', {
                error,
                userId
            });
            throw error;
        }
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
        
        try {
            // Validate message IDs
            if (!Array.isArray(messageIds) || messageIds.length === 0) {
                throw new ValidationError('Message IDs must be a non-empty array');
            }
            
            if (messageIds.length > 100) {
                throw new ValidationError('Cannot mark more than 100 messages at once');
            }
            
            // Parse read timestamp if provided
            const readTimestamp = readAt ? new Date(readAt) : new Date();
            
            // Mark messages as read through service
            const updatedCount = await messageService.markMessagesAsRead(
                userId,
                messageIds,
                readTimestamp
            );
            
            logger.info('Messages marked as read', {
                userId,
                count: updatedCount,
                requestedCount: messageIds.length
            });
            
            return {
                updated: updatedCount
            };
            
        } catch (error) {
            logger.error('Failed to mark messages as read', {
                error,
                userId,
                messageCount: messageIds?.length
            });
            throw error;
        }
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
        
        try {
            // Delete message through service
            await messageService.deleteMessage(
                userId,
                messageId,
                deleteForEveryone === true || deleteForEveryone === 'true'
            );
            
            logger.info('Message deleted', {
                messageId,
                userId,
                deleteForEveryone
            });
            
            return {
                message: 'Message deleted successfully'
            };
            
        } catch (error) {
            logger.error('Failed to delete message', {
                error,
                userId,
                messageId
            });
            throw error;
        }
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
        const { query: searchQuery, conversationId, limit = 20, offset = 0 } = request.query as any;
        
        try {
            // Search messages through service
            // Note: Server-side search is limited due to encryption
            const result = await messageService.searchMessages(
                userId,
                searchQuery,
                conversationId,
                Math.min(limit, 50), // Cap at 50 results per request
                offset
            );
            
            logger.info('Message search performed', {
                userId,
                query: searchQuery,
                conversationId,
                resultCount: result.results.length
            });
            
            return {
                results: result.results,
                total: result.total
            };
            
        } catch (error) {
            logger.error('Failed to search messages', {
                error,
                userId,
                query: searchQuery
            });
            throw error;
        }
    });
}