import {createRequire} from 'node:module';
import {describe,it,expect,vi} from 'vitest';
const require=createRequire(import.meta.url);
const {createUploadGate}=require('../electron/native-upload.cjs');
describe('native pending upload cancellation',()=>{
 it('pause during source validation prevents any stream from starting',async()=>{const gate=createUploadGate();let resume:any,started=0;const pending=gate.run('file',()=>new Promise(r=>resume=r),async()=>{started++});gate.slots.get('file').destroy(Error('paused'));resume({});await expect(pending).rejects.toThrow('paused');expect(started).toBe(0);expect(gate.slots.size).toBe(0)});
 it('reserves twenty slots atomically before asynchronous source validation',async()=>{const gate=createUploadGate();const releases:any[]=[];const pending=Array.from({length:20},(_,i)=>gate.run('f'+i,()=>new Promise(r=>releases.push(r)),async()=>{}));await expect(gate.run('twenty-first',async()=>({}),async()=>{})).rejects.toThrow('20');expect(gate.slots.size).toBe(20);for(const release of releases)release({});await Promise.all(pending);expect(gate.slots.size).toBe(0)});
});
it('aborts source validation immediately even if the source never responds',async()=>{const gate=createUploadGate();const pending=gate.run('file',()=>new Promise(()=>{}),async()=>{throw Error('must not transfer')});let rejected=false;void pending.catch(()=>rejected=true);gate.slots.get('file').destroy(Error('paused'));await new Promise(r=>setTimeout(r,10));expect(rejected).toBe(true);expect(gate.slots.size).toBe(0)});
it('bounds native validation and releases its slot when the source hangs',async()=>{const gate=createUploadGate(5,new Map(),5);await expect(gate.run('file',()=>new Promise(()=>{}),async()=>{throw Error('must not transfer')})).rejects.toThrow(/源文件读取超时/);expect(gate.slots.size).toBe(0)});

it('bounds source validation separately from an already running upload',async()=>{
 vi.useFakeTimers();
 try{
  const gate=createUploadGate(5,new Map(),15000);
  let finish!:()=>void;
  const operation=gate.run('file',async()=>({}),()=>new Promise<void>(resolve=>finish=resolve));
  const outcome=operation.then(()=> 'complete',()=> 'timed out');
  await vi.advanceTimersByTimeAsync(65000);
  finish();
  expect(await outcome).toBe('complete');
 }finally{vi.useRealTimers()}
});
