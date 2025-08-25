-- VRCX Messaging System - SQLite Schema for Client-side Storage
-- This schema is used for local message storage within the VRCX client
-- Tables are prefixed with userId to maintain user-specific data isolation

-- Messages table - Stores all encrypted messages
CREATE TABLE IF NOT EXISTS {userId}_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    encrypted_content BLOB NOT NULL,  -- Encrypted message content
    encryption_metadata TEXT,         -- JSON containing encryption params (nonce, key version, etc)
    timestamp INTEGER NOT NULL,       -- Unix timestamp in milliseconds
    read_status INTEGER DEFAULT 0,    -- 0=unread, 1=read
    delivery_status TEXT DEFAULT 'pending', -- pending, sent, delivered, failed
    message_type TEXT DEFAULT 'text', -- text, image, file, etc
    attachments TEXT,                 -- JSON array of attachment metadata
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Indexes for messages table
CREATE INDEX IF NOT EXISTS idx_{userId}_messages_conversation 
    ON {userId}_messages(conversation_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_{userId}_messages_timestamp 
    ON {userId}_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_{userId}_messages_unread 
    ON {userId}_messages(conversation_id, read_status) WHERE read_status = 0;

-- Conversations table - Stores conversation metadata
CREATE TABLE IF NOT EXISTS {userId}_conversations (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,     -- The other user in the conversation
    participant_name TEXT,            -- Display name (cached)
    participant_avatar TEXT,          -- Avatar URL (cached)
    last_message_id TEXT,            -- Reference to most recent message
    last_message_time INTEGER,       -- Timestamp of last message
    last_message_preview TEXT,       -- Encrypted preview of last message
    unread_count INTEGER DEFAULT 0,  -- Count of unread messages
    is_archived INTEGER DEFAULT 0,   -- 0=active, 1=archived
    is_muted INTEGER DEFAULT 0,      -- 0=unmuted, 1=muted
    muted_until INTEGER,             -- Unix timestamp when mute expires
    encryption_session TEXT,         -- JSON containing session state
    draft_message TEXT,              -- Encrypted draft message
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (last_message_id) REFERENCES {userId}_messages(id) ON DELETE SET NULL
);

-- Indexes for conversations table
CREATE INDEX IF NOT EXISTS idx_{userId}_conversations_updated 
    ON {userId}_conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_{userId}_conversations_archived 
    ON {userId}_conversations(is_archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_{userId}_conversations_unread 
    ON {userId}_conversations(unread_count) WHERE unread_count > 0;

-- Encryption keys table - Stores cryptographic keys
CREATE TABLE IF NOT EXISTS {userId}_encryption_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,           -- User this key belongs to
    key_type TEXT NOT NULL,          -- identity, signed_prekey, onetime_prekey
    key_id INTEGER,                  -- Numeric key ID for prekeys
    public_key TEXT NOT NULL,        -- Base64 encoded public key
    private_key_encrypted BLOB,      -- Encrypted private key
    signature TEXT,                  -- Signature for signed prekeys
    key_metadata TEXT,               -- JSON with additional metadata
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    expires_at INTEGER,              -- Expiration timestamp for rotating keys
    consumed_at INTEGER,             -- When a one-time key was used
    UNIQUE(user_id, key_type, key_id)
);

-- Indexes for encryption keys table
CREATE INDEX IF NOT EXISTS idx_{userId}_keys_type 
    ON {userId}_encryption_keys(user_id, key_type);
CREATE INDEX IF NOT EXISTS idx_{userId}_keys_expires 
    ON {userId}_encryption_keys(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_{userId}_keys_onetime 
    ON {userId}_encryption_keys(key_type, consumed_at) 
    WHERE key_type = 'onetime_prekey' AND consumed_at IS NULL;

-- Message queue table - For offline/pending messages
CREATE TABLE IF NOT EXISTS {userId}_message_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    operation TEXT NOT NULL,         -- send, delete, edit, read
    payload TEXT NOT NULL,           -- JSON payload for the operation
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    next_retry_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (message_id) REFERENCES {userId}_messages(id) ON DELETE CASCADE
);

-- Index for message queue processing
CREATE INDEX IF NOT EXISTS idx_{userId}_queue_pending 
    ON {userId}_message_queue(next_retry_at) 
    WHERE retry_count < max_retries;

-- Sessions table - Stores Signal Protocol session state
CREATE TABLE IF NOT EXISTS {userId}_sessions (
    id TEXT PRIMARY KEY,             -- Composite key: userId:deviceId
    user_id TEXT NOT NULL,
    device_id INTEGER DEFAULT 1,
    session_record BLOB NOT NULL,    -- Serialized session state
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- Index for session lookups
CREATE INDEX IF NOT EXISTS idx_{userId}_sessions_user 
    ON {userId}_sessions(user_id);

-- Attachments table - Stores attachment metadata
CREATE TABLE IF NOT EXISTS {userId}_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT,                  -- MIME type
    file_size INTEGER,               -- Size in bytes
    encrypted_url TEXT,              -- URL to encrypted file
    encryption_key TEXT,             -- Key to decrypt the file
    thumbnail_url TEXT,              -- Encrypted thumbnail URL
    thumbnail_key TEXT,              -- Key to decrypt thumbnail
    upload_status TEXT DEFAULT 'pending', -- pending, uploading, completed, failed
    download_status TEXT DEFAULT 'pending', -- pending, downloading, completed, failed
    local_path TEXT,                 -- Local file path after download
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    FOREIGN KEY (message_id) REFERENCES {userId}_messages(id) ON DELETE CASCADE
);

-- Index for attachment lookups
CREATE INDEX IF NOT EXISTS idx_{userId}_attachments_message 
    ON {userId}_attachments(message_id);

-- Trusted keys table - For key verification
CREATE TABLE IF NOT EXISTS {userId}_trusted_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    identity_key TEXT NOT NULL,      -- Their identity public key
    trust_level TEXT DEFAULT 'unverified', -- unverified, verified, trusted
    safety_number TEXT,              -- Computed safety number for verification
    verified_at INTEGER,
    verified_by TEXT,                -- Method of verification: qr, manual, etc
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    UNIQUE(user_id)
);

