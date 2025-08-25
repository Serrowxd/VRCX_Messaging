/**
 * Key Exchange Service
 * 
 * Handles all key exchange operations for the Signal Protocol implementation,
 * including key storage, retrieval, rotation, and consumption.
 */

import { 
    KeyBundle, 
    UploadKeysRequest, 
    RotateKeysRequest,
    VerifyKeyRequest,
    VerifyKeyResponse,
    TrustedKey,
    KeyCount,
    KeyStatistics,
    KeyType,
    TrustLevel,
    KeyHelpers,
    KEY_CONSTANTS,
    KeyError
} from '../models/keys';
import { query, transaction } from '../database/connection';
import { redisClient } from '../database/connection';
import { logger, logAudit } from '../utils/logger';
import { ValidationError, NotFoundError, ConflictError } from '../middleware/errorHandler';
import * as crypto from 'crypto';

/**
 * Key Service for managing Signal Protocol keys
 */
export class KeyService {
    /**
     * Upload a complete key bundle for a user/device
     */
    async uploadKeyBundle(userId: string, request: UploadKeysRequest): Promise<{ keysStored: number }> {
        const { 
            identityKey, 
            registrationId, 
            deviceId, 
            signedPreKey, 
            oneTimePreKeys 
        } = request;

        // Validate key formats
        if (!KeyHelpers.isValidKeyFormat(identityKey)) {
            throw new ValidationError('Invalid identity key format');
        }
        if (!KeyHelpers.isValidKeyFormat(signedPreKey.publicKey)) {
            throw new ValidationError('Invalid signed prekey format');
        }
        if (!KeyHelpers.isValidKeyFormat(signedPreKey.signature)) {
            throw new ValidationError('Invalid signature format');
        }

        // Validate one-time prekeys
        for (const prekey of oneTimePreKeys) {
            if (!KeyHelpers.isValidKeyFormat(prekey.publicKey)) {
                throw new ValidationError(`Invalid one-time prekey format for key ${prekey.keyId}`);
            }
        }

        // Check device limit
        const deviceCount = await this.getDeviceCount(userId);
        if (deviceCount >= KEY_CONSTANTS.MAX_DEVICES_PER_USER) {
            throw new ValidationError(`User has reached maximum device limit (${KEY_CONSTANTS.MAX_DEVICES_PER_USER})`);
        }

        return await transaction(async (client) => {
            let keysStored = 0;

            // Store identity key
            await client.query(`
                INSERT INTO user_keys (user_id, key_type, public_key, metadata)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, key_type, key_id)
                DO UPDATE SET 
                    public_key = EXCLUDED.public_key,
                    metadata = EXCLUDED.metadata,
                    created_at = CURRENT_TIMESTAMP
            `, [
                userId,
                KeyType.IDENTITY,
                identityKey,
                JSON.stringify({ registrationId, deviceId })
            ]);
            keysStored++;

            // Store signed prekey
            const signedPreKeyExpiry = KeyHelpers.calculateSignedPreKeyRotation();
            await client.query(`
                INSERT INTO user_keys (user_id, key_type, key_id, public_key, signature, expires_at, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                ON CONFLICT (user_id, key_type, key_id)
                DO UPDATE SET 
                    public_key = EXCLUDED.public_key,
                    signature = EXCLUDED.signature,
                    expires_at = EXCLUDED.expires_at,
                    created_at = CURRENT_TIMESTAMP
            `, [
                userId,
                KeyType.SIGNED_PREKEY,
                signedPreKey.keyId,
                signedPreKey.publicKey,
                signedPreKey.signature,
                signedPreKeyExpiry,
                JSON.stringify({ deviceId })
            ]);
            keysStored++;

            // Store one-time prekeys in batch
            const batchId = KeyHelpers.generateBatchId();
            for (const prekey of oneTimePreKeys) {
                await client.query(`
                    INSERT INTO prekeys (user_id, batch_id, key_id, public_key)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (user_id, key_id)
                    DO UPDATE SET 
                        public_key = EXCLUDED.public_key,
                        consumed = false,
                        consumed_at = NULL,
                        created_at = CURRENT_TIMESTAMP
                `, [
                    userId,
                    batchId,
                    prekey.keyId,
                    prekey.publicKey
                ]);
                keysStored++;
            }

            // Clear cache for this user
            await redisClient.del(`key_bundle:${userId}:${deviceId}`);
            await redisClient.del(`key_count:${userId}:${deviceId}`);

            logAudit('Keys uploaded', userId, {
                deviceId,
                registrationId,
                signedPreKeyId: signedPreKey.keyId,
                oneTimePreKeysCount: oneTimePreKeys.length,
                batchId
            });

            return { keysStored };
        });
    }

