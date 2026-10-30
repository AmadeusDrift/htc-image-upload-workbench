-- Keyset pagination can seek directly within a task without sorting every file.
-- Safe for existing installations and for retries after a partial deployment.
CREATE INDEX IF NOT EXISTS files_task_id ON files(taskId,id);
