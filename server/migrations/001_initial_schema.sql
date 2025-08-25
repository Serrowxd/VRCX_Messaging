-- VRCX Messaging System - PostgreSQL Initial Schema Migration
-- Server-side database schema for message relay and key exchange

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create enum types
CREATE TYPE message_status AS ENUM ('pending', 'sent', 'delivered', 'failed');
CREATE TYPE message_type AS ENUM ('text');
CREATE TYPE key_type AS ENUM ('identity', 'signed_prekey', 'onetime_prekey');
CREATE TYPE trust_level AS ENUM ('unverified', 'verified', 'trusted', 'untrusted');

-- Users table (integration with VRCX user system)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    vrcx_user_id VARCHAR(255) UNIQUE NOT NULL,  -- VRChat user ID
    username VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    avatar_url TEXT,
    public_key TEXT,                           -- User's public identity key
    device_id INTEGER DEFAULT 1,
    last_seen TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for users table
CREATE INDEX idx_users_vrcx_id ON users(vrcx_user_id);
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_active ON users(is_active, last_seen DESC);

-- Messages table - Stores encrypted messages for relay
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL,
    encrypted_content TEXT NOT NULL,           -- Base64 encoded encrypted content
    encryption_metadata JSONB,                 -- Encryption parameters
    message_type message_type DEFAULT 'text', -- Only text messages supported in MVP
    message_status message_status DEFAULT 'pending',
    ttl INTEGER,                               -- Time-to-live in seconds
    expires_at TIMESTAMP WITH TIME ZONE,
    delivered_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT check_ttl CHECK (ttl IS NULL OR ttl > 0)
);

-- Indexes for messages table
CREATE INDEX idx_messages_recipient ON messages(recipient_id, created_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX idx_messages_status ON messages(message_status) WHERE message_status = 'pending';
CREATE INDEX idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;

-- Conversations table - Track active conversations
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    participant1_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    participant2_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    participant1_deleted BOOLEAN DEFAULT false,
    participant2_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_participants UNIQUE(participant1_id, participant2_id),
    CONSTRAINT check_different_participants CHECK (participant1_id != participant2_id)
);

-- Indexes for conversations table
CREATE INDEX idx_conversations_participant1 ON conversations(participant1_id, last_activity DESC);
CREATE INDEX idx_conversations_participant2 ON conversations(participant2_id, last_activity DESC);
CREATE INDEX idx_conversations_activity ON conversations(last_activity DESC);

-- User keys table - Store public keys for key exchange
CREATE TABLE IF NOT EXISTS user_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_type key_type NOT NULL,
    key_id INTEGER,                           -- Numeric ID for prekeys
    public_key TEXT NOT NULL,                 -- Base64 encoded public key
    signature TEXT,                           -- Signature for signed prekeys
    metadata JSONB,                           -- Additional key metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP WITH TIME ZONE,
    consumed_at TIMESTAMP WITH TIME ZONE,     -- When a one-time key was consumed
    CONSTRAINT unique_user_key UNIQUE(user_id, key_type, key_id)
);

-- Indexes for user keys table
CREATE INDEX idx_user_keys_user ON user_keys(user_id, key_type);
CREATE INDEX idx_user_keys_available_onetime ON user_keys(user_id, key_type, consumed_at) 
    WHERE key_type = 'onetime_prekey' AND consumed_at IS NULL;
CREATE INDEX idx_user_keys_expires ON user_keys(expires_at) WHERE expires_at IS NOT NULL;

-- Prekeys table - Batch storage for one-time prekeys
CREATE TABLE IF NOT EXISTS prekeys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    batch_id UUID NOT NULL,                   -- Group prekeys by upload batch
    key_id INTEGER NOT NULL,
    public_key TEXT NOT NULL,
    consumed BOOLEAN DEFAULT false,
    consumed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_prekey UNIQUE(user_id, key_id)
);

-- Indexes for prekeys table
CREATE INDEX idx_prekeys_user_available ON prekeys(user_id, consumed, key_id) WHERE consumed = false;
CREATE INDEX idx_prekeys_batch ON prekeys(batch_id);

-- Message queue table - For async message processing
CREATE TABLE IF NOT EXISTS message_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation VARCHAR(50) NOT NULL,           -- send, notify, cleanup, etc
    payload JSONB NOT NULL,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    next_retry_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for message queue
CREATE INDEX idx_queue_pending ON message_queue(next_retry_at, retry_count) 
    WHERE processed_at IS NULL AND retry_count < max_retries;
CREATE INDEX idx_queue_recipient ON message_queue(recipient_id, created_at DESC);

-- Sessions table - Store WebSocket session info
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    socket_id VARCHAR(255) UNIQUE NOT NULL,
    ip_address INET,
    user_agent TEXT,
    connected_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    disconnected_at TIMESTAMP WITH TIME ZONE,
    last_ping TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true
);

