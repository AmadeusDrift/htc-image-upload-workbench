import {afterEach,expect,it,vi} from 'vitest';
import {UploadEngine,type QueueItem,type UploadState} from './upload';
import {nextPack,PACK_BYTE_LIMIT,packedDemand,PackLookahead} from './upload-packs';

afterEach(()=>vi.unstubAllGlobals());
const digest='a'.repeat(64);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function images(count:number):QueueItem[]{
 return Array.from({length:count},(_,i)=>({
  id:'row-'+i,nativeId:'source-'+i,name:i+'.png',relativePath:'p/'+i+'.png',
  contentType:'image/png',size:10,status:'pending',progress:0,
 }));
}

it('grows the buffer on overlapping fast transfers and shrinks it on sustained slower transfers',()=>{
 const buffer=new PackLookahead();
 buffer.recordPreparation(1500);
 expect(buffer.target(0)).toBe(2);
 for(const end of [2000,4000,6000]){
  for(let lane=0;lane<4;lane++)buffer.recordPut(end-500,end);
  expect(buffer.target(end)).toBe(end/1000+2);
 }
 for(let end=14000;end<=46000;end+=2000){
  buffer.recordPut(end-2000,end);
  buffer.target(end);
 }
 expect(buffer.target(46000)).toBe(2);
});

it('starts the first group at the selection boundary and preserves group membership across retries',()=>{
 const rows=images(18);
 rows[1].size=PACK_BYTE_LIMIT-10;
 rows[2].size=PACK_BYTE_LIMIT+1;
 expect(nextPack(rows,0)).toHaveLength(2);
 expect(nextPack(rows,2)).toHaveLength(1);
 expect(nextPack(rows,3)).toHaveLength(12);
 expect(packedDemand(rows,0,20)).toBe(4);
 rows[3].packKey=rows[3].id;rows[3].packPosition=0;
 rows[4].packKey=rows[3].id;rows[4].packPosition=1;
 expect(nextPack(rows,3)).toHaveLength(2);
 expect(()=>nextPack(rows,4)).toThrow('不完整');
});

