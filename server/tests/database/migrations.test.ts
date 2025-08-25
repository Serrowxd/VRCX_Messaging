import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';
import { initializePostgres, query, shutdown } from '../../src/database/connection';
import { 
    runMigrations, 
    verifySchema, 
    resetDatabase 
} from '../../src/database/init';

/**
 * Integration tests for database migrations
 */

describe('Database Migrations', () => {
    beforeAll(async () => {
        // Use test database
        process.env.NODE_ENV = 'test';
        process.env.DB_NAME = 'vrcx_messaging_test';
        process.env.DB_USER = 'test_user';
        process.env.DB_PASSWORD = 'test_password';
        
        await initializePostgres();
        
        // Reset database before tests
        await resetDatabase();
    });

    afterAll(async () => {
        await shutdown();
    });

    describe('Migration Execution', () => {
        it('should create migrations table', async () => {
            const result = await query(`
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = 'migrations'
                )
            `);
            
            expect(result.rows[0].exists).toBe(true);
        });

        it('should run all migrations successfully', async () => {
            await runMigrations();
            
            // Check that migrations were recorded
            const result = await query('SELECT COUNT(*) as count FROM migrations');
            expect(result.rows[0].count).toBeGreaterThan(0);
        });

        it('should not re-run already executed migrations', async () => {
            // Get current migration count
            const beforeResult = await query('SELECT COUNT(*) as count FROM migrations');
            const beforeCount = parseInt(beforeResult.rows[0].count);
            
            // Run migrations again
            await runMigrations();
            
            // Count should be the same
            const afterResult = await query('SELECT COUNT(*) as count FROM migrations');
            const afterCount = parseInt(afterResult.rows[0].count);
            
            expect(afterCount).toBe(beforeCount);
        });

        it('should verify schema after migrations', async () => {
            const isValid = await verifySchema();
            expect(isValid).toBe(true);
        });
    });

    describe('Schema Verification', () => {
        it('should have all required tables', async () => {
            const tables = [
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
            
            for (const table of tables) {
                const result = await query(`
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_name = $1
                    )
                `, [table]);
                
                expect(result.rows[0].exists).toBe(true);
            }
        });

        it('should have proper foreign key constraints', async () => {
            const result = await query(`
                SELECT 
                    tc.table_name, 
                    tc.constraint_name,
                    ccu.table_name AS foreign_table_name
                FROM information_schema.table_constraints AS tc 
                JOIN information_schema.constraint_column_usage AS ccu
                    ON ccu.constraint_name = tc.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'
                    AND tc.table_schema = 'public'
            `);
            
            expect(result.rows.length).toBeGreaterThan(0);
        });

        it('should have required indexes', async () => {
            const result = await query(`
                SELECT 
                    indexname,
                    tablename
                FROM pg_indexes
                WHERE schemaname = 'public'
                    AND indexname LIKE 'idx_%'
            `);
            
            expect(result.rows.length).toBeGreaterThan(0);
        });

        it('should have required custom types', async () => {
            const types = ['message_status', 'message_type', 'key_type', 'trust_level'];
            
            for (const typeName of types) {
                const result = await query(`
                    SELECT EXISTS (
                        SELECT 1 FROM pg_type 
                        WHERE typname = $1
                    )
                `, [typeName]);
                
                expect(result.rows[0].exists).toBe(true);
            }
        });
    });

    describe('Functions and Triggers', () => {
        it('should have update_updated_at_column function', async () => {
            const result = await query(`
                SELECT EXISTS (
                    SELECT 1 FROM pg_proc 
                    WHERE proname = 'update_updated_at_column'
                )
            `);
            
            expect(result.rows[0].exists).toBe(true);
        });

        it('should have get_or_create_conversation function', async () => {
            const result = await query(`
                SELECT EXISTS (
                    SELECT 1 FROM pg_proc 
                    WHERE proname = 'get_or_create_conversation'
                )
            `);
            
            expect(result.rows[0].exists).toBe(true);
        });

        it('should have consume_onetime_prekey function', async () => {
            const result = await query(`
                SELECT EXISTS (
                    SELECT 1 FROM pg_proc 
                    WHERE proname = 'consume_onetime_prekey'
                )
            `);
            
            expect(result.rows[0].exists).toBe(true);
        });

        it('should have updated_at triggers', async () => {
            const tables = ['users', 'conversations', 'notification_preferences'];
            
            for (const table of tables) {
                const result = await query(`
                    SELECT EXISTS (
                        SELECT 1 FROM pg_trigger 
                        WHERE tgname = $1
                    )
                `, [`update_${table}_updated_at`]);
                
                expect(result.rows[0].exists).toBe(true);
            }
        });
    });

    describe('Data Integrity', () => {
        it('should enforce unique constraints', async () => {
            // Insert a test user
            await query(`
                INSERT INTO users (vrcx_user_id, username, display_name)
                VALUES ('test_user_1', 'testuser1', 'Test User 1')
            `);
            
            // Try to insert duplicate
            await expect(
                query(`
                    INSERT INTO users (vrcx_user_id, username, display_name)
                    VALUES ('test_user_1', 'testuser2', 'Test User 2')
                `)
            ).rejects.toThrow();
        });

        it('should enforce foreign key constraints', async () => {
            // Try to insert message with non-existent user
            await expect(
                query(`
                    INSERT INTO messages (
                        sender_id, 
                        recipient_id, 
                        conversation_id,
                        encrypted_content
                    ) VALUES (
                        '00000000-0000-0000-0000-000000000000',
                        '00000000-0000-0000-0000-000000000001',
                        '00000000-0000-0000-0000-000000000002',
                        'test'
                    )
                `)
            ).rejects.toThrow();
        });

        it('should enforce check constraints', async () => {
            // Create test users
            const user1Result = await query(`
                INSERT INTO users (vrcx_user_id, username, display_name)
                VALUES ('test_user_2', 'testuser2', 'Test User 2')
                RETURNING id
            `);
            
            const user2Result = await query(`
                INSERT INTO users (vrcx_user_id, username, display_name)
                VALUES ('test_user_3', 'testuser3', 'Test User 3')
                RETURNING id
            `);
            
            const userId1 = user1Result.rows[0].id;
            const userId2 = user2Result.rows[0].id;
            
            // Try to create conversation with same participant
            await expect(
                query(`
                    INSERT INTO conversations (
                        participant1_id,
                        participant2_id
                    ) VALUES ($1, $1)
                `, [userId1])
            ).rejects.toThrow();
        });
    });
});