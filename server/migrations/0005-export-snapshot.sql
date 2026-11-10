-- Keep a database-assigned completion order independent of wall-clock precision.
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
