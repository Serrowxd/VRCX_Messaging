import sqliteService from '../sqlite.js';

/**
 * Message database operations for VRCX Messaging System
 * Handles all SQLite operations for messages, conversations, and encryption keys
 */

const messagesDb = {
    // Initialize messaging tables for a user
    async initMessagingTables(userId) {
        const userPrefix = this.getUserPrefix(userId);
        
        // Read and execute the messaging schema
        const schemaSQL = await this.getMessagingSchema(userPrefix);
        const statements = schemaSQL.split(';').filter(stmt => stmt.trim());
        
        for (const statement of statements) {
            if (statement.trim()) {
                await sqliteService.executeNonQuery(statement);
            }
        }
    },

    // Get user-specific table prefix
    getUserPrefix(userId) {
        let prefix = userId.replaceAll('-', '').replaceAll('_', '');
        // Add underscore if prefix starts with a number
        if (prefix.match(/^\d/)) {
            prefix = '_' + prefix;
        }
        return prefix;
    },

    // Get messaging schema with userId replaced
    async getMessagingSchema(userPrefix) {
        // In production, this would read from messaging.sql file
        // For now, we'll use a simplified schema
        return `
            -- Messages table
            CREATE TABLE IF NOT EXISTS ${userPrefix}_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                sender_id TEXT NOT NULL,
                recipient_id TEXT NOT NULL,
                encrypted_content BLOB NOT NULL,
                encryption_metadata TEXT,
                timestamp INTEGER NOT NULL,
                read_status INTEGER DEFAULT 0,
                delivery_status TEXT DEFAULT 'pending',
                message_type TEXT DEFAULT 'text',
                attachments TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_messages_conversation 
                ON ${userPrefix}_messages(conversation_id, timestamp DESC);
            
            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_messages_timestamp 
                ON ${userPrefix}_messages(timestamp DESC);

            -- Conversations table
            CREATE TABLE IF NOT EXISTS ${userPrefix}_conversations (
                id TEXT PRIMARY KEY,
                participant_id TEXT NOT NULL,
                participant_name TEXT,
                participant_avatar TEXT,
                last_message_id TEXT,
                last_message_time INTEGER,
                last_message_preview TEXT,
                unread_count INTEGER DEFAULT 0,
                is_archived INTEGER DEFAULT 0,
                is_muted INTEGER DEFAULT 0,
                muted_until INTEGER,
                encryption_session TEXT,
                draft_message TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_conversations_updated 
                ON ${userPrefix}_conversations(updated_at DESC);

            -- Encryption keys table
            CREATE TABLE IF NOT EXISTS ${userPrefix}_encryption_keys (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                key_type TEXT NOT NULL,
                key_id INTEGER,
                public_key TEXT NOT NULL,
                private_key_encrypted BLOB,
                signature TEXT,
                key_metadata TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                expires_at INTEGER,
                consumed_at INTEGER,
                UNIQUE(user_id, key_type, key_id)
            );

            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_keys_type 
                ON ${userPrefix}_encryption_keys(user_id, key_type);

            -- Sessions table
            CREATE TABLE IF NOT EXISTS ${userPrefix}_sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                device_id INTEGER DEFAULT 1,
                session_record BLOB NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_sessions_user 
                ON ${userPrefix}_sessions(user_id);

            -- Message queue table
            CREATE TABLE IF NOT EXISTS ${userPrefix}_message_queue (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                operation TEXT NOT NULL,
                payload TEXT NOT NULL,
                retry_count INTEGER DEFAULT 0,
                max_retries INTEGER DEFAULT 3,
                next_retry_at INTEGER,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_queue_pending 
                ON ${userPrefix}_message_queue(next_retry_at) 
                WHERE retry_count < max_retries;

            -- Trusted keys table
            CREATE TABLE IF NOT EXISTS ${userPrefix}_trusted_keys (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL UNIQUE,
                identity_key TEXT NOT NULL,
                trust_level TEXT DEFAULT 'unverified',
                safety_number TEXT,
                verified_at INTEGER,
                verified_by TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_trusted_keys_user 
                ON ${userPrefix}_trusted_keys(user_id);

            -- Attachments table
            CREATE TABLE IF NOT EXISTS ${userPrefix}_attachments (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_type TEXT,
                file_size INTEGER,
                encrypted_url TEXT,
                encryption_key TEXT,
                thumbnail_url TEXT,
                thumbnail_key TEXT,
                upload_status TEXT DEFAULT 'pending',
                download_status TEXT DEFAULT 'pending',
                local_path TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
            );

            CREATE INDEX IF NOT EXISTS idx_${userPrefix}_attachments_message 
                ON ${userPrefix}_attachments(message_id);
        `;
    },

    // Message operations
    async saveMessage(userId, message) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            INSERT INTO ${userPrefix}_messages (
                id, conversation_id, sender_id, recipient_id,
                encrypted_content, encryption_metadata, timestamp,
                read_status, delivery_status, message_type, attachments
            ) VALUES (
                @id, @conversation_id, @sender_id, @recipient_id,
                @encrypted_content, @encryption_metadata, @timestamp,
                @read_status, @delivery_status, @message_type, @attachments
            )
        `;
        return sqliteService.executeNonQuery(sql, message);
    },

    async getMessage(userId, messageId) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `SELECT * FROM ${userPrefix}_messages WHERE id = @id`;
        let result = null;
        await sqliteService.execute((row) => {
            result = row;
        }, sql, { id: messageId });
        return result;
    },

    async getConversationMessages(userId, conversationId, limit = 50, offset = 0) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            SELECT * FROM ${userPrefix}_messages 
            WHERE conversation_id = @conversation_id
            ORDER BY timestamp DESC
            LIMIT @limit OFFSET @offset
        `;
        const messages = [];
        await sqliteService.execute((row) => {
            messages.push(row);
        }, sql, { conversation_id: conversationId, limit, offset });
        return messages;
    },

    async markMessageAsRead(userId, messageId) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            UPDATE ${userPrefix}_messages 
            SET read_status = 1, updated_at = @timestamp
            WHERE id = @id
        `;
        return sqliteService.executeNonQuery(sql, {
            id: messageId,
            timestamp: Date.now()
        });
    },

    async updateMessageStatus(userId, messageId, status) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            UPDATE ${userPrefix}_messages 
            SET delivery_status = @status, updated_at = @timestamp
            WHERE id = @id
        `;
        return sqliteService.executeNonQuery(sql, {
            id: messageId,
            status,
            timestamp: Date.now()
        });
    },

    async deleteMessage(userId, messageId) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `DELETE FROM ${userPrefix}_messages WHERE id = @id`;
        return sqliteService.executeNonQuery(sql, { id: messageId });
    },

    // Conversation operations
    async getOrCreateConversation(userId, participantId, participantName = null) {
        const userPrefix = this.getUserPrefix(userId);
        
        // Check if conversation exists
        let conversation = null;
        const selectSql = `
            SELECT * FROM ${userPrefix}_conversations 
            WHERE participant_id = @participant_id
        `;
        await sqliteService.execute((row) => {
            conversation = row;
        }, selectSql, { participant_id: participantId });

        if (conversation) {
            return conversation;
        }

        // Create new conversation
        const conversationId = this.generateId();
        const insertSql = `
            INSERT INTO ${userPrefix}_conversations (
                id, participant_id, participant_name
            ) VALUES (
                @id, @participant_id, @participant_name
            )
        `;
        await sqliteService.executeNonQuery(insertSql, {
            id: conversationId,
            participant_id: participantId,
            participant_name: participantName
        });

        return { id: conversationId, participant_id: participantId, participant_name: participantName };
    },

    async getConversations(userId, includeArchived = false) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            SELECT * FROM ${userPrefix}_conversations 
            ${includeArchived ? '' : 'WHERE is_archived = 0'}
            ORDER BY updated_at DESC
        `;
        const conversations = [];
        await sqliteService.execute((row) => {
            conversations.push(row);
        }, sql);
        return conversations;
    },

    async updateConversation(userId, conversationId, updates) {
        const userPrefix = this.getUserPrefix(userId);
        const fields = Object.keys(updates).map(key => `${key} = @${key}`).join(', ');
        const sql = `
            UPDATE ${userPrefix}_conversations 
            SET ${fields}, updated_at = @updated_at
            WHERE id = @id
        `;
        return sqliteService.executeNonQuery(sql, {
            ...updates,
            id: conversationId,
            updated_at: Date.now()
        });
    },

    async updateUnreadCount(userId, conversationId, delta) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            UPDATE ${userPrefix}_conversations 
            SET unread_count = unread_count + @delta,
                updated_at = @timestamp
            WHERE id = @id
        `;
        return sqliteService.executeNonQuery(sql, {
            id: conversationId,
            delta,
            timestamp: Date.now()
        });
    },

    async archiveConversation(userId, conversationId, archived = true) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            UPDATE ${userPrefix}_conversations 
            SET is_archived = @archived, updated_at = @timestamp
            WHERE id = @id
        `;
        return sqliteService.executeNonQuery(sql, {
            id: conversationId,
            archived: archived ? 1 : 0,
            timestamp: Date.now()
        });
    },

    // Encryption key operations
    async saveEncryptionKey(userId, keyData) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            INSERT OR REPLACE INTO ${userPrefix}_encryption_keys (
                id, user_id, key_type, key_id, public_key,
                private_key_encrypted, signature, key_metadata
            ) VALUES (
                @id, @user_id, @key_type, @key_id, @public_key,
                @private_key_encrypted, @signature, @key_metadata
            )
        `;
        return sqliteService.executeNonQuery(sql, {
            id: keyData.id || this.generateId(),
            ...keyData
        });
    },

    async getEncryptionKeys(userId, targetUserId, keyType = null) {
        const userPrefix = this.getUserPrefix(userId);
        let sql = `
            SELECT * FROM ${userPrefix}_encryption_keys 
            WHERE user_id = @user_id
        `;
        if (keyType) {
            sql += ` AND key_type = @key_type`;
        }
        sql += ` ORDER BY created_at DESC`;

        const keys = [];
        await sqliteService.execute((row) => {
            keys.push(row);
        }, sql, { user_id: targetUserId, key_type: keyType });
        return keys;
    },

    async consumeOneTimeKey(userId, targetUserId) {
        const userPrefix = this.getUserPrefix(userId);
        
        // Get an unconsumed one-time key
        let key = null;
        const selectSql = `
            SELECT * FROM ${userPrefix}_encryption_keys 
            WHERE user_id = @user_id 
              AND key_type = 'onetime_prekey'
              AND consumed_at IS NULL
            ORDER BY key_id
            LIMIT 1
        `;
        await sqliteService.execute((row) => {
            key = row;
        }, selectSql, { user_id: targetUserId });

        if (key) {
            // Mark it as consumed
            const updateSql = `
                UPDATE ${userPrefix}_encryption_keys 
                SET consumed_at = @timestamp
                WHERE id = @id
            `;
            await sqliteService.executeNonQuery(updateSql, {
                id: key.id,
                timestamp: Date.now()
            });
        }

        return key;
    },

    // Session operations
    async saveSession(userId, sessionData) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            INSERT OR REPLACE INTO ${userPrefix}_sessions (
                id, user_id, device_id, session_record
            ) VALUES (
                @id, @user_id, @device_id, @session_record
            )
        `;
        return sqliteService.executeNonQuery(sql, {
            id: `${sessionData.user_id}:${sessionData.device_id || 1}`,
            ...sessionData
        });
    },

    async getSession(userId, targetUserId, deviceId = 1) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            SELECT * FROM ${userPrefix}_sessions 
            WHERE id = @id
        `;
        let session = null;
        await sqliteService.execute((row) => {
            session = row;
        }, sql, { id: `${targetUserId}:${deviceId}` });
        return session;
    },

    // Message queue operations
    async queueMessage(userId, queueData) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            INSERT INTO ${userPrefix}_message_queue (
                message_id, conversation_id, operation, payload, next_retry_at
            ) VALUES (
                @message_id, @conversation_id, @operation, @payload, @next_retry_at
            )
        `;
        return sqliteService.executeNonQuery(sql, {
            ...queueData,
            next_retry_at: queueData.next_retry_at || Date.now()
        });
    },

    async getQueuedMessages(userId, limit = 10) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            SELECT * FROM ${userPrefix}_message_queue 
            WHERE retry_count < max_retries 
              AND next_retry_at <= @now
            ORDER BY created_at
            LIMIT @limit
        `;
        const messages = [];
        await sqliteService.execute((row) => {
            messages.push(row);
        }, sql, { now: Date.now(), limit });
        return messages;
    },

    async updateQueuedMessage(userId, queueId, updates) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            UPDATE ${userPrefix}_message_queue 
            SET retry_count = retry_count + 1,
                next_retry_at = @next_retry_at
            WHERE id = @id
        `;
        return sqliteService.executeNonQuery(sql, {
            id: queueId,
            next_retry_at: Date.now() + (updates.backoff || 5000)
        });
    },

    async removeFromQueue(userId, queueId) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `DELETE FROM ${userPrefix}_message_queue WHERE id = @id`;
        return sqliteService.executeNonQuery(sql, { id: queueId });
    },

    // Trust management
    async saveTrustedKey(userId, trustData) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            INSERT OR REPLACE INTO ${userPrefix}_trusted_keys (
                id, user_id, identity_key, trust_level,
                safety_number, verified_at, verified_by
            ) VALUES (
                @id, @user_id, @identity_key, @trust_level,
                @safety_number, @verified_at, @verified_by
            )
        `;
        return sqliteService.executeNonQuery(sql, {
            id: trustData.id || this.generateId(),
            ...trustData
        });
    },

    async getTrustedKey(userId, targetUserId) {
        const userPrefix = this.getUserPrefix(userId);
        const sql = `
            SELECT * FROM ${userPrefix}_trusted_keys 
            WHERE user_id = @user_id
        `;
        let key = null;
        await sqliteService.execute((row) => {
            key = row;
        }, sql, { user_id: targetUserId });
        return key;
    },

    // Utility functions
    generateId() {
        // Generate a UUID-like ID
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = Math.random() * 16 | 0;
            const v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    },

    // Statistics and maintenance
    async getMessageCount(userId, conversationId = null) {
        const userPrefix = this.getUserPrefix(userId);
        let sql = `SELECT COUNT(*) as count FROM ${userPrefix}_messages`;
        const params = {};
        
        if (conversationId) {
            sql += ` WHERE conversation_id = @conversation_id`;
            params.conversation_id = conversationId;
        }

        let count = 0;
        await sqliteService.execute((row) => {
            count = row.count;
        }, sql, params);
        return count;
    },

    async cleanupOldMessages(userId, daysToKeep = 90) {
        const userPrefix = this.getUserPrefix(userId);
        const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
        
        const sql = `
            DELETE FROM ${userPrefix}_messages 
            WHERE timestamp < @cutoff
        `;
        return sqliteService.executeNonQuery(sql, { cutoff: cutoffTime });
    },

    async getStorageSize(userId) {
        const userPrefix = this.getUserPrefix(userId);
        const tables = [
            '_messages', '_conversations', '_encryption_keys',
            '_sessions', '_message_queue', '_trusted_keys', '_attachments'
        ];
        
        let totalSize = 0;
        for (const table of tables) {
            const sql = `
                SELECT SUM(LENGTH(id) + LENGTH(CAST(created_at AS TEXT))) as size 
                FROM ${userPrefix}${table}
            `;
            await sqliteService.execute((row) => {
                totalSize += row.size || 0;
            }, sql);
        }
        
        return totalSize;
    }
};

export { messagesDb as default, messagesDb };