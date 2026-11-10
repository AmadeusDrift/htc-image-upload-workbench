import { afterAll, beforeAll, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let service: Miniflare;
let token: string;
let taskId: string;
let groupId: string;
const timestamp = '2026-01-01T00:00:00.000Z';
const future = '2099-01-01T00:00:00.000Z';
async function request(path: string, body?: unknown) {
  const response = await service.dispatchFetch('http://localhost' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}`, 'X-Device-Id': 'test-device' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['server/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  service = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-29', d1Databases: ['DB'], r2Buckets: ['BUCKET'],
    bindings: { SETUP_TOKEN: 'test-setup', CONFIG_KEY: 'a-long-export-test-secret', R2_ENDPOINT: 'https://test.r2.cloudflarestorage.com', R2_BUCKET_NAME: 'test' },
  }));
  const db = await service.getD1Database('DB');
  await db.exec(readFileSync('server/schema.sql', 'utf8').replace(/\n/g, ' '));
  const setup = await request('/api/setup', { setupToken: 'test-setup', username: 'admin', password: 'ExportTest123!', displayName: 'Admin' });
  token = setup.body.token;
  groupId = (await request('/api/groups', { name: 'Export snapshot' })).body.group.id;
  taskId = (await request('/api/tasks', { groupId, name: 'Export task' })).body.task.id;
  const userId = setup.body.user.id;
  const rows = [
    ['a-first', 'success', future], ['m-late', 'pending', future], ['z-last', 'success', future],
    ['f-failed', 'failed', future], ['u-uploading', 'uploading', future], ['x-expired', 'expired', timestamp],
    ['e-old', 'success', timestamp], ['d-deleted', 'deleted', future],
  ];
  await db.batch(rows.map(([id, status, expiresAt]) => db.prepare(`INSERT INTO files(id,clientId,taskId,groupId,userId,name,relativePath,size,contentType,sha256,objectKey,status,createdAt,expiresAt,completedAt) VALUES(?,?,?,?,?,?,?,1,'image/jpeg','sha',?,?,?,?,?)`)
    .bind(id, id, taskId, groupId, userId, id+'.jpg', id+'.jpg', id, status, timestamp, expiresAt, status==='success' ? timestamp : null)));
});
afterAll(async () => { await service?.dispose(); });

it('freezes eligible and unfinished counts and excludes a same-timestamp completion during pagination', async () => {
  const path = `/api/export?taskId=${taskId}&limit=1`;
  const first = await request(path + '&snapshot=new');
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ eligibleCount: 2, unfinishedCount: 3, nextCursor: 'a-first' });
  expect(first.body.snapshotAt).toMatch(/Z$/);
  expect(first.body.files[0].name).toBe('a-first.jpg');
  const db = await service.getD1Database('DB');
  await db.prepare("UPDATE files SET status='success',completedAt=? WHERE id='m-late'").bind(timestamp).run();
  const scope = path + '&snapshot=' + encodeURIComponent(first.body.snapshot);
  const next = await request(scope + '&cursor=' + first.body.nextCursor);
  expect(next.status).toBe(200);
  expect(next.body).toMatchObject({ eligibleCount: 2, unfinishedCount: 3, nextCursor: null });
  expect(next.body.files.map((file: any) => file.name)).toEqual(['z-last.jpg']);
  expect((await request(scope + '&verify=1')).body.verified).toBe(true);
  expect((await request(scope + '&id=z-last')).status).toBe(400);
  const legacy = await request(path + '&cursor=a-first');
  expect(legacy.body.files[0].name).toBe('m-late.jpg');
  await db.prepare("UPDATE files SET status='deleted' WHERE id='a-first'").run();
  expect((await request(scope + '&verify=1')).status).toBe(409);
});

it('reports coverage only for selected files and excludes expired rows from unfinished', async () => {
  const response = await request(`/api/export?taskId=${taskId}&limit=500&snapshot=new&id=z-last&id=f-failed&id=x-expired`);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ eligibleCount: 1, unfinishedCount: 1, nextCursor: null });
  expect(response.body.files.map((file: any) => file.name)).toEqual(['z-last.jpg']);
});