    /**
     * Get a key bundle for establishing a session
     */
    async getKeyBundle(targetUserId: string, deviceId?: number): Promise<KeyBundle> {
        // Check cache first
        const cacheKey = `key_bundle:${targetUserId}:${deviceId || 'default'}`;
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }

        // Get identity key
        const identityResult = await query(`
            SELECT public_key, metadata
            FROM user_keys
            WHERE user_id = $1 AND key_type = $2
            ORDER BY created_at DESC
            LIMIT 1
        `, [targetUserId, KeyType.IDENTITY]);

        if (identityResult.rows.length === 0) {
            throw new NotFoundError('User has not uploaded identity keys');
        }

        const identityKey = identityResult.rows[0].public_key;
        const { registrationId, deviceId: storedDeviceId } = JSON.parse(identityResult.rows[0].metadata);

        // Get latest signed prekey
        const signedPreKeyResult = await query(`
            SELECT key_id, public_key, signature
            FROM user_keys
            WHERE user_id = $1 
                AND key_type = $2
                AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
            ORDER BY created_at DESC
            LIMIT 1
        `, [targetUserId, KeyType.SIGNED_PREKEY]);

        if (signedPreKeyResult.rows.length === 0) {
            throw new NotFoundError('No valid signed prekey available');
        }

        const signedPreKey = {
            keyId: signedPreKeyResult.rows[0].key_id,
            publicKey: signedPreKeyResult.rows[0].public_key,
            signature: signedPreKeyResult.rows[0].signature
        };

        // Consume a one-time prekey (atomically)
        const oneTimePreKeyResult = await query(`
            SELECT * FROM consume_onetime_prekey($1)
        `, [targetUserId]);

        let oneTimePreKey: { keyId: number; publicKey: string } | undefined;
        if (oneTimePreKeyResult.rows.length > 0) {
            oneTimePreKey = {
                keyId: oneTimePreKeyResult.rows[0].key_id,
                publicKey: oneTimePreKeyResult.rows[0].public_key
            };
        }

        const bundle: KeyBundle = {
            identityKey,
            registrationId,
            deviceId: deviceId || storedDeviceId,
            signedPreKey,
            oneTimePreKey
        };

        // Cache for 5 minutes
        await redisClient.setex(cacheKey, 300, JSON.stringify(bundle));

        // Check if user needs to replenish prekeys
        const remainingCount = await this.getOneTimePreKeyCount(targetUserId);
        if (KeyHelpers.shouldReplenishPreKeys(remainingCount)) {
            // Send notification to user to replenish keys
            logger.warn('User should replenish one-time prekeys', {
                userId: targetUserId,
                remainingKeys: remainingCount
            });
        }

