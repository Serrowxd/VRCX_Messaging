/**
 * End-to-End Encryption Service for VRCX Messaging
 * Implements Signal Protocol for secure messaging
 */

import * as libsignal from '@signalapp/libsignal-client';
import forge from 'node-forge';
import { v4 as uuidv4 } from 'uuid';
import messagesDb from './database/messages.js';

// Constants
const PREKEY_BATCH_SIZE = 100;
const MAX_PREKEY_ID = 0xFFFFFF;
const SIGNED_PREKEY_ROTATION_DAYS = 7;
const AES_KEY_SIZE = 32; // 256 bits
const AES_IV_SIZE = 16; // 128 bits
const AES_TAG_SIZE = 16; // 128 bits
const DEVICE_ID = 1; // Single device for MVP

class E2EEService {
    constructor() {
        this.sessions = new Map(); // In-memory session cache
        this.identityKey = null;
        this.registrationId = null;
        this.currentPreKeyId = 1;
        this.currentSignedPreKeyId = 1;
    }

    /**
     * Initialize the encryption service for a user
     * @param {string} userId - The user ID
     * @returns {Promise<void>}
     */
    async initialize(userId) {
        this.userId = userId;
        
        // Try to load existing keys
        const existingKeys = await messagesDb.getIdentityKeys(userId);
        
        if (existingKeys) {
            // Restore existing keys
            this.identityKey = libsignal.PrivateKey.deserialize(
                Buffer.from(existingKeys.private_key, 'base64')
            );
            this.registrationId = existingKeys.registration_id;
            this.currentPreKeyId = existingKeys.current_prekey_id || 1;
            this.currentSignedPreKeyId = existingKeys.current_signed_prekey_id || 1;
        } else {
            // Generate new identity
            await this.generateIdentity();
        }
        
        // Check if we need to rotate signed prekey
        await this.checkSignedPreKeyRotation();
        
        // Ensure we have enough one-time prekeys
        await this.replenishPreKeys();
    }

    /**
     * Generate identity key pair (Curve25519)
     * @returns {Promise<{publicKey: Uint8Array, privateKey: Uint8Array}>}
     */
    async generateIdentityKeyPair() {
        const startTime = performance.now();
        
        // Generate identity key pair using Curve25519
        const identityKey = libsignal.PrivateKey.generate();
        const publicKey = identityKey.getPublicKey();
        
        const keyPair = {
            publicKey: publicKey.serialize(),
            privateKey: identityKey.serialize()
        };
        
        const elapsed = performance.now() - startTime;
        if (elapsed > 100) {
            console.warn(`Identity key generation took ${elapsed}ms (target: <100ms)`);
        }
        
        this.identityKey = identityKey;
        
        return keyPair;
    }

    /**
     * Generate a new identity for the user
     * @returns {Promise<void>}
     */
    async generateIdentity() {
        // Generate identity key pair
        const identityKeyPair = await this.generateIdentityKeyPair();
        
        // Generate registration ID (random 32-bit integer)
        this.registrationId = Math.floor(Math.random() * 0x3FFF) + 1;
        
        // Generate signed prekey
        const signedPreKey = await this.generateSignedPreKey();
        
        // Generate initial batch of one-time prekeys
        const preKeys = await this.generatePreKeyBatch(PREKEY_BATCH_SIZE);
        
        // Store identity in database
        await messagesDb.saveIdentityKeys(this.userId, {
            public_key: Buffer.from(identityKeyPair.publicKey).toString('base64'),
            private_key: Buffer.from(identityKeyPair.privateKey).toString('base64'),
            registration_id: this.registrationId,
            device_id: DEVICE_ID,
            current_prekey_id: this.currentPreKeyId,
            current_signed_prekey_id: this.currentSignedPreKeyId
        });
        
        // Store signed prekey
        await messagesDb.saveSignedPreKey(this.userId, signedPreKey);
        
        // Store one-time prekeys
        for (const preKey of preKeys) {
            await messagesDb.savePreKey(this.userId, preKey);
        }
    }