-- Indexes for sessions
CREATE INDEX idx_sessions_user ON sessions(user_id, is_active);
CREATE INDEX idx_sessions_socket ON sessions(socket_id) WHERE is_active = true;
CREATE INDEX idx_sessions_active ON sessions(is_active, last_ping DESC);

-- Rate limiting table
CREATE TABLE IF NOT EXISTS rate_limits (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identifier VARCHAR(255) NOT NULL,         -- User ID or IP address
    action VARCHAR(100) NOT NULL,             -- Action being rate limited
    count INTEGER DEFAULT 1,
    window_start TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    window_end TIMESTAMP WITH TIME ZONE,
    CONSTRAINT unique_rate_limit UNIQUE(identifier, action, window_start)
);

-- Indexes for rate limiting
CREATE INDEX idx_rate_limits_identifier ON rate_limits(identifier, action, window_end);
CREATE INDEX idx_rate_limits_cleanup ON rate_limits(window_end) WHERE window_end < CURRENT_TIMESTAMP;

-- Audit log table for security events
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(50),
    entity_id UUID,
    ip_address INET,
    user_agent TEXT,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for audit log
CREATE INDEX idx_audit_user ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- Blocked users table
CREATE TABLE IF NOT EXISTS blocked_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_block UNIQUE(user_id, blocked_user_id),
    CONSTRAINT no_self_block CHECK (user_id != blocked_user_id)
);

-- Indexes for blocked users
CREATE INDEX idx_blocked_user ON blocked_users(user_id);
CREATE INDEX idx_blocked_target ON blocked_users(blocked_user_id);

-- Notification preferences table
CREATE TABLE IF NOT EXISTS notification_preferences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    push_enabled BOOLEAN DEFAULT true,
    email_enabled BOOLEAN DEFAULT false,
    sound_enabled BOOLEAN DEFAULT true,
    vibration_enabled BOOLEAN DEFAULT true,
    message_preview BOOLEAN DEFAULT true,
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at columns
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_conversations_updated_at BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_notification_preferences_updated_at BEFORE UPDATE ON notification_preferences
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to get or create conversation
CREATE OR REPLACE FUNCTION get_or_create_conversation(
    p_user1_id UUID,
    p_user2_id UUID
) RETURNS UUID AS $$
DECLARE
    v_conversation_id UUID;
    v_participant1_id UUID;
    v_participant2_id UUID;
BEGIN
    -- Normalize participant order
    IF p_user1_id < p_user2_id THEN
        v_participant1_id := p_user1_id;
        v_participant2_id := p_user2_id;
    ELSE
        v_participant1_id := p_user2_id;
        v_participant2_id := p_user1_id;
    END IF;
    
    -- Try to find existing conversation
    SELECT id INTO v_conversation_id
    FROM conversations
    WHERE participant1_id = v_participant1_id 
      AND participant2_id = v_participant2_id;
    
    -- Create new conversation if not found
    IF v_conversation_id IS NULL THEN
        INSERT INTO conversations (participant1_id, participant2_id)
        VALUES (v_participant1_id, v_participant2_id)
        RETURNING id INTO v_conversation_id;
    END IF;
    
    RETURN v_conversation_id;
END;
$$ LANGUAGE plpgsql;

-- Function to consume a one-time prekey
CREATE OR REPLACE FUNCTION consume_onetime_prekey(
    p_user_id UUID
) RETURNS TABLE(key_id INTEGER, public_key TEXT) AS $$
BEGIN
    RETURN QUERY
    UPDATE prekeys
    SET consumed = true,
        consumed_at = CURRENT_TIMESTAMP
    WHERE id = (
        SELECT id FROM prekeys
        WHERE user_id = p_user_id
          AND consumed = false
        ORDER BY key_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    RETURNING prekeys.key_id, prekeys.public_key;
END;
$$ LANGUAGE plpgsql;

-- Create materialized view for message statistics
CREATE MATERIALIZED VIEW IF NOT EXISTS message_statistics AS
SELECT 
    DATE_TRUNC('hour', created_at) as hour,
    COUNT(*) as message_count,
    COUNT(DISTINCT sender_id) as unique_senders,
    COUNT(DISTINCT recipient_id) as unique_recipients,
    COUNT(DISTINCT conversation_id) as active_conversations,
    AVG(CASE 
        WHEN delivered_at IS NOT NULL 
        THEN EXTRACT(EPOCH FROM (delivered_at - created_at))
        ELSE NULL 
    END) as avg_delivery_time_seconds
FROM messages
WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '7 days'
GROUP BY DATE_TRUNC('hour', created_at);

-- Create index on materialized view
CREATE INDEX idx_message_statistics_hour ON message_statistics(hour DESC);

-- Grants for application user (to be customized based on actual user)
-- GRANT USAGE ON SCHEMA public TO messaging_app;
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO messaging_app;
-- GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO messaging_app;
-- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO messaging_app;