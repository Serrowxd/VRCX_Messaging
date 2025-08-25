import { query, transaction, getRedis } from '../database/connection';
import {
    Message,
    MessageStatus,
    Conversation,
    ConversationWithDetails,
    MessageQueue,
    DeliveryReceipt,
    generateMessageId,
    generateConversationId,
    getConversationId
} from '../models/message';
import { logger } from '../utils/logger';
import { metadataEncryption } from '../utils/metadataEncryption';
import { NotFoundError, ValidationError } from '../middleware/errorHandler';

export class MessageService {
    /**
     * Send a message
     */
    async sendMessage(
        senderId: string,
        recipientId: string,
        encryptedContent: string,
        metadata: any,
        conversationId?: string
    ): Promise<Message> {
        return await transaction(async (client) => {
            // Get or create conversation
            if (!conversationId) {
                conversationId = getConversationId(senderId, recipientId);
            }

            // Check if conversation exists, create if not
            const convResult = await client.query(
                `SELECT * FROM get_or_create_conversation($1, $2, $3)`,
                [conversationId, senderId, recipientId]
            );
            
            const conversation = convResult.rows[0];
            if (!conversation) {
                throw new ValidationError('Failed to create conversation');
            }

            // Generate message ID
            const messageId = generateMessageId();
            const now = new Date();

            // Encrypt sensitive metadata
            const { encrypted: encryptedMetadata } = metadataEncryption.encryptMetadata(metadata);

            // Insert message
            const messageResult = await client.query(
                `INSERT INTO messages (
                    id, conversation_id, sender_id, recipient_id,
                    encrypted_content, metadata, status, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *`,
                [
                    messageId,
                    conversation.id,
                    senderId,
                    recipientId,
                    encryptedContent,
                    encryptedMetadata,
                    MessageStatus.SENT,
                    now
                ]
            );

            const message = messageResult.rows[0];

            // Update conversation's last message
            await client.query(
                `UPDATE conversations 
                SET last_message_id = $1, last_message_at = $2, updated_at = $3
                WHERE id = $4`,
                [messageId, now, now, conversation.id]
            );

            // Add to message queue for delivery
            await client.query(
                `INSERT INTO message_queue (
                    id, message_id, recipient_id, attempts, max_attempts, created_at
                ) VALUES ($1, $2, $3, 0, 5, $4)`,
                [generateMessageId(), messageId, recipientId, now]
            );

            // Log the message event
            logger.info('Message sent', {
                messageId,
                senderId,
                recipientId,
                conversationId: conversation.id
            });

            return message;
        });
    }

    /**
     * Get messages for a conversation with pagination
     */
    async getConversationMessages(
        userId: string,
        conversationId: string,
        limit: number = 20,
        cursor?: string,
        since?: Date,
        until?: Date
    ): Promise<{ messages: Message[], hasMore: boolean, cursor: string | null }> {
        // Build query conditions
        const conditions: string[] = ['m.conversation_id = $1'];
        const params: any[] = [conversationId];
        let paramIndex = 2;

        // Check user is part of conversation
        const convCheck = await query(
            `SELECT * FROM conversations 
            WHERE id = $1 AND (user1_id = $2 OR user2_id = $2)`,
            [conversationId, userId]
        );

        if (convCheck.rows.length === 0) {
            throw new NotFoundError('Conversation not found');
        }

        // Add cursor-based pagination
        if (cursor) {
            conditions.push(`m.created_at < $${paramIndex}`);
            params.push(new Date(cursor));
            paramIndex++;
        }

        // Add time range filters
        if (since) {
            conditions.push(`m.created_at >= $${paramIndex}`);
            params.push(since);
            paramIndex++;
        }

        if (until) {
            conditions.push(`m.created_at <= $${paramIndex}`);
            params.push(until);
            paramIndex++;
        }

        // Don't show deleted messages
        conditions.push(`(m.deleted_at IS NULL OR 
            (m.deleted_for_everyone = false AND m.sender_id != $${paramIndex}))`);
        params.push(userId);
        paramIndex++;

        // Build and execute query
        const whereClause = conditions.join(' AND ');
        params.push(limit + 1); // Get one extra to check if there are more

        const result = await query(
            `SELECT m.*, 
                CASE WHEN m.sender_id = $${paramIndex} THEN true ELSE false END as is_sender
            FROM messages m
            WHERE ${whereClause}
            ORDER BY m.created_at DESC
            LIMIT $${paramIndex - 1}`,
            [...params, userId]
        );

        const messages = result.rows.slice(0, limit);
        const hasMore = result.rows.length > limit;
        const newCursor = messages.length > 0 
            ? messages[messages.length - 1].created_at.toISOString()
            : null;

        return {
            messages,
            hasMore,
            cursor: newCursor
        };
    }

