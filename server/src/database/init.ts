import fs from 'fs/promises';
import path from 'path';
import { query, transaction, getPool } from './connection';
import winston from 'winston';

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
 * Database initialization script for VRCX Messaging System
 * Runs migrations and sets up initial database state
 */

interface Migration {
    filename: string;
    content: string;
    order: number;
}

/**
 * Read all migration files from the migrations directory
 */
async function readMigrations(): Promise<Migration[]> {
    const migrationsDir = path.join(process.cwd(), 'migrations');
    
    try {
        const files = await fs.readdir(migrationsDir);
        const migrations: Migration[] = [];
        
        for (const file of files) {
            if (file.endsWith('.sql')) {
                const filePath = path.join(migrationsDir, file);
                const content = await fs.readFile(filePath, 'utf-8');
                
                // Extract order from filename (e.g., 001_initial_schema.sql -> 1)
                const orderMatch = file.match(/^(\d+)/);
                const order = orderMatch ? parseInt(orderMatch[1]) : 999;
                
                migrations.push({
                    filename: file,
                    content,
                    order
                });
            }
        }
        
        // Sort by order
        migrations.sort((a, b) => a.order - b.order);
        
        return migrations;
    } catch (error) {
        logger.error('Failed to read migrations:', error);
        throw error;
    }
}

/**
 * Create migrations tracking table
 */
async function createMigrationsTable(): Promise<void> {
    await query(`
        CREATE TABLE IF NOT EXISTS migrations (
            id SERIAL PRIMARY KEY,
            filename VARCHAR(255) UNIQUE NOT NULL,
            checksum VARCHAR(64) NOT NULL,
            executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            execution_time_ms INTEGER
        )
    `);
    
    logger.info('Migrations table ready');
}

/**
 * Calculate checksum for migration content
 */