        return bundle;
    }

    /**
     * Rotate keys (signed prekey and/or one-time prekeys)
     */
    async rotateKeys(userId: string, deviceId: number, request: RotateKeysRequest): Promise<{
        signedPreKeyRotated: boolean;
        oneTimePreKeysAdded: number;
    }> {
        const { signedPreKey, oneTimePreKeys } = request;
        let signedPreKeyRotated = false;
        let oneTimePreKeysAdded = 0;

        await transaction(async (client) => {
            // Rotate signed prekey if provided
            if (signedPreKey) {
                if (!KeyHelpers.isValidKeyFormat(signedPreKey.publicKey)) {
                    throw new ValidationError('Invalid signed prekey format');
                }
                if (!KeyHelpers.isValidKeyFormat(signedPreKey.signature)) {
                    throw new ValidationError('Invalid signature format');
                }

                // Mark old signed prekeys as expired
                await client.query(`
                    UPDATE user_keys
                    SET expires_at = CURRENT_TIMESTAMP
                    WHERE user_id = $1 
                        AND key_type = $2
                        AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
                `, [userId, KeyType.SIGNED_PREKEY]);

                // Insert new signed prekey
                const signedPreKeyExpiry = KeyHelpers.calculateSignedPreKeyRotation();
                await client.query(`
                    INSERT INTO user_keys (user_id, key_type, key_id, public_key, signature, expires_at, metadata)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                `, [
                    userId,
                    KeyType.SIGNED_PREKEY,
                    signedPreKey.keyId,
                    signedPreKey.publicKey,
                    signedPreKey.signature,
                    signedPreKeyExpiry,
                    JSON.stringify({ deviceId, rotatedAt: new Date() })
                ]);

                signedPreKeyRotated = true;
            }

            // Add one-time prekeys if provided
            if (oneTimePreKeys && oneTimePreKeys.length > 0) {
                // Check current count
                const currentCount = await this.getOneTimePreKeyCount(userId);
                const totalAfterAdd = currentCount + oneTimePreKeys.length;

                if (totalAfterAdd > KEY_CONSTANTS.MAX_ONETIME_PREKEYS) {
                    throw new ValidationError(
                        `Adding ${oneTimePreKeys.length} keys would exceed maximum limit of ${KEY_CONSTANTS.MAX_ONETIME_PREKEYS}`
                    );
                }

                const batchId = KeyHelpers.generateBatchId();
                for (const prekey of oneTimePreKeys) {
                    if (!KeyHelpers.isValidKeyFormat(prekey.publicKey)) {
                        throw new ValidationError(`Invalid one-time prekey format for key ${prekey.keyId}`);
                    }

                    await client.query(`
                        INSERT INTO prekeys (user_id, batch_id, key_id, public_key)
                        VALUES ($1, $2, $3, $4)
                        ON CONFLICT (user_id, key_id)
                        DO UPDATE SET 
                            public_key = EXCLUDED.public_key,
                            consumed = false,
                            consumed_at = NULL,
                            created_at = CURRENT_TIMESTAMP
                    `, [
                        userId,
                        batchId,
                        prekey.keyId,
                        prekey.publicKey
                    ]);
                    oneTimePreKeysAdded++;
                }
            }

            // Clear cache
            await redisClient.del(`key_bundle:${userId}:${deviceId}`);
            await redisClient.del(`key_count:${userId}:${deviceId}`);
        });

        logAudit('Keys rotated', userId, {
            deviceId,
            signedPreKeyRotated,
            oneTimePreKeysAdded
        });

        return { signedPreKeyRotated, oneTimePreKeysAdded };
    }

    /**
     * Get count of remaining one-time prekeys
     */
    async getOneTimePreKeyCount(userId: string): Promise<number> {
        // Check cache first
        const cacheKey = `key_count:${userId}`;
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return parseInt(cached, 10);
        }

        const result = await query(`
            SELECT COUNT(*) as count
            FROM prekeys
            WHERE user_id = $1 AND consumed = false
        `, [userId]);

        const count = parseInt(result.rows[0].count, 10);

        // Cache for 1 minute
        await redisClient.setex(cacheKey, 60, count.toString());

        return count;
    }

    /**
     * Get key count information with replenishment recommendation
     */
    async getKeyCountInfo(userId: string): Promise<KeyCount> {
        const count = await this.getOneTimePreKeyCount(userId);
        const minimum = KEY_CONSTANTS.MIN_ONETIME_PREKEYS;
        const shouldReplenish = KeyHelpers.shouldReplenishPreKeys(count, minimum);

        return {
            count,
            minimum,
            shouldReplenish
        };
    }

    /**
     * Verify an identity key
     */
    async verifyIdentityKey(
        verifyingUserId: string,
        request: VerifyKeyRequest
    ): Promise<VerifyKeyResponse> {
        const { userId, identityKey, deviceId } = request;

        // Get stored identity key
        const result = await query(`
            SELECT public_key, metadata
            FROM user_keys
            WHERE user_id = $1 AND key_type = $2
            ORDER BY created_at DESC
            LIMIT 1
        `, [userId, KeyType.IDENTITY]);

        if (result.rows.length === 0) {
            return {
                verified: false,
                trustLevel: TrustLevel.UNTRUSTED
            };
        }

        const storedKey = result.rows[0].public_key;
        const metadata = JSON.parse(result.rows[0].metadata);
        const verified = storedKey === identityKey;

        if (verified) {
            // Store trust relationship
            await query(`
                INSERT INTO trusted_keys (
                    user_id, 
                    trusted_user_id, 
                    trusted_device_id, 
                    identity_key, 
                    trust_level, 
                    verified_at
                )
                VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                ON CONFLICT (user_id, trusted_user_id, trusted_device_id)
                DO UPDATE SET 
                    trust_level = EXCLUDED.trust_level,
                    verified_at = CURRENT_TIMESTAMP
            `, [
                verifyingUserId,
                userId,
                deviceId || metadata.deviceId,
                identityKey,
                TrustLevel.TRUSTED
            ]);
        }

        logAudit('Identity key verification', verifyingUserId, {
            targetUserId: userId,
            deviceId: deviceId || metadata.deviceId,
            verified
        });

        return {
            verified,
            trustLevel: verified ? TrustLevel.TRUSTED : TrustLevel.UNTRUSTED,
            matchedKey: verified ? storedKey : undefined,
            deviceId: deviceId || metadata.deviceId
        };
    }

    /**
     * Get trusted keys for a user
     */
    async getTrustedKeys(userId: string): Promise<TrustedKey[]> {
        const result = await query(`
            SELECT 
                tk.trusted_user_id as user_id,
                tk.trusted_device_id as device_id,
                tk.identity_key,
                tk.trust_level,
                tk.verified_at,
                u.username as verified_by
            FROM trusted_keys tk
            LEFT JOIN users u ON tk.user_id = u.id
            WHERE tk.user_id = $1
            ORDER BY tk.verified_at DESC
        `, [userId]);

        return result.rows.map(row => ({
            userId: row.user_id,
            deviceId: row.device_id,
            identityKey: row.identity_key,
            trustLevel: row.trust_level as TrustLevel,
            verifiedAt: row.verified_at,
            verifiedBy: row.verified_by
        }));
    }

    /**
     * Revoke keys for a device
     */
    async revokeDeviceKeys(userId: string, deviceId: number): Promise<void> {
        await transaction(async (client) => {
            // Delete all keys for this device
            await client.query(`
                DELETE FROM user_keys
                WHERE user_id = $1 
                    AND metadata->>'deviceId' = $2
            `, [userId, deviceId.toString()]);

            // Mark all prekeys as consumed
            await client.query(`
                UPDATE prekeys
                SET consumed = true, consumed_at = CURRENT_TIMESTAMP
                WHERE user_id = $1
                    AND consumed = false
            `, [userId]);

            // Remove from trusted keys
            await client.query(`
                DELETE FROM trusted_keys
                WHERE (user_id = $1 AND trusted_device_id = $2)
                    OR (trusted_user_id = $1 AND trusted_device_id = $2)
            `, [userId, deviceId]);

            // Clear cache
            await redisClient.del(`key_bundle:${userId}:${deviceId}`);
            await redisClient.del(`key_count:${userId}`);
        });

        logAudit('Device keys revoked', userId, {
            revokedDeviceId: deviceId
        });
    }

    /**
     * Get device count for a user
     */
    private async getDeviceCount(userId: string): Promise<number> {
        const result = await query(`
            SELECT COUNT(DISTINCT metadata->>'deviceId') as count
            FROM user_keys
            WHERE user_id = $1 AND key_type = $2
        `, [userId, KeyType.IDENTITY]);

        return parseInt(result.rows[0].count, 10);
    }

    /**
     * Get key statistics for monitoring
     */
    async getKeyStatistics(userId: string, deviceId: number): Promise<KeyStatistics> {
        const stats = await query(`
            SELECT 
                COUNT(CASE WHEN key_type = $2 THEN 1 END) as identity_rotations,
                COUNT(CASE WHEN key_type = $3 THEN 1 END) as signed_rotations,
                MAX(CASE WHEN key_type = $3 THEN created_at END) as last_rotation
            FROM user_keys
            WHERE user_id = $1
                AND metadata->>'deviceId' = $4
        `, [userId, KeyType.IDENTITY, KeyType.SIGNED_PREKEY, deviceId.toString()]);

        const prekeyStats = await query(`
            SELECT 
                COUNT(*) as total_generated,
                COUNT(CASE WHEN consumed = true THEN 1 END) as consumed,
                COUNT(CASE WHEN consumed = false THEN 1 END) as remaining
            FROM prekeys
            WHERE user_id = $1
        `, [userId]);

        return {
            userId,
            deviceId,
            identityKeyRotations: parseInt(stats.rows[0].identity_rotations, 10),
            signedPreKeyRotations: parseInt(stats.rows[0].signed_rotations, 10),
            oneTimePreKeysGenerated: parseInt(prekeyStats.rows[0].total_generated, 10),
            oneTimePreKeysConsumed: parseInt(prekeyStats.rows[0].consumed, 10),
            remainingOneTimePreKeys: parseInt(prekeyStats.rows[0].remaining, 10),
            lastRotation: stats.rows[0].last_rotation
        };
    }

    /**
     * Clean up old consumed prekeys
     */
    async cleanupOldPreKeys(daysOld: number = 7): Promise<number> {
        const result = await query(`
            DELETE FROM prekeys
            WHERE consumed = true 
                AND consumed_at < CURRENT_TIMESTAMP - INTERVAL '${daysOld} days'
        `);

        const deletedCount = result.rowCount || 0;

        if (deletedCount > 0) {
            logger.info('Cleaned up old prekeys', { deletedCount, daysOld });
        }

        return deletedCount;
    }
}

// Export singleton instance
export const keyService = new KeyService();