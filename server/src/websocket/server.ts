import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { verifyToken } from '../middleware/auth';
import { query, getRedis } from '../database/connection';
import logger, { logWebSocket } from '../utils/logger';
import { RateLimiter } from '../middleware/rateLimiter';

interface AuthenticatedSocket extends Socket {
    userId?: string;
    deviceId?: number;
    sessionId?: string;
}

interface WebSocketMessage {
    type: string;
    payload: any;
    timestamp: number;
}

export class WebSocketServer {
    private io: SocketIOServer;
    private redis = getRedis();
    private connections = new Map<string, Set<string>>(); // userId -> Set of socketIds
    private socketToUser = new Map<string, string>(); // socketId -> userId
    private rateLimiter = new RateLimiter({ max: 100, window: 60000 });
    private heartbeatInterval: NodeJS.Timer | null = null;

    constructor(httpServer: HTTPServer) {
        this.io = new SocketIOServer(httpServer, {
            cors: {
                origin: process.env.WS_CORS_ORIGIN || 'http://localhost:8080',
                credentials: true
            },
            pingTimeout: parseInt(process.env.WS_PING_TIMEOUT || '60000'),
            pingInterval: parseInt(process.env.WS_PING_INTERVAL || '25000'),
            transports: ['websocket', 'polling'],
            maxHttpBufferSize: 1e6 // 1MB
        });

        this.setupMiddleware();
        this.setupEventHandlers();
        this.startHeartbeat();
    }

    /**
     * Setup authentication middleware
     */
    private setupMiddleware(): void {
        this.io.use(async (socket: AuthenticatedSocket, next) => {
            try {
                // Get token from handshake auth or query
                const token = socket.handshake.auth?.token || socket.handshake.query?.token;
                
                if (!token) {
                    return next(new Error('Authentication required'));
                }

                // Verify JWT token
                const payload = verifyToken(token as string, 'access');
                
                // Check if session is valid
                const result = await query(
                    `SELECT * FROM sessions 
                     WHERE id = $1 
                     AND user_id = $2 
                     AND expires_at > NOW()
                     AND (revoked_at IS NULL OR revoked_at > NOW())`,
                    [payload.sessionId, payload.userId]
                );
                
                if (result.rows.length === 0) {
                    return next(new Error('Session expired or revoked'));
                }

                // Attach user info to socket
                socket.userId = payload.userId;
                socket.deviceId = payload.deviceId;
                socket.sessionId = payload.sessionId;

                // Update session activity
                await query(
                    `UPDATE sessions SET last_activity = NOW() WHERE id = $1`,
                    [payload.sessionId]
                );

                logWebSocket('Authentication successful', socket.id, {
                    userId: payload.userId,
                    deviceId: payload.deviceId
                });

                next();
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Authentication failed';
                logWebSocket('Authentication failed', socket.id, { error: message });
                next(new Error(message));
            }
        });

        // Rate limiting middleware
        this.io.use(async (socket: AuthenticatedSocket, next) => {
            const key = `ws:${socket.userId || socket.handshake.address}`;
            const allowed = await this.rateLimiter.userActionLimit(key, 'connect', 10, 60000);
            
            if (!allowed) {
                return next(new Error('Rate limit exceeded'));
            }
            
            next();
        });
    }

    /**
     * Setup socket event handlers
     */
    private setupEventHandlers(): void {
        this.io.on('connection', async (socket: AuthenticatedSocket) => {
            const userId = socket.userId!;
            const socketId = socket.id;

            logWebSocket('Client connected', socketId, {
                userId,
                deviceId: socket.deviceId,
                sessionId: socket.sessionId
            });

            // Track connection
            await this.addConnection(userId, socketId);

            // Join user room for targeted messaging
            socket.join(`user:${userId}`);
            socket.join(`device:${userId}:${socket.deviceId}`);

            // Notify user's other devices
            socket.to(`user:${userId}`).emit('device:connected', {
                deviceId: socket.deviceId,
                timestamp: Date.now()
            });

            // Send queued messages
            await this.sendQueuedMessages(socket);

            // Handle events
            this.setupSocketEvents(socket);

            // Handle disconnect
            socket.on('disconnect', async (reason) => {
                logWebSocket('Client disconnected', socketId, { reason, userId });
                
                await this.removeConnection(userId, socketId);
                
                // Notify other devices
                socket.to(`user:${userId}`).emit('device:disconnected', {
                    deviceId: socket.deviceId,
                    timestamp: Date.now()
                });

                // Update session
                await query(
                    `UPDATE sessions 
                     SET last_activity = NOW(), 
                         websocket_connected = false 
                     WHERE id = $1`,
                    [socket.sessionId]
                );
            });

            // Handle errors
            socket.on('error', (error) => {
                logWebSocket('Socket error', socketId, { error: error.message, userId });
            });
        });
    }

