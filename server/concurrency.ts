export const GLOBAL_UPLOAD_LIMIT = 20;
export const DEMAND_TTL_MS = 30_000;

export function uploadDemand(db: D1Database, userId: string, deviceId: string, time: number, runId = '') {
  return db.prepare(`INSERT INTO upload_demands(deviceId,userId,runId,expiresAt,updatedAt) VALUES(?,?,?,?,?)
    ON CONFLICT(deviceId,runId) DO UPDATE SET userId=excluded.userId,expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt
    WHERE upload_demands.expiresAt>0`)
    .bind(deviceId, userId, runId, time + DEMAND_TTL_MS, time);
}

export function stopUploadDemand(db: D1Database, userId: string, deviceId: string, runId: string, time = Date.now()) {
  // Keep a tombstone even if the corresponding start request has not arrived.
  // A delayed start/lease from this run must never resurrect a paused queue.
  return db.prepare(`INSERT INTO upload_demands(deviceId,userId,runId,expiresAt,updatedAt) VALUES(?,?,?,0,?)
    ON CONFLICT(deviceId,runId) DO UPDATE SET expiresAt=0,updatedAt=excluded.updatedAt`)
    .bind(deviceId, userId, runId, time);
}

export function pruneUploadDemands(db: D1Database, time = Date.now()) {
  return db.prepare("DELETE FROM upload_demands WHERE expiresAt<=? AND (runId='' OR updatedAt<?)")
    .bind(time, time - 86_400_000);
}

// D1 serializes each statement. Membership, fair share and the hard company cap
// must be checked INSIDE the INSERT, never by a separate read-then-write.
// Existing leases count as participants even if their client has no heartbeat.
// A reduced share blocks new grants; it never revokes in-flight image transfers.
export function reserveUpload(db: D1Database, fileId: string, userId: string, deviceId: string, time = Date.now(), runId?: string) {
  const id = crypto.randomUUID(), expiresAt = time + 300_000;
  return { id, expiresAt, async run() {
    const results = await db.batch([
      db.prepare("UPDATE files SET status='pending',error='上传授权已超时' WHERE status='uploading' AND id IN(SELECT fileId FROM leases WHERE expiresAt<=?)").bind(time),
      db.prepare('DELETE FROM leases WHERE expiresAt<=?').bind(time),
      pruneUploadDemands(db, time),
      runId === undefined ? uploadDemand(db, userId, deviceId, time) :
        db.prepare('UPDATE upload_demands SET expiresAt=?,updatedAt=? WHERE deviceId=? AND runId=? AND userId=? AND expiresAt>0')
          .bind(time + DEMAND_TTL_MS, time, deviceId, runId, userId),
      db.prepare(`WITH clock(ts) AS (VALUES(?)),
        devices AS (
          SELECT deviceId FROM upload_demands WHERE expiresAt>(SELECT ts FROM clock)
          UNION SELECT deviceId FROM leases WHERE expiresAt>(SELECT ts FROM clock)
        ), shares AS (
          SELECT deviceId,ROW_NUMBER() OVER(ORDER BY deviceId) position,COUNT(*) OVER() peers FROM devices
        )
        INSERT INTO leases(id,fileId,userId,deviceId,expiresAt)
        SELECT ?,?,?,?,? FROM shares WHERE deviceId=?
          AND EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=shares.deviceId AND runId=? AND expiresAt>(SELECT ts FROM clock))
          AND (SELECT COUNT(*) FROM leases WHERE expiresAt>(SELECT ts FROM clock))<${GLOBAL_UPLOAD_LIMIT}
          AND (SELECT COUNT(*) FROM leases WHERE deviceId=shares.deviceId AND expiresAt>(SELECT ts FROM clock))
            < MAX(1,${GLOBAL_UPLOAD_LIMIT}/peers)+CASE WHEN peers<=${GLOBAL_UPLOAD_LIMIT} AND position<=${GLOBAL_UPLOAD_LIMIT}%peers THEN 1 ELSE 0 END
          AND NOT EXISTS(SELECT 1 FROM leases WHERE fileId=?)
          AND EXISTS(SELECT 1 FROM files WHERE id=? AND status IN('pending','failed','uploading'))`)
        .bind(time, id, fileId, userId, deviceId, expiresAt, deviceId, runId ?? '', fileId, fileId),
    ]);
    return results[4];
  }};
}
