import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import { getRedis } from '../database/connection';
import { MessageService } from './messageService';
import { MessageStatus } from '../models/message';
import { logger } from '../utils/logger';
import { query } from '../database/connection';
import { WebSocketManager } from '../websocket/manager';

interface MessageJobData {
    messageId: string;
    recipientId: string;
    senderId: string;
    conversationId: string;
    encryptedContent: string;
    metadata: any;
    attempt?: number;
}

interface DeliveryJobData {
    messageId: string;
    recipientId: string;
    status: MessageStatus;
    timestamp: Date;
}

export class MessageQueueService {
    private messageQueue: Queue;
    private deliveryQueue: Queue;
    private messageWorker: Worker;
    private deliveryWorker: Worker;
    private queueEvents: QueueEvents;
    private messageService: MessageService;
    private wsManager?: WebSocketManager;

    constructor() {
        const redis = getRedis();
        
        // Initialize queues
        this.messageQueue = new Queue('messages', {
            connection: redis,
            defaultJobOptions: {
                attempts: 5,
                backoff: {
                    type: 'exponential',
                    delay: 2000 // Start with 2 second delay
                },
                removeOnComplete: {
                    age: 3600, // Keep completed jobs for 1 hour
                    count: 100 // Keep last 100 completed jobs
                },
                removeOnFail: {
                    age: 86400 // Keep failed jobs for 24 hours
                }
            }
        });

        this.deliveryQueue = new Queue('delivery', {
            connection: redis,
            defaultJobOptions: {
                attempts: 3,
                backoff: {
                    type: 'fixed',
                    delay: 5000
                },
                removeOnComplete: true,
                removeOnFail: {
                    age: 3600
                }
            }
        });

        // Initialize queue events for monitoring
        this.queueEvents = new QueueEvents('messages', {
            connection: redis
        });

        // Initialize workers
        this.messageWorker = new Worker(
            'messages',
            async (job: Job<MessageJobData>) => await this.processMessage(job),
            {
                connection: redis,
                concurrency: 10,
                limiter: {
                    max: 100,
                    duration: 1000 // Max 100 jobs per second
                }
            }
        );

        this.deliveryWorker = new Worker(
            'delivery',
            async (job: Job<DeliveryJobData>) => await this.processDelivery(job),
            {
                connection: redis,
                concurrency: 20
            }
        );

        this.messageService = new MessageService();
        
        // Set up event listeners
        this.setupEventListeners();
    }

    /**
     * Set WebSocket manager for real-time delivery
     */
    setWebSocketManager(wsManager: WebSocketManager) {
        this.wsManager = wsManager;
    }

    /**
     * Add a message to the queue for processing
     */
    async queueMessage(data: MessageJobData): Promise<string> {
        const job = await this.messageQueue.add('send', data, {
            priority: data.metadata?.priority || 0,
            delay: data.metadata?.scheduledAt 
                ? new Date(data.metadata.scheduledAt).getTime() - Date.now()
                : 0
        });

        logger.debug('Message queued', {
            jobId: job.id,
            messageId: data.messageId,
            recipientId: data.recipientId
        });

        return job.id as string;
    }

    /**
     * Queue a message for offline delivery
     */
    async queueOfflineMessage(
        recipientId: string,
        messageId: string
    ): Promise<void> {
        // Store in database for persistent offline queue
        await query(
            `INSERT INTO offline_messages (
                recipient_id, message_id, queued_at
            ) VALUES ($1, $2, $3)
            ON CONFLICT (recipient_id, message_id) DO NOTHING`,
            [recipientId, messageId, new Date()]
        );

        logger.info('Message queued for offline delivery', {
            recipientId,
            messageId
        });
    }

