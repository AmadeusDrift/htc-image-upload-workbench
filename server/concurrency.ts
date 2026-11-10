export const GLOBAL_UPLOAD_LIMIT = 20;
export const DEMAND_TTL_MS = 30_000;
const LEASE_TTL_MS = 300_000;

export function uploadDemand(db: D1Database, userId: string, deviceId: string, time: number, runId = '', desired?: number) {
  return db.prepare(`INSERT INTO upload_demands(deviceId,userId,runId,expiresAt,updatedAt,desired) VALUES(?,?,?,?,?,?)
    ON CONFLICT(deviceId,runId) DO UPDATE SET expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt,
      desired=COALESCE(excluded.desired,upload_demands.desired)
    WHERE upload_demands.userId=excluded.userId AND upload_demands.expiresAt>0`)
    .bind(deviceId, userId, runId, time + DEMAND_TTL_MS, time, desired ?? null);
}

export async function stopUploadDemand(db: D1Database, userId: string, deviceId: string, runId: string, time = Date.now()) {
  // Keep the tombstone even if the start request has not arrived yet.
  const owned = 'deviceId=? AND runId=? AND userId=?';
  await db.batch([
    db.prepare(`INSERT INTO upload_demands(deviceId,userId,runId,expiresAt,updatedAt) VALUES(?,?,?,0,?)
      ON CONFLICT(deviceId,runId) DO UPDATE SET expiresAt=0,updatedAt=excluded.updatedAt
      WHERE upload_demands.userId=excluded.userId`).bind(deviceId, userId, runId, time),
    db.prepare(`UPDATE files SET status='pending' WHERE status='uploading'
      AND id IN(SELECT fileId FROM leases WHERE ${owned})`).bind(deviceId, runId, userId),
    db.prepare(`DELETE FROM leases WHERE ${owned}`).bind(deviceId, runId, userId),
  ]);
}

export function pruneUploadDemands(db: D1Database, time = Date.now()) {
  return db.prepare("DELETE FROM upload_demands WHERE expiresAt<=? AND (runId='' OR updatedAt<?)")
    .bind(time, time - 86_400_000);
}

function maintenance(db: D1Database, time: number) {
  return [
    db.prepare("UPDATE files SET status='pending',error='上传授权已超时' WHERE status='uploading' AND id IN(SELECT fileId FROM leases WHERE expiresAt<=?)").bind(time),
    db.prepare('DELETE FROM leases WHERE expiresAt<=?').bind(time),
    pruneUploadDemands(db, time),
  ];
}

// Deal one slot to each device in turn until the pool is empty. Devices with
// short queues drop out of later rounds. The extra slots rotate for new clients.
const capacity = `WITH RECURSIVE clock(ts) AS (VALUES(?)),
  live AS (SELECT * FROM leases WHERE expiresAt>(SELECT ts FROM clock)),
  loads AS (SELECT deviceId,COUNT(*) used FROM live GROUP BY deviceId),
  requested AS (
    SELECT deviceId, MAX(COALESCE(desired,${GLOBAL_UPLOAD_LIMIT})) desired, MAX(desired IS NOT NULL) modern
    FROM upload_demands WHERE expiresAt>(SELECT ts FROM clock) GROUP BY deviceId
    UNION ALL SELECT deviceId,${GLOBAL_UPLOAD_LIMIT},0 FROM live WHERE runId=''
      AND NOT EXISTS(SELECT 1 FROM upload_demands d WHERE d.deviceId=live.deviceId AND d.expiresAt>(SELECT ts FROM clock))
  ),
  devices AS (
    SELECT deviceId,MAX(desired) desired,MAX(modern) modern FROM requested GROUP BY deviceId HAVING MAX(desired)>0
  ),
  ranked AS (
    SELECT *,ROW_NUMBER() OVER(ORDER BY deviceId)-1 position,COUNT(*) OVER() peers,MAX(modern) OVER() rotate FROM devices
  ),
  rounds(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rounds WHERE n<${GLOBAL_UPLOAD_LIMIT}),
  tickets AS (
    SELECT deviceId FROM ranked JOIN rounds ON n<=desired
    ORDER BY n,(position+peers-CASE WHEN rotate THEN (SELECT ts FROM clock)/30000%peers ELSE 0 END)%peers
    LIMIT ${GLOBAL_UPLOAD_LIMIT}
  ),
  quotas AS (
    SELECT deviceId,CASE WHEN peers>${GLOBAL_UPLOAD_LIMIT} THEN 1
      ELSE (SELECT COUNT(*) FROM tickets WHERE tickets.deviceId=ranked.deviceId) END quota FROM ranked
  )`;
const remaining = `MIN(
  (SELECT quota FROM quotas WHERE deviceId=actor.device) - COALESCE((SELECT used FROM loads WHERE deviceId=actor.device),0),
  ${GLOBAL_UPLOAD_LIMIT}-(SELECT COUNT(*) FROM live)
)`;

