/**
 * Key Service Unit Tests
 * 
 * Comprehensive test suite for the key exchange service implementation
 */

import { keyService } from '../../src/services/keyService';
import { 
    UploadKeysRequest, 
    RotateKeysRequest,
    VerifyKeyRequest,
    KeyType,
    TrustLevel,
    KEY_CONSTANTS
} from '../../src/models/keys';
import { query, transaction, redisClient } from '../../src/database/connection';
import { ValidationError, NotFoundError } from '../../src/middleware/errorHandler';

// Mock dependencies
jest.mock('../../src/database/connection');
jest.mock('../../src/utils/logger');

describe('KeyService', () => {
    const mockUserId = 'user_123';
    const mockDeviceId = 1;
    const mockRegistrationId = 12345;

    const mockUploadRequest: UploadKeysRequest = {
        identityKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPKnlPg==',
        registrationId: mockRegistrationId,
        deviceId: mockDeviceId,
        signedPreKey: {
            keyId: 1,
            publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEsigned=',
            signature: 'MEQCIQCsignaturebase64signaturebase64signature='
        },
        oneTimePreKeys: [
            { keyId: 1, publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkey1=' },
            { keyId: 2, publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEkey2=' }
        ]
    };

    beforeEach(() => {
        jest.clearAllMocks();
        (redisClient.del as jest.Mock).mockResolvedValue(1);
        (redisClient.get as jest.Mock).mockResolvedValue(null);
        (redisClient.setex as jest.Mock).mockResolvedValue('OK');
    });

    describe('uploadKeyBundle', () => {
        it('should successfully upload a complete key bundle', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            (transaction as jest.Mock).mockImplementation(async (callback) => {
                return await callback(mockClient);
            });

            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });

            const result = await keyService.uploadKeyBundle(mockUserId, mockUploadRequest);

            expect(result.keysStored).toBe(4); // 1 identity + 1 signed + 2 one-time
            expect(mockClient.query).toHaveBeenCalledTimes(4);
            expect(redisClient.del).toHaveBeenCalledWith(`key_bundle:${mockUserId}:${mockDeviceId}`);
            expect(redisClient.del).toHaveBeenCalledWith(`key_count:${mockUserId}:${mockDeviceId}`);
        });

        it('should reject invalid identity key format', async () => {
            const invalidRequest = {
                ...mockUploadRequest,
                identityKey: 'invalid_key!'
            };

            await expect(keyService.uploadKeyBundle(mockUserId, invalidRequest))
                .rejects.toThrow(ValidationError);
        });

        it('should reject invalid signed prekey format', async () => {
            const invalidRequest = {
                ...mockUploadRequest,
                signedPreKey: {
                    ...mockUploadRequest.signedPreKey,
                    publicKey: 'invalid!'
                }
            };

            await expect(keyService.uploadKeyBundle(mockUserId, invalidRequest))
                .rejects.toThrow(ValidationError);
        });

        it('should reject when device limit is exceeded', async () => {
            (query as jest.Mock).mockResolvedValue({ 
                rows: [{ count: KEY_CONSTANTS.MAX_DEVICES_PER_USER.toString() }] 
            });

            await expect(keyService.uploadKeyBundle(mockUserId, mockUploadRequest))
                .rejects.toThrow(ValidationError);
        });

        it('should handle duplicate key upload with upsert', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            (transaction as jest.Mock).mockImplementation(async (callback) => {
                return await callback(mockClient);
            });

            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });

            // Upload twice
            await keyService.uploadKeyBundle(mockUserId, mockUploadRequest);
            await keyService.uploadKeyBundle(mockUserId, mockUploadRequest);

            // Should use ON CONFLICT DO UPDATE
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('ON CONFLICT'),
                expect.any(Array)
            );
        });
    });

    describe('getKeyBundle', () => {
        it('should retrieve a complete key bundle with one-time prekey', async () => {
            const mockIdentity = {
                public_key: 'identity_key_base64',
                metadata: JSON.stringify({ registrationId: mockRegistrationId, deviceId: mockDeviceId })
            };

            const mockSignedPreKey = {
                key_id: 1,
                public_key: 'signed_key_base64',
                signature: 'signature_base64'
            };

            const mockOneTimeKey = {
                key_id: 10,
                public_key: 'onetime_key_base64'
            };

            (query as jest.Mock)
                .mockResolvedValueOnce({ rows: [mockIdentity] })      // Identity key
                .mockResolvedValueOnce({ rows: [mockSignedPreKey] })  // Signed prekey
                .mockResolvedValueOnce({ rows: [mockOneTimeKey] })    // One-time prekey (consumed)
                .mockResolvedValueOnce({ rows: [{ count: '50' }] });  // Remaining count

            const bundle = await keyService.getKeyBundle(mockUserId);

            expect(bundle).toEqual({
                identityKey: mockIdentity.public_key,
                registrationId: mockRegistrationId,
                deviceId: mockDeviceId,
                signedPreKey: {
                    keyId: mockSignedPreKey.key_id,
                    publicKey: mockSignedPreKey.public_key,
                    signature: mockSignedPreKey.signature
                },
                oneTimePreKey: {
                    keyId: mockOneTimeKey.key_id,
                    publicKey: mockOneTimeKey.public_key
                }
            });

            // Should cache the result
            expect(redisClient.setex).toHaveBeenCalledWith(
                `key_bundle:${mockUserId}:default`,
                300,
                JSON.stringify(bundle)
            );
        });

        it('should return bundle without one-time prekey when none available', async () => {
            const mockIdentity = {
                public_key: 'identity_key_base64',
                metadata: JSON.stringify({ registrationId: mockRegistrationId, deviceId: mockDeviceId })
            };

            const mockSignedPreKey = {
                key_id: 1,
                public_key: 'signed_key_base64',
                signature: 'signature_base64'
            };

            (query as jest.Mock)
                .mockResolvedValueOnce({ rows: [mockIdentity] })
                .mockResolvedValueOnce({ rows: [mockSignedPreKey] })
                .mockResolvedValueOnce({ rows: [] })  // No one-time prekey
                .mockResolvedValueOnce({ rows: [{ count: '0' }] });

            const bundle = await keyService.getKeyBundle(mockUserId);

            expect(bundle.oneTimePreKey).toBeUndefined();
        });

        it('should use cached bundle when available', async () => {
            const cachedBundle = {
                identityKey: 'cached_identity',
                registrationId: 54321,
                deviceId: 2,
                signedPreKey: {
                    keyId: 5,
                    publicKey: 'cached_signed',
                    signature: 'cached_sig'
                }
            };

            (redisClient.get as jest.Mock).mockResolvedValue(JSON.stringify(cachedBundle));

            const bundle = await keyService.getKeyBundle(mockUserId, 2);

            expect(bundle).toEqual(cachedBundle);
            expect(query).not.toHaveBeenCalled();
        });

        it('should throw NotFoundError when user has no identity keys', async () => {
            (query as jest.Mock).mockResolvedValueOnce({ rows: [] });

            await expect(keyService.getKeyBundle(mockUserId))
                .rejects.toThrow(NotFoundError);
        });

        it('should throw NotFoundError when no valid signed prekey available', async () => {
            const mockIdentity = {
                public_key: 'identity_key_base64',
                metadata: JSON.stringify({ registrationId: mockRegistrationId, deviceId: mockDeviceId })
            };

            (query as jest.Mock)
                .mockResolvedValueOnce({ rows: [mockIdentity] })
                .mockResolvedValueOnce({ rows: [] }); // No signed prekey

            await expect(keyService.getKeyBundle(mockUserId))
                .rejects.toThrow(NotFoundError);
        });
    });

    describe('rotateKeys', () => {
        it('should rotate signed prekey successfully', async () => {
            const rotateRequest: RotateKeysRequest = {
                signedPreKey: {
                    keyId: 2,
                    publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEnewkey=',
                    signature: 'MEQCIQCnewsignaturebase64newsignaturebase64='
                }
            };

            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            (transaction as jest.Mock).mockImplementation(async (callback) => {
                return await callback(mockClient);
            });

            const result = await keyService.rotateKeys(mockUserId, mockDeviceId, rotateRequest);

            expect(result.signedPreKeyRotated).toBe(true);
            expect(result.oneTimePreKeysAdded).toBe(0);
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE user_keys'),
                expect.arrayContaining([mockUserId, KeyType.SIGNED_PREKEY])
            );
        });

        it('should add one-time prekeys successfully', async () => {
            const rotateRequest: RotateKeysRequest = {
                oneTimePreKeys: [
                    { keyId: 101, publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEk101=' },
                    { keyId: 102, publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEk102=' }
                ]
            };

            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            (transaction as jest.Mock).mockImplementation(async (callback) => {
                return await callback(mockClient);
            });

            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '10' }] });

            const result = await keyService.rotateKeys(mockUserId, mockDeviceId, rotateRequest);

            expect(result.signedPreKeyRotated).toBe(false);
            expect(result.oneTimePreKeysAdded).toBe(2);
        });

        it('should rotate both signed and one-time prekeys', async () => {
            const rotateRequest: RotateKeysRequest = {
                signedPreKey: {
                    keyId: 3,
                    publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEboth==',
                    signature: 'MEQCIQCbothsignaturebase64bothsignaturebase64='
                },
                oneTimePreKeys: [
                    { keyId: 201, publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEk201=' }
                ]
            };

            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            (transaction as jest.Mock).mockImplementation(async (callback) => {
                return await callback(mockClient);
            });

            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '10' }] });

            const result = await keyService.rotateKeys(mockUserId, mockDeviceId, rotateRequest);

            expect(result.signedPreKeyRotated).toBe(true);
            expect(result.oneTimePreKeysAdded).toBe(1);
        });

        it('should reject adding too many one-time prekeys', async () => {
            const tooManyKeys = Array.from({ length: 200 }, (_, i) => ({
                keyId: i + 1,
                publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEtest='
            }));

            const rotateRequest: RotateKeysRequest = {
                oneTimePreKeys: tooManyKeys
            };

            (query as jest.Mock).mockResolvedValue({ 
                rows: [{ count: (KEY_CONSTANTS.MAX_ONETIME_PREKEYS - 100).toString() }] 
            });

            await expect(keyService.rotateKeys(mockUserId, mockDeviceId, rotateRequest))
                .rejects.toThrow(ValidationError);
        });
    });

    describe('getKeyCountInfo', () => {
        it('should return key count with replenishment recommendation', async () => {
            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '15' }] });

            const info = await keyService.getKeyCountInfo(mockUserId);

            expect(info).toEqual({
                count: 15,
                minimum: KEY_CONSTANTS.MIN_ONETIME_PREKEYS,
                shouldReplenish: true
            });
        });

        it('should indicate no replenishment needed when count is sufficient', async () => {
            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '50' }] });

            const info = await keyService.getKeyCountInfo(mockUserId);

            expect(info.shouldReplenish).toBe(false);
        });

        it('should use cached count when available', async () => {
            (redisClient.get as jest.Mock).mockResolvedValue('75');

            const info = await keyService.getKeyCountInfo(mockUserId);

            expect(info.count).toBe(75);
            expect(query).not.toHaveBeenCalled();
        });
    });

    describe('verifyIdentityKey', () => {
        it('should verify matching identity key successfully', async () => {
            const verifyRequest: VerifyKeyRequest = {
                userId: 'target_user',
                identityKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEPKnlPg==',
                deviceId: 1
            };

            (query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        public_key: verifyRequest.identityKey,
                        metadata: JSON.stringify({ deviceId: 1 })
                    }]
                })
                .mockResolvedValueOnce({ rows: [] });

            const result = await keyService.verifyIdentityKey(mockUserId, verifyRequest);

            expect(result).toEqual({
                verified: true,
                trustLevel: TrustLevel.TRUSTED,
                matchedKey: verifyRequest.identityKey,
                deviceId: 1
            });

            // Should store trust relationship
            expect(query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO trusted_keys'),
                expect.arrayContaining([mockUserId, 'target_user'])
            );
        });

        it('should return untrusted for non-matching key', async () => {
            const verifyRequest: VerifyKeyRequest = {
                userId: 'target_user',
                identityKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEwrong==',
                deviceId: 1
            };

            (query as jest.Mock).mockResolvedValueOnce({
                rows: [{
                    public_key: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEdifferent==',
                    metadata: JSON.stringify({ deviceId: 1 })
                }]
            });

            const result = await keyService.verifyIdentityKey(mockUserId, verifyRequest);

            expect(result.verified).toBe(false);
            expect(result.trustLevel).toBe(TrustLevel.UNTRUSTED);
            expect(result.matchedKey).toBeUndefined();
        });

        it('should return untrusted when user has no keys', async () => {
            const verifyRequest: VerifyKeyRequest = {
                userId: 'unknown_user',
                identityKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEunknown=='
            };

            (query as jest.Mock).mockResolvedValueOnce({ rows: [] });

            const result = await keyService.verifyIdentityKey(mockUserId, verifyRequest);

            expect(result.verified).toBe(false);
            expect(result.trustLevel).toBe(TrustLevel.UNTRUSTED);
        });
    });

    describe('getTrustedKeys', () => {
        it('should return list of trusted keys', async () => {
            const mockTrustedKeys = [
                {
                    user_id: 'user_456',
                    device_id: 1,
                    identity_key: 'key1_base64',
                    trust_level: TrustLevel.TRUSTED,
                    verified_at: new Date('2024-01-01'),
                    verified_by: 'verifier_user'
                },
                {
                    user_id: 'user_789',
                    device_id: 2,
                    identity_key: 'key2_base64',
                    trust_level: TrustLevel.VERIFIED,
                    verified_at: new Date('2024-01-02'),
                    verified_by: null
                }
            ];

            (query as jest.Mock).mockResolvedValue({ rows: mockTrustedKeys });

            const trustedKeys = await keyService.getTrustedKeys(mockUserId);

            expect(trustedKeys).toHaveLength(2);
            expect(trustedKeys[0].trustLevel).toBe(TrustLevel.TRUSTED);
            expect(trustedKeys[1].trustLevel).toBe(TrustLevel.VERIFIED);
        });

        it('should return empty array when no trusted keys exist', async () => {
            (query as jest.Mock).mockResolvedValue({ rows: [] });

            const trustedKeys = await keyService.getTrustedKeys(mockUserId);

            expect(trustedKeys).toEqual([]);
        });
    });

    describe('revokeDeviceKeys', () => {
        it('should revoke all keys for a device', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            (transaction as jest.Mock).mockImplementation(async (callback) => {
                return await callback(mockClient);
            });

            await keyService.revokeDeviceKeys(mockUserId, mockDeviceId);

            // Should delete user_keys for device
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM user_keys'),
                expect.arrayContaining([mockUserId, mockDeviceId.toString()])
            );

            // Should mark prekeys as consumed
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE prekeys'),
                expect.arrayContaining([mockUserId])
            );

            // Should remove from trusted keys
            expect(mockClient.query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM trusted_keys'),
                expect.arrayContaining([mockUserId, mockDeviceId])
            );

            // Should clear cache
            expect(redisClient.del).toHaveBeenCalledWith(`key_bundle:${mockUserId}:${mockDeviceId}`);
            expect(redisClient.del).toHaveBeenCalledWith(`key_count:${mockUserId}`);
        });
    });

    describe('getKeyStatistics', () => {
        it('should return comprehensive key statistics', async () => {
            (query as jest.Mock)
                .mockResolvedValueOnce({
                    rows: [{
                        identity_rotations: '2',
                        signed_rotations: '5',
                        last_rotation: new Date('2024-01-15')
                    }]
                })
                .mockResolvedValueOnce({
                    rows: [{
                        total_generated: '150',
                        consumed: '100',
                        remaining: '50'
                    }]
                });

            const stats = await keyService.getKeyStatistics(mockUserId, mockDeviceId);

            expect(stats).toEqual({
                userId: mockUserId,
                deviceId: mockDeviceId,
                identityKeyRotations: 2,
                signedPreKeyRotations: 5,
                oneTimePreKeysGenerated: 150,
                oneTimePreKeysConsumed: 100,
                remainingOneTimePreKeys: 50,
                lastRotation: new Date('2024-01-15')
            });
        });
    });

    describe('cleanupOldPreKeys', () => {
        it('should delete old consumed prekeys', async () => {
            (query as jest.Mock).mockResolvedValue({ rowCount: 25 });

            const deletedCount = await keyService.cleanupOldPreKeys(7);

            expect(deletedCount).toBe(25);
            expect(query).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM prekeys')
            );
        });

        it('should handle no old prekeys to delete', async () => {
            (query as jest.Mock).mockResolvedValue({ rowCount: 0 });

            const deletedCount = await keyService.cleanupOldPreKeys(30);

            expect(deletedCount).toBe(0);
        });
    });

    describe('Edge Cases', () => {
        it('should handle database connection errors gracefully', async () => {
            (query as jest.Mock).mockRejectedValue(new Error('Database connection failed'));

            await expect(keyService.getKeyCountInfo(mockUserId))
                .rejects.toThrow('Database connection failed');
        });

        it('should handle Redis connection errors gracefully', async () => {
            (redisClient.get as jest.Mock).mockRejectedValue(new Error('Redis connection failed'));
            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '25' }] });

            // Should fallback to database when Redis fails
            const info = await keyService.getKeyCountInfo(mockUserId);

            expect(info.count).toBe(25);
            expect(query).toHaveBeenCalled();
        });

        it('should handle concurrent key uploads with proper locking', async () => {
            const mockClient = {
                query: jest.fn().mockResolvedValue({ rows: [] })
            };

            (transaction as jest.Mock).mockImplementation(async (callback) => {
                return await callback(mockClient);
            });

            (query as jest.Mock).mockResolvedValue({ rows: [{ count: '0' }] });

            // Simulate concurrent uploads
            const uploads = [
                keyService.uploadKeyBundle(mockUserId, mockUploadRequest),
                keyService.uploadKeyBundle(mockUserId, mockUploadRequest)
            ];

            const results = await Promise.all(uploads);

            // Both should succeed due to upsert logic
            expect(results).toHaveLength(2);
            results.forEach(result => {
                expect(result.keysStored).toBe(4);
            });
        });
    });
});