import { MessageService } from '../../src/services/messageService';
import { MessageStatus } from '../../src/models/message';
import * as dbConnection from '../../src/database/connection';
import * as metadataEncryption from '../../src/utils/metadataEncryption';
import * as logger from '../../src/utils/logger';

// Mock all external dependencies
jest.mock('../../src/database/connection');
jest.mock('../../src/utils/metadataEncryption');
jest.mock('../../src/utils/logger');

describe('MessageService', () => {
    let messageService: MessageService;
    let mockQuery: jest.Mock;
    let mockTransaction: jest.Mock;
    let mockGetRedis: jest.Mock;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Setup mocks
        mockQuery = jest.fn();
        mockTransaction = jest.fn();
        mockGetRedis = jest.fn().mockReturnValue({
            publish: jest.fn().mockResolvedValue('OK')
        });

        (dbConnection.query as jest.Mock) = mockQuery;
        (dbConnection.transaction as jest.Mock) = mockTransaction;
        (dbConnection.getRedis as jest.Mock) = mockGetRedis;

        // Mock metadata encryption
        (metadataEncryption.metadataEncryption.encryptMetadata as jest.Mock) = jest.fn()
            .mockImplementation((metadata) => ({
                encrypted: JSON.stringify(metadata),
                fields: []
            }));

        // Mock logger
        (logger.logger.info as jest.Mock) = jest.fn();
        (logger.logger.error as jest.Mock) = jest.fn();
        (logger.logger.debug as jest.Mock) = jest.fn();

        // Create service instance
        messageService = new MessageService();
    });

    describe('sendMessage', () => {
        it('should successfully send a message', async () => {
            const senderId = 'user1';
            const recipientId = 'user2';
            const encryptedContent = 'encrypted_content';
            const metadata = { version: 1, timestamp: Date.now() };

            // Mock transaction
            mockTransaction.mockImplementation(async (callback) => {
                const mockClient = {
                    query: jest.fn()
                        .mockResolvedValueOnce({ 
                            rows: [{ id: 'conv_123' }] 
                        }) // get_or_create_conversation
                        .mockResolvedValueOnce({ 
                            rows: [{
                                id: 'msg_123',
                                conversation_id: 'conv_123',
                                sender_id: senderId,
                                recipient_id: recipientId,
                                encrypted_content: encryptedContent,
                                metadata: JSON.stringify(metadata),
                                status: MessageStatus.SENT,
                                created_at: new Date()
                            }]
                        }) // INSERT message
                        .mockResolvedValueOnce({ rows: [] }) // UPDATE conversation
                        .mockResolvedValueOnce({ rows: [] }) // INSERT message_queue
                };
                return await callback(mockClient);
            });

            const result = await messageService.sendMessage(
                senderId,
                recipientId,
                encryptedContent,
                metadata
            );

            expect(result).toHaveProperty('id', 'msg_123');
            expect(result).toHaveProperty('conversation_id', 'conv_123');
            expect(result).toHaveProperty('status', MessageStatus.SENT);
            expect(mockTransaction).toHaveBeenCalled();
        });

        it('should throw error if conversation creation fails', async () => {
            mockTransaction.mockImplementation(async (callback) => {
                const mockClient = {
                    query: jest.fn().mockResolvedValueOnce({ rows: [] })
                };
                return await callback(mockClient);
            });

            await expect(
                messageService.sendMessage('user1', 'user2', 'content', {})
            ).rejects.toThrow('Failed to create conversation');
        });
    });

    describe('getConversationMessages', () => {
        it('should retrieve messages with pagination', async () => {
            const userId = 'user1';
            const conversationId = 'conv_123';
            const limit = 20;

            // Mock conversation check
            mockQuery
                .mockResolvedValueOnce({ 
                    rows: [{ id: conversationId }] 
                }) // conversation exists
                .mockResolvedValueOnce({ 
                    rows: [
                        {
                            id: 'msg_1',
                            conversation_id: conversationId,
                            sender_id: userId,
                            encrypted_content: 'content1',
                            created_at: new Date('2024-01-01'),
                            metadata: '{}',
                            status: MessageStatus.READ
                        },
                        {
                            id: 'msg_2',
                            conversation_id: conversationId,
                            sender_id: 'user2',
                            encrypted_content: 'content2',
                            created_at: new Date('2024-01-02'),
                            metadata: '{}',
                            status: MessageStatus.DELIVERED
                        }
                    ]
                }); // messages query

            const result = await messageService.getConversationMessages(
                userId,
                conversationId,
                limit
            );

            expect(result.messages).toHaveLength(2);
            expect(result.hasMore).toBe(false);
            expect(result.cursor).toBeTruthy();
            expect(mockQuery).toHaveBeenCalledTimes(2);
        });

        it('should throw error if conversation not found', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            await expect(
                messageService.getConversationMessages('user1', 'conv_999', 20)
            ).rejects.toThrow('Conversation not found');
        });

        it('should handle cursor-based pagination', async () => {
            const cursor = new Date('2024-01-15').toISOString();

            mockQuery
                .mockResolvedValueOnce({ rows: [{ id: 'conv_123' }] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await messageService.getConversationMessages(
                'user1',
                'conv_123',
                20,
                cursor
            );

            expect(result.messages).toHaveLength(0);
            expect(result.hasMore).toBe(false);
            expect(result.cursor).toBeNull();
        });
    });

    describe('getConversations', () => {
        it('should retrieve user conversations', async () => {
            const userId = 'user1';

            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: '2' }] }) // count
                .mockResolvedValueOnce({ 
                    rows: [
                        {
                            id: 'conv_1',
                            user1_id: userId,
                            user2_id: 'user2',
                            created_at: new Date(),
                            updated_at: new Date(),
                            participant_id: 'user2',
                            participant_username: 'User Two',
                            last_message_id: 'msg_1',
                            last_message_content: 'encrypted',
                            last_message_timestamp: new Date(),
                            unread_count: '3',
                            archived: false,
                            muted: false
                        }
                    ]
                });

            const result = await messageService.getConversations(userId);

            expect(result.conversations).toHaveLength(1);
            expect(result.total).toBe(2);
            expect(result.conversations[0].unread_count).toBe(3);
            expect(result.conversations[0].participant_username).toBe('User Two');
        });

        it('should filter archived conversations', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: '0' }] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await messageService.getConversations(
                'user1',
                20,
                0,
                false,
                true // archived
            );

            expect(result.conversations).toHaveLength(0);
            expect(result.total).toBe(0);
        });
    });

    describe('markMessagesAsRead', () => {
        it('should mark messages as read', async () => {
            const userId = 'user1';
            const messageIds = ['msg_1', 'msg_2', 'msg_3'];

            mockQuery.mockResolvedValueOnce({ 
                rows: messageIds.map(id => ({ id }))
            });

            const result = await messageService.markMessagesAsRead(
                userId,
                messageIds
            );

            expect(result).toBe(3);
            expect(mockGetRedis).toHaveBeenCalled();
        });

        it('should return 0 for empty message array', async () => {
            const result = await messageService.markMessagesAsRead('user1', []);
            expect(result).toBe(0);
            expect(mockQuery).not.toHaveBeenCalled();
        });
    });

    describe('deleteMessage', () => {
        it('should delete message for everyone when sender', async () => {
            const userId = 'user1';
            const messageId = 'msg_123';

            mockQuery
                .mockResolvedValueOnce({ 
                    rows: [{
                        id: messageId,
                        sender_id: userId,
                        recipient_id: 'user2'
                    }]
                })
                .mockResolvedValueOnce({ rows: [] });

            await messageService.deleteMessage(userId, messageId, true);

            expect(mockQuery).toHaveBeenCalledTimes(2);
            expect(mockGetRedis).toHaveBeenCalled();
        });

        it('should delete message for user only', async () => {
            const userId = 'user2';
            const messageId = 'msg_123';

            mockQuery
                .mockResolvedValueOnce({ 
                    rows: [{
                        id: messageId,
                        sender_id: 'user1',
                        recipient_id: userId
                    }]
                })
                .mockResolvedValueOnce({ rows: [] });

            await messageService.deleteMessage(userId, messageId, false);

            expect(mockQuery).toHaveBeenCalledTimes(2);
        });

        it('should throw error if message not found', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            await expect(
                messageService.deleteMessage('user1', 'msg_999', false)
            ).rejects.toThrow('Message not found');
        });

        it('should throw error if user cannot delete message', async () => {
            mockQuery.mockResolvedValueOnce({ 
                rows: [{
                    id: 'msg_123',
                    sender_id: 'user1',
                    recipient_id: 'user2'
                }]
            });

            await expect(
                messageService.deleteMessage('user3', 'msg_123', false)
            ).rejects.toThrow('You do not have permission to delete this message');
        });
    });

    describe('searchMessages', () => {
        it('should search messages', async () => {
            const userId = 'user1';
            const searchQuery = 'test';

            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: '5' }] })
                .mockResolvedValueOnce({ 
                    rows: [
                        {
                            message_id: 'msg_1',
                            conversation_id: 'conv_1',
                            timestamp: new Date()
                        }
                    ]
                });

            const result = await messageService.searchMessages(
                userId,
                searchQuery
            );

            expect(result.total).toBe(5);
            expect(result.results).toHaveLength(1);
            expect(result.results[0].snippet).toBe('[Encrypted - search on client]');
        });

        it('should search within specific conversation', async () => {
            mockQuery
                .mockResolvedValueOnce({ rows: [{ total: '0' }] })
                .mockResolvedValueOnce({ rows: [] });

            const result = await messageService.searchMessages(
                'user1',
                'test',
                'conv_123'
            );

            expect(result.total).toBe(0);
            expect(result.results).toHaveLength(0);
        });
    });

    describe('updateMessageStatus', () => {
        it('should update message status to delivered', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            await messageService.updateMessageStatus(
                'msg_123',
                MessageStatus.DELIVERED
            );

            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE messages'),
                expect.arrayContaining([MessageStatus.DELIVERED])
            );
        });

        it('should update message status to read', async () => {
            mockQuery.mockResolvedValueOnce({ rows: [] });

            await messageService.updateMessageStatus(
                'msg_123',
                MessageStatus.READ,
                new Date('2024-01-01')
            );

            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('read_at'),
                expect.any(Array)
            );
        });
    });
});