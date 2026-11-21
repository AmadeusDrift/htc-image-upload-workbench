import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import worker from "../index";
import {verifiedPack} from "../packs";

let emulator: Miniflare, db: D1Database, bucket: R2Bucket, token: string, group: string;
const digest = (data: string) => createHash("sha256").update(data).digest("hex");
async function api(path: string, body?: unknown) {
  const response = await emulator.dispatchFetch("http://localhost/api"+path, {
    method: body ? "POST" : "GET", headers: {"X-Device-Id":"device","Content-Type":"application/json",Authorization:"Bearer "+(token ?? "")},
    body: body ? JSON.stringify(body) : undefined,
  });
  return {status: response.status, body: await response.json() as any};
}
beforeAll(async () => {
  const buildResult = await build({entryPoints:["server/index.ts"],bundle:true,write:false,format:"esm",platform:"browser"});
  emulator = new Miniflare(convertV4MiniflareOptions({
    modules:true,script:buildResult.outputFiles[0].text,compatibilityDate:"2026-10-29",
    d1Databases:["DB"],r2Buckets:["BUCKET"],bindings:{
      SETUP_TOKEN:"setup",CONFIG_KEY:"local-only",R2_ENDPOINT:"https://test.r2.cloudflarestorage.com",R2_BUCKET_NAME:"test",
    },
  }));
  db = await emulator.getD1Database("DB"); bucket = await emulator.getR2Bucket("BUCKET");
  await db.exec(readFileSync("server/schema.sql","utf8").replace(/\n/g," "));
  token = (await api("/setup",{setupToken:"setup",username:"tester",displayName:"Tester",password:"Password123"})).body.token;
  group = (await api("/groups",{name:"Test"})).body.group.id;
  await api("/storage",{accessKeyId:"test",secretAccessKey:"test",endpoint:"https://test.r2.cloudflarestorage.com",bucket:"test"});
});
afterAll(async () => { await emulator?.dispose(); });

