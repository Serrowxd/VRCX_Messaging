import { FastifyRequest, FastifyReply } from 'fastify';
import Ajv, { JSONSchemaType, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { ValidationError } from './errorHandler';

// Initialize AJV with defaults
const ajv = new Ajv({
    allErrors: true,
    removeAdditional: true,
    useDefaults: true,
    coerceTypes: true,
    strict: false
});

// Add format validators (email, date-time, uuid, etc.)
addFormats(ajv);

// Add custom formats
ajv.addFormat('username', /^[a-zA-Z0-9_-]{3,30}$/);
ajv.addFormat('password', /^.{8,128}$/);
ajv.addFormat('messageId', /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
ajv.addFormat('base64', /^[A-Za-z0-9+/]+=*$/);
ajv.addFormat('publicKey', /^[A-Za-z0-9+/]{43}=$/);

// Common schema definitions for reuse
export const commonSchemas = {
    userId: {
        type: 'string',
        format: 'uuid',
        description: 'User ID'
    },
    messageId: {
        type: 'string',
        format: 'messageId',
        description: 'Message ID'
    },
    conversationId: {
        type: 'string',
        format: 'uuid',
        description: 'Conversation ID'
    },
    pagination: {
        type: 'object',
        properties: {
            limit: {
                type: 'integer',
                minimum: 1,
                maximum: 100,
                default: 20
            },
            offset: {
                type: 'integer',
                minimum: 0,
                default: 0
            },
            cursor: {
                type: 'string',
                description: 'Cursor for pagination'
            }
        }
    },
    timestamp: {
        type: 'string',
        format: 'date-time'
    }
};

// Authentication schemas
export const authSchemas = {
    login: {
        type: 'object',
        properties: {
            username: {
                type: 'string',
                format: 'username',
                minLength: 3,
                maxLength: 30
            },
            password: {
                type: 'string',
                format: 'password',
                minLength: 8,
                maxLength: 128
            },
            deviceId: {
                type: 'integer',
                minimum: 1
            }
        },
        required: ['username', 'password'],
        additionalProperties: false
    },
    
    refreshToken: {
        type: 'object',
        properties: {
            refreshToken: {
                type: 'string',
                minLength: 1
            }
        },
        required: ['refreshToken'],
        additionalProperties: false
    },
    
    vrcxAuth: {
        type: 'object',
        properties: {
            vrcxToken: {
                type: 'string',
                minLength: 1
            },
            deviceId: {
                type: 'integer',
                minimum: 1
            }
        },
        required: ['vrcxToken'],
        additionalProperties: false
    }
};

// Message schemas
export const messageSchemas = {
    sendMessage: {
        type: 'object',
        properties: {
            recipientId: commonSchemas.userId,
            conversationId: {
                ...commonSchemas.conversationId,
                nullable: true
            },
            encryptedContent: {
                type: 'string',
                format: 'base64',
                minLength: 1,
                maxLength: 100000 // ~75KB base64
            },
            metadata: {
                type: 'object',
                properties: {
                    version: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 10
                    },
                    timestamp: {
                        type: 'integer',
                        minimum: 0
                    },
                    deviceId: {
                        type: 'integer',
                        minimum: 1
                    },
                    sessionId: {
                        type: 'string',
                        format: 'uuid'
                    },
                    ephemeralKey: {
                        type: 'string',
                        format: 'base64',
                        nullable: true
                    }
                },
                required: ['version', 'timestamp', 'deviceId'],
                additionalProperties: false
            }
        },
        required: ['recipientId', 'encryptedContent', 'metadata'],
        additionalProperties: false
    },
    
    getMessages: {
        type: 'object',
        properties: {
            conversationId: commonSchemas.conversationId,
            ...commonSchemas.pagination.properties,
            since: {
                type: 'string',
                format: 'date-time',
                nullable: true
            },
            until: {
                type: 'string',
                format: 'date-time',
                nullable: true
            }
        },
        required: ['conversationId'],
        additionalProperties: false
    },
    
    markAsRead: {
        type: 'object',
        properties: {
            messageIds: {
                type: 'array',
                items: commonSchemas.messageId,
                minItems: 1,
                maxItems: 100
            },
            readAt: {
                type: 'string',
                format: 'date-time',
                nullable: true
            }
        },
        required: ['messageIds'],
        additionalProperties: false
    },
    
    deleteMessage: {
        type: 'object',
        properties: {
            messageId: commonSchemas.messageId,
            deleteForEveryone: {
                type: 'boolean',
                default: false
            }
        },
        required: ['messageId'],
        additionalProperties: false
    }
};

// Key exchange schemas
export const keyExchangeSchemas = {
    uploadKeys: {
        type: 'object',
        properties: {
            identityKey: {
                type: 'string',
                format: 'publicKey'
            },
            signedPreKey: {
                type: 'object',
                properties: {
                    keyId: {
                        type: 'integer',
                        minimum: 1
                    },
                    publicKey: {
                        type: 'string',
                        format: 'publicKey'
                    },
                    signature: {
                        type: 'string',
                        format: 'base64'
                    }
                },
                required: ['keyId', 'publicKey', 'signature']
            },
            oneTimePreKeys: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        keyId: {
                            type: 'integer',
                            minimum: 1
                        },
                        publicKey: {
                            type: 'string',
                            format: 'publicKey'
                        }
                    },
                    required: ['keyId', 'publicKey']
                },
                minItems: 1,
                maxItems: 100
            },
            deviceId: {
                type: 'integer',
                minimum: 1
            },
            registrationId: {
                type: 'integer',
                minimum: 1
            }
        },
        required: ['identityKey', 'signedPreKey', 'oneTimePreKeys', 'deviceId', 'registrationId'],
        additionalProperties: false
    },
    
    getKeyBundle: {
        type: 'object',
        properties: {
            userId: commonSchemas.userId,
            deviceId: {
                type: 'integer',
                minimum: 1,
                nullable: true
            }
        },
        required: ['userId'],
        additionalProperties: false
    },
    
    rotateKeys: {
        type: 'object',
        properties: {
            signedPreKey: {
                type: 'object',
                properties: {
                    keyId: {
                        type: 'integer',
                        minimum: 1
                    },
                    publicKey: {
                        type: 'string',
                        format: 'publicKey'
                    },
                    signature: {
                        type: 'string',
                        format: 'base64'
                    }
                },
                required: ['keyId', 'publicKey', 'signature']
            },
            oneTimePreKeys: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        keyId: {
                            type: 'integer',
                            minimum: 1
                        },
                        publicKey: {
                            type: 'string',
                            format: 'publicKey'
                        }
                    },
                    required: ['keyId', 'publicKey']
                },
                minItems: 0,
                maxItems: 100
            }
        },
        required: [],
        additionalProperties: false
    }
};

