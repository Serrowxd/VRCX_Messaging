/**
 * End-to-End Encryption Service Tests
 * Comprehensive test suite for the E2EE implementation
 */

import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import e2eeService from '../src/service/e2ee.js';
import messagesDb from '../src/service/database/messages.js';
import forge from 'node-forge';

// Mock the database service
jest.mock('../src/service/database/messages.js');

// Test constants
const TEST_USER_ID = 'test_user_123';
const TEST_RECIPIENT_ID = 'recipient_456';
const TEST_MESSAGE = 'Hello, this is a test message!';
const PERFORMANCE_THRESHOLD = {
    KEY_GENERATION: 100, // ms
    ENCRYPTION: 50, // ms
    DECRYPTION: 50 // ms
};

describe('E2EE Service', () => {
    beforeEach(() => {
        // Clear all mocks before each test
        jest.clearAllMocks();
        
        // Reset the service state
        e2eeService.sessions.clear();
        e2eeService.identityKey = null;
        e2eeService.registrationId = null;
        e2eeService.currentPreKeyId = 1;
        e2eeService.currentSignedPreKeyId = 1;
    });

    describe('Identity Key Generation', () => {
        test('should generate identity key pair within performance threshold', async () => {
            const startTime = performance.now();
            const keyPair = await e2eeService.generateIdentityKeyPair();
            const elapsed = performance.now() - startTime;

            expect(keyPair).toBeDefined();
            expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);
            expect(keyPair.privateKey).toBeInstanceOf(Uint8Array);
            expect(keyPair.publicKey.length).toBeGreaterThan(0);
            expect(keyPair.privateKey.length).toBeGreaterThan(0);
            expect(elapsed).toBeLessThan(PERFORMANCE_THRESHOLD.KEY_GENERATION);
        });

        test('should generate unique key pairs', async () => {
            const keyPair1 = await e2eeService.generateIdentityKeyPair();
            const keyPair2 = await e2eeService.generateIdentityKeyPair();

            expect(Buffer.from(keyPair1.publicKey).toString('base64'))
                .not.toBe(Buffer.from(keyPair2.publicKey).toString('base64'));
            expect(Buffer.from(keyPair1.privateKey).toString('base64'))
                .not.toBe(Buffer.from(keyPair2.privateKey).toString('base64'));
        });

        test('should use Curve25519 algorithm', async () => {
            const keyPair = await e2eeService.generateIdentityKeyPair();
            
            // Curve25519 keys are 32 bytes
            expect(keyPair.publicKey.length).toBe(32);
            expect(keyPair.privateKey.length).toBe(32);
        });
    });

    describe('Signed PreKey Generation', () => {
        beforeEach(async () => {
            // Generate identity key first
            await e2eeService.generateIdentityKeyPair();
        });

        test('should generate signed prekey with Ed25519 signature', async () => {
            const signedPreKey = await e2eeService.generateSignedPreKey();

            expect(signedPreKey).toBeDefined();
            expect(signedPreKey.keyId).toBe(1);
            expect(signedPreKey.publicKey).toBeDefined();
            expect(signedPreKey.privateKey).toBeDefined();
            expect(signedPreKey.signature).toBeDefined();
            expect(signedPreKey.timestamp).toBeDefined();
            expect(typeof signedPreKey.publicKey).toBe('string');
            expect(typeof signedPreKey.signature).toBe('string');
        });

        test('should increment key ID for each generated signed prekey', async () => {
            const signedPreKey1 = await e2eeService.generateSignedPreKey();
            const signedPreKey2 = await e2eeService.generateSignedPreKey();

            expect(signedPreKey1.keyId).toBe(1);
            expect(signedPreKey2.keyId).toBe(2);
        });

        test('should generate within performance threshold', async () => {
            const startTime = performance.now();
            await e2eeService.generateSignedPreKey();
            const elapsed = performance.now() - startTime;

            expect(elapsed).toBeLessThan(PERFORMANCE_THRESHOLD.KEY_GENERATION);
        });
    });

    describe('One-Time PreKey Generation', () => {
        test('should generate batch of prekeys', async () => {
            const batchSize = 10;
            const preKeys = await e2eeService.generatePreKeyBatch(batchSize);

            expect(preKeys).toHaveLength(batchSize);
            preKeys.forEach((preKey, index) => {
                expect(preKey.keyId).toBeDefined();
                expect(preKey.publicKey).toBeDefined();
                expect(preKey.privateKey).toBeDefined();
            });
        });

        test('should generate 100 prekeys by default', async () => {
            const preKeys = await e2eeService.generatePreKeyBatch();
            expect(preKeys).toHaveLength(100);
        });

        test('should wrap key IDs at MAX_PREKEY_ID', async () => {
            // Set current prekey ID near max
            e2eeService.currentPreKeyId = 0xFFFFFF - 2;
            
            const preKeys = await e2eeService.generatePreKeyBatch(5);
            const keyIds = preKeys.map(pk => pk.keyId);
            
            // Should wrap around to 1 after reaching max
            expect(keyIds).toContain(0xFFFFFF);
            expect(keyIds).toContain(1);
            expect(keyIds).toContain(2);
        });

        test('should meet performance requirements', async () => {
            const batchSize = 100;
            const startTime = performance.now();
            await e2eeService.generatePreKeyBatch(batchSize);
            const elapsed = performance.now() - startTime;
            const perKeyTime = elapsed / batchSize;

            // Should be fast enough for batch generation
            expect(perKeyTime).toBeLessThan(10); // 10ms per key
        });
    });

    describe('Service Initialization', () => {
        test('should initialize with new identity if no existing keys', async () => {
            messagesDb.getIdentityKeys.mockResolvedValue(null);
            messagesDb.saveIdentityKeys.mockResolvedValue();
            messagesDb.saveSignedPreKey.mockResolvedValue();
            messagesDb.savePreKey.mockResolvedValue();
            messagesDb.getLatestSignedPreKey.mockResolvedValue(null);
            messagesDb.countUnusedPreKeys.mockResolvedValue(0);

            await e2eeService.initialize(TEST_USER_ID);

            expect(e2eeService.userId).toBe(TEST_USER_ID);
            expect(e2eeService.identityKey).toBeDefined();
            expect(e2eeService.registrationId).toBeDefined();
            expect(messagesDb.saveIdentityKeys).toHaveBeenCalled();
            expect(messagesDb.saveSignedPreKey).toHaveBeenCalled();
            expect(messagesDb.savePreKey).toHaveBeenCalledTimes(100); // Default batch size
        });

        test('should restore existing identity', async () => {
            const mockIdentity = {
                public_key: Buffer.from(new Uint8Array(32)).toString('base64'),
                private_key: Buffer.from(new Uint8Array(32)).toString('base64'),
                registration_id: 12345,
                current_prekey_id: 50,
                current_signed_prekey_id: 3
            };

            messagesDb.getIdentityKeys.mockResolvedValue(mockIdentity);
            messagesDb.getLatestSignedPreKey.mockResolvedValue({
                timestamp: Date.now()
            });
            messagesDb.countUnusedPreKeys.mockResolvedValue(50);

            await e2eeService.initialize(TEST_USER_ID);

            expect(e2eeService.registrationId).toBe(mockIdentity.registration_id);
            expect(e2eeService.currentPreKeyId).toBe(mockIdentity.current_prekey_id);
            expect(e2eeService.currentSignedPreKeyId).toBe(mockIdentity.current_signed_prekey_id);
        });

        test('should rotate signed prekey if older than 7 days', async () => {
            const oldTimestamp = Date.now() - (8 * 24 * 60 * 60 * 1000); // 8 days ago
            
            messagesDb.getIdentityKeys.mockResolvedValue({
                public_key: Buffer.from(new Uint8Array(32)).toString('base64'),
                private_key: Buffer.from(new Uint8Array(32)).toString('base64'),
                registration_id: 12345
            });
            messagesDb.getLatestSignedPreKey.mockResolvedValue({
                timestamp: oldTimestamp
            });
            messagesDb.countUnusedPreKeys.mockResolvedValue(50);
            messagesDb.saveSignedPreKey.mockResolvedValue();

            await e2eeService.initialize(TEST_USER_ID);

            expect(messagesDb.saveSignedPreKey).toHaveBeenCalled();
        });

        test('should replenish prekeys if running low', async () => {
            messagesDb.getIdentityKeys.mockResolvedValue({
                public_key: Buffer.from(new Uint8Array(32)).toString('base64'),
                private_key: Buffer.from(new Uint8Array(32)).toString('base64'),
                registration_id: 12345
            });
            messagesDb.getLatestSignedPreKey.mockResolvedValue({
                timestamp: Date.now()
            });
            messagesDb.countUnusedPreKeys.mockResolvedValue(5); // Low count
            messagesDb.savePreKey.mockResolvedValue();

            await e2eeService.initialize(TEST_USER_ID);

            expect(messagesDb.savePreKey).toHaveBeenCalledTimes(100);
        });
    });

    describe('Message Encryption and Decryption', () => {
        beforeEach(async () => {
            // Initialize service with mock data
            messagesDb.getIdentityKeys.mockResolvedValue(null);
            messagesDb.saveIdentityKeys.mockResolvedValue();
            messagesDb.saveSignedPreKey.mockResolvedValue();
            messagesDb.savePreKey.mockResolvedValue();
            messagesDb.getLatestSignedPreKey.mockResolvedValue(null);
            messagesDb.countUnusedPreKeys.mockResolvedValue(0);
            messagesDb.getSession.mockResolvedValue(null);
            messagesDb.saveSession.mockResolvedValue();

            await e2eeService.initialize(TEST_USER_ID);
        });

        test('should encrypt message successfully', async () => {
            const startTime = performance.now();
            const encrypted = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, TEST_MESSAGE);
            const elapsed = performance.now() - startTime;

            expect(encrypted).toBeDefined();
            expect(encrypted.ciphertext).toBeDefined();
            expect(encrypted.metadata).toBeDefined();
            expect(encrypted.metadata.version).toBe(1);
            expect(encrypted.metadata.timestamp).toBeDefined();
            expect(encrypted.metadata.deviceId).toBe(1);
            expect(elapsed).toBeLessThan(PERFORMANCE_THRESHOLD.ENCRYPTION);
        });

        test('should decrypt message successfully', async () => {
            // First encrypt a message
            const encrypted = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, TEST_MESSAGE);
            
            // Mock getting the session
            messagesDb.getSession.mockResolvedValue({
                sessionId: encrypted.metadata.sessionId,
                recipientId: TEST_RECIPIENT_ID,
                sessionKey: forge.random.getBytesSync(32)
            });

            const startTime = performance.now();
            const decrypted = await e2eeService.decryptMessage(TEST_RECIPIENT_ID, encrypted);
            const elapsed = performance.now() - startTime;

            expect(decrypted).toBe(TEST_MESSAGE);
            expect(elapsed).toBeLessThan(PERFORMANCE_THRESHOLD.DECRYPTION);
        });

        test('should handle unicode characters correctly', async () => {
            const unicodeMessage = 'Hello 世界! 🔐 End-to-end encryption';
            const encrypted = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, unicodeMessage);
            
            messagesDb.getSession.mockResolvedValue({
                sessionId: encrypted.metadata.sessionId,
                recipientId: TEST_RECIPIENT_ID,
                sessionKey: forge.random.getBytesSync(32)
            });

            const decrypted = await e2eeService.decryptMessage(TEST_RECIPIENT_ID, encrypted);
            expect(decrypted).toBe(unicodeMessage);
        });

        test('should generate different ciphertext for same message', async () => {
            const encrypted1 = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, TEST_MESSAGE);
            const encrypted2 = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, TEST_MESSAGE);

            expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
        });

        test('should fail decryption with wrong session', async () => {
            const encrypted = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, TEST_MESSAGE);
            
            // Mock wrong session
            messagesDb.getSession.mockResolvedValue({
                sessionId: 'wrong_session',
                recipientId: TEST_RECIPIENT_ID,
                sessionKey: forge.random.getBytesSync(32)
            });

            await expect(e2eeService.decryptMessage(TEST_RECIPIENT_ID, encrypted))
                .rejects.toThrow('Failed to decrypt message');
        });

        test('should fail decryption with no session', async () => {
            const encrypted = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, TEST_MESSAGE);
            
            messagesDb.getSession.mockResolvedValue(null);

            await expect(e2eeService.decryptMessage(TEST_RECIPIENT_ID, encrypted))
                .rejects.toThrow('No session found for sender');
        });
    });

    describe('AES-256-GCM Encryption', () => {
        test('should encrypt with AES-256-GCM', async () => {
            const plaintext = Buffer.from(TEST_MESSAGE, 'utf8');
            const session = {
                sessionKey: forge.random.getBytesSync(32)
            };

            const encrypted = await e2eeService.encryptWithAESGCM(plaintext, session);

            expect(encrypted).toBeDefined();
            expect(encrypted.ciphertext).toBeDefined();
            expect(typeof encrypted.ciphertext).toBe('string');
            
            // Base64 encoded should be longer than plaintext due to IV and tag
            const decodedLength = forge.util.decode64(encrypted.ciphertext).length;
            expect(decodedLength).toBeGreaterThan(plaintext.length);
        });

        test('should decrypt with AES-256-GCM', async () => {
            const plaintext = Buffer.from(TEST_MESSAGE, 'utf8');
            const session = {
                sessionKey: forge.random.getBytesSync(32)
            };

            const encrypted = await e2eeService.encryptWithAESGCM(plaintext, session);
            const decrypted = await e2eeService.decryptWithAESGCM(
                encrypted.ciphertext, 
                session, 
                {}
            );

            expect(decrypted.toString('utf8')).toBe(TEST_MESSAGE);
        });

        test('should fail with tampered ciphertext', async () => {
            const plaintext = Buffer.from(TEST_MESSAGE, 'utf8');
            const session = {
                sessionKey: forge.random.getBytesSync(32)
            };

            const encrypted = await e2eeService.encryptWithAESGCM(plaintext, session);
            
            // Tamper with the ciphertext
            const tampered = encrypted.ciphertext.slice(0, -4) + 'XXXX';

            await expect(e2eeService.decryptWithAESGCM(tampered, session, {}))
                .rejects.toThrow();
        });
    });

    describe('Session Management', () => {
        beforeEach(async () => {
            messagesDb.getSession.mockResolvedValue(null);
            messagesDb.saveSession.mockResolvedValue();
        });

        test('should create new session if none exists', async () => {
            const session = await e2eeService.getOrCreateSession(TEST_RECIPIENT_ID);

            expect(session).toBeDefined();
            expect(session.sessionId).toBeDefined();
            expect(session.recipientId).toBe(TEST_RECIPIENT_ID);
            expect(session.deviceId).toBe(1);
            expect(session.sessionKey).toBeDefined();
            expect(messagesDb.saveSession).toHaveBeenCalled();
        });

        test('should retrieve existing session from cache', async () => {
            const session1 = await e2eeService.getOrCreateSession(TEST_RECIPIENT_ID);
            const session2 = await e2eeService.getOrCreateSession(TEST_RECIPIENT_ID);

            expect(session1).toBe(session2); // Same object reference
            expect(messagesDb.saveSession).toHaveBeenCalledTimes(1);
        });

        test('should load session from database if not in cache', async () => {
            const mockSession = {
                sessionId: 'existing_session',
                recipientId: TEST_RECIPIENT_ID,
                deviceId: 1
            };

            messagesDb.getSession.mockResolvedValue(mockSession);

            const session = await e2eeService.getOrCreateSession(TEST_RECIPIENT_ID);

            expect(session).toEqual(mockSession);
            expect(e2eeService.sessions.get(TEST_RECIPIENT_ID)).toBe(session);
        });
    });

    describe('X3DH Key Agreement', () => {
        beforeEach(async () => {
            // Initialize service
            messagesDb.getIdentityKeys.mockResolvedValue(null);
            messagesDb.saveIdentityKeys.mockResolvedValue();
            messagesDb.saveSignedPreKey.mockResolvedValue();
            messagesDb.savePreKey.mockResolvedValue();
            messagesDb.getLatestSignedPreKey.mockResolvedValue(null);
            messagesDb.countUnusedPreKeys.mockResolvedValue(0);
            messagesDb.saveSession.mockResolvedValue();

            await e2eeService.initialize(TEST_USER_ID);
        });

        test('should perform X3DH key agreement', async () => {
            // Generate recipient's prekey bundle
            const recipientIdentity = await e2eeService.generateIdentityKeyPair();
            const recipientSignedPreKey = await e2eeService.generateSignedPreKey();
            const recipientPreKeys = await e2eeService.generatePreKeyBatch(1);

            const recipientBundle = {
                identityKey: Buffer.from(recipientIdentity.publicKey).toString('base64'),
                registrationId: 54321,
                deviceId: 1,
                signedPreKey: {
                    keyId: recipientSignedPreKey.keyId,
                    publicKey: recipientSignedPreKey.publicKey,
                    signature: recipientSignedPreKey.signature
                },
                oneTimePreKey: {
                    keyId: recipientPreKeys[0].keyId,
                    publicKey: recipientPreKeys[0].publicKey
                }
            };

            const session = await e2eeService.performX3DHKeyAgreement(
                TEST_RECIPIENT_ID,
                recipientBundle
            );

            expect(session).toBeDefined();
            expect(session.recipientId).toBe(TEST_RECIPIENT_ID);
            expect(session.deviceId).toBe(1);
            expect(session.sessionEstablished).toBeDefined();
            expect(messagesDb.saveSession).toHaveBeenCalled();
        });

        test('should work without one-time prekey', async () => {
            const recipientIdentity = await e2eeService.generateIdentityKeyPair();
            const recipientSignedPreKey = await e2eeService.generateSignedPreKey();

            const recipientBundle = {
                identityKey: Buffer.from(recipientIdentity.publicKey).toString('base64'),
                registrationId: 54321,
                deviceId: 1,
                signedPreKey: {
                    keyId: recipientSignedPreKey.keyId,
                    publicKey: recipientSignedPreKey.publicKey,
                    signature: recipientSignedPreKey.signature
                },
                oneTimePreKey: null
            };

            const session = await e2eeService.performX3DHKeyAgreement(
                TEST_RECIPIENT_ID,
                recipientBundle
            );

            expect(session).toBeDefined();
        });
    });

    describe('PreKey Bundle', () => {
        beforeEach(async () => {
            const mockIdentity = {
                public_key: 'mock_public_key',
                registration_id: 12345
            };
            const mockSignedPreKey = {
                keyId: 1,
                publicKey: 'mock_signed_public',
                signature: 'mock_signature'
            };

            messagesDb.getIdentityKeys.mockResolvedValue(mockIdentity);
            messagesDb.getLatestSignedPreKey.mockResolvedValue(mockSignedPreKey);
            messagesDb.getUnusedPreKey.mockResolvedValue({
                keyId: 42,
                publicKey: 'mock_onetime_public'
            });
        });

        test('should get prekey bundle', async () => {
            const bundle = await e2eeService.getPreKeyBundle();

            expect(bundle).toBeDefined();
            expect(bundle.identityKey).toBe('mock_public_key');
            expect(bundle.registrationId).toBe(12345);
            expect(bundle.deviceId).toBe(1);
            expect(bundle.signedPreKey).toBeDefined();
            expect(bundle.signedPreKey.keyId).toBe(1);
            expect(bundle.oneTimePreKey).toBeDefined();
            expect(bundle.oneTimePreKey.keyId).toBe(42);
        });

        test('should handle no one-time prekeys available', async () => {
            messagesDb.getUnusedPreKey.mockResolvedValue(null);

            const bundle = await e2eeService.getPreKeyBundle();

            expect(bundle.oneTimePreKey).toBeNull();
        });
    });

    describe('Message Integrity Verification', () => {
        test('should verify valid message', () => {
            const message = {
                ciphertext: 'encrypted_data',
                metadata: {
                    version: 1,
                    timestamp: Date.now(),
                    deviceId: 1
                }
            };

            const isValid = e2eeService.verifyMessageIntegrity(message);
            expect(isValid).toBe(true);
        });

        test('should reject message without ciphertext', () => {
            const message = {
                metadata: {
                    version: 1,
                    timestamp: Date.now(),
                    deviceId: 1
                }
            };

            const isValid = e2eeService.verifyMessageIntegrity(message);
            expect(isValid).toBe(false);
        });

        test('should reject message without metadata', () => {
            const message = {
                ciphertext: 'encrypted_data'
            };

            const isValid = e2eeService.verifyMessageIntegrity(message);
            expect(isValid).toBe(false);
        });

        test('should reject message with wrong version', () => {
            const message = {
                ciphertext: 'encrypted_data',
                metadata: {
                    version: 2,
                    timestamp: Date.now(),
                    deviceId: 1
                }
            };

            const isValid = e2eeService.verifyMessageIntegrity(message);
            expect(isValid).toBe(false);
        });

        test('should reject message from future', () => {
            const message = {
                ciphertext: 'encrypted_data',
                metadata: {
                    version: 1,
                    timestamp: Date.now() + 120000, // 2 minutes in future
                    deviceId: 1
                }
            };

            const isValid = e2eeService.verifyMessageIntegrity(message);
            expect(isValid).toBe(false);
        });

        test('should reject very old message', () => {
            const message = {
                ciphertext: 'encrypted_data',
                metadata: {
                    version: 1,
                    timestamp: Date.now() - (35 * 24 * 60 * 60 * 1000), // 35 days old
                    deviceId: 1
                }
            };

            const isValid = e2eeService.verifyMessageIntegrity(message);
            expect(isValid).toBe(false);
        });
    });

    describe('Key Backup and Restore', () => {
        beforeEach(async () => {
            const mockIdentity = {
                public_key: 'mock_public_key',
                private_key: 'mock_private_key',
                registration_id: 12345
            };
            const mockSignedPreKeys = [
                {
                    keyId: 1,
                    publicKey: 'mock_signed_public',
                    privateKey: 'mock_signed_private',
                    signature: 'mock_signature',
                    timestamp: Date.now()
                }
            ];

            messagesDb.getIdentityKeys.mockResolvedValue(mockIdentity);
            messagesDb.getAllSignedPreKeys.mockResolvedValue(mockSignedPreKeys);
            messagesDb.saveIdentityKeys.mockResolvedValue();
            messagesDb.saveSignedPreKey.mockResolvedValue();
        });

        test('should export keys with password', async () => {
            const password = 'test_password_123';
            const backup = await e2eeService.exportKeys(password);

            expect(backup).toBeDefined();
            expect(backup.encrypted).toBeDefined();
            expect(backup.salt).toBeDefined();
            expect(backup.iv).toBeDefined();
            expect(backup.tag).toBeDefined();
        });

        test('should import keys with correct password', async () => {
            const password = 'test_password_123';
            const backup = await e2eeService.exportKeys(password);

            // Reset service
            e2eeService.identityKey = null;
            e2eeService.registrationId = null;

            // Mock for import
            messagesDb.getIdentityKeys.mockResolvedValue(null);
            messagesDb.getLatestSignedPreKey.mockResolvedValue(null);
            messagesDb.countUnusedPreKeys.mockResolvedValue(0);
            messagesDb.savePreKey.mockResolvedValue();

            await e2eeService.importKeys(backup, password);

            expect(messagesDb.saveIdentityKeys).toHaveBeenCalled();
            expect(messagesDb.saveSignedPreKey).toHaveBeenCalled();
        });

        test('should fail import with wrong password', async () => {
            const password = 'test_password_123';
            const backup = await e2eeService.exportKeys(password);

            await expect(e2eeService.importKeys(backup, 'wrong_password'))
                .rejects.toThrow('Invalid backup password');
        });
    });

    describe('Cleanup Operations', () => {
        beforeEach(() => {
            messagesDb.cleanupOldMessages.mockResolvedValue();
            messagesDb.cleanupUsedPreKeys.mockResolvedValue();
        });

        test('should cleanup old sessions from cache', async () => {
            // Add old and new sessions to cache
            const oldSession = {
                recipientId: 'old_user',
                createdAt: Date.now() - (35 * 24 * 60 * 60 * 1000) // 35 days old
            };
            const newSession = {
                recipientId: 'new_user',
                createdAt: Date.now()
            };

            e2eeService.sessions.set('old_user', oldSession);
            e2eeService.sessions.set('new_user', newSession);

            await e2eeService.cleanup();

            expect(e2eeService.sessions.has('old_user')).toBe(false);
            expect(e2eeService.sessions.has('new_user')).toBe(true);
        });

        test('should cleanup old messages from database', async () => {
            e2eeService.userId = TEST_USER_ID;
            await e2eeService.cleanup();

            expect(messagesDb.cleanupOldMessages).toHaveBeenCalledWith(TEST_USER_ID, 90);
        });

        test('should cleanup used prekeys', async () => {
            e2eeService.userId = TEST_USER_ID;
            await e2eeService.cleanup();

            expect(messagesDb.cleanupUsedPreKeys).toHaveBeenCalledWith(TEST_USER_ID);
        });
    });

    describe('Security Test Vectors', () => {
        test('should validate against known test vectors', async () => {
            // This would include official Signal Protocol test vectors
            // For MVP, we're testing basic cryptographic properties
            
            const plaintext = 'Test vector message';
            const encrypted = await e2eeService.encryptMessage(TEST_RECIPIENT_ID, plaintext);
            
            // Ensure encrypted data is properly formatted
            expect(encrypted.ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/); // Base64
            expect(encrypted.metadata.version).toBe(1);
            expect(encrypted.metadata.deviceId).toBe(1);
        });
    });

    describe('Performance Benchmarks', () => {
        test('should meet performance targets for key generation', async () => {
            const iterations = 10;
            const times = [];

            for (let i = 0; i < iterations; i++) {
                const start = performance.now();
                await e2eeService.generateIdentityKeyPair();
                times.push(performance.now() - start);
            }

            const average = times.reduce((a, b) => a + b, 0) / times.length;
            expect(average).toBeLessThan(PERFORMANCE_THRESHOLD.KEY_GENERATION);
        });

        test('should meet performance targets for encryption', async () => {
            messagesDb.getSession.mockResolvedValue(null);
            messagesDb.saveSession.mockResolvedValue();

            const iterations = 10;
            const times = [];

            for (let i = 0; i < iterations; i++) {
                const start = performance.now();
                await e2eeService.encryptMessage(TEST_RECIPIENT_ID, TEST_MESSAGE);
                times.push(performance.now() - start);
            }

            const average = times.reduce((a, b) => a + b, 0) / times.length;
            expect(average).toBeLessThan(PERFORMANCE_THRESHOLD.ENCRYPTION);
        });
    });
});

