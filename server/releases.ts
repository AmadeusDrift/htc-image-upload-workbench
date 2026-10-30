import { safeEqual } from "./auth";

const CHANNEL = "(?:stable|acceptance-[a-z0-9-]+)";
const ARTIFACT = "Yuntu-Workbench-Setup-\\d+\\.\\d+\\.\\d+-x64\\.exe(?:\\.blockmap)?";
const FILE = `(?:latest\\.yml|${ARTIFACT})`;
const PART_SIZE = 8 * 1024 * 1024;
const MAX_SIZE = 5 * 1024 * 1024 * 1024;
type ReleaseEnv = Partial<Pick<Env, "RELEASES" | "RELEASE_PUBLISH_TOKEN">>;
class ReleaseError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function fail(status: number, message: string): never { throw new ReleaseError(status, message); }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});
const contentType = (name: string) => name === "latest.yml" ? "text/yaml; charset=utf-8" : "application/octet-stream";

// Bound the actual stream, including requests without Content-Length.
async function readBounded(request: Request, limit: number) {
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^\d+$/.test(length)) fail(400, "Invalid release request length");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, "Release request too large"); }
    chunks.push(item.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
async function readJson(request: Request) {
  try { return JSON.parse(new TextDecoder().decode(await readBounded(request, 128 * 1024))); }
  catch (e) { if (e instanceof ReleaseError) throw e; return fail(400, "Invalid release JSON"); }
}
function metadata(size: unknown, sha512: unknown) {
  const n = typeof size === "string" && /^\d+$/.test(size) ? Number(size) : size;
  if (!Number.isSafeInteger(n) || Number(n) < 1 || Number(n) > MAX_SIZE || typeof sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(sha512)) fail(400, "Invalid release size/checksum");
  return { size: Number(n), sha512: String(sha512) };
}
async function checksum(data: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", data));
  return btoa(String.fromCharCode(...digest));
}

// Intentionally accepts only electron-builder's single Windows x64 file schema.
// No tags, aliases, arbitrary URLs, duplicate keys, nesting, or executable YAML.
function parseManifest(data: Uint8Array) {
  const lines = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data).replace(/\r\n/g, "\n").split("\n");
  const top: Record<string, string> = {};
  const file: Record<string, string> = {};
  let files = false;
  let entry = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line === "files:" && !files) { files = true; continue; }
    const nested = /^(?:  - |    )(url|sha512|size): (.+)$/.exec(line);
    if (nested) {
      if (!files || (line.startsWith("  - ") && (entry || nested[1] !== "url")) || (!line.startsWith("  - ") && !entry)) fail(400, "Invalid release manifest files");
      entry = true;
      if (file[nested[1]] !== undefined) fail(400, "Duplicate release manifest field");
      file[nested[1]] = nested[2]; continue;
    }
    const field = /^(version|path|sha512|releaseDate): (.+)$/.exec(line);
    if (!field || top[field[1]] !== undefined) fail(400, "Invalid release manifest structure");
    top[field[1]] = field[2];
  }
  const version = top.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || file.url !== `Yuntu-Workbench-Setup-${version}-x64.exe` || top.path !== file.url || top.sha512 !== file.sha512) fail(400, "Invalid release manifest target");
  if (top.releaseDate && !/^'?\d{4}-\d{2}-\d{2}T[0-9:.]+Z'?$/.test(top.releaseDate)) fail(400, "Invalid release date");
  return { name: file.url, ...metadata(file.size, file.sha512) };
}

