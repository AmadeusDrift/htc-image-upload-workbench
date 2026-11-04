import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

let mf: Miniflare, db: D1Database, ids: string[], token: Record<string,string> = {};
async function call(device: string, path: string, body: unknown = {}) {
  const response = await mf.dispatchFetch('http://localhost/api' + path, {
    method: 'POST', headers: { 'Content-Type':'application/json', Authorization:'Bearer ' + (token[device] || ''), 'X-Device-Id':device }, body:JSON.stringify(body),
  });
  return { status:response.status, body:await response.json() as any };
}
const lease = (device: string, index: number) => call(device, '/files/' + ids[index] + '/lease');
async function release(device: string, index: number, response: any) {
  expect((await call(device, '/files/' + ids[index] + '/release', {leaseId:response.body.leaseId})).status).toBe(200);
}
beforeAll(async () => {
  const bundle = await build({entryPoints:['server/index.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-29',d1Databases:['DB','MIGRATION'],r2Buckets:['BUCKET'],bindings:{SETUP_TOKEN:'setup',CONFIG_KEY:'test-config-key',R2_ENDPOINT:'https://test.r2.cloudflarestorage.com',R2_BUCKET_NAME:'test'}}));
  db = await mf.getD1Database('DB');
  await db.exec(readFileSync('server/schema.sql','utf8').replace(/\n/g,' '));
  const setup = await call('a','/setup',{setupToken:'setup',username:'alpha',password:'12345678',displayName:'Alpha'});
  token.a = setup.body.token;
  for(const device of ['b','c','d','e']) token[device] = (await call(device,'/login',{username:'alpha',password:'12345678',deviceId:device})).body.token;
  const group = (await call('a','/groups',{name:'Images'})).body.group.id;
  await call('a','/storage',{accessKeyId:'test',secretAccessKey:'test',endpoint:'https://test.r2.cloudflarestorage.com',bucket:'test'});
  const task = (await call('a','/tasks',{groupId:group,name:'Existing task'})).body.task.id;
  ids = (await call('a','/tasks/'+task+'/files',{files:Array.from({length:100},(_,i)=>({clientId:String(i),name:i+'.png',relativePath:i+'.png',size:3,contentType:'image/png',sha256:'a'.repeat(64)}))})).body.files.map((f:any)=>f.id);
});
afterAll(async()=>{await mf?.dispose()});
beforeEach(async()=>{
  await db.prepare('DELETE FROM leases').run();
  await db.prepare('DELETE FROM upload_demands').run();
  await db.prepare("UPDATE files SET status='pending',error=NULL").run();
});

it('gives a single device twenty slots and rejects a racing twenty-first',async()=>{
  const responses = await Promise.all(ids.slice(0,21).map((_,i)=>lease('a',i)));
  expect(responses.filter(r=>r.status===200)).toHaveLength(20);
  expect(responses.filter(r=>r.status===429)).toHaveLength(1);
});

it.each([2,3,4])('fairly shares twenty slots across %i devices using the SAME alpha account',async count=>{
  const devices=['a','b','c','d'].slice(0,count);
  for(const device of devices) expect((await call(device,'/uploads/activity',{active:true})).status).toBe(200);
  for(let d=0;d<count;d++) {
    const expected=Math.floor(20/count)+(d<20%count?1:0);
    const responses=await Promise.all(Array.from({length:expected+1},(_,i)=>lease(devices[d],d*21+i)));
    expect(responses.filter(r=>r.status===200)).toHaveLength(expected);
    expect(responses.filter(r=>r.status===429)).toHaveLength(1);
  }
  expect((await db.prepare('SELECT count(*) n FROM leases').first<any>())!.n).toBe(20);
});

it('lets existing transfers finish while a new device gradually acquires its share',async()=>{
  const existing=await Promise.all(Array.from({length:20},(_,i)=>lease('a',i)));
  expect(existing.every(r=>r.status===200)).toBe(true);
  await call('b','/uploads/activity',{active:true});
  expect((await lease('b',30)).status).toBe(429);
  for(let i=0;i<10;i++) {
    await release('a',i,existing[i]);
    expect((await lease('a',20+i)).status).toBe(429);
    expect((await lease('b',30+i)).status).toBe(200);
  }
  const counts=(await db.prepare('SELECT deviceId,count(*) n FROM leases GROUP BY deviceId ORDER BY deviceId').all()).results;
  expect(counts).toEqual([{deviceId:'a',n:10},{deviceId:'b',n:10}]);
  // The remaining pre-join authorizations have not been revoked or replaced.
  for(const r of existing.slice(10)) expect(await db.prepare('SELECT 1 FROM leases WHERE id=?').bind(r.body.leaseId).first()).toBeTruthy();
});

it('reclaims a paused device immediately and an abandoned demand after its TTL',async()=>{
  await call('a','/uploads/activity',{active:true});
  await call('b','/uploads/activity',{active:true});
  const first=await Promise.all(Array.from({length:10},(_,i)=>lease('a',i)));
  expect(first.every(r=>r.status===200)).toBe(true);
  expect((await lease('a',10)).status).toBe(429);
  expect((await call('b','/uploads/activity',{active:false})).status).toBe(200);
  expect((await lease('a',10)).status).toBe(200);
  await call('b','/uploads/activity',{active:true});
  await db.prepare("UPDATE upload_demands SET expiresAt=0 WHERE deviceId='b'").run();
  expect((await lease('a',11)).status).toBe(200);
});