    /**
     * Setup individual socket event handlers
     */
    private setupSocketEvents(socket: AuthenticatedSocket): void {
        const userId = socket.userId!;
        const socketId = socket.id;

        // Message events
        socket.on('message:send', async (data: any, callback) => {
            try {
                // Rate limit check
                const allowed = await this.rateLimiter.userActionLimit(
                    userId,
                    'message',
                    30,
                    60000
                );
                
                if (!allowed) {
                    return callback({ error: 'Rate limit exceeded' });
                }

                // Validate message format
                if (!data.recipientId || !data.encryptedContent) {
                    return callback({ error: 'Invalid message format' });
                }

                // Store message (handled by message API)
                const messageId = await this.storeMessage(userId, data);

                // Send to recipient if online
                await this.deliverMessage(data.recipientId, {
                    type: 'message:received',
                    payload: {
                        messageId,
                        senderId: userId,
                        encryptedContent: data.encryptedContent,
                        metadata: data.metadata,
                        timestamp: Date.now()
                    },
                    timestamp: Date.now()
                });

                callback({ success: true, messageId });
                
                logWebSocket('Message sent', socketId, {
                    messageId,
                    recipientId: data.recipientId
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Failed to send message';
                callback({ error: message });
                logWebSocket('Message send failed', socketId, { error: message });
            }
        });

        // Typing indicators
        socket.on('typing:start', async (data: { conversationId: string }) => {
            const recipientId = await this.getConversationRecipient(userId, data.conversationId);
            
            if (recipientId) {
                this.io.to(`user:${recipientId}`).emit('typing:started', {
                    conversationId: data.conversationId,
                    userId,
                    timestamp: Date.now()
                });
            }
        });

        socket.on('typing:stop', async (data: { conversationId: string }) => {
            const recipientId = await this.getConversationRecipient(userId, data.conversationId);
            
            if (recipientId) {
                this.io.to(`user:${recipientId}`).emit('typing:stopped', {
                    conversationId: data.conversationId,
                    userId,
                    timestamp: Date.now()
                });
            }
        });

        // Read receipts
        socket.on('message:read', async (data: { messageIds: string[] }, callback) => {
            try {
                // Update read status in database
                await query(
                    `UPDATE messages 
                     SET read_at = NOW() 
                     WHERE id = ANY($1) 
                     AND recipient_id = $2`,
                    [data.messageIds, userId]
                );

                // Get sender IDs
                const result = await query(
                    `SELECT DISTINCT sender_id 
                     FROM messages 
                     WHERE id = ANY($1)`,
                    [data.messageIds]
                );

                // Notify senders
                for (const row of result.rows) {
                    this.io.to(`user:${row.sender_id}`).emit('message:delivered', {
                        messageIds: data.messageIds,
                        status: 'read',
                        timestamp: Date.now()
                    });
                }

                callback({ success: true });
            } catch (error) {
                callback({ error: 'Failed to update read status' });
            }
        });

        // Presence updates
        socket.on('presence:update', async (data: { status: string }) => {
            // Update user presence
            await this.redis.setEx(
                `presence:${userId}`,
                300, // 5 minutes TTL
                JSON.stringify({
                    status: data.status,
                    lastSeen: Date.now(),
                    deviceId: socket.deviceId
                })
            );

            // Broadcast to user's contacts
            const contacts = await this.getUserContacts(userId);
            
            for (const contactId of contacts) {
                this.io.to(`user:${contactId}`).emit('presence:updated', {
                    userId,
                    status: data.status,
                    timestamp: Date.now()
                });
            }
        });

        // Conversation events
        socket.on('conversation:join', (data: { conversationId: string }) => {
            socket.join(`conversation:${data.conversationId}`);
            logWebSocket('Joined conversation', socketId, { conversationId: data.conversationId });
        });

        socket.on('conversation:leave', (data: { conversationId: string }) => {
            socket.leave(`conversation:${data.conversationId}`);
            logWebSocket('Left conversation', socketId, { conversationId: data.conversationId });
        });

        // Custom ping for connection health
        socket.on('ping', (callback) => {
            callback({ pong: Date.now() });
        });
    }

    /**
     * Add connection tracking
     */
    private async addConnection(userId: string, socketId: string): Promise<void> {
        if (!this.connections.has(userId)) {
            this.connections.set(userId, new Set());
        }
        this.connections.get(userId)!.add(socketId);
        this.socketToUser.set(socketId, userId);

        // Update Redis for distributed systems
        await this.redis.sAdd(`ws:connections:${userId}`, socketId);
        await this.redis.expire(`ws:connections:${userId}`, 3600); // 1 hour TTL

        // Update session
        await query(
            `UPDATE sessions 
             SET websocket_connected = true, 
                 last_activity = NOW() 
             WHERE user_id = $1`,
            [userId]
        );
    }

    /**
     * Remove connection tracking
     */
    private async removeConnection(userId: string, socketId: string): Promise<void> {
        const userSockets = this.connections.get(userId);
        
        if (userSockets) {
            userSockets.delete(socketId);
            
            if (userSockets.size === 0) {
                this.connections.delete(userId);
            }
        }
        
        this.socketToUser.delete(socketId);

        // Update Redis
        await this.redis.sRem(`ws:connections:${userId}`, socketId);
    }

    /**
     * Check if user is online
     */
    public async isUserOnline(userId: string): Promise<boolean> {
        // Check local connections first
        if (this.connections.has(userId)) {
            return true;
        }

        // Check Redis for distributed systems
        const connections = await this.redis.sCard(`ws:connections:${userId}`);
        return connections > 0;
    }

    /**
     * Send queued messages
     */
    private async sendQueuedMessages(socket: AuthenticatedSocket): Promise<void> {
        const userId = socket.userId!;
        
        try {
            // Get undelivered messages
            const result = await query(
                `SELECT * FROM messages 
                 WHERE recipient_id = $1 
                 AND delivered_at IS NULL 
                 AND created_at > NOW() - INTERVAL '7 days'
                 ORDER BY created_at ASC 
                 LIMIT 100`,
                [userId]
            );

            // Send each message
            for (const message of result.rows) {
                socket.emit('message:received', {
                    messageId: message.id,
                    senderId: message.sender_id,
                    encryptedContent: message.encrypted_content,
                    metadata: message.metadata,
                    timestamp: message.created_at
                });

                // Mark as delivered
                await query(
                    `UPDATE messages SET delivered_at = NOW() WHERE id = $1`,
                    [message.id]
                );
            }

            if (result.rows.length > 0) {
                logWebSocket('Queued messages sent', socket.id, {
                    count: result.rows.length,
                    userId
                });
            }
        } catch (error) {
            logger.error('Failed to send queued messages', { error, userId });
        }
    }

    /**
     * Deliver message to recipient
     */
    private async deliverMessage(recipientId: string, message: WebSocketMessage): Promise<void> {
        // Send to all recipient's devices
        this.io.to(`user:${recipientId}`).emit(message.type, message.payload);

        // If recipient is offline, queue for later
        const isOnline = await this.isUserOnline(recipientId);
        
        if (!isOnline) {
            // Message already stored in database, will be delivered on next connection
            logWebSocket('Message queued for offline user', 'system', {
                recipientId,
                messageId: message.payload.messageId
            });
        }
    }

    /**
     * Store message (placeholder - actual implementation in message service)
     */
    private async storeMessage(senderId: string, data: any): Promise<string> {
        // This would be handled by the message service
        // Returning a placeholder ID for now
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        // In production, this would call the message service
        await query(
            `INSERT INTO messages (id, sender_id, recipient_id, encrypted_content, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, NOW())`,
            [messageId, senderId, data.recipientId, data.encryptedContent, JSON.stringify(data.metadata)]
        );
        
        return messageId;
    }

    /**
     * Get conversation recipient
     */
    private async getConversationRecipient(userId: string, conversationId: string): Promise<string | null> {
        try {
            const result = await query(
                `SELECT user1_id, user2_id 
                 FROM conversations 
                 WHERE id = $1`,
                [conversationId]
            );

            if (result.rows.length === 0) {
                return null;
            }

            const { user1_id, user2_id } = result.rows[0];
            return user1_id === userId ? user2_id : user1_id;
        } catch {
            return null;
        }
    }

    /**
     * Get user contacts
     */
    private async getUserContacts(userId: string): Promise<string[]> {
        try {
            const result = await query(
                `SELECT DISTINCT 
                    CASE 
                        WHEN user1_id = $1 THEN user2_id 
                        ELSE user1_id 
                    END as contact_id
                 FROM conversations 
                 WHERE user1_id = $1 OR user2_id = $1`,
                [userId]
            );

            return result.rows.map(row => row.contact_id);
        } catch {
            return [];
        }
    }

    /**
     * Broadcast message to multiple users
     */
    public broadcast(userIds: string[], event: string, data: any): void {
        for (const userId of userIds) {
            this.io.to(`user:${userId}`).emit(event, data);
        }
    }

    /**
     * Send message to specific user
     */
    public sendToUser(userId: string, event: string, data: any): void {
        this.io.to(`user:${userId}`).emit(event, data);
    }

    /**
     * Start heartbeat interval
     */
    private startHeartbeat(): void {
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();
            
            // Send heartbeat to all connected clients
            this.io.emit('heartbeat', { timestamp: now });
            
            // Log connection stats
            logger.debug('WebSocket heartbeat', {
                connections: this.connections.size,
                sockets: this.socketToUser.size,
                timestamp: now
            });
        }, 30000); // Every 30 seconds
    }

    /**
     * Graceful shutdown
     */
    public async shutdown(): Promise<void> {
        logger.info('Shutting down WebSocket server');
        
        // Stop heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        
        // Disconnect all clients
        this.io.disconnectSockets();
        
        // Close server
        await new Promise<void>((resolve) => {
            this.io.close(() => {
                logger.info('WebSocket server closed');
                resolve();
            });
        });
    }

    /**
     * Get server statistics
     */
    public getStats(): any {
        return {
            totalConnections: this.socketToUser.size,
            uniqueUsers: this.connections.size,
            rooms: this.io.sockets.adapter.rooms.size,
            sockets: Array.from(this.socketToUser.entries()).map(([socketId, userId]) => ({
                socketId,
                userId
            }))
        };
    }
}

export default WebSocketServer;