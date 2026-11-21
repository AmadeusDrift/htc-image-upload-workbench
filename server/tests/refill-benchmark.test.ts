import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Workbook } from 'exceljs';
import { expect, it, vi } from 'vitest';
import { UploadEngine } from '../../src/upload';
import { detailTable, productTable } from '../../src/export';

const baselineRoot=resolve(process.env.YUNTU_BENCH_BASELINE||'../../outputs/云图工作台源码');
const pauseMode=process.env.YUNTU_BENCH_PAUSE==='1';
const dataset=process.env.YUNTU_BENCH_IMAGES;
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const figures:unknown[]=[];
const require=createRequire(import.meta.url);
const {openCheckpointDb}=require('../../electron/checkpoint-db.cjs');
const {normalizeManifest}=require('../../electron/manifest.cjs');

async function exercise(variant:'1.1.4'|'refill',count:number,pause=false,repeat=1){
  const root=variant==='1.1.4'?baselineRoot:process.cwd();
  const server=await build({absWorkingDir:root,entryPoints:['server/index.ts'],bundle:true,write:false,format:'esm',platform:'browser'});
  const worker=new Miniflare(convertV4MiniflareOptions({
    modules:true,script:server.outputFiles[0].text,compatibilityDate:'2026-10-29',
    d1Databases:['DB'],r2Buckets:['BUCKET'],
    bindings:{SETUP_TOKEN:'setup',CONFIG_KEY:'test-local-benchmark-key',R2_ENDPOINT:'https://test.r2.cloudflarestorage.com',R2_BUCKET_NAME:'test'},
  }));
  const devices=Array.from({length:count},(_,i)=>'device-'+i);
  const tokens=new Map<string,string>(), puts=new Map<string,number>(), grants=new Map<string,string>();
  let bytes=0, peak=0, transferring=0, requests=0, confirmations=0, largestBatch=0;
  let pauseRequested:Promise<void>|undefined;
  let earlyExport:{eligibleCount:number;unfinishedCount:number}|undefined;
  const checkpointDir=mkdtempSync(resolve(tmpdir(),'yuntu-refill-'));
  const checkpoint=openCheckpointDb(resolve(checkpointDir,'checkpoint.sqlite'));
  const names=dataset?readdirSync(dataset,{recursive:true,withFileTypes:true})
    .filter(entry=>entry.isFile()&&/\.png$/i.test(entry.name))
    .map(entry=>resolve(entry.parentPath,entry.name)).sort().slice(0,80):[];
  const fixtures=Array.from({length:80},(_,i)=>names.length?readFileSync(names[i]):Buffer.alloc(1024*1024,(i+1)%256));
  const sources=new Map<string,Buffer>();
  const handles=new Map<string,{path:string;size:number;mtimeMs:number}>();
  const owners=new Map<string,InstanceType<typeof UploadEngine>>();
  const old=devices[0];
  const sessionStorage={getItem:()=>null};
  const db=await worker.getD1Database('DB');
  const bucket=await worker.getR2Bucket('BUCKET');
  const direct=(device:string,path:string,body?:unknown)=>worker.dispatchFetch('https://localhost/api'+path,{
    method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+(tokens.get(device)||''),'X-Device-Id':device},
    body:body===undefined?undefined:JSON.stringify(body),
  });
  const json=async(device:string,path:string,body?:unknown)=>{
    const response=await direct(device,path,body);
    if(!response.ok)throw Error(path+' HTTP '+response.status);
    return await response.json() as any;
  };
  const live=new Set<string>();
  const desktop={
    getConfig:async()=>({apiBase:'https://localhost',deviceId:old}),
    onUploadProgress:()=>{}, onPrepareClose:()=>{}, setUploadActive:async()=>true,
    loadManifest:async()=>null,loadUserManifest:async(owner:string)=>checkpoint.load(owner),
    flushManifest:async()=>true, saveManifestPatch:async(data:any)=>{
      const {items,sources,...meta}=normalizeManifest({...data.meta,items:data.changes.map((row:any)=>row.item)},(id:string)=>handles.get(id));
      const refs=new Map(sources.map((source:any)=>[source.id,source]));
      return checkpoint.save({...data,meta,changes:items.map((item:any,i:number)=>({position:data.changes[i].position,item,source:refs.get(item.nativeId)}))});
    },
    hashFile:async(id:string)=>Buffer.from(await crypto.subtle.digest('SHA-256',new Uint8Array(sources.get(id)!))).toString('hex'),
    abortUpload:async(id:string)=>{live.delete(id);return true},
    upload:async({fileId,url,headers,uploadUrl}:any)=>{
      const target=new URL(url||uploadUrl), owner=grants.get(target.href)!;
      const key=target.pathname.split('/').slice(2).map(decodeURIComponent).join('/');
      live.add(fileId);
      peak=Math.max(peak,++transferring);
      try{
        const source=sources.get(fileId)!;
        // Each request has the same per-file transfer timing in both versions.
        await delay(270+source.length/11000);
        if(!live.has(fileId))return;
        await bucket.put(key,new Uint8Array(source),{httpMetadata:{contentType:headers['Content-Type']}});
        bytes+=source.length;
        puts.set(key,(puts.get(key)||0)+1);
        expect(owner).toBeTruthy();
      }finally{live.delete(fileId);transferring--}
    },
  };
  vi.stubGlobal('window',{desktop});
  vi.stubGlobal('sessionStorage',sessionStorage);
  try{
    await db.exec(readFileSync(resolve(root,'server/schema.sql'),'utf8').replace(/\n/g,' '));
    tokens.set(old,(await json(old,'/setup',{setupToken:'setup',username:'alpha',password:'12345678',displayName:'Alpha'})).token);
    for(const device of devices.slice(1))tokens.set(device,(await json(device,'/login',{username:'alpha',password:'12345678',deviceId:device})).token);
    const group=(await json(old,'/groups',{name:'Test Images'})).group.id;
    await json(old,'/storage',{accessKeyId:'test',secretAccessKey:'test',endpoint:'https://test.r2.cloudflarestorage.com',bucket:'test'});
    let firstWave!:()=>void;
    const barrier=new Promise<void>(resolve=>{firstWave=resolve});
    const started=new Set<string>();
    vi.stubGlobal('fetch',async (url:string,init:RequestInit)=>{
      const device=new Headers(init.headers).get('X-Device-Id')!, route=new URL(url).pathname;
      const body=init.body?JSON.parse(String(init.body)):{};
      if(route.endsWith('/upload-leases')){
        requests++;
        if(body.fileIds.length){started.add(device);if(started.size===count)firstWave();await barrier;}
        await delay(100);
      }
      if(route.endsWith('/complete')||route.endsWith('/confirm-uploads')){
        confirmations++;
        largestBatch=Math.max(largestBatch,body.fileIds?.length||1);
        if(pause&&!pauseRequested&&route.endsWith('/confirm-uploads')){
          const owner=owners.get(device)!;
          const status=await json(device,'/export?taskId='+owner.state.taskId+'&snapshot=new&limit=17');
          earlyExport={eligibleCount:status.eligibleCount,unfinishedCount:status.unfinishedCount};
          pauseRequested=owner.pause();
        }
        await delay(400);
      }
      if(init.signal?.aborted)throw new DOMException('paused','AbortError');
      const response=await worker.dispatchFetch(url,init as any);
      if(route.endsWith('/upload-leases')){
        const data=await response.clone().json() as any;
        if(data.globalUsed!==undefined)expect(data.globalUsed).toBeLessThanOrEqual(20);
        for(const grant of data.grants||[])grants.set(grant.uploadUrl,device);
      }
      return response;
    });
    const Engine:typeof UploadEngine=variant==='1.1.4'
      ? (await import(/* @vite-ignore */ resolve(baselineRoot,'src/upload.ts'))).UploadEngine
      : UploadEngine;
    for(const [d,device] of devices.entries()){
      const engine=new Engine(()=>{},{apiBase:'https://localhost',deviceId:device,getToken:()=>tokens.get(device)});
      engine.setOptions({batchUpload:true,retries:0,notify:false});
      await engine.bindUser(device);
      engine.state.status='ready';
      engine.state.items=fixtures.map((file,i)=>({file,i})).filter(({i})=>i%count===d).map(({file,i})=>{
        const nativeId=device+'-'+i, name=(i%5+1)+'.png';
        sources.set(nativeId,file);
        handles.set(nativeId,{path:names[i]||resolve(checkpointDir,nativeId+'.png'),size:file.length,mtimeMs:0});
        return {id:nativeId,nativeId,name,relativePath:'product-'+Math.floor(i/5)+'/'+name,size:file.length,contentType:'image/png',status:'pending',progress:0};
      });
      owners.set(device,engine as InstanceType<typeof UploadEngine>);
    }
    const start=performance.now();
    await Promise.all([...owners.values()].map(engine=>engine.start(group)));
    for(const engine of owners.values()){
      if(engine.state.error)throw Error(engine.state.error);
      if(engine.state.items.some(item=>item.status==='failed'))
        throw Error(engine.state.items.find(item=>item.status==='failed')!.error);
    }
    if(pause){
      expect(earlyExport).toEqual({eligibleCount:0,unfinishedCount:80});
      expect(pauseRequested).toBeTruthy();
      await pauseRequested;
      const original=owners.get(old)!;
      expect(original.state.status).toBe('paused');
      expect(checkpoint.load(old).items.some((item:any)=>item.awaitingConfirmation)).toBe(true);
      const reopened=new UploadEngine(()=>{},{apiBase:'https://localhost',deviceId:old,getToken:()=>tokens.get(old)});
      reopened.setOptions({batchUpload:true,retries:0,notify:false});
      await reopened.bindUser(old);
      const known=[...puts.keys()];
      expect(known.length).toBeGreaterThan(0);
      await reopened.resume();
      expect(reopened.state.taskId).toBe(original.state.taskId);
      expect([...known].every(key=>puts.get(key)===1)).toBe(true);
      owners.set(old,reopened);
    }
    const ms=Math.round(performance.now()-start);
    expect(peak).toBe(20);
    expect(puts.size).toBe(80);
    expect([...puts.values()].every(n=>n===1)).toBe(true);
    if(variant==='refill')expect(largestBatch).toBeGreaterThan(1);
    let links=0;
    for(const [device,engine] of owners){
      expect(engine.state.error).toBeUndefined();
      expect(engine.state.status).toBe('completed');
      expect(engine.state.items.every(f=>f.status==='success')).toBe(true);
      const expected=new Set(engine.state.items.map(f=>f.url));
      let snapshot='new', cursor='';
      const files=[];
      do{
        const page=await json(device,'/export?'+new URLSearchParams({taskId:engine.state.taskId!,snapshot,limit:'17',...(cursor?{cursor}:{})}));
        snapshot=page.snapshot;
        cursor=page.nextCursor;
        expect(page.eligibleCount).toBe(expected.size);
        expect(page.unfinishedCount).toBe(0);
        files.push(...page.files);
      }while(cursor);
      const checked=await json(device,'/export?'+new URLSearchParams({taskId:engine.state.taskId!,snapshot,limit:'17',verify:'1'}));
      expect(checked.verified).toBe(true);
      expect(files).toHaveLength(expected.size);
      for(const [table,firstColumn] of [[productTable(files),2],[detailTable(files,'name',date=>date),3]] as const){
        const workbook=new Workbook();
        const sheet=workbook.addWorksheet('图片链接');
        sheet.addRow(table.headers);
        table.rows.forEach(row=>sheet.addRow(row));
        const loaded=new Workbook();
        await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
        const urls:string[]=[];
        loaded.worksheets[0].eachRow((row,index)=>{
          if(index>1)row.eachCell((cell,col)=>{
            if(col>=firstColumn&&typeof cell.value==='string'&&cell.value.startsWith('http'))urls.push(cell.value);
          });
        });
        expect(urls).toHaveLength(expected.size);
        expect(new Set(urls)).toEqual(expected);
      }
      for(const file of files){
        const image=await worker.dispatchFetch(file.url);
        expect(image.status).toBe(200);
        await image.arrayBuffer();
      }
      links+=files.length;
    }
    expect((await db.prepare('SELECT count(*) n FROM leases').first<{n:number}>())!.n).toBe(0);
    const row={variant,count,repeat,pause,ms,bytes,peak,requests,confirmations,largestBatch,links,duplicatePuts:[...puts.values()].filter(n=>n>1).length};
    console.log(JSON.stringify(row));
    figures.push(row);
    if(process.env.YUNTU_BENCH_OUT)writeFileSync(process.env.YUNTU_BENCH_OUT,JSON.stringify(figures,null,2));
  }finally{
    vi.unstubAllGlobals();
    checkpoint.close();
    // This directory was created by mkdtemp above and contains only this test's SQLite files.
    for(const entry of readdirSync(checkpointDir,{withFileTypes:true}))if(entry.isFile())rmSync(resolve(checkpointDir,entry.name));
    rmdirSync(checkpointDir);
    await worker.dispose();
  }
}

it.skipIf(!process.env.YUNTU_BENCH_OUT)('benchmarks identical files with one and four clients',async()=>{
  if(pauseMode){await exercise('refill',1,true);return}
  for(const count of [1,4]){
    await exercise('1.1.4',count,false,1);
    await exercise('refill',count,false,1);
    await exercise('refill',count,false,2);
    await exercise('1.1.4',count,false,2);
  }
},240000);
