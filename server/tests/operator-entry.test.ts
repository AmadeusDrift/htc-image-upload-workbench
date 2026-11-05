import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let mf: Miniflare, off: Miniflare, db: D1Database;
async function call(path: string, body?: unknown, token = '', device = 'device-a', worker = mf) {
  const response = await worker.dispatchFetch('http://localhost/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Id': device, Authorization: 'Bearer ' + token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  const bundle = await build({ entryPoints: ['server/index.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
  const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-10-29', d1Databases: ['DB'], r2Buckets: ['BUCKET'], bindings: { SETUP_TOKEN: 'setup', CONFIG_KEY: 'test-config-key' } };
  mf = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, OPERATOR_CARD_ENTRY_ENABLED: 'true' } }));
  off = new Miniflare(convertV4MiniflareOptions(options));
  db = await mf.getD1Database('DB');
  for (const worker of [mf, off]) await (await worker.getD1Database('DB')).exec(readFileSync('server/schema.sql', 'utf8').replace(/\n/g, ' '));
  await call('/setup', { setupToken: 'setup', username: 'admin', displayName: 'Administrator', password: '12345678' });
  for (const name of ['delta', 'gamma', 'beta', 'alpha', 'unlisted']) {
    await db.prepare("INSERT INTO users VALUES(?,?,?,'employee','active','secret-hash',1,?,?)")
      .bind(name, name, name.toUpperCase(), '{"upload":true,"view":false,"export":false,"delete":false}', '2026-11-05').run();
  }
});
afterAll(async () => { await mf?.dispose(); await off?.dispose(); });
beforeEach(async () => {
  await db.exec("DELETE FROM sessions; DELETE FROM login_attempts; DELETE FROM leases; DELETE FROM files; DELETE FROM tasks; DELETE FROM groups; UPDATE users SET status='active',role='employee' WHERE username<>'admin';");
});

