-- Migration: Message Queue and Deleted Messages Tables
-- Purpose: Support offline messaging, message deletion, and queue processing

-- Table for tracking deleted messages per user
CREATE TABLE IF NOT EXISTS deleted_messages (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, message_id)
);

-- Index for efficient queries
CREATE INDEX idx_deleted_messages_user_id ON deleted_messages(user_id);
CREATE INDEX idx_deleted_messages_deleted_at ON deleted_messages(deleted_at);

-- Table for offline message queue
CREATE TABLE IF NOT EXISTS offline_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    queued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivery_attempts INTEGER DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    UNIQUE(recipient_id, message_id)
);

-- Indexes for offline messages
CREATE INDEX idx_offline_messages_recipient_id ON offline_messages(recipient_id) WHERE delivered_at IS NULL;
CREATE INDEX idx_offline_messages_queued_at ON offline_messages(queued_at) WHERE delivered_at IS NULL;
CREATE INDEX idx_offline_messages_message_id ON offline_messages(message_id);

-- Update message_queue table for better queue management
ALTER TABLE message_queue 
ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;

-- Index for priority queue processing
CREATE INDEX IF NOT EXISTS idx_message_queue_priority 
ON message_queue(priority DESC, created_at ASC) 
WHERE completed_at IS NULL AND failed_at IS NULL;

-- Index for scheduled messages
CREATE INDEX IF NOT EXISTS idx_message_queue_scheduled 
ON message_queue(scheduled_at) 
WHERE scheduled_at IS NOT NULL AND completed_at IS NULL;

-- Function to clean up old deleted messages (older than 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_deleted_messages()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM deleted_messages
    WHERE deleted_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get offline message count for a user
CREATE OR REPLACE FUNCTION get_offline_message_count(p_user_id UUID)
RETURNS INTEGER AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)
        FROM offline_messages
        WHERE recipient_id = p_user_id
        AND delivered_at IS NULL
    );
END;
$$ LANGUAGE plpgsql;

-- Trigger to update conversation when message is deleted for everyone
CREATE OR REPLACE FUNCTION update_conversation_on_message_delete()
RETURNS TRIGGER AS $$
BEGIN
    -- If the deleted message was the last message in conversation
    IF NEW.deleted_for_everyone = true AND EXISTS (
        SELECT 1 FROM conversations 
        WHERE id = NEW.conversation_id 
        AND last_message_id = NEW.id
    ) THEN
        -- Update to previous message
        UPDATE conversations
        SET last_message_id = (
            SELECT id FROM messages
            WHERE conversation_id = NEW.conversation_id
            AND id != NEW.id
            AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
        ),
        last_message_at = (
            SELECT created_at FROM messages
            WHERE conversation_id = NEW.conversation_id
            AND id != NEW.id
            AND deleted_at IS NULL
            ORDER BY created_at DESC
            LIMIT 1
        ),
        updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.conversation_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for message deletion
CREATE TRIGGER trigger_update_conversation_on_message_delete
AFTER UPDATE OF deleted_at, deleted_for_everyone ON messages
FOR EACH ROW
WHEN (NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION update_conversation_on_message_delete();

-- Add comment
COMMENT ON TABLE deleted_messages IS 'Tracks messages deleted by individual users (not for everyone)';
COMMENT ON TABLE offline_messages IS 'Queue for messages to be delivered when recipient comes online';
COMMENT ON FUNCTION cleanup_old_deleted_messages() IS 'Removes deleted message records older than 30 days';
COMMENT ON FUNCTION get_offline_message_count(UUID) IS 'Returns count of pending offline messages for a user';