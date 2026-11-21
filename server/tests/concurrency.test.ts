import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { UploadEngine, type UploadState } from '../../src/upload';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import worker from '../index';
import { operatorStatus } from '../operator-entry';

let mf: Miniflare, db: D1Database, ids: string[], taskId: string, groupId: string, token: Record<string,string> = {};
async function call(device: string, path: string, body: unknown = {}) {
  const response = await mf.dispatchFetch('http://localhost/api' + path, {
    method: 'POST', headers: { 'Content-Type':'application/json', Authorization:'Bearer ' + (token[device] || ''), 'X-Device-Id':device }, body:JSON.stringify(body),
  });
  return { status:response.status, body:await response.json() as any };
}
const lease = (device: string, index: number) => call(device, '/files/' + ids[index] + '/lease');
it('returns a successful legacy confirmation without rereading the file after the write', async () => {
  const {body: {leaseId}} = await lease('a', 0);
  const fileId = ids[0];
  const row = await db.prepare('SELECT objectKey FROM files WHERE id=?').bind(fileId).first<{objectKey:string}>();
  const bucket = await mf.getR2Bucket('BUCKET');
  await bucket.put(row!.objectKey, 'png', {httpMetadata:{contentType:'image/png'}});
  const statements:string[] = [];
  const response = await worker.fetch(new Request('http://localhost/api/files/' + fileId + '/complete', {
    method:'POST',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+token.a,'X-Device-Id':'a'},
    body:JSON.stringify({leaseId}),
  }), {
    DB:{
      prepare(sql:string) { statements.push(sql); return db.prepare(sql); },
      batch:db.batch.bind(db),
    },
    BUCKET:bucket,
  } as unknown as Env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({file:{id:fileId,status:'success',url:'http://localhost/img/'+fileId}});
  expect(statements.filter(sql=>sql==='SELECT * FROM files WHERE id=?')).toHaveLength(1);
});
it('confirms a legacy upload exactly once even when the same confirmation is sent concurrently', async () => {
  const {body: {leaseId}} = await lease('a', 0);
  const fileId = ids[0];
  const row = await db.prepare('SELECT objectKey FROM files WHERE id=?').bind(fileId).first<{objectKey:string}>();
  const bucket = await mf.getR2Bucket('BUCKET');
  await bucket.put(row!.objectKey, 'png', {httpMetadata:{contentType:'image/png'}});
  expect((await call('b', '/files/' + fileId + '/complete', {leaseId})).status).toBe(409);
  const results = await Promise.all(Array.from({length: 8}, () =>
    call('a', '/files/' + fileId + '/complete', {leaseId}),
  ));
  expect(results.map(result => result.status)).toEqual(Array(8).fill(200));
  expect(new Set(results.map(result => result.body.file.expiresAt)).size).toBe(1);
  expect(results[0].body.file).toMatchObject({id:fileId,status:'success',url:'http://localhost/img/'+fileId});
  expect(await db.prepare('SELECT id FROM leases WHERE id=?').bind(leaseId).first()).toBeNull();
});
it('logs a device quota block with spare company capacity and no signed URL', async () => {
  await batch('b', [], 20);
  await batch('a', ids.slice(0,10), 20);
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    const response = await worker.fetch(new Request('http://localhost/api/tasks/' + taskId + '/upload-leases', {
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:'Bearer '+token.a,'X-Device-Id':'a'},
      body:JSON.stringify({runId:'a', demand:20, fileIds:[ids[10]]}),
    }), {
      DB:db, CONFIG_KEY:'test-config-key',
      R2_ENDPOINT:'https://test.r2.cloudflarestorage.com', R2_BUCKET_NAME:'test',
    } as unknown as Env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({grants:[],quota:10,used:10,globalUsed:10});
    const log = info.mock.calls.find(([value]) => value?.event === 'upload.lease_batch')?.[0];
    expect(log).toMatchObject({
      requested:1, eligible:1, granted:0, deviceQuota:10, deviceUsed:10,
      globalUsed:10, globalLimit:20, deviceQuotaReached:true, globalLimitReached:false,
    });
    expect(JSON.stringify(log)).not.toMatch(/X-Amz|Bearer|cloudflarestorage|uploadUrl/);
  } finally {
    info.mockRestore();
  }
});
it('refills an acknowledged PUT before confirmation, then confirms it after pause', async () => {
  const runId = 'receipt-test';
  const path = '/tasks/' + taskId;
  const first = await call('a', path + '/upload-leases', {runId, demand:20, fileIds:ids.slice(0,20)});
  expect(first.body.grants).toHaveLength(20);
  const {fileId,leaseId} = first.body.grants[0];
  const file = await db.prepare('SELECT objectKey FROM files WHERE id=?').bind(fileId).first<{objectKey:string}>();
  const bucket = await mf.getR2Bucket('BUCKET');
  await bucket.put(file!.objectKey,'png',{httpMetadata:{contentType:'image/png'}});
  const next = await call('a', path + '/upload-leases', {runId,demand:20,fileIds:[ids[20]],uploaded:[{fileId,leaseId}]});
  expect(next.body.grants).toHaveLength(1);
  const get = () => db.prepare('SELECT status FROM files WHERE id=?').bind(fileId).first<{status:string}>();
  expect((await get())!.status).toBe('uploading');
  await call('a','/uploads/activity',{runId,active:false});
  const restored = await mf.dispatchFetch('http://localhost/api'+path+'?limit=100',{
    headers:{Authorization:'Bearer '+token.a,'X-Device-Id':'a'},
  });
  const task = await restored.json() as any;
  expect(task.files.find((row:any)=>row.id===fileId)).toMatchObject({awaitingConfirmation:true,status:'uploading'});
  const other = await call('b',path+'/confirm-uploads',{fileIds:[fileId]});
  expect(other.body.files).toEqual([]);
  const complete = await call('a',path+'/confirm-uploads',{fileIds:[fileId]});
  expect(complete.body.files).toMatchObject([{id:fileId,status:'success'}]);
  expect((await call('a',path+'/confirm-uploads',{fileIds:[fileId]})).body.files).toMatchObject([{id:fileId,status:'success'}]);
});
it('applies backpressure when forty files on one device are still awaiting confirmation', async () => {
  const runId='confirmation-limit-test', path='/tasks/'+taskId;
  let response=await batch('a',ids.slice(0,20),20,runId);
  for(let offset=20;offset<=40;offset+=20){
    const uploaded=response.body.grants.map(({fileId,leaseId}:any)=>({fileId,leaseId}));
    response=await call('a',path+'/upload-leases',{runId,demand:20,fileIds:ids.slice(offset,offset+20),uploaded});
    expect(response.body.receipts).toHaveLength(20);
    expect(response.body.grants).toHaveLength(offset===20?20:0);
  }
  expect(response.body.used).toBe(0);
  const other=await batch('b',ids.slice(60,65),5,'other-device-backpressure-test');
  expect(other.body.grants).toHaveLength(5);
});
it('never publishes a link for an acknowledged PUT that is missing or the wrong size', async () => {
  const runId='invalid-object-test', path='/tasks/'+taskId;
  const early=await batch('a',ids.slice(0,2),2,runId);
  const grants=early.body.grants;
  const bucket=await mf.getR2Bucket('BUCKET');
  const row=await db.prepare('SELECT objectKey FROM files WHERE id=?').bind(ids[0]).first<{objectKey:string}>();
  await bucket.put(row!.objectKey,'wrong size',{httpMetadata:{contentType:'image/png'}});
  await call('a',path+'/upload-leases',{runId,demand:2,fileIds:[],uploaded:grants.map(({fileId,leaseId}:any)=>({fileId,leaseId}))});
  const result=await call('a',path+'/confirm-uploads',{fileIds:ids.slice(0,2)});
  expect(result.body.files).toEqual([]);
  expect(result.body.retry.sort()).toEqual(ids.slice(0,2).sort());
  expect((await batch('a',ids.slice(0,2),2,runId)).body.grants).toHaveLength(2);
});
async function release(device: string, index: number, response: any) {
  expect((await call(device, '/files/' + ids[index] + '/release', {leaseId:response.body.leaseId})).status).toBe(200);
}
beforeAll(async () => {
  const bundle = await build({entryPoints:['server/index.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
  mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-29',d1Databases:['DB','MIGRATION','UPLOAD_MIGRATION'],r2Buckets:['BUCKET'],bindings:{SETUP_TOKEN:'setup',CONFIG_KEY:'test-config-key',R2_ENDPOINT:'https://test.r2.cloudflarestorage.com',R2_BUCKET_NAME:'test'}}));
  db = await mf.getD1Database('DB');
  await db.exec(readFileSync('server/schema.sql','utf8').replace(/\n/g,' '));
  const setup = await call('a','/setup',{setupToken:'setup',username:'alpha',password:'12345678',displayName:'Alpha'});
  token.a = setup.body.token;
  for(const device of ['b','c','d','e']) token[device] = (await call(device,'/login',{username:'alpha',password:'12345678',deviceId:device})).body.token;
  const group = groupId = (await call('a','/groups',{name:'Images'})).body.group.id;
  await call('a','/storage',{accessKeyId:'test',secretAccessKey:'test',endpoint:'https://test.r2.cloudflarestorage.com',bucket:'test'});
  const task = (await call('a','/tasks',{groupId:group,name:'Existing task'})).body.task.id;
  taskId = task;
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

it('rechecks session, task ownership and current group permissions on every batch', async () => {
  const device = 'batch-access-employee';
  const {body:{user}} = await call('a','/users',{
    username:'batch-access',password:'12345678',role:'employee',displayName:'Batch test',
    groupIds:[groupId],permissions:{upload:true,view:true,export:false,delete:false},
  });
  token[device]=(await call(device,'/login',{username:'batch-access',password:'12345678',deviceId:device})).body.token;
  const {body:{task}}=await call(device,'/tasks',{groupId,name:'Access check'});
  const request=(id=task.id, sender=device)=>call(sender,'/tasks/'+id+'/upload-leases',{
    fileIds:[],runId:'batch-access-run',demand:0,
  });
  const seen=()=>db.prepare('SELECT lastSeen FROM sessions WHERE userId=? AND deviceId=?')
    .bind(user.id,device).first<number>('lastSeen');
  await db.prepare('UPDATE sessions SET lastSeen=0 WHERE userId=?').bind(user.id).run();
  token['wrong-device']=token[device];
  expect((await request('missing','wrong-device')).status).toBe(401);
  expect(await seen()).toBe(0);
  expect((await request()).status).toBe(200);
  const refreshed=await seen();
  expect(refreshed).toBeGreaterThan(0);
  expect((await request()).status).toBe(200);
  expect(await seen()).toBe(refreshed);
  expect((await request(taskId)).status).toBe(403);
  expect((await request('missing')).status).toBe(404);
  await db.prepare('UPDATE users SET permissions=? WHERE id=?').bind('{}',user.id).run();
  expect((await request()).status).toBe(403);
  await db.prepare('UPDATE users SET permissions=? WHERE id=?').bind('{"upload":true}',user.id).run();
  await db.prepare('DELETE FROM user_groups WHERE userId=?').bind(user.id).run();
  expect((await request()).status).toBe(403);
  await db.prepare('INSERT INTO user_groups VALUES(?,?)').bind(user.id,groupId).run();
  await db.prepare("UPDATE groups SET status='disabled' WHERE id=?").bind(groupId).run();
  try {
    expect((await request()).status).toBe(403);
    expect((await request(task.id,'a')).status).toBe(200);
  } finally {
    await db.prepare("UPDATE groups SET status='active' WHERE id=?").bind(groupId).run();
  }
  await db.prepare('DELETE FROM sessions WHERE userId=?').bind(user.id).run();
  expect((await request()).status).toBe(401);
});

it('keeps the company pool independent of external batch and legacy uploads', async () => {
  const externalDevice = 'external-device';
  const externalUser = (await call('a', '/users', {
    username: 'external-test', displayName: 'External test', password: 'external-password',
    role: 'employee', groupIds: [groupId], permissions: {upload:true},
  })).body.user;
  await db.prepare("INSERT INTO upload_pool_members(userId,pool) VALUES(?,'external')").bind(externalUser.id).run();
  const login = await call(externalDevice,'/login',{username:'external-test',password:'external-password',deviceId:externalDevice});
  token[externalDevice] = login.body.token;
  await call(externalDevice,'/password',{oldPassword:'external-password',newPassword:'external-new-password'});
  token[externalDevice] = (await call(externalDevice,'/login',{username:'external-test',password:'external-new-password',deviceId:externalDevice})).body.token;
  const externalTask = (await call(externalDevice,'/tasks',{groupId,name:'External task'})).body.task.id;
  const path = '/tasks/' + externalTask;
  const externalFiles = (await call(externalDevice,path+'/files',{files:ids.slice(0,21).map((_, index)=>({
    clientId:String(index),name:index+'.png',relativePath:index+'.png',size:3,contentType:'image/png',sha256:'a'.repeat(64),
  }))})).body.files.map((file: {id:string})=>file.id);
  const company = await batch('a',ids.slice(0,20),20);
  expect(company.body.grants).toHaveLength(20);
  const first = await call(externalDevice, '/files/'+externalFiles[0]+'/lease');
  expect(first.status).toBe(200);
  const external = await call(externalDevice,path+'/upload-leases',{
    runId:'external-run',demand:20,fileIds:externalFiles.slice(1),
  });
  expect(external.body).toMatchObject({pool:'external',globalUsed:20,globalLimit:20,quota:20});
  expect(external.body.grants).toHaveLength(19);
  const remaining = externalFiles.find(id => id !== externalFiles[0] && !external.body.grants.some((grant: {fileId:string}) => grant.fileId===id));
  expect(remaining).toBeDefined();
  expect((await call(externalDevice, '/files/'+remaining+'/lease')).status).toBe(429);
  const companySnapshot = await batch('a', [], 20);
  expect(companySnapshot.body).toMatchObject({pool:'company',globalUsed:20,globalLimit:20,quota:20});
  expect((await operatorStatus(db)).globalSlots).toBe(20);
  expect(await db.prepare('SELECT count(*) n FROM leases').first()).toEqual({n:40});
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
    INSERT INTO leases(id,fileId,userId,deviceId,expiresAt) VALUES('old-lease','old-file','u','old-device',9999999999999);` .replace(/\n/g,' '));
  const tables=['users','tasks','files','leases'];
  const before=await Promise.all(tables.map(table=>old.prepare('SELECT * FROM '+table).all()));
  const migration=readFileSync('server/migrations/0003-upload-demands.sql','utf8').replace(/^--[^\n]*\n/gm,'').replace(/\n/g,' ');
  await old.exec(migration);await old.exec(migration);
  const after=await Promise.all(tables.map(table=>old.prepare('SELECT * FROM '+table).all()));
  expect(after.map(r=>r.results)).toEqual(before.map(r=>r.results));
  expect((await old.prepare('SELECT count(*) n FROM upload_demands').first<any>())!.n).toBe(0);
});

it('adds the confirmation marker to the old schema while preserving existing upload leases', async () => {
  const old = await mf.getD1Database('UPLOAD_MIGRATION');
  await old.exec("CREATE TABLE leases (id TEXT PRIMARY KEY, fileId TEXT NOT NULL, userId TEXT NOT NULL, deviceId TEXT NOT NULL, expiresAt INTEGER NOT NULL, runId TEXT NOT NULL DEFAULT '');");
  await old.exec("INSERT INTO leases VALUES('legacy-lease','legacy-file','legacy-user','legacy-device',9999999999999,'active-run');");
  const seed = await old.prepare("SELECT * FROM leases").first();
  await old.exec(readFileSync('server/migrations/0007-upload-confirmation.sql','utf8').trim());
  expect(await old.prepare("SELECT * FROM leases").first()).toEqual({...seed, uploadedAt:null});
});

const batch = (device: string, fileIds: string[], demand: number, runId = device) =>
  call(device, '/tasks/' + taskId + '/upload-leases', {runId, fileIds, demand});

it('resumes after a lost stop, fencing the abandoned run while keeping its saved receipt', async () => {
  const first = await batch('a',ids.slice(0,20),20,'abandoned');
  const receipt = first.body.grants[0];
  await call('a','/tasks/'+taskId+'/upload-leases',{runId:'abandoned',demand:20,fileIds:[ids[20]],uploaded:[receipt]});
  expect((await batch('a',ids.slice(1,21),20,'resumed')).body.grants).toHaveLength(0);
  await db.prepare("UPDATE upload_demands SET expiresAt=1 WHERE runId='abandoned'").run();
  const resumed = await batch('a',ids.slice(1,21),20,'resumed');
  expect(resumed.body.grants).toHaveLength(20);
  expect(resumed.body.used).toBe(20);
  expect(await db.prepare('SELECT uploadedAt FROM leases WHERE id=?').bind(receipt.leaseId).first('uploadedAt')).toBeTruthy();
  expect((await batch('a',[ids[23]],20,'abandoned')).status).toBe(409);
  expect((await call('a','/files/'+ids[1]+'/release',{leaseId:first.body.grants[1].leaseId})).status).toBe(409);
  await call('a','/uploads/activity',{runId:'abandoned',active:false});
  expect((await db.prepare("SELECT COUNT(*) n FROM leases WHERE runId='resumed'").first('n'))).toBe(20);
});

it('releases a single-file grant carrying a run ID as soon as its run pauses', async () => {
  await call('a','/uploads/activity',{runId:'single',active:true});
  expect((await call('a','/files/'+ids[0]+'/lease',{runId:'single'})).status).toBe(200);
  await call('a','/uploads/activity',{runId:'single',active:false});
  expect(await db.prepare('SELECT COUNT(*) n FROM leases').first('n')).toBe(0);
});

it('keeps another task on the same device and the same task on a different device intact', async () => {
  const other=(await call('a','/tasks',{groupId,name:'Independent task'})).body.task.id;
  const ref=(await call('a','/tasks/'+other+'/files',{files:[{clientId:'x',name:'x.png',relativePath:'x.png',size:3,contentType:'image/png',sha256:'a'.repeat(64)}]})).body.files[0].id;
  const otherGrant=(await call('a','/tasks/'+other+'/upload-leases',{runId:'shared',demand:20,fileIds:[ref]})).body.grants[0];
  await batch('a',ids.slice(0,4),20,'shared');
  const peer=(await batch('b',[ids[4]],20,'peer')).body.grants[0];
  await batch('a',ids.slice(5,10),20,'abandoned');
  await db.prepare("UPDATE upload_demands SET expiresAt=1 WHERE runId IN ('abandoned','peer','shared')").run();
  await batch('a',ids.slice(0,4),20,'restart');
  for(const id of [otherGrant.leaseId,peer.leaseId]) expect(await db.prepare('SELECT id FROM leases WHERE id=?').bind(id).first('id')).toBe(id);
  expect(await db.prepare("SELECT COUNT(*) n FROM leases WHERE runId='shared'").first('n')).toBe(5);
});

it('grants all twenty leases in a single request and replays a lost response without extra leases', async () => {
  const requested = ids.slice(0, 20);
  const first = await batch('a', requested, 20);
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({quota:20, used:20, globalUsed:20});
  expect(first.body.grants).toHaveLength(20);
  const repeated = await batch('a', requested, 20);
  expect(repeated.body.grants.map((g: any) => g.leaseId)).toEqual(first.body.grants.map((g: any) => g.leaseId));
  expect((await batch('a', [ids[20]], 20)).body.grants).toEqual([]);
});

it('shares five slots per device in a simultaneous batch and lends unused tail capacity', async () => {
  const devices = ['a','b','c','d'];
  for (const device of devices) await batch(device, [], 20);
  const results = await Promise.all(devices.map((device, i) => batch(device, ids.slice(i*20,i*20+20), 20)));
  expect(results.map(r => r.body.grants?.length)).toEqual([5,5,5,5]);
  expect(results.map(r => r.body.quota)).toEqual([5,5,5,5]);
  expect((await db.prepare('SELECT count(*) n FROM leases').first<any>())!.n).toBe(20);

  for (const g of results[3].body.grants.slice(2)) {
    expect((await call('d', '/files/'+g.fileId+'/release', {leaseId:g.leaseId})).status).toBe(200);
  }
  expect((await batch('d', [], 2)).body.quota).toBe(2);
  const refills = await Promise.all(devices.slice(0,3).map((device,i) => batch(device, ids.slice(i*20+5,i*20+15), 20)));
  expect(refills.map(r => r.body.quota)).toEqual([6,6,6]);
  expect(refills.map(r => r.body.grants.length)).toEqual([1,1,1]);
});

it('adjusts quota without revoking a busy device and refuses a stopped run', async () => {
  const first = await batch('a', ids.slice(0,20),20);
  expect(first.body.grants).toHaveLength(20);
  const joined = await batch('b', ids.slice(30,50),20);
  expect(joined.body).toMatchObject({quota:10,used:0,globalUsed:20,grants:[]});
  expect((await batch('a', [], 20)).body).toMatchObject({quota:10,used:20});
  await call('a','/uploads/activity',{active:false,runId:'a'});
  expect((await batch('a', [ids[21]],20)).status).toBe(409);
  expect((await batch('b', ids.slice(30,50),20)).body.grants).toHaveLength(20);
});


it.each([1, 4])('completes real local R2 objects through %i upload engine queues', async count => {
  const devices = ['a','b','c','d'].slice(0,count);
  const expected = 20/count;
  const bucket = await mf.getR2Bucket('BUCKET');
  const image = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9sAAAAASUVORK5CYII=', 'base64'));
  const payload = new Uint8Array(32 * 1024);
  payload.set(image);
  const engineStates = new Map<string, UploadState[]>();
  const requested = new Map<string, number>();
  const grantSizes = new Map<string, number[]>();
  const occupied = new Map<string,number>();
  let peak = 0;
  let allStarted!: () => void;
  const firstRequests = new Set<string>();
  const starts = new Promise<void>(resolve => { allStarted = resolve; });
  const putter = new Map<string,string>();
  class LocalPut {
    private url = '';
    upload: { onprogress?: (event: {lengthComputable:boolean;loaded:number;total:number}) => void } = {};
    status = 0;
    onload?: () => void;
    onerror?: () => void;
    open(_method:string,url:string) { this.url=url; }
    setRequestHeader() {}
    send(file:File) {
      const owner = putter.get(this.url)!;
      occupied.set(owner,(occupied.get(owner)||0)+1);
      peak = Math.max(peak,[...occupied.values()].reduce((a,b)=>a+b,0));
      void (async () => {
        try {
          expect(new URL(this.url).searchParams.has('X-Amz-Signature')).toBe(true);
          const key = new URL(this.url).pathname.split('/').slice(2).map(decodeURIComponent).join('/');
          this.upload.onprogress?.({lengthComputable:true,loaded:file.size/2,total:file.size});
          await new Promise(resolve=>setTimeout(resolve,400));
          await bucket.put(key, await file.arrayBuffer(), {httpMetadata:{contentType:file.type}});
          this.upload.onprogress?.({lengthComputable:true,loaded:file.size,total:file.size});
          this.status=200;
        } catch { this.status=500; }
        finally { occupied.set(owner,occupied.get(owner)!-1); this.onload?.(); }
      })();
    }
  }
  vi.stubGlobal('window', {});
  vi.stubGlobal('XMLHttpRequest', LocalPut);
  vi.stubGlobal('fetch', async (url:string, init:RequestInit) => {
    const device = new Headers(init.headers).get('X-Device-Id')!;
    if (!url.endsWith('/upload-leases')) return mf.dispatchFetch(url, init as any);
    requested.set(device,(requested.get(device)||0)+1);
    firstRequests.add(device);
    if(firstRequests.size===count) allStarted();
    await starts;
    const response = await mf.dispatchFetch(url, init as any);
    const data = await response.clone().json() as any;
    const sizes = grantSizes.get(device)||[];
    sizes.push(data.grants?.length ?? 0);
    grantSizes.set(device,sizes);
    for(const grant of data.grants||[]) putter.set(grant.uploadUrl,device);
    return response;
  });
  try {
    const engines = devices.map(device => {
      const states:UploadState[] = [];
      engineStates.set(device,states);
      const engine = new UploadEngine(state=>states.push(state),{
        apiBase:'http://localhost', deviceId:device, getToken:()=>token[device],
      });
      engine.setOptions({batchUpload:true,retries:0,notify:false});
      engine.addBrowserFiles(Array.from({length:24},(_,i)=>new File([payload],device+'-'+i+'.png',{type:'image/png'})));
      return engine;
    });
    await Promise.all(engines.map(engine=>engine.start(groupId)));
    expect(peak).toBe(20);
    for (const [i,device] of devices.entries()) {
      const engine = engines[i], states = engineStates.get(device)!;
      expect(grantSizes.get(device)?.[0]).toBe(expected);
      expect(requested.get(device)!).toBeLessThan(24);
      expect(states.some(s=>s.telemetry?.quota===expected && s.telemetry.transferring===expected)).toBe(true);
      expect(states.some(s=>(s.telemetry?.bytesPerSecond??0)>0)).toBe(true);
      expect(engine.state.items.every(f=>f.status==='success')).toBe(true);
      expect(engine.state.status).toBe('completed');
      const response = await mf.dispatchFetch(engine.state.items[0].url!);
      expect(response.status).toBe(200);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    }
    expect((await db.prepare('SELECT count(*) n FROM leases').first<any>())!.n).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});
