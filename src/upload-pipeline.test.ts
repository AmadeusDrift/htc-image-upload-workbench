import {afterEach,expect,it,vi} from 'vitest';
import {UploadEngine,type QueueItem} from './upload';
afterEach(()=>vi.unstubAllGlobals());

function fixture(count:number,failSave:boolean|'during'=false,pauseAt?:number,putResult?:(attempt:number)=>unknown){
 const saved=new Map<number,QueueItem>(), records=new Map<string,any>();
 let peak=0, transmitting=0, puts=0, registrations=0;
 let checkpoint:any, pauseTriggered=false;
 const putIds:number[]=[];
 let firstPutFromPageTwo=false, overlappingRegistration=false;
 let releaseLast!:()=>void;
 const lastOnFirstPage=new Promise<void>(resolve=>{releaseLast=resolve});
 const active=new Set<string>();
 const desktop={
  getConfig:async()=>({apiBase:'https://service.test',deviceId:'device'}),
  loadManifest:async()=>null,
  loadUserManifest:async()=>checkpoint?{
   ...checkpoint.meta,checkpointKey:checkpoint.key,savedCount:saved.size,expectedCount:checkpoint.expected,
   items:[...saved.entries()].sort(([a],[b])=>a-b).map(([,item])=>item),
  }:null,
  onUploadProgress:()=>{},
  onPrepareClose:()=>{},setUploadActive:async()=>true,flushManifest:async()=>true,
  saveManifest:async()=>{throw Error('Unexpected full-queue save')},
  saveManifestPatch:async(data:any)=>{
   if(failSave===true || failSave==='during'&&data.changes.some((row:any)=>row.position>=100&&row.item.fileId))
    throw Error('磁盘空间不足');
   expect(data.changes.length).toBeLessThanOrEqual(100);
   checkpoint=data;
   for(const row of data.changes)saved.set(row.position,row.item);
   return saved.size;
  },
  hashFile:async()=> 'a'.repeat(64),
  abortUpload:async()=>{releaseLast();return true},
  upload:async({fileId}:{fileId:string})=>{
   const index=Number(fileId.slice(2));
   expect(saved.get(index)?.fileId).toBe('remote-'+index);
   puts++;
   putIds.push(index);
   if(pauseAt===index&&!pauseTriggered){
    pauseTriggered=true;
    void engine.pause();
   }
   peak=Math.max(peak,++transmitting);
   if(index===99)await lastOnFirstPage;
   if(index>=100&&!firstPutFromPageTwo){
    firstPutFromPageTwo=transmitting>1;
    releaseLast();
   }
   await new Promise(resolve=>setTimeout(resolve,5));
   transmitting--;
   return putResult?.(puts);
  },
 };
 vi.stubGlobal('window',{desktop});
 vi.stubGlobal('sessionStorage',{getItem:()=>null});
 vi.stubGlobal('fetch',async(url:string,init:RequestInit)=>{
  const route=new URL(url).pathname, body=JSON.parse(String(init.body||'{}'));
  let result:unknown={ok:true};
  if(route==='/api/tasks')result={task:{id:'task'}};
  else if(route==='/api/tasks/task')result={files:[...records.values()]};
  else if(route==='/api/uploads/activity'&&!body.active)active.clear();
  else if(route.endsWith('/files')){
   registrations++;
   if(registrations>1&&active.size)overlappingRegistration=true;
   await new Promise(resolve=>setTimeout(resolve,20));
   result={files:body.files.map((row:any)=>{
    const record={id:'remote-'+row.clientId,clientId:row.clientId,status:'pending'};
    records.set(record.id,record);
    return record;
   })};
  }else if(route.endsWith('/upload-leases')){
   const grants=body.fileIds.slice(0,20-active.size).map((fileId:string)=>{
    active.add(fileId);
    return {fileId,leaseId:'lease-'+fileId,uploadUrl:'https://r2.test/'+fileId,headers:{}};
   });
   result={quota:20,used:active.size,globalLimit:20,globalUsed:active.size,grants,unavailable:[]};
  }else if(route.endsWith('/release'))active.delete(route.split('/')[3]);
  else if(route.endsWith('/complete')){
   const id=route.split('/')[3];
   active.delete(id);
   const file=records.get(id);
   file.status='success';file.url='https://service.test/img/'+id;
   result={file};
  }
  return new Response(JSON.stringify(result));
 });
 const newEngine=()=>{
  const client=new UploadEngine(()=>{});
  client.setOptions({batchUpload:true,retries:0,notify:false});
  return client;
 };
 const engine=newEngine();
 const setItems=()=>{
  engine.state.items=Array.from({length:count},(_,i)=>({
   id:String(i),nativeId:'n-'+i,name:i+'.jpg',relativePath:'A/'+i+'.jpg',size:1,
   contentType:'image/jpeg',status:'pending',progress:0,
  }));
  engine.state.status='ready';
 };
 return {engine,newEngine,setItems,saved,records,putIds,restoreSpace:()=>{failSave=false},stats:()=>({puts,peak,registrations,firstPutFromPageTwo,overlappingRegistration})};
}

