// Local acceptance only. No Cloudflare account, external endpoint, or deployment is used.
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import https from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'esbuild';
import ExcelJS from 'exceljs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const require = createRequire(import.meta.url);
const { Workbook } = ExcelJS;
const { createPackSpool } = require('../electron/pack-spool.cjs');
const { createHashReader } = require('../electron/hash.cjs');
const { createUploadGate, uploadHeaders, uploadNativeFile } = require('../electron/native-upload.cjs');
const { validateUploadTarget } = require('../electron/security.cjs');
const { normalizeManifest } = require('../electron/manifest.cjs');
const { openCheckpointDb } = require('../electron/checkpoint-db.cjs');
const root = path.resolve(import.meta.dirname, '..');
const input = process.argv[2];
const output = process.argv[3];
if (!input || !output) throw Error('Usage: node scripts/pack-acceptance.mjs IMAGE_DIRECTORY REPORT_JSON [scenario names]');
const wanted = new Set(process.argv.slice(4));
const simulateWan = process.env.YUNTU_BENCH_PROFILE === 'shared-100';
const sha = b => createHash('sha256').update(b).digest('hex');
const round = n => Math.round(n * 100) / 100;
const contexts = new AsyncLocalStorage();
const nativeFetch = globalThis.fetch;
const bundle = async options => (await build({absWorkingDir:root, bundle:true, write:false, format:'esm', ...options})).outputFiles[0].text;
const ui = await bundle({stdin:{contents:"export {UploadEngine} from './src/upload'; export {productTable,detailTable} from './src/export';", resolveDir:root}});
const {UploadEngine, productTable, detailTable} = await import('data:text/javascript;base64,'+Buffer.from(ui).toString('base64'));
const workerScript = await bundle({stdin:{resolveDir:root,contents:`
 import worker from './server/index';
 export default {async fetch(req,env){
   const u=new URL(req.url);
   if(u.pathname.startsWith('/local-test-put/')){
     if(req.method!=='PUT'||req.headers.get('x-local-key')!==env.LOCAL_KEY)return new Response(null,{status:403});
     const key=u.pathname.slice('/local-test-put/'.length).split('/').map(decodeURIComponent).join('/');
     const options={httpMetadata:{contentType:req.headers.get('content-type')}};
     const digest=req.headers.get('x-amz-checksum-sha256');
     if(digest) options.sha256=Uint8Array.from(atob(digest),c=>c.charCodeAt(0)).buffer;
     await env.BUCKET.put(key,req.body,options);return new Response(null,{status:200});
   }
   return worker.fetch(req,env);
 }}`}, platform:'browser'});
const files = [];
for (const e of await fs.readdir(input,{recursive:true,withFileTypes:true})) {
  if(!e.isFile()||!/[.](png|jpe?g|webp)$/i.test(e.name))continue;
  const sourcePath=path.resolve(e.parentPath,e.name), stats=await fs.stat(sourcePath);
  const contentType=/[.]png$/i.test(e.name)?'image/png':/[.]webp$/i.test(e.name)?'image/webp':'image/jpeg';
  files.push({sourcePath,size:stats.size,mtimeMs:stats.mtimeMs,contentType,digest:sha(await fs.readFile(sourcePath))});
}
files.sort((a,b)=>a.sourcePath.localeCompare(b.sourcePath));
assert.ok(files.length>=48,'Use at least 48 selected images for the matrix');
const report={start:new Date().toISOString(),mode:'Loopback HTTPS, local Worker + D1 + R2, real image bytes',
  networkModel:simulateWan?{sharedUploadMbps:100,controlDelayMs:150,putPreBodyDelayMs:150}:null,
  images:files.length,scenarios:[]};
const persist=async()=>{await fs.mkdir(path.dirname(path.resolve(output)),{recursive:true}); await fs.writeFile(output,JSON.stringify(report,null,2));};
const windowShim={get desktop(){return contexts.getStore()?.desktop}};
globalThis.window=windowShim;
globalThis.sessionStorage={getItem:()=>null};