export function reserveUpload(db: D1Database, fileId: string, userId: string, deviceId: string, time = Date.now(), runId?: string) {
  const id = crypto.randomUUID(), expiresAt = time + LEASE_TTL_MS;
  return { id, expiresAt, async run() {
    const results = await db.batch([
      ...maintenance(db, time),
      runId === undefined ? uploadDemand(db, userId, deviceId, time) :
        db.prepare('UPDATE upload_demands SET expiresAt=?,updatedAt=? WHERE deviceId=? AND runId=? AND userId=? AND expiresAt>0')
          .bind(time + DEMAND_TTL_MS, time, deviceId, runId, userId),
      db.prepare(`${capacity}, actor(device,run,user) AS (VALUES(?,?,?))
        INSERT INTO leases(id,fileId,userId,deviceId,expiresAt)
        SELECT ?,?,actor.user,actor.device,? FROM actor
        WHERE ${remaining}>0
          AND EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=actor.device AND runId=actor.run AND userId=actor.user AND expiresAt>(SELECT ts FROM clock))
          AND NOT EXISTS(SELECT 1 FROM live WHERE fileId=?)
          AND EXISTS(SELECT 1 FROM files WHERE id=? AND expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND status IN('pending','failed','uploading'))`)
        .bind(time, deviceId, runId ?? '', userId, id, fileId, expiresAt, fileId, fileId),
    ]);
    return results[4];
  }};
}

type Grant = {fileId:string; leaseId:string; expiresAt:number; objectKey:string; contentType:string};
type SlotSnapshot = {active:number; quota:number; used:number; globalUsed:number; uploadingDevices:number};

export async function reserveUploadBatch(db: D1Database, input: {
  fileIds: string[]; demand: number; taskId: string; userId: string; deviceId: string; runId: string;
}) {
  const {fileIds,demand,taskId,userId,deviceId,runId} = input;
  const time = Date.now(), expiresAt = time + LEASE_TTL_MS;
  const requested = JSON.stringify(fileIds);
  const statements = [
    ...(fileIds.length ? maintenance(db,time) : []),
    uploadDemand(db, userId, deviceId, time, runId, demand),
  ];
  if (fileIds.length) statements.push(
    db.prepare(`${capacity}, actor(device,run,user,task) AS (VALUES(?,?,?,?))
      INSERT INTO leases(id,fileId,userId,deviceId,expiresAt,runId)
      SELECT lower(hex(randomblob(16))),f.id,actor.user,actor.device,?,actor.run
      FROM actor, json_each(?) AS input JOIN files f ON f.id=input.value
      WHERE f.taskId=actor.task AND f.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND f.status IN('pending','failed','uploading')
        AND NOT EXISTS(SELECT 1 FROM live WHERE fileId=f.id)
        AND EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=actor.device AND runId=actor.run AND userId=actor.user AND expiresAt>(SELECT ts FROM clock))
      ORDER BY input.key
      LIMIT MAX(0,COALESCE((SELECT ${remaining} FROM actor),0))`)
      .bind(time, deviceId, runId, userId, taskId, expiresAt, requested),
    db.prepare(`UPDATE files SET status='uploading',error=NULL WHERE taskId=? AND id IN(
      SELECT l.fileId FROM leases l JOIN json_each(?) j ON j.value=l.fileId
      WHERE l.deviceId=? AND l.runId=? AND l.userId=? AND l.expiresAt>?
    ) AND (status IN('pending','failed') OR (status='uploading' AND error IS NOT NULL))`).bind(taskId, requested, deviceId, runId, userId, time),
    db.prepare(`SELECT l.fileId,l.id leaseId,l.expiresAt,f.objectKey,f.contentType
      FROM json_each(?) j JOIN leases l ON l.fileId=j.value JOIN files f ON f.id=l.fileId
      WHERE f.taskId=? AND f.status='uploading' AND l.deviceId=? AND l.runId=? AND l.userId=? AND l.expiresAt>?
      ORDER BY j.key`).bind(requested, taskId, deviceId, runId, userId, time),
  );
  statements.push(db.prepare(`${capacity}, actor(device,run,user) AS (VALUES(?,?,?))
    SELECT EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=actor.device AND runId=actor.run AND userId=actor.user AND expiresAt>(SELECT ts FROM clock)) active,
      COALESCE((SELECT quota FROM quotas WHERE deviceId=actor.device),0) quota,
      COALESCE((SELECT used FROM loads WHERE deviceId=actor.device),0) used,
      (SELECT COUNT(*) FROM live) globalUsed,(SELECT COUNT(*) FROM loads) uploadingDevices FROM actor`)
    .bind(time,deviceId,runId,userId));
  const results = await db.batch(statements);
  return {
    slots: results.at(-1)!.results[0] as SlotSnapshot,
    grants: fileIds.length ? results.at(-2)!.results as Grant[] : [],
  };
}
