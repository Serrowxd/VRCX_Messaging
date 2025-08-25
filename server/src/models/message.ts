import { v4 as uuidv4 } from 'uuid';

export interface Message {
    id: string;
    conversation_id: string;
    sender_id: string;
    recipient_id: string;
    encrypted_content: string;
    metadata: MessageMetadata;
    status: MessageStatus;
    created_at: Date;
    delivered_at?: Date;
    read_at?: Date;
    deleted_at?: Date;
    deleted_for_everyone?: boolean;
}

export interface MessageMetadata {
    version: number;
    timestamp: number;
    deviceId: number;
    sessionId: string;
    ephemeralKey?: string;
    messageType?: 'text' | 'system';
}

export enum MessageStatus {
    PENDING = 'pending',
    SENT = 'sent',
    DELIVERED = 'delivered',
    READ = 'read',
    FAILED = 'failed'
}

export interface Conversation {
    id: string;
    user1_id: string;
    user2_id: string;
    created_at: Date;
    updated_at: Date;
    last_message_id?: string;
    last_message_at?: Date;
    user1_deleted_at?: Date;
    user2_deleted_at?: Date;
    user1_archived?: boolean;
    user2_archived?: boolean;
    user1_muted?: boolean;
    user2_muted?: boolean;
}

export interface ConversationWithDetails extends Conversation {
    participant_id: string;
    participant_username: string;
    last_message?: {
        id: string;
        preview: string;
        timestamp: Date;
    };
    unread_count: number;
    archived: boolean;
    muted: boolean;
}

export interface MessageQueue {
    id: string;
    message_id: string;
    recipient_id: string;
    attempts: number;
    max_attempts: number;
    next_retry_at?: Date;
    error?: string;
    created_at: Date;
    updated_at: Date;
}

export interface DeliveryReceipt {
    message_id: string;
    recipient_id: string;
    status: MessageStatus;
    timestamp: Date;
    device_id?: number;
}

export function generateMessageId(): string {
    return `msg_${uuidv4()}`;
}

export function generateConversationId(): string {
    return `conv_${uuidv4()}`;
}

export function getConversationId(user1Id: string, user2Id: string): string {
    // Sort user IDs to ensure consistent conversation ID regardless of who initiates
    const sortedIds = [user1Id, user2Id].sort();
    return `conv_${sortedIds[0]}_${sortedIds[1]}`;
}