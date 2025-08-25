import { MessageQueueService } from '../../src/services/messageQueue';
import { MessageStatus } from '../../src/models/message';
import * as dbConnection from '../../src/database/connection';
import { Queue, Worker, Job } from 'bullmq';

// Mock dependencies
jest.mock('bullmq');
jest.mock('../../src/database/connection');
jest.mock('../../src/services/messageService');
jest.mock('../../src/utils/logger');

describe('MessageQueueService', () => {
    let messageQueueService: MessageQueueService;
    let mockRedis: any;
    let mockQueue: any;
    let mockWorker: any;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();

        // Setup Redis mock
        mockRedis = {
            publish: jest.fn().mockResolvedValue('OK')
        };
        (dbConnection.getRedis as jest.Mock) = jest.fn().mockReturnValue(mockRedis);

        // Setup Queue mock
        mockQueue = {
            add: jest.fn().mockResolvedValue({ id: 'job_123' }),
            getJobCounts: jest.fn().mockResolvedValue({
                waiting: 5,
                active: 2,
                completed: 100,
                failed: 3
            }),
            clean: jest.fn().mockResolvedValue([]),
            close: jest.fn().mockResolvedValue(undefined)
        };
        (Queue as jest.MockedClass<typeof Queue>).mockImplementation(() => mockQueue as any);

        // Setup Worker mock
        mockWorker = {
            on: jest.fn(),
            close: jest.fn().mockResolvedValue(undefined)
        };
        (Worker as jest.MockedClass<typeof Worker>).mockImplementation(() => mockWorker as any);

        // Create service instance
        messageQueueService = new MessageQueueService();
    });

    describe('queueMessage', () => {
        it('should queue a message for processing', async () => {
            const messageData = {
                messageId: 'msg_123',
                recipientId: 'user2',
                senderId: 'user1',
                conversationId: 'conv_123',
                encryptedContent: 'encrypted',
                metadata: { version: 1 }
            };

            const jobId = await messageQueueService.queueMessage(messageData);

            expect(jobId).toBe('job_123');
            expect(mockQueue.add).toHaveBeenCalledWith(
                'send',
                messageData,
                expect.objectContaining({
                    priority: 0,
                    delay: 0
                })
            );
        });

        it('should queue message with priority', async () => {
            const messageData = {
                messageId: 'msg_123',
                recipientId: 'user2',
                senderId: 'user1',
                conversationId: 'conv_123',
                encryptedContent: 'encrypted',
                metadata: { priority: 5 }
            };

            await messageQueueService.queueMessage(messageData);

            expect(mockQueue.add).toHaveBeenCalledWith(
                'send',
                messageData,
                expect.objectContaining({
                    priority: 5
                })
            );
        });

        it('should queue scheduled message', async () => {
            const futureTime = new Date(Date.now() + 60000); // 1 minute from now
            const messageData = {
                messageId: 'msg_123',
                recipientId: 'user2',
                senderId: 'user1',
                conversationId: 'conv_123',
                encryptedContent: 'encrypted',
                metadata: { scheduledAt: futureTime.toISOString() }
            };

            await messageQueueService.queueMessage(messageData);

            expect(mockQueue.add).toHaveBeenCalledWith(
                'send',
                messageData,
                expect.objectContaining({
                    delay: expect.any(Number)
                })
            );
        });
    });

    describe('queueOfflineMessage', () => {
        it('should queue message for offline delivery', async () => {
            const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
            (dbConnection.query as jest.Mock) = mockQuery;

            await messageQueueService.queueOfflineMessage('user2', 'msg_123');

            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO offline_messages'),
                expect.arrayContaining(['user2', 'msg_123'])
            );
        });
    });

    describe('deliverOfflineMessages', () => {
        it('should deliver queued offline messages', async () => {
            const offlineMessages = [
                {
                    id: 'msg_1',
                    recipient_id: 'user1',
                    queued_at: new Date()
                },
                {
                    id: 'msg_2',
                    recipient_id: 'user1',
                    queued_at: new Date()
                }
            ];

            const mockQuery = jest.fn()
                .mockResolvedValueOnce({ rows: offlineMessages })
                .mockResolvedValueOnce({ rows: [] });
            (dbConnection.query as jest.Mock) = mockQuery;

            await messageQueueService.deliverOfflineMessages('user1');

            expect(mockQueue.add).toHaveBeenCalledTimes(2);
            expect(mockQuery).toHaveBeenCalledTimes(2);
        });

        it('should handle no offline messages', async () => {
            const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
            (dbConnection.query as jest.Mock) = mockQuery;

            await messageQueueService.deliverOfflineMessages('user1');

            expect(mockQueue.add).not.toHaveBeenCalled();
            expect(mockQuery).toHaveBeenCalledTimes(1);
        });
    });

    describe('getQueueStats', () => {
        it('should return queue statistics', async () => {
            const stats = await messageQueueService.getQueueStats();

            expect(stats).toEqual({
                messages: {
                    waiting: 5,
                    active: 2,
                    completed: 100,
                    failed: 3
                },
                delivery: {
                    waiting: 5,
                    active: 2,
                    completed: 100,
                    failed: 3
                }
            });

            expect(mockQueue.getJobCounts).toHaveBeenCalledTimes(2);
        });
    });

    describe('retryFailedMessages', () => {
        it('should retry failed messages', async () => {
            const failedMessages = [
                {
                    id: 'msg_1',
                    recipient_id: 'user2',
                    sender_id: 'user1',
                    conversation_id: 'conv_1',
                    encrypted_content: 'content1',
                    metadata: {}
                },
                {
                    id: 'msg_2',
                    recipient_id: 'user3',
                    sender_id: 'user1',
                    conversation_id: 'conv_2',
                    encrypted_content: 'content2',
                    metadata: {}
                }
            ];

            const mockQuery = jest.fn().mockResolvedValue({ rows: failedMessages });
            (dbConnection.query as jest.Mock) = mockQuery;

            const count = await messageQueueService.retryFailedMessages();

            expect(count).toBe(2);
            expect(mockQueue.add).toHaveBeenCalledTimes(2);
        });

        it('should retry failed messages for specific user', async () => {
            const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
            (dbConnection.query as jest.Mock) = mockQuery;

            const count = await messageQueueService.retryFailedMessages('user1');

            expect(count).toBe(0);
            expect(mockQuery).toHaveBeenCalledWith(
                expect.stringContaining('sender_id = $2 OR recipient_id = $2'),
                expect.arrayContaining(['user1'])
            );
        });
    });

    describe('cleanupOldJobs', () => {
        it('should cleanup old completed jobs', async () => {
            await messageQueueService.cleanupOldJobs(7);

            expect(mockQueue.clean).toHaveBeenCalledTimes(4); // 2 queues × 2 statuses
            expect(mockQueue.clean).toHaveBeenCalledWith(
                expect.any(Number),
                1000,
                'completed'
            );
            expect(mockQueue.clean).toHaveBeenCalledWith(
                expect.any(Number),
                1000,
                'failed'
            );
        });
    });

    describe('shutdown', () => {
        it('should gracefully shutdown queues', async () => {
            await messageQueueService.shutdown();

            expect(mockWorker.close).toHaveBeenCalledTimes(2);
            expect(mockQueue.close).toHaveBeenCalledTimes(2);
        });
    });

    describe('setWebSocketManager', () => {
        it('should set WebSocket manager', () => {
            const mockWsManager = { isUserOnline: jest.fn() };
            
            expect(() => {
                messageQueueService.setWebSocketManager(mockWsManager as any);
            }).not.toThrow();
        });
    });
});