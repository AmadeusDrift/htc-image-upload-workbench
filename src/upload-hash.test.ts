import {createRequire} from 'node:module';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
const {createHashReader}=createRequire(import.meta.url)('../electron/hash.cjs');
describe('abortable native hashing',()=>{
 it('cancels a hash during source validation and never opens its stream',async()=>{let resolveSource:any;const stream=vi.fn(()=>Readable.from(['image']));const reader=createHashReader({source:()=>new Promise(r=>resolveSource=r),createReadStream:stream});const pending=reader.hash('file');expect(reader.jobs.size).toBe(1);reader.abort('file');await expect(pending).rejects.toThrow(/暂停/);resolveSource({path:'source.png'});await Promise.resolve();expect(stream).not.toHaveBeenCalled();expect(reader.jobs.size).toBe(0)});
 it('destroys an active stream when hashing is paused',async()=>{const stream=new Readable({read(){}});const reader=createHashReader({source:async()=>({path:'source.png'}),createReadStream:()=>stream});const pending=reader.hash('file');await vi.waitFor(()=>expect(reader.jobs.get('file')?.stream).toBe(stream));reader.abort('file');await expect(pending).rejects.toThrow(/暂停/);expect(stream.destroyed).toBe(true);expect(reader.jobs.size).toBe(0)});
 it('times out a stalled source without leaking its reservation',async()=>{const reader=createHashReader({timeoutMs:5,source:()=>new Promise(()=>{})});await expect(reader.hash('file')).rejects.toThrow(/60 秒/);expect(reader.jobs.size).toBe(0)});
 it('returns the streaming SHA256 and removes completed jobs',async()=>{const reader=createHashReader({source:async()=>({path:'source.png'}),createReadStream:()=>Readable.from(['hello','world'])});expect(await reader.hash('file')).toBe(createHash('sha256').update('helloworld').digest('hex'));expect(reader.jobs.size).toBe(0)});
});

