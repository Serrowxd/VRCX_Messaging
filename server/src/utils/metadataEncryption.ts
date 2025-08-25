import crypto from 'crypto';
import { logger } from './logger';

// Encryption configuration
const ALGORITHM = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

export class MetadataEncryption {
    private key: Buffer;

    constructor() {
        // Derive key from environment secret
        const secret = process.env.METADATA_ENCRYPTION_SECRET || process.env.JWT_SECRET;
        if (!secret) {
            throw new Error('METADATA_ENCRYPTION_SECRET is not configured');
        }

        // Use a consistent salt for the application (stored in env or generated once)
        const appSalt = process.env.METADATA_SALT 
            ? Buffer.from(process.env.METADATA_SALT, 'hex')
            : crypto.scryptSync(secret, 'vrcx-messaging-metadata', SALT_LENGTH);

        // Derive encryption key
        this.key = crypto.pbkdf2Sync(secret, appSalt, ITERATIONS, KEY_LENGTH, 'sha256');
    }

    /**
     * Encrypt sensitive metadata fields
     */
    encryptMetadata(metadata: any): { encrypted: string; fields: string[] } {
        try {
            // Identify sensitive fields to encrypt
            const sensitiveFields = this.identifySensitiveFields(metadata);
            
            if (sensitiveFields.length === 0) {
                // No sensitive data to encrypt
                return {
                    encrypted: JSON.stringify(metadata),
                    fields: []
                };
            }

            // Create a copy with sensitive fields encrypted
            const encryptedMetadata = { ...metadata };
            const encryptedValues: Record<string, string> = {};

            for (const field of sensitiveFields) {
                if (metadata[field] !== undefined && metadata[field] !== null) {
                    const value = typeof metadata[field] === 'string' 
                        ? metadata[field] 
                        : JSON.stringify(metadata[field]);
                    
                    encryptedValues[field] = this.encryptField(value);
                    encryptedMetadata[field] = '[ENCRYPTED]';
                }
            }

            // Store encrypted values separately
            encryptedMetadata._encrypted = encryptedValues;

            return {
                encrypted: JSON.stringify(encryptedMetadata),
                fields: sensitiveFields
            };

        } catch (error) {
            logger.error('Failed to encrypt metadata', { error });
            throw new Error('Metadata encryption failed');
        }
    }

    /**
     * Decrypt sensitive metadata fields
     */
    decryptMetadata(encryptedData: string): any {
        try {
            const metadata = JSON.parse(encryptedData);
            
            // Check if there are encrypted fields
            if (!metadata._encrypted || typeof metadata._encrypted !== 'object') {
                return metadata;
            }

            const decryptedMetadata = { ...metadata };
            const encryptedValues = metadata._encrypted;

            // Decrypt each field
            for (const [field, encryptedValue] of Object.entries(encryptedValues)) {
                if (typeof encryptedValue === 'string') {
                    try {
                        const decrypted = this.decryptField(encryptedValue);
                        
                        // Try to parse as JSON first (for objects/arrays)
                        try {
                            decryptedMetadata[field] = JSON.parse(decrypted);
                        } catch {
                            // If not JSON, use as string
                            decryptedMetadata[field] = decrypted;
                        }
                    } catch (error) {
                        logger.warn('Failed to decrypt field', { field, error });
                        decryptedMetadata[field] = '[DECRYPTION_FAILED]';
                    }
                }
            }

            // Remove the encrypted values object
            delete decryptedMetadata._encrypted;

            return decryptedMetadata;

        } catch (error) {
            logger.error('Failed to decrypt metadata', { error });
            throw new Error('Metadata decryption failed');
        }
    }

    /**
     * Encrypt a single field value
     */
    private encryptField(value: string): string {
        // Generate random IV for each encryption
        const iv = crypto.randomBytes(IV_LENGTH);
        
        // Create cipher
        const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
        
        // Encrypt the value
        const encrypted = Buffer.concat([
            cipher.update(value, 'utf8'),
            cipher.final()
        ]);
        
        // Get the authentication tag
        const tag = cipher.getAuthTag();
        
        // Combine IV + tag + encrypted data
        const combined = Buffer.concat([iv, tag, encrypted]);
        
        // Return base64 encoded
        return combined.toString('base64');
    }

