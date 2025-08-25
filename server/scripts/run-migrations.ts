#!/usr/bin/env node

/**
 * Migration runner script for VRCX Messaging System
 * Run this script to execute database migrations
 * 
 * Usage:
 *   npm run migrate
 *   npm run migrate:reset (for development only)
 */

import dotenv from 'dotenv';
import path from 'path';
import { 
    initializePostgres, 
    initializeRedis, 
    shutdown 
} from '../src/database/connection';
import { 
    initializeDatabase, 
    resetDatabase 
} from '../src/database/init';
import winston from 'winston';

// Load environment variables
dotenv.config();

// Configure logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.simple()
    ),
    transports: [
        new winston.transports.Console()
    ]
});

/**
 * Main migration runner
 */
async function main() {
    const command = process.argv[2];
    
    try {
        logger.info('Starting migration runner...');
        logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
        logger.info(`Database: ${process.env.DB_NAME || 'vrcx_messaging'}`);
        
        // Initialize database connections
        logger.info('Initializing database connections...');
        await initializePostgres();
        await initializeRedis();
        
        switch (command) {
            case 'reset':
                if (process.env.NODE_ENV === 'production') {
                    logger.error('Cannot reset database in production!');
                    process.exit(1);
                }
                logger.warn('Resetting database - all data will be lost!');
                await resetDatabase();
                logger.info('Database reset completed');
                break;
                
            case 'verify':
                logger.info('Verifying database schema...');
                const { verifySchema } = await import('../src/database/init');
                const isValid = await verifySchema();
                if (isValid) {
                    logger.info('Database schema is valid');
                } else {
                    logger.error('Database schema validation failed');
                    process.exit(1);
                }
                break;
                
            default:
                logger.info('Running database migrations...');
                await initializeDatabase();
                logger.info('Database initialization completed successfully');
                break;
        }
        
        // Shutdown connections
        await shutdown();
        logger.info('Migration runner completed successfully');
        process.exit(0);
        
    } catch (error) {
        logger.error('Migration runner failed:', error);
        
        // Try to shutdown connections
        try {
            await shutdown();
        } catch (shutdownError) {
            logger.error('Failed to shutdown connections:', shutdownError);
        }
        
        process.exit(1);
    }
}

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
    logger.error('Unhandled rejection:', error);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
});

// Run the migration
main();