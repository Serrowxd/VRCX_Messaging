-- VRCX Messaging System - Additional Indexes and Constraints Migration
-- Performance optimizations and data integrity constraints

-- Additional composite indexes for common query patterns

-- Messages table optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_sender_status 
    ON messages(sender_id, message_status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_undelivered 
    ON messages(recipient_id, delivered_at) 
    WHERE delivered_at IS NULL AND message_status = 'pending';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_unread 
    ON messages(conversation_id, recipient_id, delivered_at DESC) 
    WHERE delivered_at IS NULL;

-- Partial index for expired messages cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_expired 
    ON messages(expires_at) 
    WHERE expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP;

-- Conversations table optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_composite 
    ON conversations(participant1_id, participant2_id, last_activity DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_active 
    ON conversations(last_activity DESC) 
    WHERE participant1_deleted = false AND participant2_deleted = false;

-- User keys optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_keys_identity 
    ON user_keys(user_id) 
    WHERE key_type = 'identity';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_keys_signed_current 
    ON user_keys(user_id, created_at DESC) 
    WHERE key_type = 'signed_prekey' AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP);

-- Sessions optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_cleanup 
    ON sessions(disconnected_at) 
    WHERE is_active = false AND disconnected_at < CURRENT_TIMESTAMP - INTERVAL '24 hours';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_inactive 
    ON sessions(last_ping) 
    WHERE is_active = true AND last_ping < CURRENT_TIMESTAMP - INTERVAL '5 minutes';

-- Audit log optimizations
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_security_events 
    ON audit_log(action, created_at DESC) 
    WHERE action IN ('login_failed', 'key_mismatch', 'rate_limit_exceeded', 'suspicious_activity');

-- Add check constraints for data integrity
ALTER TABLE messages 
    ADD CONSTRAINT check_delivery_time 
    CHECK (delivered_at IS NULL OR delivered_at >= created_at);

ALTER TABLE conversations 
    ADD CONSTRAINT check_last_activity 
    CHECK (last_activity >= created_at);

ALTER TABLE user_keys 
    ADD CONSTRAINT check_key_expiration 
    CHECK (expires_at IS NULL OR expires_at > created_at);

ALTER TABLE prekeys 
    ADD CONSTRAINT check_consumed_time 
    CHECK (consumed_at IS NULL OR consumed_at >= created_at);

ALTER TABLE sessions 
    ADD CONSTRAINT check_session_times 
    CHECK (disconnected_at IS NULL OR disconnected_at >= connected_at);

-- Add foreign key indexes that might be missing
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_messages_conversation_fk 
    ON messages(conversation_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_last_message_fk 
    ON conversations(last_message_id);

-- Create partial unique indexes for business logic
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_users_active_vrcx_id 
    ON users(vrcx_user_id) 
    WHERE is_active = true;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_sessions_active_user 
    ON sessions(user_id) 
    WHERE is_active = true;

-- Table partitioning preparation for messages (for future scaling)
-- This is commented out but can be enabled when message volume requires it
/*
-- Create parent table for partitioned messages
CREATE TABLE messages_partitioned (
    LIKE messages INCLUDING ALL
) PARTITION BY RANGE (created_at);

-- Create partitions for recent months
CREATE TABLE messages_y2024m01 PARTITION OF messages_partitioned
    FOR VALUES FROM ('2024-01-01') TO ('2024-02-01');

CREATE TABLE messages_y2024m02 PARTITION OF messages_partitioned
    FOR VALUES FROM ('2024-02-01') TO ('2024-03-01');

-- Add trigger to automatically create monthly partitions
CREATE OR REPLACE FUNCTION create_monthly_partition()
RETURNS void AS $$
DECLARE
    partition_name text;
    start_date date;
    end_date date;
BEGIN
    start_date := date_trunc('month', CURRENT_DATE);
    end_date := start_date + interval '1 month';
    partition_name := 'messages_y' || to_char(start_date, 'YYYY') || 'm' || to_char(start_date, 'MM');
    
    EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF messages_partitioned FOR VALUES FROM (%L) TO (%L)',
                   partition_name, start_date, end_date);
END;
$$ LANGUAGE plpgsql;
*/

-- Statistics for query planner
ANALYZE users;
ANALYZE messages;
ANALYZE conversations;
ANALYZE user_keys;
ANALYZE prekeys;
ANALYZE sessions;