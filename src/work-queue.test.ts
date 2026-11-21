import {createRequire} from 'node:module';
import {afterEach,expect,it,vi} from 'vitest';
import {UploadEngine} from './upload';
import type {DesktopTask} from './desktop';
const {createWorkQueue}=createRequire(import.meta.url)('../electron/work-queue.cjs');
afterEach(()=>vi.unstubAllGlobals());

function setup(){
 const handles=new Map(), scanned:string[]=[], calls:string[]=[], records=new Map<string,any>();
 const scan=async(input:{paths:string[]},cursor:number|null)=>{
  const index=cursor??0, path=input.paths[0], name=path.split('\\').pop()!;
  scanned.push(name+index);
  return {files:[{name:'a.jpg',relativePath:name+'/'+index+'/a.jpg',size:42,mtimeMs:1,contentType:'image/jpeg',path:path+'\\'+index+'\\a.jpg'}],
   cursor:index+1,done:name==='second'||index===1};
 };
 const queue=createWorkQueue(':memory:',handles,scan);
 let saved:any=null, broken=false;
 const desktop={
  getConfig:async()=>({apiBase:'https://local.test',deviceId:'test-device'}),
  listWork:(owner:string)=>queue.list(owner),openWorkGroup:(owner:string)=>queue.open(owner),
  finishWorkGroup:(...args:any[])=>queue.finish(...args), enqueueImport:(...args:any[])=>queue.enqueue(...args),
  loadManifest:async()=>saved,loadUserManifest:async()=>saved,saveManifest:async(data:any)=>{saved=structuredClone(data);return true},
  hashFile:async()=> 'a'.repeat(64), upload:async()=>{if(broken)throw Error('transfer failed')},
  abortUpload:async()=>true,onUploadProgress:()=>()=>{},onPrepareClose:()=>()=>{},
 };
 vi.stubGlobal('window',{desktop});
 vi.stubGlobal('sessionStorage',{getItem:()=> 'token'});
 const response=(value:unknown)=>({ok:true,json:async()=>value,headers:new Headers()});
 vi.stubGlobal('fetch',async(raw:string,init:{body?:string;method:string})=>{
  const path=new URL(raw).pathname;
  const data=JSON.parse(init.body||'{}');
  if(path==='/api/uploads/activity')return response({});
  if(path==='/api/tasks'){calls.push('create '+data.name);return response({task:{id:data.clientTaskId}})}
  if(path.endsWith('/files')&&data.files){
   calls.push('register '+path);
   return response({files:data.files.map((f:any)=>{
    if(!records.has(f.clientId))records.set(f.clientId,{id:f.clientId,clientId:f.clientId,status:'pending'});
    return records.get(f.clientId);
   })});
  }
  if(path.startsWith('/api/tasks/')&&init.method==='GET')return response({files:[...records.values()],nextCursor:null});
  const [,id,op]=path.match(/\/api\/files\/([^/]+)\/(\w+)/)||[];
  if(op==='lease')return response({leaseId:'lease',uploadUrl:'https://local.test/put'});
  if(op==='fail'||op==='release')return response({});
  if(op==='complete'){const item=records.get(id);item.status='success';item.url='https://local.test/'+id;return response({file:item})}
  throw Error(path);
 });
 const engine=new UploadEngine(()=>{});
 engine.setOptions({notify:false,retries:0});
 async function add(name:string){
  const entry=queue.stage('u',['C:\\mock\\'+name],'folders',true);
  await engine.enqueueDesktopImport(entry.id,name,'g');
 }
 return {engine,queue,scanned,calls,handles,records,add,setBroken:(v:boolean)=>{broken=v}};
}
it('uploads every group of one server task before admitting the next queued task',async()=>{
 const {engine,add,calls,scanned,handles}=setup();
 await engine.bindUser('u');await add('first');await add('second');
 expect(scanned).toEqual([]);
 const [first,second]=engine.state.worklist!;
 await engine.start('g');
 expect(scanned).toEqual(['first0','first1','second0']);
 expect(calls).toEqual(['create first','register /api/tasks/'+first.id+'/files','register /api/tasks/'+first.id+'/files','create second','register /api/tasks/'+second.id+'/files']);
 expect(engine.state).toMatchObject({status:'completed',taskId:second.id,items:[],worklist:[{id:second.id,finished:true,completed:1}]});
 expect(handles.size).toBe(0);
});
it('keeps a failed group and its handles until a successful retry',async()=>{
 const {engine,add,scanned,setBroken,handles,records}=setup();
 await engine.bindUser('u');await add('first');
 setBroken(true);await engine.start('g');
 expect(engine.state.status).toBe('error');
 expect(scanned).toEqual(['first0']);expect(handles.size).toBe(1);
 setBroken(false);await engine.retryFailed();
 expect(scanned).toEqual(['first0','first1']);
 expect(engine.state.worklist![0].completed).toBe(2);
 expect(records.size).toBe(2);
});
it('restores exactly the same in-flight files and keeps another owner isolated',async()=>{
 const {queue,scanned}=setup(),selected=queue.stage('u',['C:\\mock\\first'],'folders',true);
 await expect(queue.enqueue('other',selected.id,'task','g')).rejects.toThrow();
 const [job]:DesktopTask[]=await queue.enqueue('u',selected.id,'task','g');
 const first=await queue.open('u'), resumed=await queue.open('u');
 expect(scanned).toEqual(['first0']);
 expect(resumed.files).toEqual(first.files);expect(resumed.recovered).toBe(true);
 await expect(queue.finish('u',job.id,'old ticket','server-id')).rejects.toThrow();
 expect(await queue.list('other')).toEqual([]);
});