-- Index for trusted keys
CREATE INDEX IF NOT EXISTS idx_{userId}_trusted_keys_user 
    ON {userId}_trusted_keys(user_id);

-- Message search index (FTS5 virtual table for full-text search)
CREATE VIRTUAL TABLE IF NOT EXISTS {userId}_message_search USING fts5(
    message_id UNINDEXED,
    conversation_id UNINDEXED,
    content,                         -- Decrypted content for search
    sender_name,
    timestamp UNINDEXED,
    tokenize = 'unicode61'
);

-- Triggers to maintain updated_at timestamps
CREATE TRIGGER IF NOT EXISTS update_{userId}_messages_timestamp 
    AFTER UPDATE ON {userId}_messages
    BEGIN
        UPDATE {userId}_messages 
        SET updated_at = strftime('%s', 'now') * 1000 
        WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_{userId}_conversations_timestamp 
    AFTER UPDATE ON {userId}_conversations
    BEGIN
        UPDATE {userId}_conversations 
        SET updated_at = strftime('%s', 'now') * 1000 
        WHERE id = NEW.id;
    END;

-- View for conversation list with last message info
CREATE VIEW IF NOT EXISTS {userId}_conversation_list AS
SELECT 
    c.id,
    c.participant_id,
    c.participant_name,
    c.participant_avatar,
    c.last_message_time,
    c.last_message_preview,
    c.unread_count,
    c.is_archived,
    c.is_muted,
    c.draft_message,
    m.delivery_status as last_message_status,
    c.updated_at
FROM {userId}_conversations c
LEFT JOIN {userId}_messages m ON c.last_message_id = m.id
ORDER BY c.updated_at DESC;