// Conversation schemas
export const conversationSchemas = {
    createConversation: {
        type: 'object',
        properties: {
            participantId: commonSchemas.userId,
            initialMessage: {
                type: 'string',
                format: 'base64',
                nullable: true
            }
        },
        required: ['participantId'],
        additionalProperties: false
    },
    
    getConversations: {
        type: 'object',
        properties: {
            ...commonSchemas.pagination.properties,
            unreadOnly: {
                type: 'boolean',
                default: false
            },
            archived: {
                type: 'boolean',
                default: false
            }
        },
        additionalProperties: false
    },
    
    updateConversation: {
        type: 'object',
        properties: {
            conversationId: commonSchemas.conversationId,
            archived: {
                type: 'boolean',
                nullable: true
            },
            muted: {
                type: 'boolean',
                nullable: true
            },
            muteUntil: {
                type: 'string',
                format: 'date-time',
                nullable: true
            }
        },
        required: ['conversationId'],
        additionalProperties: false
    }
};

// Compiled validators cache
const validators = new Map<string, ValidateFunction>();

/**
 * Compile and cache a schema validator
 */
function getValidator(schema: any): ValidateFunction {
    const key = JSON.stringify(schema);
    
    if (!validators.has(key)) {
        validators.set(key, ajv.compile(schema));
    }
    
    return validators.get(key)!;
}

