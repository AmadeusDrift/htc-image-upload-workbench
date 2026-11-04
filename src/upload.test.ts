import {describe,it,expect} from 'vitest';
import {runLimited, retryOperation} from './upload';
describe('upload scheduler',()=>{
 it('supports twenty upload candidates while keeping hashing at five by default',async()=>{
  let active=0,max=0;
  await runLimited(Array.from({length:25}),async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--},new AbortController().signal,20);
  expect(max).toBe(20);
 });
 it('never runs more than five requests',async()=>{
  let active=0,max=0,done=0;
  await runLimited(Array.from({length:23},(_,i)=>i),async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;done++},new AbortController().signal);
  expect(max).toBe(5);expect(done).toBe(23);
 });
 it('retries three times after initial failure',async()=>{let count=0;await retryOperation(async()=>{if(++count<4)throw Error('temporary')},3,new AbortController().signal,0);expect(count).toBe(4)});
 it('cancellation stops retries and queued work',async()=>{
  const c=new AbortController();let count=0;
  await expect(retryOperation(async()=>{count++;c.abort();throw Error('failure')},3,c.signal,0)).rejects.toThrow();expect(count).toBe(1);
  let started=0;await runLimited(Array.from({length:50}),async()=>{started++;c.abort()},c.signal);expect(started).toBe(0);
 });
});