    /**
     * Deliver queued offline messages when user comes online
     */
    async deliverOfflineMessages(userId: string): Promise<void> {
        const result = await query(
            `SELECT m.*, om.queued_at
            FROM offline_messages om
            JOIN messages m ON om.message_id = m.id
            WHERE om.recipient_id = $1
            ORDER BY om.queued_at ASC
            LIMIT 100`, // Deliver in batches
            [userId]
        );

        if (result.rows.length === 0) {
            return;
        }

        const messageIds = result.rows.map(row => row.id);

        // Queue all messages for delivery
        for (const message of result.rows) {
            await this.deliveryQueue.add('deliver', {
                messageId: message.id,
                recipientId: userId,
                status: MessageStatus.DELIVERED,
                timestamp: new Date()
            });
        }

        // Remove from offline queue
        const placeholders = messageIds.map((_, i) => `$${i + 2}`).join(', ');
        await query(
            `DELETE FROM offline_messages 
            WHERE recipient_id = $1 AND message_id IN (${placeholders})`,
            [userId, ...messageIds]
        );

        logger.info('Offline messages queued for delivery', {
            userId,
            count: messageIds.length
        });
    }

    /**
     * Process a message job
     */
    private async processMessage(job: Job<MessageJobData>): Promise<void> {
        const { messageId, recipientId, senderId, conversationId } = job.data;

        try {
            // Check if recipient is online
            const isOnline = this.wsManager?.isUserOnline(recipientId) || false;

            if (isOnline) {
                // Attempt real-time delivery via WebSocket
                const delivered = await this.wsManager!.sendToUser(recipientId, 'message:received', {
                    messageId,
                    senderId,
                    conversationId,
                    encryptedContent: job.data.encryptedContent,
                    metadata: job.data.metadata,
                    timestamp: new Date()
                });

                if (delivered) {
                    // Update message status to delivered
                    await this.messageService.updateMessageStatus(
                        messageId,
                        MessageStatus.DELIVERED,
                        new Date()
                    );

                    logger.info('Message delivered in real-time', {
                        messageId,
                        recipientId
                    });
                } else {
                    // Queue for offline delivery
                    await this.queueOfflineMessage(recipientId, messageId);
                }
            } else {
                // Queue for offline delivery
                await this.queueOfflineMessage(recipientId, messageId);
            }

            // Send delivery confirmation to sender
            if (this.wsManager?.isUserOnline(senderId)) {
                await this.wsManager.sendToUser(senderId, 'message:sent', {
                    messageId,
                    conversationId,
                    status: isOnline ? MessageStatus.DELIVERED : MessageStatus.SENT,
                    timestamp: new Date()
                });
            }

        } catch (error) {
            logger.error('Failed to process message', {
                error,
                jobId: job.id,
                messageId,
                attempt: job.attemptsMade
            });

            // If this is the last attempt, mark message as failed
            if (job.attemptsMade >= (job.opts.attempts || 5) - 1) {
                await this.messageService.updateMessageStatus(
                    messageId,
                    MessageStatus.FAILED,
                    new Date()
                );

                // Store error for debugging
                await query(
                    `UPDATE message_queue 
                    SET error = $1, updated_at = $2
                    WHERE message_id = $3`,
                    [error instanceof Error ? error.message : 'Unknown error', new Date(), messageId]
                );
            }

            throw error; // Re-throw to trigger retry
        }
    }

    /**
     * Process a delivery confirmation job
     */
    private async processDelivery(job: Job<DeliveryJobData>): Promise<void> {
        const { messageId, recipientId, status, timestamp } = job.data;

        try {
            // Update message status
            await this.messageService.updateMessageStatus(messageId, status, timestamp);

            // Get message details for notification
            const result = await query(
                `SELECT sender_id, conversation_id 
                FROM messages 
                WHERE id = $1`,
                [messageId]
            );

            if (result.rows.length > 0) {
                const { sender_id, conversation_id } = result.rows[0];

                // Notify sender of delivery status
                if (this.wsManager?.isUserOnline(sender_id)) {
                    await this.wsManager.sendToUser(sender_id, 'message:status', {
                        messageId,
                        status,
                        timestamp
                    });
                }

                // For read receipts, notify via conversation
                if (status === MessageStatus.READ) {
                    await this.wsManager?.sendToConversation(conversation_id, 'message:read', {
                        messageId,
                        readBy: recipientId,
                        timestamp
                    });
                }
            }

            logger.debug('Delivery confirmation processed', {
                messageId,
                status,
                recipientId
            });

        } catch (error) {
            logger.error('Failed to process delivery confirmation', {
                error,
                jobId: job.id,
                messageId
            });
            throw error;
        }
    }

