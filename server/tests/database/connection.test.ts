import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import {
    initializePostgres,
    initializeRedis,
    getPool,
    getRedis,
    query,
    transaction,
    healthCheck,
    shutdown
} from '../../src/database/connection';

/**
 * Unit tests for database connection module
 */

describe('Database Connection', () => {
    beforeAll(async () => {
        // Set test environment variables
        process.env.DB_NAME = 'vrcx_messaging_test';
        process.env.DB_USER = 'test_user';
        process.env.DB_PASSWORD = 'test_password';
        process.env.REDIS_URL = 'redis://localhost:6379/1'; // Use database 1 for tests
        
        // Initialize connections
        await initializePostgres();
        await initializeRedis();
    });

    afterAll(async () => {
        // Clean up connections
        await shutdown();
    });

    describe('PostgreSQL Connection', () => {
        it('should initialize PostgreSQL pool', async () => {
            const pool = getPool();
            expect(pool).toBeDefined();
        });

        it('should execute a simple query', async () => {
            const result = await query('SELECT 1 + 1 as sum');
            expect(result.rows[0].sum).toBe(2);
        });

        it('should handle parameterized queries', async () => {
            const result = await query(
                'SELECT $1::text as value',
                ['test']
            );
            expect(result.rows[0].value).toBe('test');
        });

        it('should handle transactions with commit', async () => {
            const result = await transaction(async (client) => {
                // Create a temporary table
                await client.query(
                    'CREATE TEMP TABLE test_table (id SERIAL, value TEXT)'
                );
                
                // Insert data
                await client.query(
                    'INSERT INTO test_table (value) VALUES ($1)',
                    ['test_value']
                );
                
                // Return inserted data
                const selectResult = await client.query(
                    'SELECT * FROM test_table'
                );
                return selectResult.rows[0];
            });
            
            expect(result.value).toBe('test_value');
        });

        it('should handle transactions with rollback on error', async () => {
            await expect(
                transaction(async (client) => {
                    // This should fail
                    await client.query('SELECT * FROM non_existent_table');
                })
            ).rejects.toThrow();
        });

        it('should handle connection pool errors gracefully', async () => {
            // Test with invalid query
            await expect(
                query('INVALID SQL SYNTAX')
            ).rejects.toThrow();
        });
    });

    describe('Redis Connection', () => {
        it('should initialize Redis client', () => {
            const redis = getRedis();
            expect(redis).toBeDefined();
        });

        it('should set and get values', async () => {
            const redis = getRedis();
            await redis.set('test_key', 'test_value');
            const value = await redis.get('test_key');
            expect(value).toBe('test_value');
        });

        it('should handle JSON values', async () => {
            const redis = getRedis();
            const testObject = { id: 1, name: 'test' };
            await redis.set('test_json', JSON.stringify(testObject));
            const retrieved = await redis.get('test_json');
            expect(JSON.parse(retrieved!)).toEqual(testObject);
        });

        it('should handle key expiration', async () => {
            const redis = getRedis();
            await redis.setEx('test_expire', 1, 'value');
            
            // Value should exist immediately
            let value = await redis.get('test_expire');
            expect(value).toBe('value');
            
            // Wait for expiration
            await new Promise(resolve => setTimeout(resolve, 1100));
            
            // Value should be gone
            value = await redis.get('test_expire');
            expect(value).toBeNull();
        });

        it('should handle Redis lists', async () => {
            const redis = getRedis();
            const listKey = 'test_list';
            
            // Push items
            await redis.rPush(listKey, ['item1', 'item2', 'item3']);
            
            // Get list length
            const length = await redis.lLen(listKey);
            expect(length).toBe(3);
            
            // Get all items
            const items = await redis.lRange(listKey, 0, -1);
            expect(items).toEqual(['item1', 'item2', 'item3']);
            
            // Clean up
            await redis.del(listKey);
        });
    });

    describe('Health Check', () => {
        it('should report healthy connections', async () => {
            const health = await healthCheck();
            
            expect(health.postgres).toBe(true);
            expect(health.redis).toBe(true);
            expect(health.details.postgres.connected).toBe(true);
            expect(health.details.redis.connected).toBe(true);
        });
    });
});

describe('Database Connection Error Handling', () => {
    it('should throw error when PostgreSQL not initialized', () => {
        // Create a new instance without initialization
        jest.resetModules();
        const { getPool } = require('../../src/database/connection');
        
        expect(() => getPool()).toThrow(
            'PostgreSQL pool not initialized'
        );
    });

    it('should throw error when Redis not initialized', () => {
        // Create a new instance without initialization
        jest.resetModules();
        const { getRedis } = require('../../src/database/connection');
        
        expect(() => getRedis()).toThrow(
            'Redis client not initialized'
        );
    });
});