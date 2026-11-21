export const PACK_TYPE = "application/octet-stream";
const MAX_PACK_BYTES = 24 * 1024 * 1024;
type Fail = (status: number, message: string) => never;

export type PackFields = {
  packLeaderId: string | null;
  packOffset: number | null;
  packSize: number | null;
  packObjectKey: string | null;
  packEtag: string | null;
  packSha256: string | null;
  packGeneration: string | null;
};

// A new lease gets a new object. A delayed PUT can never overwrite a newer lease.
export function packKey(leaderId: string, leaseId: string) {
  return `images/packs/${leaderId}/${leaseId}`;
}

export async function verifiedPack(bucket: R2Bucket, key: string, size: number, sha256: string, freshAfter: number) {
  const object = await bucket.head(key);
  if (!object || object.size !== size || object.httpMetadata?.contentType !== PACK_TYPE ||
      object.checksums.toJSON().sha256 !== sha256) return null;
  if (object.uploaded.getTime() >= freshAfter) return object;
  // The bucket expires objects eight days after writing. Refresh a late recovery
  // inside R2 to give its new public links seven full days, without a desktop PUT.
  const source = await bucket.get(key, {onlyIf: {etagMatches: object.etag}});
  if (!source || !("body" in source)) return null;
  return bucket.put(key, source.body, {onlyIf: {etagMatches: object.etag}, sha256, httpMetadata: {contentType: PACK_TYPE}});
}

export async function registerPacks(db: D1Database, taskId: string, packs: unknown, fail: Fail) {
  if (!Array.isArray(packs) || !packs.length || packs.length > 100)
    fail(400, "每次可登记1至100个图片包");
  const seen = new Set<string>();
  const rows: {leader: string; id: string; hash: string; digest: string; position: number}[] = [];
  for (const pack of packs) {
    const members = pack?.members;
    if (!Array.isArray(members) || members.length < 2 || members.length > 12)
      fail(400, "每个图片包需含2至12张图片");
    if (typeof pack.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(pack.sha256))
      fail(400, "图片包SHA256校验值无效");
    for (const [position, member] of members.entries()) {
      if (typeof member?.fileId !== "string" || !member.fileId || member.fileId.length > 120 ||
          typeof member.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(member.sha256) || seen.has(member.fileId))
        fail(400, "图片包成员或校验值无效");
      seen.add(member.fileId);
      rows.push({leader: members[0].fileId, id: member.fileId, hash: member.sha256.toLowerCase(), digest: pack.sha256.toLowerCase(), position});
    }
  }
  // Materialize the checks against a single snapshot before updating any member.
  // An overlapping request either replays the exact manifest or changes zero rows.
  const result = await db.prepare(`
    WITH input AS (SELECT value->>'$.leader' leader,value->>'$.id' id,
      value->>'$.hash' hash,value->>'$.digest' digest,value->>'$.position' position FROM json_each(?)),
    manifest AS MATERIALIZED (
      SELECT i.*, f.id found, f.taskId, f.sha256, f.packSha256, f.packLeaderId, f.packSize, f.packOffset, f.status, f.expiresAt,
        SUM(f.size) OVER (PARTITION BY i.leader) total,
        MIN(f.expiresAt) OVER (PARTITION BY i.leader) firstExpiry,
        SUM(f.size) OVER (PARTITION BY i.leader ORDER BY i.position ROWS UNBOUNDED PRECEDING)-f.size offset,
        EXISTS(SELECT 1 FROM leases l WHERE l.fileId=i.id) leased
      FROM input i LEFT JOIN files f ON f.id=i.id
    ),
    valid AS MATERIALIZED (SELECT MIN(CASE WHEN found IS NOT NULL AND taskId=? AND lower(sha256)=hash AND total<=?
      AND ((packLeaderId=leader AND packOffset=offset AND packSize=total AND packSha256=digest) OR
        (packLeaderId IS NULL AND status IN('pending','failed') AND expiresAt>? AND leased=0
          AND NOT EXISTS(SELECT 1 FROM files existing WHERE existing.packLeaderId=manifest.leader)))
      THEN 1 ELSE 0 END) ok FROM manifest)
    UPDATE files SET packLeaderId=m.leader, packOffset=m.offset, packSize=m.total, packSha256=m.digest,
      expiresAt=CASE WHEN files.packLeaderId IS NULL THEN m.firstExpiry ELSE files.expiresAt END,
      packGeneration=CASE WHEN files.id=m.leader THEN COALESCE(files.packGeneration,lower(hex(randomblob(16)))) END
    FROM manifest m WHERE files.id=m.id AND (SELECT ok FROM valid)=1 RETURNING id
  `).bind(JSON.stringify(rows), taskId, MAX_PACK_BYTES, new Date().toISOString()).all();
  if (result.results.length !== rows.length)
    fail(409, "图片包超过24 MiB，或成员、顺序、校验值或上传状态已改变");
}

export async function readPackedImage(request: Request, bucket: R2Bucket, file: PackFields & {
  id: string; size: number; contentType: string;
}, fail: Fail) {
  if (!file.packObjectKey || !file.packEtag || file.packOffset === null || file.packSize === null ||
      file.packOffset < 0 || file.packOffset + file.size > file.packSize)
    return fail(404, "图片不存在");
  const etag = `"${file.id}-${file.packEtag}"`;
  const headers = new Headers({
    "Content-Type": file.contentType, "Content-Length": String(file.size), "Accept-Ranges": "bytes",
    "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox", ETag: etag,
  });
  let start = 0, end = file.size - 1, status = 200;
  const raw = request.headers.get("Range");
  if (raw && (!request.headers.has("If-Range") || request.headers.get("If-Range") === etag)) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
    if (match?.[1]) {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    } else if (match?.[2]) {
      const tail = Number(match[2]);
      start = Number.isSafeInteger(tail) && tail > 0 ? Math.max(0, file.size - tail) : -1;
    } else start = -1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      headers.set("Content-Range", `bytes */${file.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, {status: 416, headers});
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
    headers.set("Content-Length", String(end - start + 1));
    status = 206;
  }
  const object = request.method === "HEAD" ? await bucket.head(file.packObjectKey) :
    await bucket.get(file.packObjectKey, {
      range: {offset: file.packOffset + start, length: end - start + 1},
      onlyIf: {etagMatches: file.packEtag},
    });
  if (!object || object.etag !== file.packEtag || object.size !== file.packSize ||
      (request.method !== "HEAD" && !("body" in object)))
    return fail(404, "图片不存在");
  return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, {headers, status});
}

// Terminal rows never acquire a second reference to a confirmed lease object.
// A failed delete stays in the queue and the next sweep can safely repeat it.
export async function cleanPackObjects(db: D1Database, bucket: R2Bucket, specificKey?: string) {
  const keys = (specificKey
    ? await db.prepare("SELECT objectKey FROM pack_cleanup WHERE objectKey=?").bind(specificKey).all<{objectKey: string}>()
    : await db.prepare("SELECT objectKey FROM pack_cleanup LIMIT 1000").all<{objectKey: string}>()
  ).results.map(row => row.objectKey);
  if (!keys.length) return;
  await bucket.delete(keys);
  await db.prepare("DELETE FROM pack_cleanup WHERE objectKey IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(keys)).run();
}