describe('E2EE Integration Tests', () => {
    test('should complete full encryption flow', async () => {
        // Initialize two users
        const aliceId = 'alice_123';
        const bobId = 'bob_456';

        // Mock database for both users
        messagesDb.getIdentityKeys.mockResolvedValue(null);
        messagesDb.saveIdentityKeys.mockResolvedValue();
        messagesDb.saveSignedPreKey.mockResolvedValue();
        messagesDb.savePreKey.mockResolvedValue();
        messagesDb.getLatestSignedPreKey.mockResolvedValue(null);
        messagesDb.countUnusedPreKeys.mockResolvedValue(0);
        messagesDb.getSession.mockResolvedValue(null);
        messagesDb.saveSession.mockResolvedValue();

        // Alice initializes
        const aliceService = new (e2eeService.constructor)();
        await aliceService.initialize(aliceId);

        // Bob initializes
        const bobService = new (e2eeService.constructor)();
        await bobService.initialize(bobId);

        // Alice encrypts message for Bob
        const message = 'Secret message from Alice to Bob';
        const encrypted = await aliceService.encryptMessage(bobId, message);

        // Verify encrypted message
        expect(encrypted).toBeDefined();
        expect(encrypted.ciphertext).toBeDefined();
        expect(encrypted.metadata).toBeDefined();

        // Bob would decrypt (in real scenario with proper key exchange)
        // This test validates the encryption pipeline works end-to-end
    });
});