it('opens the next page while the prior page still has a transfer and saves only small changes',async()=>{
 const {engine,setItems,saved,stats}=fixture(210);
 await engine.bindUser('alpha');
 setItems();
 await engine.start('group');
 expect(engine.state.status).toBe('completed');
 expect(stats()).toEqual({puts:210,peak:20,registrations:3,firstPutFromPageTwo:true,overlappingRegistration:true});
 expect(saved.size).toBe(210);
 expect([...saved.values()].every(row=>row.status==='success')).toBe(true);
});

it('stops before requesting leases when the first page cannot be saved',async()=>{
 const {engine,setItems,stats}=fixture(120,true);
 await engine.bindUser('alpha');
 setItems();
 await engine.start('group');
 expect(engine.state.status).toBe('error');
 expect(engine.state.persistenceError).toContain('磁盘空间不足');
 expect(stats()).toMatchObject({puts:0,registrations:0});
});

it('restores the same task after a pause during handoff and skips confirmed images',async()=>{
 const {engine,newEngine,setItems,records,putIds}=fixture(210,false,100);
 await engine.bindUser('alpha');
 setItems();
 await engine.start('group');
 expect(engine.state.status).toBe('paused');
 const confirmed=new Set([...records.values()].filter(record=>record.status==='success').map(record=>Number(record.clientId)));
 expect(confirmed.size).toBeGreaterThan(20);
 const offset=putIds.length;
 const restarted=newEngine();
 await restarted.bindUser('alpha');
 expect(restarted.state.taskId).toBe('task');
 expect(restarted.state.items).toHaveLength(210);
 await restarted.resume();
 expect(restarted.state.status).toBe('completed');
 expect(putIds.slice(offset).every(index=>!confirmed.has(index))).toBe(true);
 expect(restarted.state.items.every(item=>item.status==='success')).toBe(true);
});

it('stops taking new slots when a later checkpoint fails and can continue after space is freed',async()=>{
 const {engine,setItems,records,putIds,restoreSpace,stats}=fixture(210,'during');
 await engine.bindUser('alpha');
 setItems();
 await engine.start('group');
 expect(engine.state.status).toBe('error');
 expect(stats().puts).toBeGreaterThan(0);
 expect(stats().puts).toBeLessThan(100);
 const confirmed=new Set([...records.values()].filter(record=>record.status==='success').map(record=>Number(record.clientId)));
 const offset=putIds.length;
 restoreSpace();
 await engine.resume();
 expect(engine.state.status).toBe('completed');
 expect(putIds.slice(offset).every(index=>!confirmed.has(index))).toBe(true);
 expect(engine.state.items.every(item=>item.status==='success')).toBe(true);
});

it.each([{kind:'signature-expired',puts:2},{kind:'auth',puts:1}])('bounds batch reacquisition for $kind',async({kind,puts})=>{
 const {engine,setItems,stats}=fixture(1,false,undefined,()=>({ok:false,error:{kind,status:403,message:'storage rejected'}}));
 await engine.bindUser('alpha');setItems();
 await engine.start('group');
 expect(stats().puts).toBe(puts);
 expect(engine.state.items[0].status).toBe('failed');
});