/**
 * Validation middleware factory
 */
export function validate(schema: any, target: 'body' | 'query' | 'params' = 'body') {
    const validator = getValidator(schema);
    
    return async (request: FastifyRequest, reply: FastifyReply) => {
        const data = request[target];
        
        const valid = validator(data);
        
        if (!valid) {
            const errors = validator.errors?.map(err => ({
                field: err.instancePath || err.schemaPath,
                message: err.message,
                params: err.params
            }));
            
            throw new ValidationError('Request validation failed', { errors, target });
        }
        
        // Replace original data with coerced/defaulted data
        (request as any)[target] = data;
    };
}

/**
 * Custom validators for complex validation
 */
export const customValidators = {
    /**
     * Validate message content size (after decryption)
     */
    messageSize: (maxSize: number = 5000) => {
        return async (request: FastifyRequest, reply: FastifyReply) => {
            const body = request.body as any;
            
            if (body.encryptedContent) {
                // Estimate decrypted size (base64 is ~1.33x larger)
                const estimatedSize = body.encryptedContent.length * 0.75;
                
                if (estimatedSize > maxSize) {
                    throw new ValidationError(
                        `Message content exceeds maximum size of ${maxSize} bytes`,
                        { estimatedSize, maxSize }
                    );
                }
            }
        };
    },
    
    /**
     * Validate date range
     */
    dateRange: (field1: string, field2: string) => {
        return async (request: FastifyRequest, reply: FastifyReply) => {
            const data = request.body as any;
            
            if (data[field1] && data[field2]) {
                const date1 = new Date(data[field1]);
                const date2 = new Date(data[field2]);
                
                if (date1 > date2) {
                    throw new ValidationError(
                        `${field1} must be before ${field2}`,
                        { [field1]: data[field1], [field2]: data[field2] }
                    );
                }
            }
        };
    },
    
    /**
     * Validate array uniqueness
     */
    uniqueArray: (field: string) => {
        return async (request: FastifyRequest, reply: FastifyReply) => {
            const data = request.body as any;
            
            if (Array.isArray(data[field])) {
                const unique = new Set(data[field]);
                
                if (unique.size !== data[field].length) {
                    throw new ValidationError(
                        `${field} must contain unique values`,
                        { field, duplicates: data[field].length - unique.size }
                    );
                }
            }
        };
    },
    
    /**
     * Validate conditional requirements
     */
    requireIf: (field: string, condition: (data: any) => boolean, message?: string) => {
        return async (request: FastifyRequest, reply: FastifyReply) => {
            const data = request.body as any;
            
            if (condition(data) && !data[field]) {
                throw new ValidationError(
                    message || `${field} is required`,
                    { field, condition: condition.toString() }
                );
            }
        };
    }
};

/**
 * Sanitize input data
 */
export function sanitize(data: any): any {
    if (typeof data === 'string') {
        // Remove null bytes
        data = data.replace(/\0/g, '');
        
        // Trim whitespace
        data = data.trim();
        
        // Prevent script injection
        data = data.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
        
        return data;
    }
    
    if (Array.isArray(data)) {
        return data.map(sanitize);
    }
    
    if (data && typeof data === 'object') {
        const sanitized: any = {};
        
        for (const key in data) {
            if (data.hasOwnProperty(key)) {
                sanitized[key] = sanitize(data[key]);
            }
        }
        
        return sanitized;
    }
    
    return data;
}

/**
 * Sanitization middleware
 */
export function sanitizeInput(target: 'body' | 'query' | 'params' = 'body') {
    return async (request: FastifyRequest, reply: FastifyReply) => {
        if (request[target]) {
            (request as any)[target] = sanitize(request[target]);
        }
    };
}

export default {
    validate,
    sanitize,
    sanitizeInput,
    customValidators,
    schemas: {
        auth: authSchemas,
        message: messageSchemas,
        keyExchange: keyExchangeSchemas,
        conversation: conversationSchemas
    }
};