function fixture(options:{droppedResponse?:boolean;pauseAtConfirm?:boolean;missingOnce?:boolean;legacy?:boolean;sampleLive?:boolean}={}){
 const rows=images(25),puts:string[]=[],registrations:string[][]=[],captured:UploadState[]=[];
 const records=new Map<string,any>(),packs=new Map<string,string[]>(),objects=new Set<string>();
 const spools=new Map<string,string[]>(),received=new Set<string>();
 let snapshot:any=options.legacy?{ownerId:'alpha',taskId:'task',groupId:'group',items:rows.slice(0,2)}:undefined;
 let peakSpools=0,firstPutAt=0,preparing=0,peakPreparing=0;
 let progress:((p:{fileId:string;loaded:number;total:number})=>void)|undefined;
 let pause:Promise<void>|undefined;
 let engine:UploadEngine;
 const desktop={
  loadManifest:async()=>snapshot,loadUserManifest:async()=>snapshot&&structuredClone(snapshot),
  saveManifest:async(value:any)=>{snapshot=structuredClone(value);return true},
  flushManifest:async()=>true,setUploadActive:async()=>true,
  getConfig:async()=>({apiBase:'https://service.test',deviceId:'desktop-1'}),
  onPrepareClose:()=>{},onUploadProgress:(cb:typeof progress)=>{progress=cb},
  hashFile:vi.fn(async()=>digest),abortUpload:async()=>true,
  preparePack:async(key:string,ids:string[])=>{
   peakPreparing=Math.max(peakPreparing,++preparing);
   await sleep(2);
   spools.set(key,ids);peakSpools=Math.max(peakSpools,spools.size);preparing--;
   return {id:'spool-'+key,size:ids.length*10,sha256:digest,entries:ids.map((id,i)=>({id,offset:i*10,size:10,sha256:digest}))};
  },
  releasePack:async(key:string)=>spools.delete(key),
  upload:async({fileId,url,headers}:any)=>{
   const leader=new URL(url).pathname.slice(1),members=packs.get(leader)??[leader];
   const row=snapshot.items.find((item:QueueItem)=>item.fileId===leader);
   if(!options.legacy){
    expect(row.packLeaseId).toBe('lease-'+leader);
    expect(row.packRunId).toBeTruthy();
   }
   if(members.length>1){
    expect(headers['x-amz-checksum-sha256']).toBe('signed');
    expect(spools.get(row.id)).toHaveLength(members.length);
   }
   if(!puts.length)firstPutAt=records.size;
   puts.push(leader);
   progress?.({fileId,loaded:10,total:members.length*10});
   await sleep(options.sampleLive&&leader==='remote-row-0'?700:3);
   if(options.missingOnce && leader==='remote-row-0'){options.missingOnce=false;return {ok:false,error:{kind:'network',message:'socket closed'}}}
   objects.add(leader);
   if(options.droppedResponse)return {ok:false,error:{kind:'network',message:'response lost'}};
  },
 };
 vi.stubGlobal('window',{desktop});vi.stubGlobal('sessionStorage',{getItem:()=>null});
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  const path=new URL(url).pathname,body=JSON.parse(String(init.body||'{}'));
  let data:unknown={ok:true};
  if(path==='/api/tasks')data={task:{id:'task'}};
  else if(path==='/api/tasks/task')data={files:[...records.values()].map(row=>({...row,awaitingConfirmation:received.has(row.id)}))};
  else if(path.endsWith('/files')){
   registrations.push(body.files.map((row:any)=>row.clientId));
   data={files:body.files.map((row:any)=>{
    const result={...row,id:'remote-'+row.clientId,status:'pending'};
    records.set(result.id,result);
    return result;
   })};
  }else if(path.endsWith('/packs')){
   for(const pack of body.packs){
    expect(pack.sha256).toBe(digest);
    const ids=pack.members.map((m:any)=>m.fileId);
    expect(ids.length).toBeLessThanOrEqual(12);
    if(packs.has(ids[0]))expect(packs.get(ids[0])).toEqual(ids);
    packs.set(ids[0],ids);
    for(const id of ids)records.get(id).packLeaderId=ids[0];
   }
  }else if(path.endsWith('/upload-leases')){
   expect(body.packed).toBe(options.legacy?undefined:true);
   const receipts=(body.uploaded??[]).filter((r:any)=>!options.droppedResponse||!packs.has(r.fileId));
   for(const receipt of receipts)received.add(receipt.fileId);
   const grants=body.fileIds.slice(0,1).map((id:string)=>({
    fileId:id,leaseId:'lease-'+id,uploadUrl:'https://store.test/'+id,headers:{'x-amz-checksum-sha256':'signed'},
   }));
   data={grants,quota:1,unavailable:[],receipts};
  }else if(path.endsWith('/confirm-uploads')){
   if(options.pauseAtConfirm&&!pause){pause=engine.pause();throw new DOMException('paused','AbortError')}
   const files=[],retry=[];
   for(const id of body.fileIds){
    if(!received.has(id)&&!body.packedReceipts?.some((receipt:any)=>receipt.fileId===id))continue;
    if(!objects.has(id)){retry.push(id);received.delete(id);continue}
    for(const fileId of packs.get(id)??[id]){
     const row=records.get(fileId);row.status='success';row.url='https://service.test/img/'+fileId;files.push(row);
    }
   }
   data={files,retry};
  }
  return new Response(JSON.stringify(data));
 });
 const create=()=>{engine=new UploadEngine(state=>captured.push(state));engine.setOptions({batchUpload:true,packedUpload:true,notify:false,retries:1});return engine};
 const initial=create();
 const removeUnfinished=(leader:string,id:string)=>{
  for(const member of packs.get(leader)!)records.get(member).packLeaderId=undefined;
  records.get(id).status='deleted';packs.delete(leader);objects.delete(leader);received.delete(leader);
 };
 return {initial,create,rows,puts,objects,registrations,captured,desktop,spools,received,removeUnfinished,getSnapshot:()=>snapshot,
  stats:()=>({firstPutAt,peakPreparing,peakSpools}),pause:()=>pause};
}

