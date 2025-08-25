/**
 * Key Exchange Models and Types
 * 
 * This module defines the data structures for the Signal Protocol key exchange system,
 * including identity keys, signed prekeys, and one-time prekeys.
 */

/**
 * Key types used in the Signal Protocol
 */
export enum KeyType {
    IDENTITY = 'identity',
    SIGNED_PREKEY = 'signed_prekey',
    ONETIME_PREKEY = 'onetime_prekey'
}

/**
 * Trust levels for identity keys
 */
export enum TrustLevel {
    UNTRUSTED = 'untrusted',
    TRUSTED = 'trusted',
    VERIFIED = 'verified'
}

/**
 * Base structure for all key types
 */
export interface BaseKey {
    id?: string;
    userId: string;
    keyType: KeyType;
    publicKey: string;  // Base64 encoded public key
    createdAt?: Date;
    expiresAt?: Date;
}

/**
 * Identity key - long-term key for a user/device
 */
export interface IdentityKey extends BaseKey {
    keyType: KeyType.IDENTITY;
    registrationId: number;
    deviceId: number;
    trustLevel?: TrustLevel;
}

/**
 * Signed prekey - medium-term key with signature
 */
export interface SignedPreKey extends BaseKey {
    keyType: KeyType.SIGNED_PREKEY;
    keyId: number;
    signature: string;  // Ed25519 signature
    rotatedAt?: Date;
}

/**
 * One-time prekey - ephemeral key for single use
 */
export interface OneTimePreKey extends BaseKey {
    keyType: KeyType.ONETIME_PREKEY;
    keyId: number;
    consumed?: boolean;
    consumedAt?: Date;
    batchId?: string;
}

/**
 * Key bundle for initiating a session
 */
export interface KeyBundle {
    identityKey: string;
    registrationId: number;
    deviceId: number;
    signedPreKey: {
        keyId: number;
        publicKey: string;
        signature: string;
    };
    oneTimePreKey?: {
        keyId: number;
        publicKey: string;
    };
}

/**
 * Request to upload keys
 */
export interface UploadKeysRequest {
    identityKey: string;
    registrationId: number;
    deviceId: number;
    signedPreKey: {
        keyId: number;
        publicKey: string;
        signature: string;
    };
    oneTimePreKeys: Array<{
        keyId: number;
        publicKey: string;
    }>;
}

/**
 * Request to rotate keys
 */
export interface RotateKeysRequest {
    signedPreKey?: {
        keyId: number;
        publicKey: string;
        signature: string;
    };
    oneTimePreKeys?: Array<{
        keyId: number;
        publicKey: string;
    }>;
}

/**
 * Key verification request
 */
export interface VerifyKeyRequest {
    userId: string;
    identityKey: string;
    deviceId?: number;
}

/**
 * Key verification response
 */
export interface VerifyKeyResponse {
    verified: boolean;
    trustLevel: TrustLevel;
    matchedKey?: string;
    deviceId?: number;
}

/**
 * Trusted key entry
 */
export interface TrustedKey {
    userId: string;
    deviceId: number;
    identityKey: string;
    trustLevel: TrustLevel;
    verifiedAt: Date;
    verifiedBy?: string;
}

/**
 * Key count information
 */
export interface KeyCount {
    count: number;
    minimum: number;
    shouldReplenish: boolean;
}

/**
 * Key statistics for monitoring
 */
export interface KeyStatistics {
    userId: string;
    deviceId: number;
    identityKeyRotations: number;
    signedPreKeyRotations: number;
    oneTimePreKeysGenerated: number;
    oneTimePreKeysConsumed: number;
    remainingOneTimePreKeys: number;
    lastRotation?: Date;
}

/**
 * Error types specific to key operations
 */
export enum KeyError {
    INVALID_KEY_FORMAT = 'INVALID_KEY_FORMAT',
    KEY_NOT_FOUND = 'KEY_NOT_FOUND',
    INSUFFICIENT_PREKEYS = 'INSUFFICIENT_PREKEYS',
    SIGNATURE_VERIFICATION_FAILED = 'SIGNATURE_VERIFICATION_FAILED',
    KEY_ALREADY_EXISTS = 'KEY_ALREADY_EXISTS',
    KEY_EXPIRED = 'KEY_EXPIRED',
    DEVICE_NOT_FOUND = 'DEVICE_NOT_FOUND',
    USER_NOT_FOUND = 'USER_NOT_FOUND'
}

/**
 * Helper functions for key operations
 */
export const KeyHelpers = {
    /**
     * Generate a batch ID for a group of one-time prekeys
     */
    generateBatchId(): string {
        return `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    },

    /**
     * Check if a key has expired
     */
    isKeyExpired(expiresAt?: Date): boolean {
        if (!expiresAt) return false;
        return new Date() > expiresAt;
    },

    /**
     * Calculate when a signed prekey should be rotated (weekly)
     */
    calculateSignedPreKeyRotation(): Date {
        const rotationDate = new Date();
        rotationDate.setDate(rotationDate.getDate() + 7);
        return rotationDate;
    },

    /**
     * Validate key format (basic base64 check)
     */
    isValidKeyFormat(key: string): boolean {
        // Check if it's valid base64
        const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
        return base64Regex.test(key) && key.length > 0;
    },

    /**
     * Check if we need to replenish one-time prekeys
     */
    shouldReplenishPreKeys(currentCount: number, minimum: number = 20): boolean {
        return currentCount < minimum;
    }
};

/**
 * Constants for key management
 */
export const KEY_CONSTANTS = {
    MIN_ONETIME_PREKEYS: 20,
    DEFAULT_ONETIME_PREKEYS_BATCH: 100,
    MAX_ONETIME_PREKEYS: 1000,
    SIGNED_PREKEY_ROTATION_DAYS: 7,
    KEY_EXPIRY_DAYS: 30,
    MAX_DEVICES_PER_USER: 10,
    MAX_KEY_ID: 0xFFFFFF  // Maximum value for key IDs (24-bit)
};