async function fixture(parts: string[], sizes=parts.map(s=>s.length)) {
  const task = (await api("/tasks",{name:"Packed",groupId:group})).body.task;
  const path = "/tasks/"+task.id;
  const files = parts.map((data,i)=>({clientId:String(i),name:i+".png",relativePath:i+".png",size:sizes[i],contentType:"image/png",sha256:digest(data)}));
  const registered = (await api(path+"/files",{files})).body.files;
  const ids: string[] = files.map(file=>registered.find((row:any)=>row.clientId===file.clientId).id);
  const members = ids.map((id,i)=>({fileId:id,sha256:files[i].sha256}));
  const pack = {sha256:digest(parts.join("")),members};
  const submit = (...packs: unknown[])=>api(path+"/packs",{packs});
  const allocate = (fileIds: string[], packed=true)=>api(path+"/upload-leases",{runId:task.id,demand:fileIds.length,fileIds,packed});
  const ack = (grant: {fileId:string;leaseId:string})=>api(path+"/upload-leases",{runId:task.id,demand:0,fileIds:[],uploaded:[{fileId:grant.fileId,leaseId:grant.leaseId}],packed:true});
  const confirm = ()=>api(path+"/confirm-uploads",{fileIds:[ids[0]]});
  return {ids,pack,path,submit,allocate,ack,confirm,task};
}
it("publishes each original range only after one checksum-verified pack receipt, and removes the last shared object",async()=>{
  const parts=["abc","DEFGH","ijkl"], f=await fixture(parts);
  expect((await f.submit(f.pack)).status).toBe(200);
  expect((await f.submit(f.pack)).status).toBe(200);
  expect((await f.submit({...f.pack, members:[...f.pack.members].reverse()})).status).toBe(409);
  expect((await f.submit({...f.pack, sha256:digest("different")})).status).toBe(409);
  expect((await f.allocate(f.ids,false)).body.grants).toEqual([]);
  expect((await api("/files/"+f.ids[0]+"/lease",{})).status).toBe(409);
  const allocation=await f.allocate(f.ids);
  expect(allocation.body.grants).toHaveLength(1);
  expect(allocation.body.unavailable.map((unavailable:any)=>unavailable.fileId)).toEqual(f.ids.slice(1));
  const grant=allocation.body.grants[0], key=new URL(grant.uploadUrl).pathname.slice("/test/".length);
  expect(grant.headers).toEqual({"Content-Type":"application/octet-stream","x-amz-checksum-sha256":Buffer.from(f.pack.sha256,"hex").toString("base64")});
  expect(new URL(grant.uploadUrl).searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host;x-amz-checksum-sha256");
  expect((await f.confirm()).body.files).toEqual([]);
  const publicImage=(index:number,method="GET",range?:string)=>emulator.dispatchFetch("http://localhost/img/"+f.ids[index],{method,headers:range?{Range:range}:{}});
  expect((await publicImage(0)).status).toBe(404);
  const exportPath="/export?taskId="+f.task.id+"&limit=2&snapshot=";
  const before=(await api(exportPath+"new")).body;
  expect(before).toMatchObject({eligibleCount:0,unfinishedCount:3});
  await bucket.put(key,parts.join(""),{httpMetadata:{contentType:"application/octet-stream"},sha256:f.pack.sha256});
  expect((await f.ack(grant)).body.receipts).toMatchObject([{fileId:f.ids[0]}]);
  await api("/uploads/activity",{runId:f.task.id,active:false});
  const view=(await api(f.path+"?limit=10")).body.files;
  expect(view.find((row:any)=>row.id===f.ids[1])).toMatchObject({packLeaderId:f.ids[0],packOffset:3,status:"uploading"});
  expect(view.find((row:any)=>row.id===f.ids[0]).awaitingConfirmation).toBe(true);
  for(let replay=0;replay<2;replay++){
    const completed=await f.confirm();
    expect(completed.body.retry).toEqual([]);
    expect(completed.body.files.map((row:any)=>row.id).sort()).toEqual([...f.ids].sort());
  }
  for(const [i,part] of parts.entries()){
    const image=await publicImage(i);
    expect(image.headers.get("Content-Type")).toBe("image/png");
    expect(image.headers.get("Content-Length")).toBe(String(part.length));
    expect(await image.text()).toBe(part);
    expect((await publicImage(i,"HEAD")).headers.get("Content-Length")).toBe(String(part.length));
  }
  const partial=await publicImage(1,"GET","bytes=1-9999");
  expect(partial.status).toBe(206); expect(partial.headers.get("Content-Range")).toBe("bytes 1-4/5");
  expect(await partial.text()).toBe("EFGH");
  expect((await publicImage(1,"GET","bytes=5-")).status).toBe(416);
  expect((await api(exportPath+encodeURIComponent(before.snapshot)+"&verify=1")).body.verified).toBe(true);
  const after=(await api(exportPath+"new")).body;
  expect(after).toMatchObject({eligibleCount:3,unfinishedCount:0});
  expect((await api("/export?taskId="+f.task.id)).body.files).toHaveLength(3);
  expect((await api("/files/delete",{ids:[f.ids[0]]})).status).toBe(200);
  expect((await publicImage(0)).status).toBe(404);
  expect(await (await publicImage(1)).text()).toBe(parts[1]);
  expect((await api(exportPath+encodeURIComponent(after.snapshot)+"&verify=1")).status).toBe(409);
  await db.prepare("UPDATE files SET expiresAt='2000-01-01' WHERE id=?").bind(f.ids[1]).run();
  await worker.scheduled({} as ScheduledController,{DB:db,BUCKET:bucket} as Env);
  expect((await publicImage(1)).status).toBe(404);
  expect(await (await publicImage(2)).text()).toBe(parts[2]);
  await api("/files/delete",{ids:[f.ids[2]]});
  expect(await bucket.head(key)).toBeNull();
});

it("rejects equal-length corrupt bytes and retries with a new fenced object key",async()=>{
  const f=await fixture(["abc","xyz"]);
  expect((await f.submit(f.pack)).status).toBe(200);
  const grant=(await f.allocate([f.ids[0]])).body.grants[0];
  const key=new URL(grant.uploadUrl).pathname.slice("/test/".length);
  await bucket.put(key,"badbad",{httpMetadata:{contentType:"application/octet-stream"},sha256:digest("badbad")});
  await f.ack(grant);
  expect((await f.confirm()).body).toEqual({files:[],retry:[f.ids[0]]});
  const retry=(await f.allocate([f.ids[0]])).body.grants[0];
  expect(new URL(retry.uploadUrl).pathname).not.toBe(new URL(grant.uploadUrl).pathname);
  await api("/files/delete",{ids:[f.ids[1]]});
  expect((await f.ack(retry)).body.receipts).toEqual([]);
  expect((await api("/files/"+f.ids[0])).body.file).not.toHaveProperty("packLeaderId");
  const single=(await f.allocate([f.ids[0]],false)).body.grants[0];
  expect(single.headers).toEqual({"Content-Type":"image/png"});
  await api("/files/"+f.ids[0]+"/release",{leaseId:single.leaseId});
});

it("enforces byte and count limits and makes registration atomic across malformed or overlapping packs",async()=>{
  const f=await fixture(Array.from({length:13},(_,i)=>String(i)));
  expect((await f.submit(f.pack)).status).toBe(400);
  const good={sha256:digest("01"),members:f.pack.members.slice(0,2)};
  const invalid={sha256:digest("23"),members:f.pack.members.slice(2,4).map(m=>({...m,sha256:digest("wrong")}))};
  expect((await f.submit(good,invalid)).status).toBe(409);
  expect((await api("/files/"+f.ids[0])).body.file).not.toHaveProperty("packLeaderId");
  const exact=await fixture(["a","b"],[24*1024*1024-1,1]);
  const over=await fixture(["a","b"],[24*1024*1024,1]);
  expect((await exact.submit(exact.pack)).status).toBe(200);
  expect((await over.submit(over.pack)).status).toBe(409);
  const twelve=await fixture(Array(12).fill("A"));
  expect((await twelve.submit(twelve.pack)).status).toBe(200);
  const competing={sha256:digest("12"),members:f.pack.members.slice(1,3)};
  expect((await Promise.all([f.submit(good),f.submit(competing)])).map(r=>r.status).sort()).toEqual([200,409]);
  const duplicates=await fixture(["A","B","B"]);
  const original={sha256:digest("AB"),members:duplicates.pack.members.slice(0,2)};
  expect((await duplicates.submit(original)).status).toBe(200);
  expect((await duplicates.submit({...original,members:[original.members[0],duplicates.pack.members[2]]})).status).toBe(409);
});
it("recovers a checkpointed PUT after stop and reclamation; a newer lease cannot publish a second copy",async()=>{
  const parts=["abc","XYZ"], f=await fixture(parts);
  await f.submit(f.pack);
  const first=(await f.allocate([f.ids[0]])).body.grants[0];
  const key=new URL(first.uploadUrl).pathname.slice("/test/".length);
  await bucket.put(key,parts.join(""),{httpMetadata:{contentType:"application/octet-stream"},sha256:f.pack.sha256});
  await api("/uploads/activity",{runId:f.task.id,active:false});
  expect(await db.prepare("SELECT 1 FROM leases WHERE id=?").bind(first.leaseId).first()).toBeNull();
  const reclaim=await api(f.path+"/upload-leases",{runId:"replacement",demand:1,fileIds:[f.ids[0]],packed:true});
  const next=reclaim.body.grants[0], nextKey=new URL(next.uploadUrl).pathname.slice("/test/".length);
  const recover=(runId:string)=>api(f.path+"/confirm-uploads",{
    fileIds:[f.ids[0]],packedReceipts:[{fileId:f.ids[0],leaseId:first.leaseId,runId}],
  });
  expect((await recover("wrong-run")).body.files).toEqual([]);
  const verified=await recover(f.task.id);
  expect(verified.body.retry).toEqual([]);
  expect(verified.body.files).toHaveLength(2);
  expect(await db.prepare("SELECT 1 FROM leases WHERE fileId=?").bind(f.ids[0]).first()).toBeNull();
  await bucket.put(nextKey,parts.join(""),{httpMetadata:{contentType:"application/octet-stream"},sha256:f.pack.sha256});
  await db.prepare("UPDATE pack_attempts SET cleanupAt=0 WHERE leaderId=?").bind(f.ids[0]).run();
  await worker.scheduled({} as ScheduledController,{DB:db,BUCKET:bucket} as Env);
  expect(await bucket.head(nextKey)).toBeNull();
  expect(await bucket.head(key)).not.toBeNull();
  const rows=(await db.prepare("SELECT DISTINCT packObjectKey FROM files WHERE taskId=?").bind(f.task.id).all()).results;
  expect(rows).toEqual([{packObjectKey:key}]);
});
it("renews an old, checksum-valid R2 object in place for seven-day retention without a desktop transfer",async()=>{
  const key="images/packs/recovery-test/old", body="abcdefgh", hash=digest(body);
  await bucket.put(key,body,{httpMetadata:{contentType:"application/octet-stream"},sha256:hash});
  const refreshed=await verifiedPack(bucket,key,body.length,hash,Date.now()+1000);
  expect(refreshed?.checksums.toJSON().sha256).toBe(hash);
  expect(await (await bucket.get(key))!.text()).toBe(body);
});
it("migrates existing rows and leases without changing direct upload or retention fields",async()=>{
  const { DatabaseSync } = await import("node:sqlite");
  const fresh=readFileSync("server/schema.sql","utf8");
  const oldSchema=fresh.split("CREATE INDEX IF NOT EXISTS files_pack_members")[0]
    .replace(/, packLeaderId TEXT, packOffset INTEGER, packSize INTEGER, packObjectKey TEXT, packEtag TEXT, packSha256 TEXT, packGeneration TEXT/,"");
  const old=new DatabaseSync(":memory:");
  const current=new DatabaseSync(":memory:");
  try {
    old.exec(oldSchema);
    old.exec(`INSERT INTO users VALUES('u','user','User','employee','active','hash',0,'{}','today');
      INSERT INTO groups VALUES('g','Group','active','today');
      INSERT INTO tasks VALUES('t','u','g','Task','today');
      INSERT INTO files(id,clientId,taskId,groupId,userId,name,relativePath,size,contentType,sha256,objectKey,status,createdAt,expiresAt)
        VALUES('legacy','client','t','g','u','x','x',1,'image/png','digest','images/legacy','uploading','today','later');
      INSERT INTO leases(id,fileId,userId,deviceId,expiresAt,runId) VALUES('lease','legacy','u','device',99,'run');`);
    const original=old.prepare("SELECT * FROM files").get();
    const lease=old.prepare("SELECT * FROM leases").get();
    old.exec(readFileSync("server/migrations/0009-packed-uploads.sql","utf8"));
    expect(old.prepare("SELECT * FROM files").get()).toMatchObject({...original,packLeaderId:null,packObjectKey:null});
    expect(old.prepare("SELECT * FROM leases").get()).toEqual(lease);
    expect(old.prepare("SELECT * FROM pack_attempts").all()).toHaveLength(0);
    current.exec(fresh);
    for(const query of ["SELECT name,type FROM sqlite_master ORDER BY name","SELECT name,type FROM pragma_table_info('files') ORDER BY name"]){
      expect(old.prepare(query).all()).toEqual(current.prepare(query).all());
    }
  } finally {old.close();current.close();}
});
