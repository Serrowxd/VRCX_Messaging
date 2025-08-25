import { Server as SocketServer, Socket } from 'socket.io';
import { logger } from '../utils/logger';
import { query } from '../database/connection';

interface UserConnection {
    userId: string;
    socketId: string;
    deviceId: number;
    connectedAt: Date;
}

interface ConversationRoom {
    conversationId: string;
    participants: Set<string>;
}

export class WebSocketManager {
    private io: SocketServer;
    private userConnections: Map<string, Set<UserConnection>>;
    private socketToUser: Map<string, string>;
    private conversationRooms: Map<string, ConversationRoom>;
    private typingStatus: Map<string, Map<string, NodeJS.Timeout>>;

    constructor(io: SocketServer) {
        this.io = io;
        this.userConnections = new Map();
        this.socketToUser = new Map();
        this.conversationRooms = new Map();
        this.typingStatus = new Map();
    }

    /**
     * Handle new socket connection
     */
    async handleConnection(socket: Socket, userId: string, deviceId: number): Promise<void> {
        const connection: UserConnection = {
            userId,
            socketId: socket.id,
            deviceId,
            connectedAt: new Date()
        };

        // Add to user connections
        if (!this.userConnections.has(userId)) {
            this.userConnections.set(userId, new Set());
        }
        this.userConnections.get(userId)!.add(connection);
        this.socketToUser.set(socket.id, userId);

        // Join user-specific room
        socket.join(`user:${userId}`);

        // Load and join conversation rooms
        await this.loadUserConversations(socket, userId);

        // Update user presence
        await this.updateUserPresence(userId, true);

        // Send pending messages
        await this.sendPendingMessages(userId);

        logger.info('User connected via WebSocket', {
            userId,
            socketId: socket.id,
            deviceId
        });

        // Emit connection success
        socket.emit('connected', {
            userId,
            deviceId,
            timestamp: new Date()
        });
    }

    /**
     * Handle socket disconnection
     */
    async handleDisconnection(socketId: string): Promise<void> {
        const userId = this.socketToUser.get(socketId);
        if (!userId) return;

        // Remove connection
        const connections = this.userConnections.get(userId);
        if (connections) {
            const toRemove = Array.from(connections).find(c => c.socketId === socketId);
            if (toRemove) {
                connections.delete(toRemove);
            }

            // If no more connections, user is offline
            if (connections.size === 0) {
                this.userConnections.delete(userId);
                await this.updateUserPresence(userId, false);
            }
        }

        // Clean up typing status
        this.clearTypingStatus(userId);

        this.socketToUser.delete(socketId);

        logger.info('User disconnected from WebSocket', {
            userId,
            socketId
        });
    }

    /**
     * Load user's conversations and join rooms
     */
    private async loadUserConversations(socket: Socket, userId: string): Promise<void> {
        const result = await query(
            `SELECT id, user1_id, user2_id 
            FROM conversations 
            WHERE (user1_id = $1 OR user2_id = $1)
            AND ((user1_id = $1 AND user1_deleted_at IS NULL) OR 
                 (user2_id = $1 AND user2_deleted_at IS NULL))`,
            [userId]
        );

        for (const conv of result.rows) {
            const roomName = `conversation:${conv.id}`;
            socket.join(roomName);

            // Update conversation room tracking
            if (!this.conversationRooms.has(conv.id)) {
                this.conversationRooms.set(conv.id, {
                    conversationId: conv.id,
                    participants: new Set([conv.user1_id, conv.user2_id])
                });
            }
        }
    }

    /**
     * Update user presence status
     */
    private async updateUserPresence(userId: string, isOnline: boolean): Promise<void> {
        const timestamp = new Date();

        // Update database
        await query(
            `UPDATE users 
            SET is_online = $1, last_seen_at = $2
            WHERE id = $3`,
            [isOnline, timestamp, userId]
        );

        // Get user's conversations to notify participants
        const result = await query(
            `SELECT id, user1_id, user2_id 
            FROM conversations 
            WHERE user1_id = $1 OR user2_id = $1`,
            [userId]
        );

        // Notify conversation participants
        for (const conv of result.rows) {
            const otherUserId = conv.user1_id === userId ? conv.user2_id : conv.user1_id;
            await this.sendToUser(otherUserId, 'presence:update', {
                userId,
                isOnline,
                timestamp
            });
        }
    }

    /**
     * Send pending messages when user comes online
     */
    private async sendPendingMessages(userId: string): Promise<void> {
        // This is handled by the messageQueue service
        const { messageQueueService } = await import('../services/messageQueue');
        await messageQueueService.deliverOfflineMessages(userId);
    }

    /**
     * Check if user is online
     */
    isUserOnline(userId: string): boolean {
        return this.userConnections.has(userId) && 
               this.userConnections.get(userId)!.size > 0;
    }