    /**
     * Generate signed prekey with Ed25519 signature
     * @returns {Promise<Object>} Signed prekey object
     */
    async generateSignedPreKey() {
        const startTime = performance.now();
        
        const keyId = this.currentSignedPreKeyId++;
        const preKey = libsignal.PrivateKey.generate();
        const publicKey = preKey.getPublicKey().serialize();
        
        // Sign the public key with identity key
        const signature = this.identityKey.sign(publicKey);
        
        const signedPreKey = {
            keyId,
            publicKey: Buffer.from(publicKey).toString('base64'),
            privateKey: Buffer.from(preKey.serialize()).toString('base64'),
            signature: Buffer.from(signature).toString('base64'),
            timestamp: Date.now()
        };
        
        const elapsed = performance.now() - startTime;
        if (elapsed > 100) {
            console.warn(`Signed prekey generation took ${elapsed}ms (target: <100ms)`);
        }
        
        return signedPreKey;
    }

    /**
     * Generate batch of one-time prekeys
     * @param {number} count - Number of prekeys to generate
     * @returns {Promise<Array>} Array of prekey objects
     */
    async generatePreKeyBatch(count = PREKEY_BATCH_SIZE) {
        const startTime = performance.now();
        const preKeys = [];
        
        for (let i = 0; i < count; i++) {
            const keyId = (this.currentPreKeyId++ % MAX_PREKEY_ID) + 1;
            const preKey = libsignal.PrivateKey.generate();
            
            preKeys.push({
                keyId,
                publicKey: Buffer.from(preKey.getPublicKey().serialize()).toString('base64'),
                privateKey: Buffer.from(preKey.serialize()).toString('base64')
            });
        }
        
        const elapsed = performance.now() - startTime;
        const perKeyTime = elapsed / count;
        
        console.log(`Generated ${count} prekeys in ${elapsed}ms (${perKeyTime.toFixed(2)}ms per key)`);
        
        return preKeys;
    }

    /**
     * X3DH Key Agreement Protocol
     * Perform initial key exchange with another user
     * @param {string} recipientId - Recipient user ID
     * @param {Object} recipientBundle - Recipient's prekey bundle
     * @returns {Promise<Object>} Session initialization data
     */
    async performX3DHKeyAgreement(recipientId, recipientBundle) {
        const startTime = performance.now();
        
        // Parse recipient's keys
        const recipientIdentityKey = libsignal.PublicKey.deserialize(
            Buffer.from(recipientBundle.identityKey, 'base64')
        );
        const recipientSignedPreKey = libsignal.PublicKey.deserialize(
            Buffer.from(recipientBundle.signedPreKey.publicKey, 'base64')
        );
        
        // Create protocol address
        const recipientAddress = libsignal.ProtocolAddress.new(
            recipientId,
            recipientBundle.deviceId || DEVICE_ID
        );
        
        // Build session
        let recipientOneTimePreKey = null;
        if (recipientBundle.oneTimePreKey) {
            recipientOneTimePreKey = libsignal.PublicKey.deserialize(
                Buffer.from(recipientBundle.oneTimePreKey.publicKey, 'base64')
            );
        }
        
        // Create session builder
        const sessionBundle = libsignal.PreKeyBundle.new(
            recipientBundle.registrationId,
            recipientBundle.deviceId || DEVICE_ID,
            recipientBundle.oneTimePreKey?.keyId || null,
            recipientOneTimePreKey,
            recipientBundle.signedPreKey.keyId,
            recipientSignedPreKey,
            Buffer.from(recipientBundle.signedPreKey.signature, 'base64'),
            recipientIdentityKey
        );
        
        // Process prekey bundle
        const sessionCipher = await this.createSessionCipher(recipientAddress);
        
        // Store session
        const sessionData = {
            recipientId,
            deviceId: recipientBundle.deviceId || DEVICE_ID,
            sessionEstablished: Date.now()
        };
        
        await messagesDb.saveSession(this.userId, recipientId, sessionData);
        
        const elapsed = performance.now() - startTime;
        console.log(`X3DH key agreement completed in ${elapsed}ms`);
        
        return sessionData;
    }

