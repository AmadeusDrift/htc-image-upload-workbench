import {afterEach,describe,it,expect,vi} from 'vitest';
import {UploadEngine} from './upload';
afterEach(()=>vi.unstubAllGlobals());
function environment(count:number,upload:(id:string)=>Promise<void>,abort:(id:string)=>void=()=>{},manifest?:any,server?:{files:any[];lostComplete?:boolean}){
 const calls:string[]=[],requests:Array<{pathname:string,body:any}>=[];
 const files=Array.from({length:count},(_,i)=>({id:'native'+i,name:i+'.png',relativePath:i+'.png',size:100,contentType:'image/png'}));
 vi.stubGlobal('window',{desktop:{getConfig:async()=>({apiBase:'https://service.example',deviceId:'device'}),chooseFiles:async()=>files,hashFile:async()=>'a'.repeat(64),loadManifest:async()=>manifest||null,saveManifest:async()=>true,onUploadProgress:()=>()=>{},upload:async({fileId}:any)=>upload(fileId),abortUpload:async(id:string)=>abort(id)}});
 vi.stubGlobal('fetch',async(input:string,options:any)=>{const pathname=new URL(input).pathname;calls.push(pathname);const body=JSON.parse(options?.body||'{}');requests.push({pathname,body});let data:any={ok:true};if(pathname==='/api/tasks')data={task:{id:'task'}};else if(pathname==='/api/tasks/task/files')data={files:body.files.map((f:any)=>({id:'server'+f.clientId,clientId:f.clientId}))};else if(pathname==='/api/tasks/task'&&options.method==='GET')data={task:{id:'task'},files:server?.files||[]};else if(/^\/api\/files\/[^/]+$/.test(pathname)&&options.method==='GET')data={file:server?.files.find((f:any)=>f.id===decodeURIComponent(pathname.split('/').at(-1)))};else if(pathname.endsWith('/lease'))data={leaseId:'lease',uploadUrl:'https://target.example',headers:{}};else if(pathname.endsWith('/complete')){const file={id:pathname.split('/')[3],status:'success',url:'https://service.example/img/confirmed'};data={file};if(server?.lostComplete){server.files.push(file);throw Error('complete response lost')}};return new Response(JSON.stringify(data),{status:200})});
 const engine=new UploadEngine(()=>{},{getToken:()=> 'test-token'});return {engine,calls,requests};
}
describe('upload engine integration',()=>{
 it('reconciles remotely completed files before resuming a stale manifest',async()=>{let puts=0;const manifest={ownerId:'alice',taskId:'task',groupId:'group',items:[{id:'local',nativeId:'native0',fileId:'f1',name:'private.png',status:'pending',progress:0}]};const {engine,calls}=environment(0,async()=>{puts++},()=>{},manifest,{files:[{id:'f1',clientId:'local',status:'success',url:'https://service.example/img/f1'}]});await engine.bindUser('alice');await engine.resume();expect(puts).toBe(0);expect(calls.some(p=>p.endsWith('/lease'))).toBe(false);expect(engine.state.items[0].status).toBe('success');expect(engine.state.items[0].url).toContain('/f1')});
 it('does not reupload a file deleted or expired on the server',async()=>{const manifest={ownerId:'alice',taskId:'task',groupId:'group',items:[{id:'local',nativeId:'native0',fileId:'f1',name:'private.png',status:'pending',progress:0}]};const {engine,calls}=environment(0,async()=>{throw Error('must not upload')},()=>{},manifest,{files:[{id:'f1',clientId:'local',status:'deleted'}]});await engine.bindUser('alice');await engine.resume();expect(calls.some(p=>p.endsWith('/lease'))).toBe(false);expect(engine.state.items[0].status).toBe('failed');expect(engine.state.items[0].error).toMatch(/删除|过期/)});
 it('recovers a lost complete response without uploading twice',async()=>{let puts=0;const {engine}=environment(1,async()=>{puts++},()=>{},undefined,{files:[],lostComplete:true});engine.setOptions({retries:0});await engine.addDesktopFiles();await engine.start('group');expect(puts).toBe(1);expect(engine.state.items[0].status).toBe('success');expect(engine.state.items[0].url).toContain('/confirmed')});
 it('keeps a restored queue hidden until its owner logs in',async()=>{const manifest={ownerId:'alice',taskId:'old',groupId:'group',items:[{id:'oldfile',name:'private.png',status:'success',progress:100}]};const first=environment(0,async()=>{},()=>{},manifest).engine;await first.bindUser('bob');expect(first.state.items).toHaveLength(0);const second=environment(0,async()=>{},()=>{},manifest).engine;await second.bindUser('alice');expect(second.state.items[0].name).toBe('private.png');await second.bindUser('');expect(second.state.items).toHaveLength(0)}); 
 it('hashes, registers, streams and confirms all files with twenty uploads maximum',async()=>{let active=0,max=0;const {engine,calls}=environment(25,async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,3));active--});await engine.addDesktopFiles();await engine.start('group');expect(max).toBe(20);expect(engine.state.items.every(i=>i.status==='success'&&i.progress===100)).toBe(true);expect(calls.filter(p=>p.endsWith('/complete'))).toHaveLength(25)});
 it('pause aborts native streams, releases leases and does not retry',async()=>{const pending=new Map<string,(error:Error)=>void>();let started=0;const {engine,calls}=environment(12,id=>{started++;return new Promise((_resolve,reject)=>pending.set(id,reject))},id=>pending.get(id)?.(Error('paused')));await engine.addDesktopFiles();const running=engine.start('group');await vi.waitFor(()=>expect(started).toBe(12));engine.pause();await running;expect(engine.state.status).toBe('paused');expect(started).toBe(12);expect(calls.filter(p=>p.endsWith('/release'))).toHaveLength(12);expect(calls.some(p=>p.endsWith('/complete'))).toBe(false);expect(calls.at(-1)).toBe('/api/uploads/activity');expect(engine.state.items.every(i=>i.status==='pending')).toBe(true)});
});




 it('uses a new run identifier to resume the same task and closes exactly the paused run',async()=>{
  const pending=new Map<string,(error:Error)=>void>();let resumed=false;const server={files:[] as any[]};
  const {engine,requests}=environment(25,id=>resumed?Promise.resolve():new Promise((_resolve,reject)=>pending.set(id,reject)),id=>pending.get(id)?.(Error('paused')),undefined,server);
  await engine.addDesktopFiles();const first=engine.start('group');await vi.waitFor(()=>expect(pending.size).toBe(20));await engine.pause();await first;
  const oldRun=requests.find(r=>r.pathname==='/api/uploads/activity'&&r.body.active===true)!.body.runId;
  expect(oldRun).toBeTruthy();expect(requests.filter(r=>r.pathname.endsWith('/lease')).every(r=>r.body.runId===oldRun)).toBe(true);
  expect(requests.at(-1)!.body).toEqual({active:false,runId:oldRun});
  server.files=engine.state.items.filter(item=>item.fileId).map(item=>({id:item.fileId,clientId:item.id,status:'pending'}));
  resumed=true;await engine.resume();
  const runs=requests.filter(r=>r.pathname==='/api/uploads/activity'&&r.body.active===true).map(r=>r.body.runId);
  expect(new Set(runs).size).toBe(2);expect(requests.filter(r=>r.pathname==='/api/tasks')).toHaveLength(1);
  expect(engine.state.items.every(item=>item.status==='success')).toBe(true);
 });

 it('continues through the legacy lease API when an older backend has no activity endpoint',async()=>{
  const {engine,requests}=environment(1,async()=>{});
  const original=fetch;
  vi.stubGlobal('fetch',async(input:any,options:any)=>new URL(String(input)).pathname==='/api/uploads/activity'
    ?new Response(JSON.stringify({error:'Not found'}),{status:404}):original(input,options));
  await engine.addDesktopFiles();await engine.start('group');
  expect(engine.state.status).toBe('completed');expect(engine.state.items[0].status).toBe('success');
  expect(requests.find(r=>r.pathname.endsWith('/lease'))!.body).toEqual({});
 });
