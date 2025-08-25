-- Migration: Add trusted keys table for key verification
-- This table stores verified identity keys to establish trust relationships

-- Trusted keys table - Store verified identity keys
CREATE TABLE IF NOT EXISTS trusted_keys (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,           -- User who verified the key
    trusted_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- User whose key was verified
    trusted_device_id INTEGER NOT NULL,                                     -- Device ID of the trusted key
    identity_key TEXT NOT NULL,                                            -- The verified identity key
    trust_level VARCHAR(20) NOT NULL DEFAULT 'trusted',                    -- untrusted, trusted, verified
    verified_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    verified_by VARCHAR(255),                                              -- Optional: who verified (for manual verification)
    notes TEXT,                                                            -- Optional notes about verification
    CONSTRAINT unique_trusted_key UNIQUE(user_id, trusted_user_id, trusted_device_id),
    CONSTRAINT check_trust_level CHECK (trust_level IN ('untrusted', 'trusted', 'verified'))
);

-- Indexes for trusted keys table
CREATE INDEX idx_trusted_keys_user ON trusted_keys(user_id);
CREATE INDEX idx_trusted_keys_trusted_user ON trusted_keys(trusted_user_id);
CREATE INDEX idx_trusted_keys_verification ON trusted_keys(verified_at DESC);
CREATE INDEX idx_trusted_keys_trust_level ON trusted_keys(trust_level, verified_at DESC);

-- Add comment for documentation
COMMENT ON TABLE trusted_keys IS 'Stores verified identity keys for establishing trust relationships in E2EE';
COMMENT ON COLUMN trusted_keys.trust_level IS 'Trust level: untrusted (key seen but not verified), trusted (key verified), verified (manually verified by user)';

-- Function to check if a key is trusted
CREATE OR REPLACE FUNCTION is_key_trusted(
    p_user_id UUID,
    p_target_user_id UUID,
    p_device_id INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
    v_trusted BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1 
        FROM trusted_keys 
        WHERE user_id = p_user_id 
            AND trusted_user_id = p_target_user_id 
            AND trusted_device_id = p_device_id
            AND trust_level IN ('trusted', 'verified')
    ) INTO v_trusted;
    
    RETURN v_trusted;
END;
$$ LANGUAGE plpgsql;

-- Function to get trust level
CREATE OR REPLACE FUNCTION get_trust_level(
    p_user_id UUID,
    p_target_user_id UUID,
    p_device_id INTEGER
) RETURNS VARCHAR AS $$
DECLARE
    v_trust_level VARCHAR(20);
BEGIN
    SELECT trust_level
    INTO v_trust_level
    FROM trusted_keys
    WHERE user_id = p_user_id 
        AND trusted_user_id = p_target_user_id 
        AND trusted_device_id = p_device_id
    ORDER BY verified_at DESC
    LIMIT 1;
    
    RETURN COALESCE(v_trust_level, 'untrusted');
END;
$$ LANGUAGE plpgsql;

-- Trigger to clean up old untrusted keys (optional, can be run as scheduled job)
CREATE OR REPLACE FUNCTION cleanup_old_untrusted_keys()
RETURNS void AS $$
BEGIN
    DELETE FROM trusted_keys
    WHERE trust_level = 'untrusted'
        AND verified_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;

-- Grant permissions if needed
-- GRANT ALL PRIVILEGES ON TABLE trusted_keys TO messaging_app;
-- GRANT EXECUTE ON FUNCTION is_key_trusted TO messaging_app;
-- GRANT EXECUTE ON FUNCTION get_trust_level TO messaging_app;
-- GRANT EXECUTE ON FUNCTION cleanup_old_untrusted_keys TO messaging_app;