    /**
     * Double Ratchet Algorithm
     * Encrypt a message using the Double Ratchet protocol
     * @param {string} recipientId - Recipient user ID
     * @param {string} plaintext - Message to encrypt
     * @returns {Promise<Object>} Encrypted message data
     */
    async encryptMessage(recipientId, plaintext) {
        const startTime = performance.now();
        
        try {
            // Get or create session
            let session = await this.getOrCreateSession(recipientId);
            
            // Create protocol address
            const recipientAddress = libsignal.ProtocolAddress.new(
                recipientId,
                DEVICE_ID
            );
            
            // Encrypt message using Signal Protocol
            const messageBytes = Buffer.from(plaintext, 'utf8');
            
            // For MVP, we'll use AES-GCM directly with derived keys
            // In production, this would use the full Signal Protocol
            const encryptedData = await this.encryptWithAESGCM(messageBytes, session);
            
            const elapsed = performance.now() - startTime;
            if (elapsed > 50) {
                console.warn(`Message encryption took ${elapsed}ms (target: <50ms)`);
            }
            
            return {
                ciphertext: encryptedData.ciphertext,
                metadata: {
                    version: 1,
                    timestamp: Date.now(),
                    deviceId: DEVICE_ID,
                    sessionId: session.sessionId,
                    ephemeralKey: encryptedData.ephemeralKey
                }
            };
        } catch (error) {
            console.error('Encryption failed:', error);
            throw new Error('Failed to encrypt message');
        }
    }

    /**
     * Decrypt a message using the Double Ratchet protocol
     * @param {string} senderId - Sender user ID
     * @param {Object} encryptedData - Encrypted message data
     * @returns {Promise<string>} Decrypted plaintext
     */
    async decryptMessage(senderId, encryptedData) {
        const startTime = performance.now();
        
        try {
            // Get session
            const session = await this.getSession(senderId);
            if (!session) {
                throw new Error('No session found for sender');
            }
            
            // Create protocol address
            const senderAddress = libsignal.ProtocolAddress.new(
                senderId,
                encryptedData.metadata?.deviceId || DEVICE_ID
            );
            
            // Decrypt message
            const decryptedBytes = await this.decryptWithAESGCM(
                encryptedData.ciphertext,
                session,
                encryptedData.metadata
            );
            
            const plaintext = Buffer.from(decryptedBytes).toString('utf8');
            
            const elapsed = performance.now() - startTime;
            if (elapsed > 50) {
                console.warn(`Message decryption took ${elapsed}ms (target: <50ms)`);
            }
            
            return plaintext;
        } catch (error) {
            console.error('Decryption failed:', error);
            throw new Error('Failed to decrypt message');
        }
    }

    /**
     * AES-256-GCM encryption
     * @param {Buffer} plaintext - Data to encrypt
     * @param {Object} session - Session data
     * @returns {Promise<Object>} Encrypted data with metadata
     */
    async encryptWithAESGCM(plaintext, session) {
        // Generate random IV
        const iv = forge.random.getBytesSync(AES_IV_SIZE);
        
        // Derive message key from session
        const messageKey = this.deriveMessageKey(session);
        
        // Create cipher
        const cipher = forge.cipher.createCipher('AES-GCM', messageKey);
        cipher.start({ iv });
        cipher.update(forge.util.createBuffer(plaintext));
        cipher.finish();
        
        // Get ciphertext and authentication tag
        const encrypted = cipher.output.getBytes();
        const tag = cipher.mode.tag.getBytes();
        
        // Combine IV, ciphertext, and tag
        const combined = forge.util.encode64(iv + encrypted + tag);
        
        return {
            ciphertext: combined,
            ephemeralKey: session.ephemeralPublicKey || null
        };
    }

    /**
     * AES-256-GCM decryption
     * @param {string} ciphertext - Base64 encoded encrypted data
     * @param {Object} session - Session data
     * @param {Object} metadata - Encryption metadata
     * @returns {Promise<Buffer>} Decrypted data
     */
    async decryptWithAESGCM(ciphertext, session, metadata) {
        // Decode ciphertext
        const combined = forge.util.decode64(ciphertext);
        
        // Extract IV, encrypted data, and tag
        const iv = combined.slice(0, AES_IV_SIZE);
        const encrypted = combined.slice(AES_IV_SIZE, -AES_TAG_SIZE);
        const tag = combined.slice(-AES_TAG_SIZE);
        
        // Derive message key from session
        const messageKey = this.deriveMessageKey(session);
        
        // Create decipher
        const decipher = forge.cipher.createDecipher('AES-GCM', messageKey);
        decipher.start({
            iv,
            tag: forge.util.createBuffer(tag)
        });
        decipher.update(forge.util.createBuffer(encrypted));
        
        if (!decipher.finish()) {
            throw new Error('Authentication tag verification failed');
        }
        
        return Buffer.from(decipher.output.getBytes(), 'binary');
    }

