export const GLOBAL_UPLOAD_LIMIT = 20;
export const DEMAND_TTL_MS = 30_000;
const LEASE_TTL_MS = 300_000;
export const UPLOAD_CONFIRM_LIMIT = GLOBAL_UPLOAD_LIMIT * 2;
const CONFIRM_TTL_MS = 12 * 60 * 60 * 1000;
export type UploadReceipt = {fileId:string; leaseId:string};

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
      AND id IN(SELECT fileId FROM leases WHERE ${owned} AND uploadedAt IS NULL)`).bind(deviceId, runId, userId),
    db.prepare(`DELETE FROM leases WHERE ${owned} AND uploadedAt IS NULL`).bind(deviceId, runId, userId),
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
  upload_pool(name) AS (SELECT COALESCE((SELECT pool FROM upload_pool_members WHERE userId=?),'company')),
  live AS (
    SELECT l.* FROM leases l LEFT JOIN upload_pool_members m ON m.userId=l.userId
    WHERE l.expiresAt>(SELECT ts FROM clock) AND l.uploadedAt IS NULL
      AND COALESCE(m.pool,'company')=(SELECT name FROM upload_pool)
  ),
  active_demands AS (
    SELECT d.* FROM upload_demands d LEFT JOIN upload_pool_members m ON m.userId=d.userId
    WHERE d.expiresAt>(SELECT ts FROM clock) AND COALESCE(m.pool,'company')=(SELECT name FROM upload_pool)
  ),
  loads AS (SELECT deviceId,COUNT(*) used FROM live GROUP BY deviceId),
  requested AS (
    SELECT deviceId, MAX(COALESCE(desired,${GLOBAL_UPLOAD_LIMIT})) desired, MAX(desired IS NOT NULL) modern
    FROM active_demands GROUP BY deviceId
    UNION ALL SELECT deviceId,${GLOBAL_UPLOAD_LIMIT},0 FROM live WHERE runId=''
      AND NOT EXISTS(SELECT 1 FROM active_demands d WHERE d.deviceId=live.deviceId)
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
        INSERT INTO leases(id,fileId,userId,deviceId,expiresAt,runId)
        SELECT ?,?,actor.user,actor.device,?,actor.run FROM actor
        WHERE ${remaining}>0
          AND EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=actor.device AND runId=actor.run AND userId=actor.user AND expiresAt>(SELECT ts FROM clock))
          AND NOT EXISTS(SELECT 1 FROM leases WHERE fileId=?)
          AND EXISTS(SELECT 1 FROM files WHERE id=? AND packLeaderId IS NULL AND expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND status IN('pending','failed','uploading'))`)
        .bind(time, userId, deviceId, runId ?? '', userId, id, fileId, expiresAt, fileId, fileId),
    ]);
    return results[4];
  }};
}

type Grant = {fileId:string; leaseId:string; expiresAt:number; objectKey:string; contentType:string; packLeaderId:string|null; packSha256:string|null};
type SlotSnapshot = {active:number; pool:'company'|'external'; quota:number; used:number; globalUsed:number; uploadingDevices:number; deviceHeld:number};

type BatchRequest = {
  fileIds: string[]; demand: number; taskId: string; userId: string; deviceId: string; runId: string;
  uploaded?: UploadReceipt[]; packed?: boolean;
};

async function retireAbandonedRuns(db: D1Database, input: BatchRequest, time: number) {
  const {deviceId,userId,runId,taskId}=input;
  // A third-party client can share one run across tasks. Only retire runs whose
  // unacknowledged leases all belong to this task; keep every saved receipt.
  const retired = db.prepare(`UPDATE upload_demands SET expiresAt=0,updatedAt=?
    WHERE deviceId=? AND userId=? AND expiresAt<=? AND runId IN (
      SELECT l.runId FROM leases l JOIN files f ON f.id=l.fileId
      WHERE l.deviceId=? AND l.userId=? AND l.runId<>? AND l.runId<>'' AND l.uploadedAt IS NULL
      GROUP BY l.runId HAVING MIN(f.taskId)=? AND MAX(f.taskId)=?)
    AND EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=? AND userId=? AND runId=? AND expiresAt>?)`)
    .bind(time,deviceId,userId,time,deviceId,userId,runId,taskId,taskId,deviceId,userId,runId,time);
  const abandoned = `deviceId=? AND userId=? AND uploadedAt IS NULL AND runId<>'' AND runId<>?
    AND EXISTS(SELECT 1 FROM upload_demands d WHERE d.deviceId=leases.deviceId AND d.runId=leases.runId
      AND d.userId=leases.userId AND d.expiresAt=0)
    AND EXISTS(SELECT 1 FROM files f WHERE f.id=leases.fileId AND f.taskId=?)`;
  const args=[deviceId,userId,runId,taskId];
  const results=await db.batch([retired,
    db.prepare(`UPDATE files SET status='pending' WHERE status='uploading' AND id IN
      (SELECT fileId FROM leases WHERE ${abandoned})`).bind(...args),
    db.prepare(`DELETE FROM leases WHERE ${abandoned}`).bind(...args),
  ]);
  return results[2].meta.changes>0;
}

