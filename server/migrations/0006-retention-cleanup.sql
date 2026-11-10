CREATE INDEX IF NOT EXISTS files_expiry_active ON files(expiresAt,id) WHERE status NOT IN('deleted','expired');