    /**
     * Get all conversations for a user
     */
    async getConversations(
        userId: string,
        limit: number = 20,
        offset: number = 0,
        unreadOnly: boolean = false,
        archived: boolean = false
    ): Promise<{ conversations: ConversationWithDetails[], total: number }> {
        // Build query conditions
        const conditions: string[] = ['(c.user1_id = $1 OR c.user2_id = $1)'];
        const params: any[] = [userId];
        let paramIndex = 2;

        // Add archived filter
        if (archived) {
            conditions.push(`(
                (c.user1_id = $1 AND c.user1_archived = true) OR
                (c.user2_id = $1 AND c.user2_archived = true)
            )`);
        } else {
            conditions.push(`(
                (c.user1_id = $1 AND (c.user1_archived = false OR c.user1_archived IS NULL)) OR
                (c.user2_id = $1 AND (c.user2_archived = false OR c.user2_archived IS NULL))
            )`);
        }

        // Don't show deleted conversations
        conditions.push(`(
            (c.user1_id = $1 AND c.user1_deleted_at IS NULL) OR
            (c.user2_id = $1 AND c.user2_deleted_at IS NULL)
        )`);

        const whereClause = conditions.join(' AND ');

        // Get total count
        const countResult = await query(
            `SELECT COUNT(*) as total FROM conversations c WHERE ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total);

        // Get conversations with details
        params.push(limit, offset);
        const result = await query(
            `SELECT 
                c.*,
                CASE 
                    WHEN c.user1_id = $1 THEN c.user2_id
                    ELSE c.user1_id
                END as participant_id,
                CASE 
                    WHEN c.user1_id = $1 THEN u2.username
                    ELSE u1.username
                END as participant_username,
                CASE 
                    WHEN c.user1_id = $1 THEN c.user1_archived
                    ELSE c.user2_archived
                END as archived,
                CASE 
                    WHEN c.user1_id = $1 THEN c.user1_muted
                    ELSE c.user2_muted
                END as muted,
                m.id as last_message_id,
                m.encrypted_content as last_message_content,
                m.created_at as last_message_timestamp,
                (
                    SELECT COUNT(*)
                    FROM messages msg
                    WHERE msg.conversation_id = c.id
                    AND msg.recipient_id = $1
                    AND msg.read_at IS NULL
                    AND msg.deleted_at IS NULL
                ) as unread_count
            FROM conversations c
            LEFT JOIN users u1 ON c.user1_id = u1.id
            LEFT JOIN users u2 ON c.user2_id = u2.id
            LEFT JOIN messages m ON c.last_message_id = m.id
            WHERE ${whereClause}
            ${unreadOnly ? 'AND unread_count > 0' : ''}
            ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
            LIMIT $${paramIndex}
            OFFSET $${paramIndex + 1}`,
            params
        );

        // Format conversations
        const conversations: ConversationWithDetails[] = result.rows.map(row => ({
            id: row.id,
            user1_id: row.user1_id,
            user2_id: row.user2_id,
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_message_id: row.last_message_id,
            last_message_at: row.last_message_at,
            participant_id: row.participant_id,
            participant_username: row.participant_username,
            last_message: row.last_message_id ? {
                id: row.last_message_id,
                preview: '[Encrypted Message]', // Will be decrypted on client
                timestamp: row.last_message_timestamp
            } : undefined,
            unread_count: parseInt(row.unread_count) || 0,
            archived: row.archived || false,
            muted: row.muted || false
        }));

        return { conversations, total };
    }

    /**
     * Mark messages as read
     */
    async markMessagesAsRead(
        userId: string,
        messageIds: string[],
        readAt: Date = new Date()
    ): Promise<number> {
        if (messageIds.length === 0) {
            return 0;
        }

        // Create placeholders for the query
        const placeholders = messageIds.map((_, i) => `$${i + 3}`).join(', ');
        
        const result = await query(
            `UPDATE messages 
            SET read_at = $1, status = $2
            WHERE id IN (${placeholders})
            AND recipient_id = $${messageIds.length + 3}
            AND read_at IS NULL
            RETURNING id`,
            [readAt, MessageStatus.READ, ...messageIds, userId]
        );

        const updatedCount = result.rows.length;

        // Send read receipts via WebSocket (handled by WebSocket service)
        if (updatedCount > 0) {
            const redis = getRedis();
            await redis.publish('message:read', JSON.stringify({
                userId,
                messageIds: result.rows.map(r => r.id),
                readAt
            }));
        }

        logger.info('Messages marked as read', {
            userId,
            count: updatedCount,
            messageIds: result.rows.map(r => r.id)
        });

        return updatedCount;
    }

    /**
     * Delete a message
     */
    async deleteMessage(
        userId: string,
        messageId: string,
        deleteForEveryone: boolean = false
    ): Promise<void> {
        const result = await query(
            `SELECT * FROM messages WHERE id = $1`,
            [messageId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Message not found');
        }

        const message = result.rows[0];

        // Check if user can delete the message
        if (message.sender_id !== userId && message.recipient_id !== userId) {
            throw new ValidationError('You do not have permission to delete this message');
        }

        // Only sender can delete for everyone
        if (deleteForEveryone && message.sender_id !== userId) {
            throw new ValidationError('Only the sender can delete a message for everyone');
        }

        const now = new Date();

        if (deleteForEveryone) {
            // Soft delete for everyone
            await query(
                `UPDATE messages 
                SET deleted_at = $1, deleted_for_everyone = true
                WHERE id = $2`,
                [now, messageId]
            );

            // Notify recipient via WebSocket
            const redis = getRedis();
            await redis.publish('message:deleted', JSON.stringify({
                messageId,
                deletedBy: userId,
                deleteForEveryone: true,
                timestamp: now
            }));
        } else {
            // Mark as deleted only for this user
            // This is handled client-side by adding to a local deleted messages list
            // Server keeps the message for the other party
            await query(
                `INSERT INTO deleted_messages (user_id, message_id, deleted_at)
                VALUES ($1, $2, $3)
                ON CONFLICT (user_id, message_id) DO NOTHING`,
                [userId, messageId, now]
            );
        }

        logger.info('Message deleted', {
            messageId,
            userId,
            deleteForEveryone
        });
    }

    /**
     * Search messages
     */
    async searchMessages(
        userId: string,
        searchQuery: string,
        conversationId?: string,
        limit: number = 20,
        offset: number = 0
    ): Promise<{ results: any[], total: number }> {
        // Note: Since messages are encrypted, server-side search is limited
        // This would typically search metadata or require client-side decryption
        
        const conditions: string[] = [
            '(m.sender_id = $1 OR m.recipient_id = $1)',
            'm.deleted_at IS NULL'
        ];
        const params: any[] = [userId];
        let paramIndex = 2;

        if (conversationId) {
            conditions.push(`m.conversation_id = $${paramIndex}`);
            params.push(conversationId);
            paramIndex++;
        }

        const whereClause = conditions.join(' AND ');

        // Get total count
        const countResult = await query(
            `SELECT COUNT(*) as total 
            FROM messages m
            WHERE ${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].total);

        // Get search results (limited since content is encrypted)
        params.push(limit, offset);
        const result = await query(
            `SELECT 
                m.id as message_id,
                m.conversation_id,
                m.created_at as timestamp,
                c.user1_id,
                c.user2_id
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE ${whereClause}
            ORDER BY m.created_at DESC
            LIMIT $${paramIndex}
            OFFSET $${paramIndex + 1}`,
            params
        );

        // Format results
        const results = result.rows.map(row => ({
            messageId: row.message_id,
            conversationId: row.conversation_id,
            snippet: '[Encrypted - search on client]',
            timestamp: row.timestamp
        }));

        return { results, total };
    }

    /**
     * Get delivery status for a message
     */
    async getMessageStatus(messageId: string): Promise<MessageStatus> {
        const result = await query(
            `SELECT status FROM messages WHERE id = $1`,
            [messageId]
        );

        if (result.rows.length === 0) {
            throw new NotFoundError('Message not found');
        }

        return result.rows[0].status;
    }

    /**
     * Update message delivery status
     */
    async updateMessageStatus(
        messageId: string,
        status: MessageStatus,
        timestamp: Date = new Date()
    ): Promise<void> {
        const fieldMap: Record<MessageStatus, string> = {
            [MessageStatus.DELIVERED]: 'delivered_at',
            [MessageStatus.READ]: 'read_at',
            [MessageStatus.FAILED]: 'updated_at',
            [MessageStatus.SENT]: 'updated_at',
            [MessageStatus.PENDING]: 'updated_at'
        };

        const timeField = fieldMap[status];
        
        await query(
            `UPDATE messages 
            SET status = $1, ${timeField} = $2
            WHERE id = $3`,
            [status, timestamp, messageId]
        );

        logger.debug('Message status updated', {
            messageId,
            status,
            timestamp
        });
    }
}