    /**
     * Get user's active connections
     */
    getUserConnections(userId: string): UserConnection[] {
        const connections = this.userConnections.get(userId);
        return connections ? Array.from(connections) : [];
    }

    /**
     * Send event to specific user (all devices)
     */
    async sendToUser(userId: string, event: string, data: any): Promise<boolean> {
        const connections = this.userConnections.get(userId);
        if (!connections || connections.size === 0) {
            return false;
        }

        // Send to all user's devices
        this.io.to(`user:${userId}`).emit(event, data);

        logger.debug('Event sent to user', {
            userId,
            event,
            deviceCount: connections.size
        });

        return true;
    }

    /**
     * Send event to specific device
     */
    async sendToDevice(userId: string, deviceId: number, event: string, data: any): Promise<boolean> {
        const connections = this.userConnections.get(userId);
        if (!connections) return false;

        const connection = Array.from(connections).find(c => c.deviceId === deviceId);
        if (!connection) return false;

        this.io.to(connection.socketId).emit(event, data);

        logger.debug('Event sent to device', {
            userId,
            deviceId,
            event
        });

        return true;
    }

    /**
     * Send event to all participants in a conversation
     */
    async sendToConversation(conversationId: string, event: string, data: any): Promise<void> {
        const roomName = `conversation:${conversationId}`;
        this.io.to(roomName).emit(event, data);

        logger.debug('Event sent to conversation', {
            conversationId,
            event
        });
    }

    /**
     * Handle typing indicator
     */
    async handleTyping(userId: string, conversationId: string, isTyping: boolean): Promise<void> {
        if (!this.typingStatus.has(conversationId)) {
            this.typingStatus.set(conversationId, new Map());
        }

        const conversationTyping = this.typingStatus.get(conversationId)!;

        if (isTyping) {
            // Clear existing timeout if any
            const existingTimeout = conversationTyping.get(userId);
            if (existingTimeout) {
                clearTimeout(existingTimeout);
            }

            // Set new timeout to auto-clear after 10 seconds
            const timeout = setTimeout(() => {
                this.handleTyping(userId, conversationId, false);
            }, 10000);

            conversationTyping.set(userId, timeout);

            // Notify other participants
            await this.sendToConversation(conversationId, 'typing:start', {
                userId,
                conversationId,
                timestamp: new Date()
            });
        } else {
            // Clear typing status
            const timeout = conversationTyping.get(userId);
            if (timeout) {
                clearTimeout(timeout);
                conversationTyping.delete(userId);
            }

            // Notify other participants
            await this.sendToConversation(conversationId, 'typing:stop', {
                userId,
                conversationId,
                timestamp: new Date()
            });
        }
    }

    /**
     * Clear all typing status for a user
     */
    private clearTypingStatus(userId: string): void {
        for (const [conversationId, typingMap] of this.typingStatus.entries()) {
            const timeout = typingMap.get(userId);
            if (timeout) {
                clearTimeout(timeout);
                typingMap.delete(userId);
                
                // Notify conversation participants
                this.sendToConversation(conversationId, 'typing:stop', {
                    userId,
                    conversationId,
                    timestamp: new Date()
                });
            }
        }
    }

    /**
     * Get active typing users for a conversation
     */
    getTypingUsers(conversationId: string): string[] {
        const typingMap = this.typingStatus.get(conversationId);
        return typingMap ? Array.from(typingMap.keys()) : [];
    }

    /**
     * Broadcast to all connected users
     */
    broadcast(event: string, data: any): void {
        this.io.emit(event, data);
        logger.debug('Broadcast sent', { event });
    }

    /**
     * Get connection statistics
     */
    getStats() {
        const totalUsers = this.userConnections.size;
        let totalConnections = 0;
        
        for (const connections of this.userConnections.values()) {
            totalConnections += connections.size;
        }

        return {
            totalUsers,
            totalConnections,
            averageConnectionsPerUser: totalUsers > 0 ? totalConnections / totalUsers : 0,
            conversationRooms: this.conversationRooms.size,
            activeTyping: Array.from(this.typingStatus.values())
                .reduce((sum, map) => sum + map.size, 0)
        };
    }

    /**
     * Clean up stale connections
     */
    async cleanupStaleConnections(): Promise<void> {
        const staleThreshold = Date.now() - (30 * 60 * 1000); // 30 minutes

        for (const [userId, connections] of this.userConnections.entries()) {
            const stale = Array.from(connections).filter(
                c => c.connectedAt.getTime() < staleThreshold
            );

            for (const connection of stale) {
                connections.delete(connection);
                this.socketToUser.delete(connection.socketId);
                
                // Disconnect the socket
                const socket = this.io.sockets.sockets.get(connection.socketId);
                if (socket) {
                    socket.disconnect(true);
                }
            }

            if (connections.size === 0) {
                this.userConnections.delete(userId);
                await this.updateUserPresence(userId, false);
            }
        }

        logger.info('Cleaned up stale connections');
    }
}

export default WebSocketManager;