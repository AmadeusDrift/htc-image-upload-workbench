import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { createHash } from "node:crypto";
let mf: Miniflare;
const token = "release-token-012345678901234567890123456789";
const name = "Yuntu-Workbench-Setup-1.1.1-x64.exe";
const sha = (data: string | Uint8Array) => createHash("sha512").update(data).digest("base64");
const call = (path: string, method = "GET", body?: string | Uint8Array, headers = {}) => mf.dispatchFetch("http://localhost" + path, { method, body, headers });
const publish = (file: string, data: string, channel = "stable") => call(`/api/releases/${channel}/files/${file}`, "PUT", data, { "X-Release-Token": token, "X-Release-Sha512": sha(data), "X-Release-Size": String(Buffer.byteLength(data)) });
const manifest = (hash = sha("installer"), size = 9) => `version: 1.1.1\nfiles:\n  - url: ${name}\n    sha512: ${hash}\n    size: ${size}\npath: ${name}\nsha512: ${hash}\nreleaseDate: '2026-10-30T00:00:00.000Z'\n`;
beforeAll(async () => {
  const b = await build({ entryPoints: ["server/index.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: b.outputFiles[0].text, compatibilityDate: "2026-10-29", r2Buckets: ["RELEASES"], bindings: { RELEASE_PUBLISH_TOKEN: token } }));
});
afterAll(async () => { await mf?.dispose(); });
describe("isolated release service", () => {
  it("fails closed for missing/wrong/ordinary employee credentials", async () => {
    for (const headers of [{}, { "X-Release-Token": "wrong" }, { Authorization: "Bearer employee-token" }]) expect((await call(`/api/releases/stable/files/${name}`, "PUT", "installer", headers)).status).toBe(403);
  });
  it("rejects paths, unsupported channels and non-release filenames", async () => {
    for (const path of ["/updates/beta/latest.yml", "/updates/stable/other.exe", "/updates/stable/a%2fb.exe", "/updates/acceptance-/latest.yml", "/api/releases/stable/files/no.txt"]) expect((await call(path)).status).toBe(404);
  });
  it("does not publish manifest before artifacts or with mismatched metadata", async () => {
    expect((await publish("latest.yml", manifest())).status).toBe(409);
    expect((await publish(name, "installer")).status).toBe(201);
    expect((await publish("latest.yml", manifest())).status).toBe(409);
    expect((await publish(name + ".blockmap", "map")).status).toBe(201);
    expect((await publish("latest.yml", manifest(sha("wrong")))).status).toBe(409);
    expect((await publish("latest.yml", manifest())).status).toBe(201);
  });
  it("serves public GET/HEAD with immutable caching and manifest no-store", async () => {
    const response = await call(`/updates/stable/${name}`);
    expect(response.status).toBe(200); expect(await response.text()).toBe("installer");
    expect(response.headers.get("Cache-Control")).toContain("immutable");
    const head = await call(`/updates/stable/${name}`, "HEAD");
    expect(head.status).toBe(200); expect(head.headers.get("Content-Length")).toBe("9"); expect(await head.text()).toBe("");
    expect((await call("/updates/stable/latest.yml")).headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns correct bounded, suffix, open ranges and 416", async () => {
    for (const [range, text, contentRange] of [["bytes=1-3", "nst", "bytes 1-3/9"], ["bytes=-3", "ler", "bytes 6-8/9"], ["bytes=7-", "er", "bytes 7-8/9"], ["bytes=7-999", "er", "bytes 7-8/9"]]) {
      const r = await call(`/updates/stable/${name}`, "GET", undefined, { Range: range }); expect(r.status).toBe(206); expect(await r.text()).toBe(text); expect(r.headers.get("Content-Range")).toBe(contentRange);
    }
    for (const range of ["bytes=10-", "bytes=3-1", "bytes=0-1,3-4", "bytes=-0", "garbage"]) { const r = await call(`/updates/stable/${name}`, "GET", undefined, { Range: range }); expect(r.status).toBe(416); expect(r.headers.get("Content-Range")).toBe("bytes */9"); }
  });
  it("rejects overwrites and false small-file checksums", async () => {
    expect((await publish(name, "replacement")).status).toBe(409);
    expect(await (await call(`/updates/stable/${name}`)).text()).toBe("installer");
    expect((await call(`/api/releases/acceptance-hash/files/${name}`, "PUT", "data", { "X-Release-Token": token, "X-Release-Sha512": sha("wrong"), "X-Release-Size": "4" })).status).toBe(400);
  });
  it("rejects malicious manifest structures and external URLs", async () => {
    for (const value of [manifest().replace(name, "https://evil.test/file.exe"), manifest() + "path: duplicate.exe\n", "version: &a 1.1.1\nfiles: *a\n"]) expect((await publish("latest.yml", value)).status).toBe(400);
  });
  it("uploads and completes real R2 multipart data, and aborts an upload", async () => {
    const channel = "acceptance-multipart";
    const base = `/api/releases/${channel}/multipart/${name}`;
    const data = new Uint8Array(8 * 1024 * 1024 + 5).fill(7);
    const auth = { "X-Release-Token": token };
    const start = await call(base, "POST", JSON.stringify({ size: data.length, sha512: sha(data) }), auth);
    expect(start.status).toBe(201);
    const { uploadId } = await start.json() as { uploadId: string };
    const parts = [];
    for (let offset = 0, partNumber = 1; offset < data.length; offset += 8 * 1024 * 1024, partNumber++) {
      const response = await call(`${base}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, "PUT", data.slice(offset, offset + 8 * 1024 * 1024), auth);
      expect(response.status).toBe(200); parts.push(await response.json());
    }
    expect((await call(`${base}/complete`, "POST", JSON.stringify({ uploadId, parts }), auth)).status).toBe(201);
    const downloaded = new Uint8Array(await (await call(`/updates/${channel}/${name}`)).arrayBuffer());
    expect(sha(downloaded)).toBe(sha(data));
    expect((await call(base, "POST", JSON.stringify({ size: data.length, sha512: sha(data) }), auth)).status).toBe(409);
    const abortBase = `/api/releases/acceptance-abort/multipart/${name}`;
    const started = await call(abortBase, "POST", JSON.stringify({ size: 10, sha512: sha("0123456789") }), auth);
    const aborted = await started.json() as { uploadId: string };
    expect((await call(`${abortBase}?uploadId=${encodeURIComponent(aborted.uploadId)}`, "DELETE", undefined, auth)).status).toBe(200);
    expect((await call(`/updates/acceptance-abort/${name}`)).status).toBe(404);
  });
});

it("fails closed when the publisher secret is absent or too short", async () => {
  const { handleRelease } = await import("../releases");
  const bucket = {} as R2Bucket;
  for (const secret of [undefined, "short"]) {
    const response = await handleRelease(new Request(`http://localhost/api/releases/stable/files/${name}`, { method: "PUT", headers: { "X-Release-Token": token } }), { RELEASES: bucket, RELEASE_PUBLISH_TOKEN: secret });
    expect(response?.status).toBe(403);
  }
});
it("accepts every permitted acceptance channel and serializes simultaneous immutable writes", async () => {
  const responses = await Promise.all([publish(name, "winner-a", "acceptance-double--dash"), publish(name, "winner-b", "acceptance-double--dash")]);
  expect(responses.map(r => r.status).sort()).toEqual([201, 409]);
  expect(["winner-a", "winner-b"]).toContain(await (await call(`/updates/acceptance-double--dash/${name}`)).text());
});
it("bounds small uploads and multipart parts and rejects wrong upload identity", async () => {
  const base = `/api/releases/acceptance-bounds/multipart/${name}`;
  const auth = { "X-Release-Token": token };
  const data = new Uint8Array(8 * 1024 * 1024 + 1).fill(1);
  expect((await call(`/api/releases/acceptance-bounds/files/${name}`, "PUT", data, { ...auth, "X-Release-Size": String(data.length), "X-Release-Sha512": sha(data) })).status).toBe(413);
  const start = await call(base, "POST", JSON.stringify({ size: data.length, sha512: sha(data) }), auth);
  const { uploadId } = await start.json() as { uploadId: string };
  expect((await call(`${base}?uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, "PUT", data, auth)).status).toBe(413);
  expect((await call(`${base}?uploadId=${encodeURIComponent(uploadId)}&partNumber=1`, "PUT", "short", auth)).status).toBe(400);
  expect((await call(`${base}?uploadId=wrong&partNumber=1`, "PUT", "short", auth)).status).toBe(409);
  expect((await call(`${base}/complete`, "POST", JSON.stringify({ uploadId, parts: [{ partNumber: 2, etag: "fake" }] }), auth)).status).toBe(400);
  expect((await call(`${base}?uploadId=${encodeURIComponent(uploadId)}`, "DELETE", undefined, auth)).status).toBe(200);
});
it("publishes an installer exceeding 100 MiB using thirteen bounded R2 parts", async () => {
  const base = `/api/releases/acceptance-large/multipart/${name}`;
  const auth = { "X-Release-Token": token };
  const part = new Uint8Array(8 * 1024 * 1024).fill(42);
  const digest = createHash("sha512");
  for (let i = 0; i < 13; i++) digest.update(part);
  const hash = digest.digest("base64");
  const size = part.length * 13;
  const start = await call(base, "POST", JSON.stringify({ size, sha512: hash }), auth);
  expect(start.status).toBe(201);
  const { uploadId } = await start.json() as { uploadId: string };
  const parts = [];
  for (let partNumber = 1; partNumber <= 13; partNumber++) {
    const response = await call(`${base}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}`, "PUT", part, auth);
    expect(response.status).toBe(200); parts.push(await response.json());
  }
  expect((await call(`${base}/complete`, "POST", JSON.stringify({ uploadId, parts }), auth)).status).toBe(201);
  const response = await call(`/updates/acceptance-large/${name}`);
  expect(response.headers.get("Content-Length")).toBe(String(size));
  const remote = createHash("sha512");
  for await (const chunk of response.body!) remote.update(chunk);
  expect(remote.digest("base64")).toBe(hash);
});
it("resumes matching interrupted uploads and clears claims for expired/aborted R2 sessions", async () => {
  const channel = "acceptance-resume";
  const base = `/api/releases/${channel}/multipart/${name}`;
  const auth = { "X-Release-Token": token };
  const input = JSON.stringify({ size: 10, sha512: sha("0123456789") });
  const first = await (await call(base, "POST", input, auth)).json() as { uploadId: string };
  const again = await (await call(base, "POST", input, auth)).json() as { uploadId: string };
  expect(again.uploadId).toBe(first.uploadId);
  const bucket = await mf.getR2Bucket("RELEASES");
  await bucket.resumeMultipartUpload(`${channel}/${name}`, first.uploadId).abort();
  expect((await call(`${base}?uploadId=${encodeURIComponent(first.uploadId)}`, "DELETE", undefined, auth)).status).toBe(200);
  expect((await call(base, "POST", input, auth)).status).toBe(201);
});
it("takes mutable manifest headers from the same R2 read as its body", async () => {
  const { handleRelease } = await import("../releases");
  const old = { size: 3, httpEtag: '"old"', uploaded: new Date(), customMetadata: {} };
  const current = { ...old, size: 8, httpEtag: '"new"', body: new Response("manifest").body };
  const bucket = { head: async () => old, get: async () => current } as unknown as R2Bucket;
  const response = await handleRelease(new Request("http://localhost/updates/stable/latest.yml"), { RELEASES: bucket });
  expect(response?.headers.get("Content-Length")).toBe("8");
  expect(response?.headers.get("ETag")).toBe('"new"');
  expect(await response?.text()).toBe("manifest");
});
