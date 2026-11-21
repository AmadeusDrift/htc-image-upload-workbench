PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, displayName TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','employee')), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), passwordHash TEXT NOT NULL, mustChangePassword INTEGER NOT NULL DEFAULT 1, permissions TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS upload_pool_members (userId TEXT PRIMARY KEY NOT NULL REFERENCES users(id), pool TEXT NOT NULL CHECK(pool IN ('external')));
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS user_groups (userId TEXT NOT NULL REFERENCES users(id), groupId TEXT NOT NULL REFERENCES groups(id), PRIMARY KEY(userId,groupId));
CREATE TABLE IF NOT EXISTS sessions (tokenHash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), deviceId TEXT NOT NULL, expiresAt INTEGER NOT NULL, lastSeen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(userId,expiresAt);
CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), groupId TEXT NOT NULL REFERENCES groups(id), name TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, clientId TEXT NOT NULL, taskId TEXT NOT NULL REFERENCES tasks(id), groupId TEXT NOT NULL REFERENCES groups(id), userId TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, relativePath TEXT NOT NULL, size INTEGER NOT NULL, contentType TEXT NOT NULL, sha256 TEXT NOT NULL, objectKey TEXT UNIQUE NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','uploading','success','failed','expired','deleted')), error TEXT, createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL, completedAt TEXT, packLeaderId TEXT, packOffset INTEGER, packSize INTEGER, packObjectKey TEXT, packEtag TEXT, packSha256 TEXT, packGeneration TEXT, UNIQUE(taskId,clientId));
CREATE INDEX IF NOT EXISTS files_group ON files(groupId,createdAt);
CREATE INDEX IF NOT EXISTS files_task ON files(taskId);
CREATE INDEX IF NOT EXISTS files_task_id ON files(taskId,id);
CREATE INDEX IF NOT EXISTS files_expiry_active ON files(expiresAt,id) WHERE status NOT IN('deleted','expired');
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, fileId TEXT NOT NULL REFERENCES files(id), userId TEXT NOT NULL REFERENCES users(id), deviceId TEXT NOT NULL, expiresAt INTEGER NOT NULL, runId TEXT NOT NULL DEFAULT '', uploadedAt INTEGER);
CREATE INDEX IF NOT EXISTS leases_expiry ON leases(expiresAt);
CREATE INDEX IF NOT EXISTS leases_user ON leases(userId,expiresAt);
CREATE INDEX IF NOT EXISTS leases_device ON leases(deviceId,expiresAt);
CREATE UNIQUE INDEX IF NOT EXISTS leases_file ON leases(fileId);
CREATE TABLE IF NOT EXISTS upload_demands (deviceId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES users(id), runId TEXT NOT NULL DEFAULT '', expiresAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL DEFAULT 0, desired INTEGER, PRIMARY KEY(deviceId,runId));
CREATE INDEX IF NOT EXISTS upload_demands_expiry ON upload_demands(expiresAt);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, userId TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, createdAt TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, resetAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS export_completion_order (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  fileId TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS export_completion_insert
AFTER INSERT ON files WHEN NEW.status='success'
BEGIN
  INSERT INTO export_completion_order(fileId) VALUES (NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS export_completion_update
AFTER UPDATE OF status ON files WHEN OLD.status<>'success' AND NEW.status='success'
BEGIN
  INSERT OR REPLACE INTO export_completion_order(fileId) VALUES (NEW.id);
END;

CREATE TRIGGER IF NOT EXISTS export_completion_terminal
AFTER UPDATE OF status ON files WHEN OLD.status='success' AND NEW.status IN('expired','deleted')
BEGIN
  DELETE FROM export_completion_order WHERE fileId=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS export_completion_delete
AFTER DELETE ON files
BEGIN
  DELETE FROM export_completion_order WHERE fileId=OLD.id;
END;

CREATE INDEX IF NOT EXISTS files_pack_members ON files(packLeaderId,packOffset) WHERE packLeaderId IS NOT NULL;
CREATE TABLE IF NOT EXISTS pack_cleanup (objectKey TEXT PRIMARY KEY NOT NULL);
CREATE TRIGGER IF NOT EXISTS pack_sync_status
AFTER UPDATE OF status ON files
WHEN NEW.packLeaderId=NEW.id AND NEW.status IN ('pending','uploading','failed','success')
BEGIN
  UPDATE files SET status=NEW.status,error=NEW.error,completedAt=NEW.completedAt,
    expiresAt=NEW.expiresAt,packObjectKey=NEW.packObjectKey,packEtag=NEW.packEtag
  WHERE packLeaderId=NEW.id AND id<>NEW.id AND status NOT IN ('deleted','expired');
END;
CREATE TRIGGER IF NOT EXISTS pack_cleanup_terminal
AFTER UPDATE OF status ON files
WHEN OLD.packObjectKey IS NOT NULL AND NEW.status IN ('deleted','expired')
  AND NOT EXISTS(SELECT 1 FROM files WHERE packLeaderId=OLD.packLeaderId AND status NOT IN ('deleted','expired'))
BEGIN
  INSERT OR IGNORE INTO pack_cleanup(objectKey) VALUES(OLD.packObjectKey);
END;
CREATE TRIGGER IF NOT EXISTS pack_dissolve_unfinished
AFTER UPDATE OF status ON files
WHEN OLD.packLeaderId IS NOT NULL AND OLD.packObjectKey IS NULL AND NEW.status IN ('deleted','expired')
BEGIN
  DELETE FROM leases WHERE fileId=OLD.packLeaderId;
  UPDATE files SET packLeaderId=NULL,packOffset=NULL,packSize=NULL,packSha256=NULL,packGeneration=NULL,
    status=CASE WHEN status IN ('uploading','failed') THEN 'pending' ELSE status END
  WHERE packLeaderId=OLD.packLeaderId;
END;
CREATE TABLE IF NOT EXISTS pack_attempts (
  leaseId TEXT PRIMARY KEY NOT NULL,
  leaderId TEXT NOT NULL REFERENCES files(id),
  generation TEXT NOT NULL,
  userId TEXT NOT NULL,
  deviceId TEXT NOT NULL,
  runId TEXT NOT NULL,
  cleanupAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_attempts_cleanup ON pack_attempts(cleanupAt);
CREATE INDEX IF NOT EXISTS pack_attempts_leader ON pack_attempts(leaderId);
CREATE TRIGGER IF NOT EXISTS pack_save_attempt
AFTER INSERT ON leases
WHEN EXISTS(SELECT 1 FROM files WHERE id=NEW.fileId AND packLeaderId=NEW.fileId)
BEGIN
  INSERT INTO pack_attempts(leaseId,leaderId,generation,userId,deviceId,runId,cleanupAt)
  SELECT NEW.id,NEW.fileId,packGeneration,NEW.userId,NEW.deviceId,NEW.runId,NEW.expiresAt+691200000
  FROM files WHERE id=NEW.fileId;
END;
CREATE TRIGGER IF NOT EXISTS pack_retire_attempt
AFTER DELETE ON pack_attempts
WHEN NOT EXISTS(SELECT 1 FROM files WHERE packLeaderId=OLD.leaderId
  AND packObjectKey='images/packs/'||OLD.leaderId||'/'||OLD.leaseId AND status='success')
BEGIN
  INSERT OR IGNORE INTO pack_cleanup(objectKey) VALUES('images/packs/'||OLD.leaderId||'/'||OLD.leaseId);
END;
