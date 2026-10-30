import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
const require=createRequire(import.meta.url);
const {createUploadGate}=require('../electron/native-upload.cjs');
describe('native pending upload cancellation',()=>{
 it('pause during source validation prevents any stream from starting',async()=>{const gate=createUploadGate();let resume:any,started=0;const pending=gate.run('file',()=>new Promise(r=>resume=r),async()=>{started++});gate.slots.get('file').destroy(Error('paused'));resume({});await expect(pending).rejects.toThrow('paused');expect(started).toBe(0);expect(gate.slots.size).toBe(0)});
 it('reserves five slots atomically before asynchronous source validation',async()=>{const gate=createUploadGate();const releases:any[]=[];const pending=Array.from({length:5},(_,i)=>gate.run('f'+i,()=>new Promise(r=>releases.push(r)),async()=>{}));await expect(gate.run('sixth',async()=>({}),async()=>{})).rejects.toThrow('5');expect(gate.slots.size).toBe(5);for(const release of releases)release({});await Promise.all(pending);expect(gate.slots.size).toBe(0)});
});
it('aborts source validation immediately even if the source never responds',async()=>{const gate=createUploadGate();const pending=gate.run('file',()=>new Promise(()=>{}),async()=>{throw Error('must not transfer')});let rejected=false;void pending.catch(()=>rejected=true);gate.slots.get('file').destroy(Error('paused'));await new Promise(r=>setTimeout(r,10));expect(rejected).toBe(true);expect(gate.slots.size).toBe(0)});
it('bounds native validation and releases its slot when the source hangs',async()=>{const gate=createUploadGate(5,new Map(),5);await expect(gate.run('file',()=>new Promise(()=>{}),async()=>{throw Error('must not transfer')})).rejects.toThrow(/60 秒/);expect(gate.slots.size).toBe(0)});