it('defaults to disabled and advertises the opt-in flag', async () => {
  expect((await call('/health', undefined, '', 'a', off)).body.operatorEntryEnabled).toBe(false);
  expect((await call('/operator-status', undefined, '', 'a', off)).status).toBe(404);
  expect((await call('/operator-entry', { username: 'alpha', deviceId: 'a' }, '', 'a', off)).status).toBe(404);
  expect((await call('/health')).body.operatorEntryEnabled).toBe(true);
});
it('returns exactly four ordered public cards without sensitive fields', async () => {
  const result = await call('/operator-status');
  expect(result.status).toBe(200);
  expect(result.body.globalLimit).toBe(20);
  expect(result.body.globalSlots).toBe(0);
  expect(result.body.profiles.map((p: any) => p.username)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
  for (const p of result.body.profiles) {
    expect(Object.keys(p).sort()).toEqual(['id', 'username', 'displayName', 'available', 'onlineDevices', 'uploadingDevices', 'uploadSlots'].sort());
    expect(p.available).toBe(true);
  }
  expect(JSON.stringify(result.body)).not.toMatch(/secret|password|token|permissions|Administrator/);
});
it('enters without a password and keeps existing permissions and device-bound authentication', async () => {
  const entry = await call('/operator-entry', { username: 'alpha', deviceId: 'device-a' });
  expect(entry.status).toBe(200);
  expect(entry.body.token).toBeTruthy();
  expect(entry.body.user.role).toBe('employee');
  expect(entry.body.user.permissions).toEqual({ upload: true, view: false, export: false, delete: false });
  expect((await call('/presence', undefined, entry.body.token)).status).toBe(200);
  expect((await call('/presence', undefined, entry.body.token, 'forged')).status).toBe(401);
  expect((await call('/groups', { name: 'Forbidden' }, entry.body.token)).status).toBe(403);
});
it('rejects administrators, unlisted, disabled and allowlisted administrator accounts', async () => {
  for (const username of ['admin', 'unlisted', 'missing']) expect((await call('/operator-entry', { username, deviceId: 'device-a' })).status).toBe(403);
  await db.prepare("UPDATE users SET status='disabled' WHERE username='alpha'").run();
  await db.prepare("UPDATE users SET role='admin' WHERE username='beta'").run();
  for (const username of ['alpha', 'beta']) expect((await call('/operator-entry', { username, deviceId: 'device-a' })).status).toBe(403);
  const cards = (await call('/operator-status')).body.profiles;
  expect(cards.slice(0, 2).map((p: any) => p.available)).toEqual([false, false]);
  expect(cards[1]).toMatchObject({ id: '', displayName: 'beta', onlineDevices: 0, uploadingDevices: 0, uploadSlots: 0 });
});
it('keeps a placeholder when an employee account is missing', async () => {
  await db.prepare("UPDATE users SET username='renamed' WHERE id='delta'").run();
  try {
    expect((await call('/operator-status')).body.profiles[3]).toEqual({
      id: '', username: 'delta', displayName: 'delta', available: false,
      onlineDevices: 0, uploadingDevices: 0, uploadSlots: 0,
    });
    expect((await call('/operator-entry', { username: 'delta', deviceId: 'device-a' })).status).toBe(403);
  } finally {
    await db.prepare("UPDATE users SET username='delta' WHERE id='delta'").run();
  }
});
it('requires matching body/header device identity and throttles repeated entries including successes', async () => {
  expect((await call('/operator-entry', { username: 'alpha', deviceId: 'forged' })).status).toBe(400);
  expect((await call('/operator-entry', { username: 'alpha' })).status).toBe(400);
  for (let i = 0; i < 10; i++) expect((await call('/operator-entry', { username: 'alpha', deviceId: 'device-a' })).status).toBe(200);
  expect((await call('/operator-entry', { username: 'alpha', deviceId: 'device-a' })).status).toBe(429);
});
it('counts distinct recent devices, active leases and leaves only the current session', async () => {
  const a = (await call('/operator-entry', { username: 'alpha', deviceId: 'device-a' })).body.token;
  const second = (await call('/operator-entry', { username: 'alpha', deviceId: 'device-a' })).body.token;
  await call('/operator-entry', { username: 'alpha', deviceId: 'device-b' }, '', 'device-b');
  await db.prepare("UPDATE sessions SET lastSeen=? WHERE deviceId='device-b'").bind(Date.now() - 100_000).run();
  await db.prepare("INSERT INTO sessions VALUES('expired','alpha','expired',0,?)").bind(Date.now()).run();
  await db.exec("INSERT INTO groups VALUES('g','g','active','now'); INSERT INTO tasks VALUES('t','alpha','g','t','now');");
  for (let i = 0; i < 4; i++) {
    const owner = i === 3 ? 'unlisted' : 'alpha';
    await db.prepare("INSERT INTO files(id,clientId,taskId,groupId,userId,name,relativePath,size,contentType,sha256,objectKey,createdAt,expiresAt) VALUES(?,?, 't','g',?,'x','x',1,'image/png','x',?,'now','later')").bind('f' + i, 'c' + i, owner, 'key' + i).run();
    await db.prepare('INSERT INTO leases VALUES(?,?,?,?,?)').bind('l' + i, 'f' + i, owner, i === 2 ? 'stale' : i === 1 ? 'device-b' : 'device-a', i === 2 ? 0 : Date.now() + 60000).run();
  }
  let status = (await call('/operator-status')).body;
  expect(status.profiles[0]).toMatchObject({ onlineDevices: 1, uploadingDevices: 2, uploadSlots: 2 });
  expect(status.globalSlots).toBe(3);
  expect((await call('/presence/leave', {}, a)).status).toBe(200);
  expect((await db.prepare('SELECT count(*) n FROM sessions WHERE lastSeen>0 AND deviceId=?').bind('device-a').first<any>())!.n).toBe(1);
  expect((await call('/presence', undefined, second)).status).toBe(200);
  expect((await call('/presence', undefined, '', 'device-a')).status).toBe(401);
});
it('preserves password login for administrator and requires its password', async () => {
  expect((await call('/login', { username: 'admin', deviceId: 'device-a' })).status).toBe(401);
  const login = await call('/login', { username: 'admin', password: '12345678', deviceId: 'device-a' });
  expect(login.status).toBe(200);
  expect(login.body.user.role).toBe('admin');
});