async function scenario(name,machines,packed,pause=false){
  if(wanted.size&&!wanted.has(name))return;
  const scratch=await fs.mkdtemp(path.join(tmpdir(),'yuntu-pack-accept-'));
  const localKey=randomUUID(), user='local-admin', password=randomUUID();
  const mf=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:workerScript,host:'127.0.0.1',https:true,compatibilityDate:'2026-10-29',
    d1Databases:['DB'],r2Buckets:['BUCKET'],outboundService:()=>new Response(null,{status:403}),
    bindings:{LOCAL_KEY:localKey,SETUP_TOKEN:localKey,CONFIG_KEY:'isolated-pack-acceptance-test-key',
      R2_ENDPOINT:'https://local-test.r2.cloudflarestorage.com',R2_BUCKET_NAME:'test'},
  }));
  const agents=[],devices=[],puts=new Map(),logicalPuts=new Map(),granted=new Map();
  let active=0,peak=0,maxLeases=0,peakSpool=0,observedDisk=0,pausePromise,oldKeys=[],allReady;
  let nextByteAt=0;
  // One shared token clock for all clients. This is explicitly a local model, not a WAN measurement.
  function shapedReader(file){
    return Readable.from((async function*(){
      await sleep(150);
      for await(const chunk of createReadStream(file)){
        const now=performance.now();
        nextByteAt=Math.max(now,nextByteAt)+chunk.length*8/100000;
        await sleep(Math.max(0,nextByteAt-now));yield chunk;
      }
    })(),{objectMode:false});
  }
  const pauseSeen=new Promise(resolve=>{allReady=resolve});
  const loseReceipt=name==='lost-receipt';
  let dropReceipts=false;
  const base='https://localhost';
  try{
    const entry=await mf.ready;
    assert.equal(entry.hostname,'127.0.0.1');
    const db=await mf.getD1Database('DB');
    await db.exec((await fs.readFile(path.resolve(root,'server/schema.sql'),'utf8')).replaceAll('\n',' '));
    const call=async(d,endpoint,body)=>{
      const res=await mf.dispatchFetch(base+'/api'+endpoint,{method:body===undefined?'GET':'POST',headers:{
        'Content-Type':'application/json',Authorization:'Bearer '+(d.token||''),'X-Device-Id':d.id
      },body:body===undefined?undefined:JSON.stringify(body)});
      const data=await res.json();assert.ok(res.ok,endpoint+' '+JSON.stringify(data));return data;
    };
    globalThis.fetch=async(url,opts)=>{
      assert.equal(new URL(url).origin,base);
      if(simulateWan)await sleep(150);
      if(dropReceipts && new URL(url).pathname.endsWith('/upload-leases') && opts.body && JSON.parse(opts.body).uploaded?.length)
        return Response.json({error:'验收故障注入：上传回执未到达服务器'},{status:503});
      const res=await mf.dispatchFetch(url,opts);
      if(new URL(url).pathname.endsWith('/upload-leases')&&res.ok){
        const data=await res.clone().json();
        maxLeases=Math.max(maxLeases,data.globalUsed??0);assert.ok(maxLeases<=20);
        for(const g of data.grants??[])granted.set(g.uploadUrl,{device:contexts.getStore()?.id,fileId:g.fileId});
      }
      return res;
    };
    const sampleDisk=()=>{peakSpool=Math.max(peakSpool,devices.reduce((sum,d)=>sum+d.spool.stats().bytes,0));};
    const inspectDisk=()=>{
      let total=0;
      for(const d of devices){
        let used=0;
        for(const name of readdirSync(d.packDirectory)){
          try{used+=statSync(path.join(d.packDirectory,name)).size;}catch(e){if(e.code!=='ENOENT')throw e;}
        }
        d.observedDisk=Math.max(d.observedDisk,used);total+=used;
      }
      observedDisk=Math.max(observedDisk,total);return total;
    };
    for(let i=0;i<machines;i++){
      const id='bench-device-'+i,directory=path.join(scratch,id);await fs.mkdir(directory);
      const handles=new Map(), selected=[], expected=new Map(), progress=new Set();
      const source=async nativeId=>{const h=handles.get(nativeId);assert.ok(h,'missing local handle');return h;};
      const gate=createUploadGate(), hasher=createHashReader({source});
      const packDirectory=path.join(directory,'packs');
      let spool=createPackSpool({directory:packDirectory,source,handles});await spool.initialize();
      const checkpointPath=path.join(directory,'manifest.sqlite');
      let checkpoint=openCheckpointDb(checkpointPath);
      const client=new https.Agent({keepAlive:true,maxSockets:20,rejectUnauthorized:false});
      agents.push(client);
      const d={id,spool,packDirectory,observedDisk:0,checkpoint,handles,selected,expected,token:'',engine:null,desktop:null,peak:0,active:0};
      devices.push(d);
      d.reopen=async()=>{
        await spool.clear();checkpoint.close();progress.clear();handles.clear();
        d.checkpoint=checkpoint=openCheckpointDb(checkpointPath);
        d.spool=spool=createPackSpool({directory:packDirectory,source,handles});await spool.initialize();
      };
      const sample=()=>{
        const stats=spool.stats();assert.ok(stats.bytes<=552*1024*1024);sampleDisk();return stats;
      };
      const transport=async({fileId,url,headers,deadlineAt})=>{
        const grant=granted.get(url);assert.equal(grant?.device,id);
        const signedTarget=validateUploadTarget(url,'local-test.r2.cloudflarestorage.com');
        const key=signedTarget.pathname.split('/').slice(2).join('/');
        const target=new URL('/local-test-put/'+key,entry);
        d.peak=Math.max(d.peak,++d.active);peak=Math.max(peak,++active);
        try{
          await gate.run(fileId,()=>source(fileId),(file,slot)=>uploadNativeFile({target,file,slot,deadlineAt,
            ...(simulateWan?{createReadStream:shapedReader}:{}),
            headers:{...uploadHeaders(file,signedTarget,headers),'x-local-key':localKey},
            request:(uri,opts,cb)=>https.request(uri,{...opts,agent:client},cb),
            onProgress:(loaded,total)=>{for(const fn of progress)fn({fileId,loaded,total});sample();},
          }));
          puts.set(key,(puts.get(key)||0)+1);
          logicalPuts.set(grant.fileId,(logicalPuts.get(grant.fileId)||0)+1);
          // Simulate a user pause after at least one complete PUT. A subset may still be in flight.
          if(pause&&!pausePromise){
            dropReceipts=loseReceipt;
            pausePromise=new Promise((resolve,reject)=>setImmediate(()=>d.engine.pause().then(resolve,reject)));
            allReady();
            if(loseReceipt)throw Object.assign(Error('验收故障注入：R2 写入后的网络响应丢失'),{kind:'network',retryable:true});
          }
        }finally{active--;d.active--;sample();}
      };
      d.desktop={getConfig:async()=>({apiBase:base,deviceId:id}),chooseFiles:async()=>selected,
        hashFile:hasher.hash,abortHash:async id=>hasher.abort(id),
        upload:transport,abortUpload:async fileId=>{gate.slots.get(fileId)?.destroy();return true;},
        onUploadProgress:fn=>{progress.add(fn);return ()=>progress.delete(fn);},onPrepareClose:()=>{},
        preparePack:async(...args)=>{const result=await spool.prepare(...args);sample();return result;},
        releasePack:async(...args)=>{inspectDisk();const result=await spool.release(...args);sample();return result;},
        getPackSpoolStats:async()=>sample(),loadManifest:async()=>null,loadUserManifest:async owner=>{
          const restored=checkpoint.load(owner);
          for(const local of restored?.sources??[]){
            const item=restored.items.find(x=>x.nativeId===local.id);assert.ok(item);
            handles.set(local.id,{...local,contentType:item.contentType});
          }
          return restored;
        },
        saveManifestPatch:async patch=>{
          const {items,sources,...meta}=normalizeManifest({...patch.meta,items:patch.changes.map(c=>c.item)},id=>handles.get(id));
          const refs=new Map(sources.map(s=>[s.id,s]));
          return checkpoint.save({...patch,meta,changes:items.map((item,j)=>({position:patch.changes[j].position,item,source:refs.get(item.nativeId)}))});
        },flushManifest:async()=>true,setUploadActive:async active=>{if(!active)await spool.clear();return true;},
      };
      for(let k=i;k<files.length;k+=machines){
        const f=files[k],id=randomUUID(),ext=path.extname(f.sourcePath),name=(k%7+1)+ext;
        const relativePath='产品-'+String(Math.floor(k/7)).padStart(3,'0')+'/'+name;
        handles.set(id,{path:f.sourcePath,size:f.size,mtimeMs:f.mtimeMs,contentType:f.contentType});
        selected.push({id,name,relativePath,size:f.size,contentType:f.contentType});
        expected.set(relativePath,f);
      }
    }
    const first=devices[0];
    first.token=(await call(first,'/setup',{setupToken:localKey,username:user,password,displayName:'本地验收'})).token;
    const {group}=await call(first,'/groups',{name:'组包离线验收'});
    await call(first,'/storage',{accessKeyId:'test',secretAccessKey:'test',endpoint:'https://local-test.r2.cloudflarestorage.com',bucket:'test'});
    const admin={...first};
    for(const [i,d] of devices.entries()){
      const username=['alpha','beta','gamma','delta'][i],credential=randomUUID();
      await call(admin,'/users',{username,password:credential,displayName:username,role:'employee',
        groupIds:[group.id],permissions:{view:true,upload:true,export:true,delete:false}});
      d.token=(await call(d,'/login',{username,password:credential,deviceId:d.id})).token;
    }
    const health=await call(first,'/health');if(packed)assert.equal(health.packedUpload,true);
    const open=async d=>{
      d.engine=new UploadEngine(()=>{},{apiBase:base,deviceId:d.id,getToken:()=>d.token});
      d.engine.setOptions({batchUpload:true,packedUpload:packed,notify:false,retries:1});
      await d.engine.bindUser(d.id);
    };
    for(const d of devices)await contexts.run(d,async()=>{await open(d);await d.engine.addDesktopFiles();});
    const start=performance.now();
    const timer=setInterval(()=>{sampleDisk();inspectDisk();},25);
    try{
      await Promise.all(devices.map(d=>contexts.run(d,()=>d.engine.start(group.id))));
      for(const d of devices)assert.ok(!d.engine.state.error,d.engine.state.error);
      if(pause){
        assert.ok(pausePromise,'pause point was not reached');await pauseSeen;await pausePromise;
        assert.equal(first.engine.state.status,'paused');oldKeys=[...puts.keys()];assert.ok(oldKeys.length);
        const taskId=first.engine.state.taskId;
        if(loseReceipt){
          await db.prepare('DELETE FROM leases').run();
          dropReceipts=false;
        }
        await contexts.run(first,async()=>{await first.reopen();await open(first);await first.engine.resume();});
        assert.equal(first.engine.state.taskId,taskId);
        assert.ok(oldKeys.every(k=>puts.get(k)===1),'previously successful PUT was repeated');
      }
    }finally{clearInterval(timer);}
    const ms=performance.now()-start,bytes=files.reduce((sum,f)=>sum+f.size,0);
    let verified=0,excelCells=0;
    for(const d of devices){
      const state=d.engine.state;
      assert.equal(state.status,'completed',state.error);
      assert.ok(state.items.every(f=>f.status==='success'),JSON.stringify(state.items.filter(f=>f.status!=='success').slice(0,1)));
      assert.equal(d.spool.stats().bytes,0);
      const rows=[];let cursor='',snapshot='new';
      do{const page=await call(d,'/export?'+new URLSearchParams({taskId:state.taskId,snapshot,limit:'17',...(cursor?{cursor}:{})}));
        snapshot=page.snapshot;cursor=page.nextCursor;assert.equal(page.unfinishedCount,0);rows.push(...page.files);
      }while(cursor);
      assert.equal(rows.length,d.expected.size);
      const urls=new Map(rows.map(row=>[row.url,row.relativePath]));assert.equal(urls.size,d.expected.size);
      const checked=await call(d,'/export?'+new URLSearchParams({taskId:state.taskId,snapshot,verify:'1',limit:'17'}));
      assert.equal(checked.verified,true);
      for(const [table,detail] of [[productTable(rows),false],[detailTable(rows,'name',x=>x),true]]){
        const book=new Workbook(),sheet=book.addWorksheet('图片链接');sheet.addRow(table.headers);sheet.addRows(table.rows);
        const read=new Workbook();await read.xlsx.load(await book.xlsx.writeBuffer());
        const cells=new Set();
        read.worksheets[0].eachRow((r,no)=>{if(no===1)return;
          const values=r.values.slice(1);const links=detail?[values[2]]:values.slice(1).filter(Boolean);
          for(const url of links){const relative=urls.get(url);assert.ok(relative);assert.ok(!cells.has(url));cells.add(url);
            if(detail)assert.equal(values[0],path.basename(relative));
            else assert.equal(values[0],relative.split('/').at(-2));
          }
          if(!detail){const expected=Array.from(d.expected.keys()).filter(k=>k.split('/').at(-2)===values[0]).sort((a,b)=>a.localeCompare(b,'zh-CN',{numeric:true}));
            assert.deepEqual(links.map(url=>urls.get(url)),expected);}
        });
        assert.equal(cells.size,d.expected.size);excelCells+=cells.size;
      }
      for(const row of rows){const original=d.expected.get(row.relativePath);assert.ok(original);
        const head=await mf.dispatchFetch(row.url,{method:'HEAD'});assert.equal(+head.headers.get('content-length'),original.size);
        const r=await mf.dispatchFetch(row.url);assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),original.contentType);
        assert.equal(sha(Buffer.from(await r.arrayBuffer())),original.digest);verified++;}
    }
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM leases').first()).n,0);
    assert.equal(inspectDisk(),0);
    assert.ok([...puts.values()].every(n=>n===1));
    assert.ok([...logicalPuts.values()].every(n=>n===1),'a successfully written logical pack was sent again on another lease');
    if(packed)assert.ok(puts.size < verified);
    else assert.equal(puts.size,verified);
    const actual={name,machines,packed,pause,images:verified,bytes,seconds:round(ms/1000),
      effectiveMbps:round(bytes*8/ms/1000),imagesPerMinute:round(verified*60000/ms),
      uniquePuts:puts.size,duplicatePuts:0,peakActivePuts:peak,peakServerLanes:maxLeases,
      peakSpoolBytes:devices.map(d=>d.spool.stats().peakBytes),aggregateSpoolHighWaterSampleBytes:peakSpool,
      observedDirectoryPeakBytes:devices.map(d=>d.observedDisk),observedCompanyPeakBytes:observedDisk,
      peakReservedBytes:devices.map(d=>d.spool.stats().peakReservedBytes),endingSpoolBytes:0,
      resumedPreviouslyWritten:oldKeys.length,distinctVerifiedLinks:verified,excelCellsRoundTripped:excelCells};
    console.log(JSON.stringify(actual));report.scenarios.push(actual);await persist();
  }finally{
    globalThis.fetch=nativeFetch;
    for(const a of agents)a.destroy();
    for(const d of devices){await d.spool.clear();d.checkpoint.close();}
    await mf.dispose();
    assert.equal(path.dirname(scratch),tmpdir());assert.ok(path.basename(scratch).startsWith('yuntu-pack-accept-'));
    await fs.rm(scratch,{recursive:true,force:true});
  }
}
const cases=[['single-direct',1,false],['single-packed',1,true],['four-packed',4,true],['four-direct',4,false],['pause-packed',1,true,true],['lost-receipt',1,true,true]];
if(process.env.YUNTU_BENCH_REVERSE==='1')cases.reverse();
for(const scenarioArgs of cases)await scenario(...scenarioArgs);