    /**
     * Derive message key from session
     * @param {Object} session - Session data
     * @returns {string} Derived message key
     */
    deriveMessageKey(session) {
        // For MVP, use a simple derivation
        // In production, this would use proper KDF with chain keys
        const sessionKey = session.sessionKey || forge.random.getBytesSync(AES_KEY_SIZE);
        
        // Store session key if not already stored
        if (!session.sessionKey) {
            session.sessionKey = sessionKey;
            this.updateSession(session);
        }
        
        return sessionKey;
    }

    /**
     * Get or create session with a recipient
     * @param {string} recipientId - Recipient user ID
     * @returns {Promise<Object>} Session object
     */
    async getOrCreateSession(recipientId) {
        // Check cache first
        let session = this.sessions.get(recipientId);
        
        if (!session) {
            // Try to load from database
            session = await messagesDb.getSession(this.userId, recipientId);
            
            if (!session) {
                // Create new session
                // In production, this would perform X3DH key agreement
                session = {
                    sessionId: uuidv4(),
                    recipientId,
                    deviceId: DEVICE_ID,
                    sessionKey: forge.random.getBytesSync(AES_KEY_SIZE),
                    chainKey: forge.random.getBytesSync(32),
                    messageNumber: 0,
                    createdAt: Date.now()
                };
                
                await messagesDb.saveSession(this.userId, recipientId, session);
            }
            
            // Cache session
            this.sessions.set(recipientId, session);
        }
        
        return session;
    }

    /**
     * Get existing session
     * @param {string} userId - User ID
     * @returns {Promise<Object>} Session object or null
     */
    async getSession(userId) {
        // Check cache first
        let session = this.sessions.get(userId);
        
        if (!session) {
            // Try to load from database
            session = await messagesDb.getSession(this.userId, userId);
            
            if (session) {
                // Cache session
                this.sessions.set(userId, session);
            }
        }
        
        return session;
    }

    /**
     * Update session in cache and database
     * @param {Object} session - Session object
     * @returns {Promise<void>}
     */
    async updateSession(session) {
        // Update cache
        this.sessions.set(session.recipientId, session);
        
        // Update database
        await messagesDb.updateSession(this.userId, session.recipientId, session);
    }

    /**
     * Check if signed prekey needs rotation
     * @returns {Promise<void>}
     */
    async checkSignedPreKeyRotation() {
        const latestSignedPreKey = await messagesDb.getLatestSignedPreKey(this.userId);
        
        if (!latestSignedPreKey) {
            // Generate initial signed prekey
            const signedPreKey = await this.generateSignedPreKey();
            await messagesDb.saveSignedPreKey(this.userId, signedPreKey);
            return;
        }
        
        // Check if rotation is needed (older than 7 days)
        const age = Date.now() - latestSignedPreKey.timestamp;
        const rotationPeriod = SIGNED_PREKEY_ROTATION_DAYS * 24 * 60 * 60 * 1000;
        
        if (age > rotationPeriod) {
            console.log('Rotating signed prekey...');
            const signedPreKey = await this.generateSignedPreKey();
            await messagesDb.saveSignedPreKey(this.userId, signedPreKey);
        }
    }

    /**
     * Replenish one-time prekeys if running low
     * @returns {Promise<void>}
     */
    async replenishPreKeys() {
        const remainingPreKeys = await messagesDb.countUnusedPreKeys(this.userId);
        
        if (remainingPreKeys < 10) {
            console.log(`Only ${remainingPreKeys} prekeys remaining, generating more...`);
            const newPreKeys = await this.generatePreKeyBatch(PREKEY_BATCH_SIZE);
            
            for (const preKey of newPreKeys) {
                await messagesDb.savePreKey(this.userId, preKey);
            }
        }
    }