async function download(request: Request, bucket: R2Bucket, key: string, name: string) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  // The mutable manifest's body and headers must come from one atomic R2 read.
  const prefetched = request.method === "GET" && (name === "latest.yml" || !request.headers.has("Range")) ? await bucket.get(key) : null;
  const head = prefetched ?? await bucket.head(key);
  if (!head) return json({ error: "Release not found" }, 404);
  const headers = new Headers({
    "Content-Type": contentType(name), "Content-Length": String(head.size), "Accept-Ranges": "bytes",
    "Cache-Control": name === "latest.yml" ? "no-store" : "public, max-age=31536000, immutable",
    ETag: head.httpEtag, "Last-Modified": head.uploaded.toUTCString(), "X-Content-Type-Options": "nosniff",
  });
  if (head.customMetadata?.sha512) headers.set("X-Release-Sha512", head.customMetadata.sha512);
  let range: { offset: number; length: number } | undefined;
  const raw = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (raw && (!ifRange || ifRange === head.httpEtag || ifRange === head.uploaded.toUTCString())) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(raw);
    let start = -1, end = -1;
    if (match && (match[1] || match[2])) {
      if (!match[1]) { const suffix = Number(match[2]); if (Number.isSafeInteger(suffix) && suffix > 0) { start = Math.max(0, head.size - suffix); end = head.size - 1; } }
      else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), head.size - 1) : head.size - 1; }
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= head.size || end < start) {
      headers.set("Content-Range", `bytes */${head.size}`); headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    range = { offset: start, length: end - start + 1 };
    headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`); headers.set("Content-Length", String(range.length));
  }
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = prefetched ?? await bucket.get(key, range ? { range } : undefined);
  if (!object) return json({ error: "Release not found" }, 404);
  if (prefetched && range) {
    if (prefetched.size > 32 * 1024) fail(500, "Invalid hosted release manifest");
    const bytes = new Uint8Array(await prefetched.arrayBuffer());
    return new Response(bytes.slice(range.offset, range.offset + range.length), { status: 206, headers });
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

type UploadSession = { uploadId: string; size: number; sha512: string };
async function claim(bucket: R2Bucket, key: string, value: unknown) {
  const lock = await bucket.put(`.claims/${key}`, JSON.stringify(value), { onlyIf: { etagDoesNotMatch: "*" } });
  if (!lock) fail(409, "Release already exists or upload in progress");
}
async function session(bucket: R2Bucket, key: string, uploadId: unknown): Promise<UploadSession> {
  if (typeof uploadId !== "string" || !uploadId || uploadId.length > 1024) fail(400, "Invalid upload ID");
  const stored = await bucket.get(`.claims/${key}`);
  if (!stored) fail(404, "Upload not found");
  const result = await stored.json<UploadSession>();
  if (result.uploadId !== uploadId) fail(409, "Upload ID does not match release");
  return result;
}

export async function handleRelease(request: Request, env: ReleaseEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/updates/") && !url.pathname.startsWith("/api/releases/")) return null;
  try {
    const publicMatch = new RegExp(`^/updates/(${CHANNEL})/(${FILE})$`).exec(url.pathname);
    const publishMatch = new RegExp(`^/api/releases/(${CHANNEL})/(files|multipart)/(${FILE})(/complete)?$`).exec(url.pathname);
    if (!publicMatch && !publishMatch) return json({ error: "Release route not found" }, 404);
    if (!env.RELEASES) return json({ error: "Release hosting unavailable" }, 503);
    const bucket = env.RELEASES;
    if (publicMatch) return await download(request, bucket, `${publicMatch[1]}/${publicMatch[2]}`, publicMatch[2]);
    const secret = env.RELEASE_PUBLISH_TOKEN;
    const supplied = request.headers.get("X-Release-Token");
    if (typeof secret !== "string" || secret.length < 32 || !supplied || supplied.length > 512 || !(await safeEqual(secret, supplied))) fail(403, "Release publisher token required");
    const [, channel, action, name, complete] = publishMatch!;
    const key = `${channel}/${name}`;
    if (action === "files" && !complete && request.method === "PUT") {
      const bytes = await readBounded(request, name === "latest.yml" ? 32 * 1024 : PART_SIZE);
      if (name === "latest.yml") {
        let manifest: ReturnType<typeof parseManifest>;
        try { manifest = parseManifest(bytes); } catch (e) { if (e instanceof ReleaseError) throw e; return fail(400, "Invalid release manifest"); }
        const executable = await bucket.head(`${channel}/${manifest.name}`);
        const blockmap = await bucket.head(`${channel}/${manifest.name}.blockmap`);
        if (!executable || executable.size !== manifest.size || executable.customMetadata?.sha512 !== manifest.sha512 || !blockmap || !blockmap.customMetadata?.sha512) fail(409, "Publish verified release artifacts before manifest");
        await bucket.put(key, bytes, { httpMetadata: { contentType: contentType(name), cacheControl: "no-store" } });
        return json({ ok: true }, 201);
      }
      if (await bucket.head(key)) fail(409, "Release artifact is immutable");
      const expected = metadata(request.headers.get("X-Release-Size"), request.headers.get("X-Release-Sha512"));
      if (expected.size !== bytes.length || expected.sha512 !== await checksum(bytes)) fail(400, "Release checksum/size mismatch");
      await claim(bucket, key, { complete: true });
      try {
        const object = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: { sha512: expected.sha512, size: String(expected.size) }, httpMetadata: { contentType: contentType(name) } });
        if (!object) fail(409, "Release artifact is immutable");
      } catch (e) { await bucket.delete(`.claims/${key}`); throw e; }
      return json({ ok: true }, 201);
    }
    if (action !== "multipart" || name === "latest.yml") fail(405, "Release method not allowed");
    if (!complete && request.method === "POST") {
      const input = await readJson(request);
      const expected = metadata(input?.size, input?.sha512);
      if (await bucket.head(key)) fail(409, "Release artifact is immutable");
      const existing = await bucket.get(`.claims/${key}`);
      if (existing) {
        const active = await existing.json<UploadSession>();
        if (active.uploadId && active.size === expected.size && active.sha512 === expected.sha512) return json({ uploadId: active.uploadId, partSize: PART_SIZE }, 201);
        fail(409, "Release upload already in progress with different metadata");
      }
      const upload = await bucket.createMultipartUpload(key, { customMetadata: { sha512: expected.sha512, size: String(expected.size) }, httpMetadata: { contentType: contentType(name) } });
      try { await claim(bucket, key, { uploadId: upload.uploadId, ...expected }); }
      catch (e) { await upload.abort(); throw e; }
      return json({ uploadId: upload.uploadId, partSize: PART_SIZE }, 201);
    }
    if (complete && request.method === "POST") {
      const input = await readJson(request);
      const stored = await session(bucket, key, input?.uploadId);
      const count = Math.ceil(stored.size / PART_SIZE);
      if (!Array.isArray(input.parts) || input.parts.length !== count || input.parts.some((p: R2UploadedPart, i: number) => !p || p.partNumber !== i + 1 || typeof p.etag !== "string" || !p.etag || p.etag.length > 256)) fail(400, "Invalid release parts");
      if (await bucket.head(key)) fail(409, "Release artifact is immutable");
      await bucket.resumeMultipartUpload(key, stored.uploadId).complete(input.parts);
      const object = await bucket.head(key);
      if (!object || object.size !== stored.size || object.customMetadata?.sha512 !== stored.sha512) {
        await bucket.delete(key); await bucket.delete(`.claims/${key}`); fail(400, "Completed release metadata mismatch");
      }
      return json({ ok: true, size: object.size, sha512: stored.sha512 }, 201);
    }
    const stored = await session(bucket, key, url.searchParams.get("uploadId"));
    if (!complete && request.method === "PUT") {
      const value = url.searchParams.get("partNumber") ?? "";
      const partNumber = Number(value), count = Math.ceil(stored.size / PART_SIZE);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > count) fail(400, "Invalid release part number");
      const bytes = await readBounded(request, PART_SIZE);
      const expectedSize = partNumber === count ? stored.size - (count - 1) * PART_SIZE : PART_SIZE;
      if (bytes.length !== expectedSize) fail(400, "Incorrect release part size");
      return json(await bucket.resumeMultipartUpload(key, stored.uploadId).uploadPart(partNumber, bytes));
    }
    if (!complete && request.method === "DELETE") {
      // A completed artifact is never removed by the publishing API.
      if (await bucket.head(key)) fail(409, "Release artifact is immutable");
      try { await bucket.resumeMultipartUpload(key, stored.uploadId).abort(); }
      catch (e) {
        // Recover the reservation after R2's incomplete-upload expiry or a lost abort response.
        if (!(e instanceof Error) || !/(?:10024|NoSuchUpload|multipart upload.*does not exist|specified upload does not exist)/i.test(e.message)) throw e;
      }
      await bucket.delete(`.claims/${key}`);
      return json({ ok: true });
    }
    return json({ error: "Release method not allowed" }, 405);
  } catch (e) {
    if (e instanceof ReleaseError) return json({ error: e.message }, e.status);
    console.error(JSON.stringify({ event: "release.error", path: url.pathname, message: e instanceof Error ? e.message : "unknown" }));
    return json({ error: "Release operation failed" }, 500);
  }
}