it('sends 25 originals in two packs and one direct PUT, and recovers an accepted PUT with a lost response',async()=>{
 const f=fixture({droppedResponse:true});await f.initial.bindUser('alpha');f.initial.state.items=f.rows;
 await f.initial.start('group');
 expect(f.initial.state.error).toBeUndefined();
 expect(f.initial.state.status).toBe('completed');
 expect(f.puts).toHaveLength(3);
 expect(new Set(f.rows.map(item=>item.url)).size).toBe(25);
 expect(f.rows.every(row=>row.status==='success'&&row.progress===100)).toBe(true);
 // Registration can finish out of order while a prepared pack is uploading.
 expect(f.registrations.flat().sort()).toEqual(f.rows.map(row=>row.id).sort());
 expect(f.desktop.hashFile).toHaveBeenCalledTimes(1);
 expect(f.stats().firstPutAt).toBeLessThan(25);
 expect(f.stats().peakPreparing).toBe(1);
 expect(f.stats().peakSpools).toBeLessThanOrEqual(3);
 expect(f.spools.size).toBe(0);
});

it('reopens a stopped pack before confirmation and preserves every individual link',async()=>{
 const f=fixture({pauseAtConfirm:true});await f.initial.bindUser('alpha');f.initial.state.items=f.rows;
 await f.initial.start('group');await f.pause();
 expect(f.initial.state.status).toBe('paused');
 expect(f.getSnapshot().transportMode).toBe('packed-v1');
 const prior=new Set(f.objects),offset=f.puts.length;
 expect(prior.size).toBeGreaterThan(0);
 f.received.clear(); // Even a lost server receipt can be probed using the persisted attempt.
 const resumed=f.create();await resumed.bindUser('alpha');await resumed.resume();
 expect(resumed.state.error).toBeUndefined();
 expect(resumed.state.status).toBe('completed');
 expect(resumed.state.items.every(item=>item.status==='success'&&item.url?.endsWith(item.fileId!))).toBe(true);
 expect(f.puts.slice(offset).some(id=>prior.has(id))).toBe(false);
 expect(f.spools.size).toBe(0);
});

it('rebuilds exactly the missing pack after a definite negative confirmation',async()=>{
 const f=fixture({missingOnce:true});await f.initial.bindUser('alpha');f.initial.state.items=f.rows;
 await f.initial.start('group');
 expect(f.initial.state.error).toBeUndefined();
 expect(f.rows.every(item=>item.status==='success')).toBe(true);
 expect(f.puts.filter(id=>id==='remote-row-0')).toHaveLength(2);
 expect(f.puts).toHaveLength(4);
 expect(f.spools.size).toBe(0);
});

it('replans surviving originals after an unfinished pack was dissolved by a member deletion',async()=>{
 const f=fixture({pauseAtConfirm:true});await f.initial.bindUser('alpha');f.initial.state.items=f.rows;
 await f.initial.start('group');await f.pause();
 f.removeUnfinished('remote-row-0','remote-row-6');
 const resumed=f.create();await resumed.bindUser('alpha');await resumed.resume();
 expect(resumed.state.error).toBeUndefined();
 expect(resumed.state.status).toBe('completed');
 expect(resumed.state.items[6]).toMatchObject({status:'failed',blocked:true});
 expect(resumed.state.items.filter(item=>item.status==='success')).toHaveLength(24);
});

it('keeps an earlier desktop task on its per-image transport on a pack-capable service',async()=>{
 const f=fixture({legacy:true});await f.initial.bindUser('alpha');await f.initial.resume();
 expect(f.initial.state.error).toBeUndefined();
 expect(f.initial.state.transportMode).toBeUndefined();
 expect(f.initial.state.items.every(item=>item.status==='success')).toBe(true);
 expect(f.stats().peakSpools).toBe(0);
 expect(f.puts).toHaveLength(2);
});

it('reports one assigned lane, twelve transferring images and individual byte progress',async()=>{
 const f=fixture({sampleLive:true});await f.initial.bindUser('alpha');f.initial.state.items=f.rows;
 await f.initial.start('group');
 const live=f.captured.find(state=>state.telemetry?.used===1&&state.telemetry.transferring===12&&
  state.telemetry.bytesPerSecond>0&&state.items[0].progress===99);
 expect(live?.telemetry.quota).toBe(1);
 expect(live?.items[1].progress).toBe(0);
 expect(live?.items.slice(0,12).every(item=>item.status==='uploading')).toBe(true);
});