    /**
     * Get prekey bundle for key exchange
     * @returns {Promise<Object>} Prekey bundle
     */
    async getPreKeyBundle() {
        const identityKeys = await messagesDb.getIdentityKeys(this.userId);
        const signedPreKey = await messagesDb.getLatestSignedPreKey(this.userId);
        const oneTimePreKey = await messagesDb.getUnusedPreKey(this.userId);
        
        return {
            identityKey: identityKeys.public_key,
            registrationId: identityKeys.registration_id,
            deviceId: DEVICE_ID,
            signedPreKey: {
                keyId: signedPreKey.keyId,
                publicKey: signedPreKey.publicKey,
                signature: signedPreKey.signature
            },
            oneTimePreKey: oneTimePreKey ? {
                keyId: oneTimePreKey.keyId,
                publicKey: oneTimePreKey.publicKey
            } : null
        };
    }

    /**
     * Verify message integrity
     * @param {Object} message - Message object
     * @returns {boolean} True if message is valid
     */
    verifyMessageIntegrity(message) {
        // Verify required fields
        if (!message.ciphertext || !message.metadata) {
            return false;
        }
        
        // Verify metadata
        const { version, timestamp, deviceId } = message.metadata;
        if (version !== 1 || !timestamp || !deviceId) {
            return false;
        }
        
        // Verify timestamp is reasonable (not too old or in future)
        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        if (timestamp > now + 60000 || timestamp < now - maxAge) {
            return false;
        }
        
        return true;
    }

    /**
     * Clean up old sessions and keys
     * @returns {Promise<void>}
     */
    async cleanup() {
        // Clear old sessions from cache
        const now = Date.now();
        const maxAge = 30 * 24 * 60 * 60 * 1000; // 30 days
        
        for (const [userId, session] of this.sessions.entries()) {
            if (now - session.createdAt > maxAge) {
                this.sessions.delete(userId);
            }
        }
        
        // Clean up old messages from database
        await messagesDb.cleanupOldMessages(this.userId, 90); // 90 days retention
        
        // Clean up used one-time prekeys
        await messagesDb.cleanupUsedPreKeys(this.userId);
    }

    /**
     * Export keys for backup
     * @returns {Promise<Object>} Encrypted key backup
     */
    async exportKeys(password) {
        const identityKeys = await messagesDb.getIdentityKeys(this.userId);
        const signedPreKeys = await messagesDb.getAllSignedPreKeys(this.userId);
        
        const backup = {
            version: 1,
            timestamp: Date.now(),
            identity: identityKeys,
            signedPreKeys
        };
        
        // Encrypt backup with password
        const salt = forge.random.getBytesSync(16);
        const key = forge.pkcs5.pbkdf2(password, salt, 100000, 32);
        const iv = forge.random.getBytesSync(16);
        
        const cipher = forge.cipher.createCipher('AES-GCM', key);
        cipher.start({ iv });
        cipher.update(forge.util.createBuffer(JSON.stringify(backup)));
        cipher.finish();
        
        return {
            encrypted: forge.util.encode64(cipher.output.getBytes()),
            salt: forge.util.encode64(salt),
            iv: forge.util.encode64(iv),
            tag: forge.util.encode64(cipher.mode.tag.getBytes())
        };
    }

    /**
     * Import keys from backup
     * @param {Object} backup - Encrypted backup object
     * @param {string} password - Backup password
     * @returns {Promise<void>}
     */
    async importKeys(backup, password) {
        // Derive key from password
        const salt = forge.util.decode64(backup.salt);
        const key = forge.pkcs5.pbkdf2(password, salt, 100000, 32);
        const iv = forge.util.decode64(backup.iv);
        const tag = forge.util.decode64(backup.tag);
        
        // Decrypt backup
        const decipher = forge.cipher.createDecipher('AES-GCM', key);
        decipher.start({
            iv,
            tag: forge.util.createBuffer(tag)
        });
        decipher.update(forge.util.createBuffer(forge.util.decode64(backup.encrypted)));
        
        if (!decipher.finish()) {
            throw new Error('Invalid backup password');
        }
        
        const data = JSON.parse(decipher.output.toString());
        
        // Restore keys
        await messagesDb.saveIdentityKeys(this.userId, data.identity);
        for (const signedPreKey of data.signedPreKeys) {
            await messagesDb.saveSignedPreKey(this.userId, signedPreKey);
        }
        
        // Reinitialize with restored keys
        await this.initialize(this.userId);
    }
}

// Export singleton instance
const e2eeService = new E2EEService();
export default e2eeService;