export async function reserveUploadBatch(db: D1Database, input: BatchRequest, allowRecovery=true):
  Promise<{slots:SlotSnapshot; grants:Grant[]; receipts:UploadReceipt[]}> {
  const {fileIds,demand,taskId,userId,deviceId,runId,uploaded} = input;
  const time = Date.now(), expiresAt = time + LEASE_TTL_MS;
  const requested = JSON.stringify(fileIds);
  const statements = [
    ...(fileIds.length || uploaded?.length ? maintenance(db,time) : []),
    uploadDemand(db, userId, deviceId, time, runId, demand),
  ];
  if (uploaded?.length) statements.push(db.prepare(`
    UPDATE leases SET uploadedAt=?,expiresAt=?
    WHERE userId=? AND deviceId=? AND runId=? AND expiresAt>? AND uploadedAt IS NULL
      AND fileId IN (SELECT id FROM files WHERE taskId=? AND status='uploading')
      AND EXISTS (SELECT 1 FROM json_each(?) j
        WHERE json_extract(j.value,'$.leaseId')=leases.id AND json_extract(j.value,'$.fileId')=leases.fileId)
    `).bind(time,time+CONFIRM_TTL_MS,userId,deviceId,runId,time,taskId,JSON.stringify(uploaded)));
  if (fileIds.length) statements.push(
    db.prepare(`${capacity}, actor(device,run,user,task) AS (VALUES(?,?,?,?))
      INSERT INTO leases(id,fileId,userId,deviceId,expiresAt,runId)
      SELECT lower(hex(randomblob(16))),f.id,actor.user,actor.device,?,actor.run
      FROM actor, json_each(?) AS input JOIN files f ON f.id=input.value
      WHERE f.taskId=actor.task AND f.expiresAt>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND f.status IN('pending','failed','uploading')
        AND (f.packLeaderId IS NULL OR (?=1 AND f.packLeaderId=f.id))
        AND NOT EXISTS(SELECT 1 FROM leases WHERE fileId=f.id)
        AND EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=actor.device AND runId=actor.run AND userId=actor.user AND expiresAt>(SELECT ts FROM clock))
      ORDER BY input.key
      LIMIT MAX(0,MIN(COALESCE((SELECT ${remaining} FROM actor),0),
        ${UPLOAD_CONFIRM_LIMIT}-(SELECT COUNT(*) FROM leases WHERE deviceId=? AND userId=? AND expiresAt>?)))`)
      .bind(time, userId, deviceId, runId, userId, taskId, expiresAt, requested,input.packed ? 1 : 0,deviceId,userId,time),
    db.prepare(`UPDATE files SET status='uploading',error=NULL WHERE taskId=? AND id IN(
      SELECT l.fileId FROM leases l JOIN json_each(?) j ON j.value=l.fileId
      WHERE l.deviceId=? AND l.runId=? AND l.userId=? AND l.expiresAt>?
    ) AND (status IN('pending','failed') OR (status='uploading' AND error IS NOT NULL))`).bind(taskId, requested, deviceId, runId, userId, time),
    db.prepare(`SELECT l.fileId,l.id leaseId,l.expiresAt,f.objectKey,f.contentType,f.packLeaderId,f.packSha256
      FROM json_each(?) j JOIN leases l ON l.fileId=j.value JOIN files f ON f.id=l.fileId
      WHERE f.taskId=? AND f.status='uploading' AND l.deviceId=? AND l.runId=? AND l.userId=? AND l.expiresAt>? AND l.uploadedAt IS NULL
        AND (f.packLeaderId IS NULL OR (?=1 AND f.packLeaderId=f.id))
      ORDER BY j.key`).bind(requested, taskId, deviceId, runId, userId, time, input.packed ? 1 : 0),
  );
  if (uploaded?.length) statements.push(db.prepare(`
    SELECT l.fileId,l.id leaseId FROM leases l JOIN files f ON f.id=l.fileId
    JOIN json_each(?) j ON json_extract(j.value,'$.leaseId')=l.id AND json_extract(j.value,'$.fileId')=l.fileId
    WHERE f.taskId=? AND l.userId=? AND l.deviceId=? AND l.runId=? AND l.uploadedAt IS NOT NULL AND l.expiresAt>?
  `).bind(JSON.stringify(uploaded),taskId,userId,deviceId,runId,time));
  statements.push(db.prepare(`${capacity}, actor(device,run,user) AS (VALUES(?,?,?))
    SELECT EXISTS(SELECT 1 FROM upload_demands WHERE deviceId=actor.device AND runId=actor.run AND userId=actor.user AND expiresAt>(SELECT ts FROM clock)) active,
      (SELECT name FROM upload_pool) pool,
      COALESCE((SELECT quota FROM quotas WHERE deviceId=actor.device),0) quota,
      COALESCE((SELECT used FROM loads WHERE deviceId=actor.device),0) used,
      EXISTS(SELECT 1 FROM live WHERE deviceId=actor.device AND userId=actor.user AND runId<>actor.run AND runId<>'') otherRunHeld,
      (SELECT COUNT(*) FROM leases WHERE deviceId=actor.device AND userId=actor.user AND expiresAt>(SELECT ts FROM clock)) deviceHeld,
      (SELECT COUNT(*) FROM live) globalUsed,(SELECT COUNT(*) FROM loads) uploadingDevices FROM actor`)
    .bind(time,userId,deviceId,runId,userId));
  const results = await db.batch(statements);
  const receipts = uploaded?.length ? results.at(-2)!.results as UploadReceipt[] : [];
  const slots=results.at(-1)!.results[0] as SlotSnapshot & {otherRunHeld:number};
  const grants=fileIds.length ? results.at(uploaded?.length ? -3 : -2)!.results as Grant[] : [];
  if (allowRecovery && slots.active && fileIds.length && !grants.length && slots.otherRunHeld &&
      await retireAbandonedRuns(db,input,Date.now())) {
    return reserveUploadBatch(db,input,false);
  }
  return {slots,grants,receipts};
}
