-- Additive migration: existing users, tasks, files and live leases stay intact.
CREATE TABLE IF NOT EXISTS upload_demands (deviceId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES users(id), runId TEXT NOT NULL DEFAULT '', expiresAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(deviceId,runId));
CREATE INDEX IF NOT EXISTS upload_demands_expiry ON upload_demands(expiresAt);
