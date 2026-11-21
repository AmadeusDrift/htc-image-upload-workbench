ALTER TABLE files ADD COLUMN packLeaderId TEXT;
ALTER TABLE files ADD COLUMN packOffset INTEGER;
ALTER TABLE files ADD COLUMN packSize INTEGER;
ALTER TABLE files ADD COLUMN packObjectKey TEXT;
ALTER TABLE files ADD COLUMN packEtag TEXT;
ALTER TABLE files ADD COLUMN packSha256 TEXT;
ALTER TABLE files ADD COLUMN packGeneration TEXT;
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