    /**
     * Decrypt a single field value
     */
    private decryptField(encryptedValue: string): string {
        // Decode from base64
        const combined = Buffer.from(encryptedValue, 'base64');
        
        // Extract components
        const iv = combined.slice(0, IV_LENGTH);
        const tag = combined.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
        const encrypted = combined.slice(IV_LENGTH + TAG_LENGTH);
        
        // Create decipher
        const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
        decipher.setAuthTag(tag);
        
        // Decrypt
        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]);
        
        return decrypted.toString('utf8');
    }

    /**
     * Identify sensitive fields that should be encrypted
     */
    private identifySensitiveFields(metadata: any): string[] {
        const sensitivePatterns = [
            'ip', 'ipAddress', 'ip_address',
            'location', 'geo', 'coordinates',
            'deviceInfo', 'device_info', 'deviceDetails',
            'userAgent', 'user_agent',
            'sessionInfo', 'session_info',
            'privateKey', 'private_key', 'secretKey', 'secret_key',
            'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token',
            'password', 'passphrase',
            'email', 'phone', 'phoneNumber', 'phone_number',
            'address', 'street', 'city', 'zipCode', 'zip_code',
            'ssn', 'socialSecurity', 'social_security',
            'creditCard', 'credit_card', 'cardNumber', 'card_number',
            'bankAccount', 'bank_account', 'accountNumber', 'account_number'
        ];

        const fields: string[] = [];

        for (const key of Object.keys(metadata)) {
            const lowerKey = key.toLowerCase();
            
            // Check if field matches any sensitive pattern
            if (sensitivePatterns.some(pattern => 
                lowerKey.includes(pattern.toLowerCase())
            )) {
                fields.push(key);
            }
        }

        return fields;
    }

    /**
     * Hash sensitive data for comparison without exposing the value
     */
    hashSensitiveData(value: string): string {
        return crypto
            .createHash('sha256')
            .update(value + (process.env.METADATA_HASH_SALT || ''))
            .digest('hex');
    }

    /**
     * Verify a value against a hash
     */
    verifySensitiveData(value: string, hash: string): boolean {
        const computedHash = this.hashSensitiveData(value);
        return crypto.timingSafeEqual(
            Buffer.from(computedHash),
            Buffer.from(hash)
        );
    }

    /**
     * Sanitize metadata for logging (remove sensitive fields)
     */
    sanitizeForLogging(metadata: any): any {
        const sensitiveFields = this.identifySensitiveFields(metadata);
        const sanitized = { ...metadata };

        for (const field of sensitiveFields) {
            if (sanitized[field] !== undefined) {
                sanitized[field] = '[REDACTED]';
            }
        }

        // Also remove any _encrypted field
        delete sanitized._encrypted;

        return sanitized;
    }
}

// Export singleton instance
export const metadataEncryption = new MetadataEncryption();

// Middleware to automatically encrypt/decrypt metadata in requests/responses
export function encryptMetadataMiddleware() {
    return async (req: any, res: any, next: any) => {
        // Encrypt metadata in request body if present
        if (req.body?.metadata) {
            try {
                const { encrypted, fields } = metadataEncryption.encryptMetadata(req.body.metadata);
                req.body.encryptedMetadata = encrypted;
                req.body.encryptedFields = fields;
                
                // Keep original for application use, but log sanitized version
                logger.debug('Metadata encrypted', {
                    fields: fields.length > 0 ? fields : 'none',
                    sanitized: metadataEncryption.sanitizeForLogging(req.body.metadata)
                });
            } catch (error) {
                logger.error('Failed to encrypt request metadata', { error });
            }
        }

        // Hook into response to decrypt metadata
        const originalJson = res.json.bind(res);
        res.json = function(data: any) {
            // Decrypt metadata in response if present
            if (data?.metadata && typeof data.metadata === 'string') {
                try {
                    data.metadata = metadataEncryption.decryptMetadata(data.metadata);
                } catch (error) {
                    logger.error('Failed to decrypt response metadata', { error });
                }
            }

            // Handle arrays of items with metadata
            if (Array.isArray(data?.messages)) {
                data.messages = data.messages.map((msg: any) => {
                    if (msg.metadata && typeof msg.metadata === 'string') {
                        try {
                            msg.metadata = metadataEncryption.decryptMetadata(msg.metadata);
                        } catch (error) {
                            logger.error('Failed to decrypt message metadata', { 
                                error,
                                messageId: msg.id 
                            });
                        }
                    }
                    return msg;
                });
            }

            return originalJson(data);
        };

        next();
    };
}