function calculateChecksum(content: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a migration has been executed
 */
async function isMigrationExecuted(filename: string, checksum: string): Promise<boolean> {
    const result = await query(
        'SELECT checksum FROM migrations WHERE filename = $1',
        [filename]
    );
    
    if (result.rows.length === 0) {
        return false;
    }
    
    const existingChecksum = result.rows[0].checksum;
    if (existingChecksum !== checksum) {
        throw new Error(
            `Migration ${filename} has been modified after execution. ` +
            `Expected checksum: ${existingChecksum}, Current: ${checksum}`
        );
    }
    
    return true;
}

/**
 * Execute a single migration
 */
async function executeMigration(migration: Migration): Promise<void> {
    const startTime = Date.now();
    const checksum = calculateChecksum(migration.content);
    
    // Check if already executed
    const executed = await isMigrationExecuted(migration.filename, checksum);
    if (executed) {
        logger.info(`Migration ${migration.filename} already executed, skipping`);
        return;
    }
    
    logger.info(`Executing migration: ${migration.filename}`);
    
    try {
        await transaction(async (client) => {
            // Split migration into individual statements
            const statements = migration.content
                .split(/;\s*$/m)
                .filter(stmt => stmt.trim().length > 0);
            
            for (const statement of statements) {
                // Skip comments and empty lines
                if (statement.trim().startsWith('--') || !statement.trim()) {
                    continue;
                }
                
                await client.query(statement);
            }
            
            // Record migration execution
            const executionTime = Date.now() - startTime;
            await client.query(
                `INSERT INTO migrations (filename, checksum, execution_time_ms) 
                 VALUES ($1, $2, $3)`,
                [migration.filename, checksum, executionTime]
            );
        });
        
        logger.info(`Migration ${migration.filename} completed in ${Date.now() - startTime}ms`);
    } catch (error) {
        logger.error(`Migration ${migration.filename} failed:`, error);
        throw error;
    }
}

/**
 * Run all pending migrations
 */
export async function runMigrations(): Promise<void> {
    logger.info('Starting database migrations...');
    
    try {
        // Create migrations table
        await createMigrationsTable();
        
        // Read all migrations
        const migrations = await readMigrations();
        logger.info(`Found ${migrations.length} migration files`);
        
        // Execute migrations in order
        let executed = 0;
        for (const migration of migrations) {
            await executeMigration(migration);
            executed++;
        }
        
        logger.info(`Database migrations completed. Executed ${executed} migrations.`);
    } catch (error) {
        logger.error('Database migration failed:', error);
        throw error;
    }
}

/**
 * Create initial admin user (optional)
 */
export async function createInitialUser(): Promise<void> {
    const adminUserId = process.env.ADMIN_USER_ID;
    const adminUsername = process.env.ADMIN_USERNAME;
    
    if (!adminUserId || !adminUsername) {
        logger.info('No admin user configured, skipping');
        return;
    }
    
    try {
        const result = await query(
            'SELECT id FROM users WHERE vrcx_user_id = $1',
            [adminUserId]
        );
        
        if (result.rows.length > 0) {
            logger.info('Admin user already exists');
            return;
        }
        
        await query(
            `INSERT INTO users (vrcx_user_id, username, display_name, is_active) 
             VALUES ($1, $2, $3, true)`,
            [adminUserId, adminUsername, 'Admin']
        );
        
        logger.info('Initial admin user created');
    } catch (error) {
        logger.error('Failed to create admin user:', error);
        // Non-critical error, don't throw
    }
}

/**
 * Verify database schema integrity
 */
export async function verifySchema(): Promise<boolean> {
    const requiredTables = [
        'users',
        'messages',
        'conversations',
        'user_keys',
        'prekeys',
        'message_queue',
        'sessions',
        'rate_limits',
        'audit_log',
        'blocked_users',
        'notification_preferences'
    ];
    
    try {
        for (const table of requiredTables) {
            const result = await query(
                `SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_schema = 'public' 
                    AND table_name = $1
                )`,
                [table]
            );
            
            if (!result.rows[0].exists) {
                logger.error(`Required table missing: ${table}`);
                return false;
            }
        }
        
        logger.info('Schema verification passed');
        return true;
    } catch (error) {
        logger.error('Schema verification failed:', error);
        return false;
    }
}

/**
 * Create database indexes for performance
 */
export async function createIndexes(): Promise<void> {
    logger.info('Creating database indexes...');
    
    // This function can be used to create indexes that might not be in migrations
    // or to rebuild indexes for performance optimization
    
    const indexes = [
        // Add any additional indexes here if needed
    ];
    
    for (const indexSql of indexes) {
        try {
            await query(indexSql);
        } catch (error) {
            // Index might already exist
            logger.warn('Index creation warning:', error);
        }
    }
    
    logger.info('Database indexes created');
}

/**
 * Initialize database with all required setup
 */
export async function initializeDatabase(): Promise<void> {
    logger.info('Initializing database...');
    
    try {
        // Run migrations
        await runMigrations();
        
        // Create initial user if configured
        await createInitialUser();
        
        // Verify schema
        const schemaValid = await verifySchema();
        if (!schemaValid) {
            throw new Error('Database schema verification failed');
        }
        
        // Create/update indexes
        await createIndexes();
        
        // Analyze tables for query optimizer
        await query('ANALYZE');
        
        logger.info('Database initialization completed successfully');
    } catch (error) {
        logger.error('Database initialization failed:', error);
        throw error;
    }
}

/**
 * Reset database (DANGEROUS - for development only)
 */
export async function resetDatabase(): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Database reset is not allowed in production');
    }
    
    logger.warn('RESETTING DATABASE - ALL DATA WILL BE LOST');
    
    try {
        // Drop all tables in reverse dependency order
        const tables = [
            'migrations',
            'message_statistics',
            'notification_preferences',
            'blocked_users',
            'audit_log',
            'rate_limits',
            'sessions',
            'message_queue',
            'prekeys',
            'user_keys',
            'conversations',
            'messages',
            'users'
        ];
        
        for (const table of tables) {
            try {
                await query(`DROP TABLE IF EXISTS ${table} CASCADE`);
                logger.info(`Dropped table: ${table}`);
            } catch (error) {
                logger.warn(`Failed to drop table ${table}:`, error);
            }
        }
        
        // Drop custom types
        await query('DROP TYPE IF EXISTS message_status CASCADE');
        await query('DROP TYPE IF EXISTS message_type CASCADE');
        await query('DROP TYPE IF EXISTS key_type CASCADE');
        await query('DROP TYPE IF EXISTS trust_level CASCADE');
        
        logger.info('Database reset completed');
        
        // Re-initialize
        await initializeDatabase();
    } catch (error) {
        logger.error('Database reset failed:', error);
        throw error;
    }
}

// Export for use in other modules
export default {
    runMigrations,
    createInitialUser,
    verifySchema,
    createIndexes,
    initializeDatabase,
    resetDatabase
};