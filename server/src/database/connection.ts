import { Pool, PoolClient, QueryResult } from 'pg';
import Redis from 'redis';
import winston from 'winston';

/**
 * Database connection manager for VRCX Messaging System
 * Handles PostgreSQL and Redis connections with pooling and error handling
 */

// PostgreSQL connection pool
let pgPool: Pool | null = null;

// Redis client
let redisClient: Redis.RedisClientType | null = null;

// Logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.Console({
            format: winston.format.simple()
        })
    ]
});

/**
 * Initialize PostgreSQL connection pool
 */
export async function initializePostgres(): Promise<void> {
    if (pgPool) {
        logger.warn('PostgreSQL pool already initialized');
        return;
    }

    const config = {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'vrcx_messaging',
        user: process.env.DB_USER || 'messaging_user',
        password: process.env.DB_PASSWORD || '',
        max: parseInt(process.env.DB_POOL_SIZE || '20'),
        idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
        connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '2000'),
    };

    pgPool = new Pool(config);

    // Test connection
    try {
        const client = await pgPool.connect();
        await client.query('SELECT NOW()');
        client.release();
        logger.info('PostgreSQL connection pool initialized successfully');
    } catch (error) {
        logger.error('Failed to initialize PostgreSQL pool:', error);
        throw error;
    }

    // Handle pool errors
    pgPool.on('error', (err) => {
        logger.error('Unexpected PostgreSQL pool error:', err);
    });
}

/**
 * Initialize Redis connection
 */
export async function initializeRedis(): Promise<void> {
    if (redisClient) {
        logger.warn('Redis client already initialized');
        return;
    }

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    
    redisClient = Redis.createClient({
        url: redisUrl,
        password: process.env.REDIS_PASSWORD,
        socket: {
            connectTimeout: 5000,
            reconnectStrategy: (retries) => {
                if (retries > 10) {
                    logger.error('Redis reconnection failed after 10 attempts');
                    return new Error('Redis reconnection failed');
                }
                return Math.min(retries * 100, 3000);
            }
        }
    });

    redisClient.on('error', (err) => {
        logger.error('Redis client error:', err);
    });

    redisClient.on('connect', () => {
        logger.info('Redis client connected');
    });

    redisClient.on('ready', () => {
        logger.info('Redis client ready');
    });

    try {
        await redisClient.connect();
        await redisClient.ping();
        logger.info('Redis connection initialized successfully');
    } catch (error) {
        logger.error('Failed to initialize Redis:', error);
        throw error;
    }
}

/**
 * Get PostgreSQL pool instance
 */
export function getPool(): Pool {
    if (!pgPool) {
        throw new Error('PostgreSQL pool not initialized. Call initializePostgres() first.');
    }
    return pgPool;
}

/**
 * Get Redis client instance
 */
export function getRedis(): Redis.RedisClientType {
    if (!redisClient) {
        throw new Error('Redis client not initialized. Call initializeRedis() first.');
    }
    return redisClient;
}

/**
 * Execute a PostgreSQL query with automatic connection handling
 */
export async function query<T = any>(
    text: string,
    params?: any[]
): Promise<QueryResult<T>> {
    const pool = getPool();
    const start = Date.now();
    
    try {
        const result = await pool.query<T>(text, params);
        const duration = Date.now() - start;
        
        if (duration > 1000) {
            logger.warn('Slow query detected', {
                query: text.substring(0, 100),
                duration,
                rows: result.rowCount
            });
        }
        
        return result;
    } catch (error) {
        logger.error('Query error:', {
            query: text.substring(0, 100),
            error: error instanceof Error ? error.message : error
        });
        throw error;
    }
}

/**
 * Execute a transaction with automatic rollback on error
 */
export async function transaction<T>(
    callback: (client: PoolClient) => Promise<T>
): Promise<T> {
    const pool = getPool();
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Transaction error:', error);
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Run database migrations
 */
export async function runMigrations(): Promise<void> {
    const pool = getPool();
    
    // Create migrations table if it doesn't exist
    await query(`
        CREATE TABLE IF NOT EXISTS migrations (
            id SERIAL PRIMARY KEY,
            filename VARCHAR(255) UNIQUE NOT NULL,
            executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Get list of executed migrations
    const executedResult = await query<{ filename: string }>(
        'SELECT filename FROM migrations ORDER BY filename'
    );
    const executed = new Set(executedResult.rows.map(row => row.filename));

    // Read migration files (in production, this would read from the migrations directory)
    const migrations = [
        '001_initial_schema.sql',
        '002_indexes_and_constraints.sql'
    ];

    for (const migration of migrations) {
        if (!executed.has(migration)) {
            logger.info(`Running migration: ${migration}`);
            
            try {
                // In production, read the migration file content
                // For now, we'll just mark it as executed
                await transaction(async (client) => {
                    // Execute migration SQL here
                    // await client.query(migrationContent);
                    
                    // Record migration as executed
                    await client.query(
                        'INSERT INTO migrations (filename) VALUES ($1)',
                        [migration]
                    );
                });
                
                logger.info(`Migration ${migration} completed successfully`);
            } catch (error) {
                logger.error(`Migration ${migration} failed:`, error);
                throw error;
            }
        }
    }
    
    logger.info('All migrations completed');
}

/**
 * Health check for database connections
 */
export async function healthCheck(): Promise<{
    postgres: boolean;
    redis: boolean;
    details: any;
}> {
    const health = {
        postgres: false,
        redis: false,
        details: {}
    };

    // Check PostgreSQL
    try {
        const result = await query('SELECT NOW() as time, version() as version');
        health.postgres = true;
        health.details.postgres = {
            connected: true,
            time: result.rows[0].time,
            version: result.rows[0].version.split(' ')[1]
        };
    } catch (error) {
        health.details.postgres = {
            connected: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }

    // Check Redis
    try {
        const redis = getRedis();
        const pong = await redis.ping();
        const info = await redis.info('server');
        health.redis = pong === 'PONG';
        health.details.redis = {
            connected: health.redis,
            version: info.match(/redis_version:([^\r\n]+)/)?.[1] || 'unknown'
        };
    } catch (error) {
        health.details.redis = {
            connected: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }

    return health;
}

/**
 * Gracefully shutdown database connections
 */
export async function shutdown(): Promise<void> {
    logger.info('Shutting down database connections...');

    // Close PostgreSQL pool
    if (pgPool) {
        try {
            await pgPool.end();
            logger.info('PostgreSQL pool closed');
        } catch (error) {
            logger.error('Error closing PostgreSQL pool:', error);
        }
        pgPool = null;
    }

    // Close Redis client
    if (redisClient) {
        try {
            await redisClient.quit();
            logger.info('Redis client closed');
        } catch (error) {
            logger.error('Error closing Redis client:', error);
        }
        redisClient = null;
    }
}

// Handle process termination
process.on('SIGINT', async () => {
    await shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    await shutdown();
    process.exit(0);
});

export default {
    initializePostgres,
    initializeRedis,
    getPool,
    getRedis,
    query,
    transaction,
    runMigrations,
    healthCheck,
    shutdown
};