    /**
     * Set up event listeners for queue monitoring
     */
    private setupEventListeners() {
        // Message queue events
        this.messageWorker.on('completed', (job) => {
            logger.debug('Message job completed', {
                jobId: job.id,
                messageId: job.data.messageId
            });
        });

        this.messageWorker.on('failed', (job, error) => {
            logger.error('Message job failed', {
                jobId: job?.id,
                messageId: job?.data.messageId,
                error: error.message,
                attempt: job?.attemptsMade
            });
        });

        // Delivery queue events
        this.deliveryWorker.on('completed', (job) => {
            logger.debug('Delivery job completed', {
                jobId: job.id,
                messageId: job.data.messageId
            });
        });

        this.deliveryWorker.on('failed', (job, error) => {
            logger.error('Delivery job failed', {
                jobId: job?.id,
                messageId: job?.data.messageId,
                error: error.message
            });
        });

        // Queue-level events
        this.queueEvents.on('waiting', ({ jobId }) => {
            logger.debug('Job waiting', { jobId });
        });

        this.queueEvents.on('stalled', ({ jobId }) => {
            logger.warn('Job stalled', { jobId });
        });
    }

    /**
     * Get queue statistics
     */
    async getQueueStats() {
        const [messageStats, deliveryStats] = await Promise.all([
            this.messageQueue.getJobCounts(),
            this.deliveryQueue.getJobCounts()
        ]);

        return {
            messages: messageStats,
            delivery: deliveryStats
        };
    }

    /**
     * Retry failed messages
     */
    async retryFailedMessages(userId?: string): Promise<number> {
        const conditions = ['status = $1'];
        const params: any[] = [MessageStatus.FAILED];

        if (userId) {
            conditions.push('(sender_id = $2 OR recipient_id = $2)');
            params.push(userId);
        }

        const result = await query(
            `SELECT * FROM messages 
            WHERE ${conditions.join(' AND ')}
            LIMIT 100`,
            params
        );

        let retryCount = 0;
        for (const message of result.rows) {
            await this.queueMessage({
                messageId: message.id,
                recipientId: message.recipient_id,
                senderId: message.sender_id,
                conversationId: message.conversation_id,
                encryptedContent: message.encrypted_content,
                metadata: message.metadata
            });
            retryCount++;
        }

        logger.info('Retrying failed messages', {
            count: retryCount,
            userId
        });

        return retryCount;
    }

    /**
     * Clean up old completed jobs
     */
    async cleanupOldJobs(olderThanDays: number = 7): Promise<void> {
        const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);

        await Promise.all([
            this.messageQueue.clean(cutoffTime, 1000, 'completed'),
            this.messageQueue.clean(cutoffTime, 1000, 'failed'),
            this.deliveryQueue.clean(cutoffTime, 1000, 'completed'),
            this.deliveryQueue.clean(cutoffTime, 1000, 'failed')
        ]);

        logger.info('Queue cleanup completed', {
            olderThanDays
        });
    }

    /**
     * Gracefully shutdown queues
     */
    async shutdown(): Promise<void> {
        logger.info('Shutting down message queues...');

        // Close workers
        await this.messageWorker.close();
        await this.deliveryWorker.close();

        // Close queue events
        await this.queueEvents.close();

        // Close queues
        await this.messageQueue.close();
        await this.deliveryQueue.close();

        logger.info('Message queues shut down successfully');
    }
}

// Export singleton instance
export const messageQueueService = new MessageQueueService();