it('keeps old clients in fair allocation without an activity call, and expires abandoned leases',async()=>{
  expect((await lease('a',0)).status).toBe(200);
  expect((await lease('b',1)).status).toBe(200);
  await db.prepare('UPDATE upload_demands SET expiresAt=0').run();
  const more=await Promise.all(Array.from({length:10},(_,i)=>lease('a',i+2)));
  expect(more.filter(r=>r.status===200)).toHaveLength(9);
  await db.prepare("UPDATE leases SET expiresAt=0 WHERE deviceId='b'").run();
  expect((await lease('a',20)).status).toBe(200);
});

it('does not count ordinary logged-in devices and refuses anonymous demand registration',async()=>{
  expect((await call('anonymous','/uploads/activity',{active:true})).status).toBe(401);
  expect((await call('a','/uploads/activity',{active:'yes'})).status).toBe(400);
  expect((await Promise.all(Array.from({length:20},(_,i)=>lease('a',i)))).every(r=>r.status===200)).toBe(true);
});

it('keeps same-file authorization unique under racing devices',async()=>{
  const responses=await Promise.all(['a','b','c','d'].map(device=>lease(device,0)));
  expect(responses.filter(r=>r.status===200)).toHaveLength(1);
  expect((await db.prepare('SELECT count(*) n FROM leases').first<any>())!.n).toBe(1);
});

it('rejects a delayed lease after its run was paused, without recreating demand',async()=>{
  await call('b','/uploads/activity',{active:true,runId:'old-run'});
  await call('b','/uploads/activity',{active:false,runId:'old-run'});
  expect((await call('b','/uploads/activity',{active:true,runId:'old-run'})).status).toBe(409);
  expect((await call('b','/files/'+ids[30]+'/lease',{runId:'old-run'})).status).toBe(429);
  const all=await Promise.all(Array.from({length:20},(_,i)=>lease('a',i)));
  expect(all.every(r=>r.status===200)).toBe(true);
});

it('ignores delayed cleanup and leases from the previous run after resume',async()=>{
  await call('b','/uploads/activity',{active:true,runId:'old-run'});
  await call('b','/uploads/activity',{active:false,runId:'old-run'});
  await call('b','/uploads/activity',{active:true,runId:'new-run'});
  await call('b','/uploads/activity',{active:false,runId:'old-run'});
  expect((await call('b','/files/'+ids[0]+'/lease',{runId:'old-run'})).status).toBe(429);
  expect((await call('b','/files/'+ids[0]+'/lease',{runId:'new-run'})).status).toBe(200);
});

it('keeps a canceled run tombstone through maintenance while reclaiming idle membership',async()=>{
  await call('b','/uploads/activity',{active:false,runId:'not-yet-started'});
  // Force other traffic to run expired-demand maintenance before the late start.
  expect((await lease('a',0)).status).toBe(200);
  expect((await call('b','/uploads/activity',{active:true,runId:'not-yet-started'})).status).toBe(409);
  expect((await call('b','/files/'+ids[30]+'/lease',{runId:'not-yet-started'})).status).toBe(429);
});

it('applies the additive migration twice without changing old accounts, tasks, files or live leases',async()=>{
  const old = await mf.getD1Database('MIGRATION');
  const schema = readFileSync('server/schema.sql','utf8').replace(/^CREATE (?:TABLE|INDEX) IF NOT EXISTS upload_demands[^\n]*\n/gm,'');
  await old.exec(schema.replace(/\n/g,' '));
  await old.exec(`INSERT INTO users VALUES('u','alpha','Alpha','employee','active','preserved-hash',0,'{}','2026-11-04');
    INSERT INTO groups VALUES('g','Images','active','2026-11-04');
    INSERT INTO tasks VALUES('old-task','u','g','Old batch','2026-11-04');
    INSERT INTO files(id,clientId,taskId,groupId,userId,name,relativePath,size,contentType,sha256,objectKey,status,createdAt,expiresAt) VALUES('old-file','old-client','old-task','g','u','1.jpg','folder/1.jpg',3,'image/jpeg','hash','images/old','uploading','2026-11-04','2099-01-01');
    INSERT INTO leases VALUES('old-lease','old-file','u','old-device',9999999999999);` .replace(/\n/g,' '));
  const tables=['users','tasks','files','leases'];
  const before=await Promise.all(tables.map(table=>old.prepare('SELECT * FROM '+table).all()));
  const migration=readFileSync('server/migrations/0003-upload-demands.sql','utf8').replace(/^--[^\n]*\n/gm,'').replace(/\n/g,' ');
  await old.exec(migration);await old.exec(migration);
  const after=await Promise.all(tables.map(table=>old.prepare('SELECT * FROM '+table).all()));
  expect(after.map(r=>r.results)).toEqual(before.map(r=>r.results));
  expect((await old.prepare('SELECT count(*) n FROM upload_demands').first<any>())!.n).toBe(0);
});
