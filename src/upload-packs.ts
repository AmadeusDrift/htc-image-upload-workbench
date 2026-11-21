import type {QueueItem} from './upload';

export const PACK_FILE_LIMIT = 12;
export const PACK_BYTE_LIMIT = 24 * 1024 * 1024;

/** Read only the next group. A checkpointed boundary survives later additions to the queue. */
export function nextPack(items:QueueItem[], offset:number) {
 const first=items[offset];
 const members=[first];
 let size=first.size;
 while(members.length<PACK_FILE_LIMIT && offset+members.length<items.length){
  const candidate=items[offset+members.length];
  if(first.packKey ? candidate.packKey!==first.packKey : !!candidate.packKey)break;
  if(size+candidate.size>PACK_BYTE_LIMIT)break;
  members.push(candidate);
  size+=candidate.size;
 }
 if(first.packKey && members.some((item,index)=>item.packPosition!==index || first.id!==first.packKey))
  throw Error('本地图片包清单不完整，请重新读取原任务');
 return members;
}

export function packedDemand(items:QueueItem[],offset:number,limit:number){
 let lanes=0;
 while(offset<items.length&&lanes<limit){
  offset+=nextPack(items,offset).length;
  lanes++;
 }
 return lanes;
}

// Estimate the number of packs this device consumes during a preparation cycle.
// Overlapping PUT intervals share airtime. Exclude idle time waiting for more work.
export class PackLookahead {
 private uploads:{start:number;end:number}[]=[];
 private preparationMs:number[]=[];
 private nextSample=0;
 private goal=2;
 private lowSamples=0;

 recordPut(start:number,end:number){
  this.uploads=this.uploads.filter(put=>put.end>end-6000);
  this.uploads.push({start,end});
 }

 recordPreparation(ms:number){
  this.preparationMs.push(ms);
  if(this.preparationMs.length>24)this.preparationMs.shift();
 }

 target(now:number){
  if(now<this.nextSample)return this.goal;
  this.nextSample=now+2000;
  const begin=now-6000;
  this.uploads=this.uploads.filter(put=>put.end>begin);
  const recent=[...this.uploads].sort((a,b)=>a.start-b.start);
  let covered=0, packs=0, last=begin;
  for(const put of recent){
   const left=Math.max(begin,put.start);
   covered+=Math.max(0,put.end-Math.max(last,left));
   packs+=(put.end-left)/Math.max(1,put.end-put.start);
   last=Math.max(last,put.end);
  }
  if(covered<400||!this.preparationMs.length)return this.goal;
  const sorted=[...this.preparationMs].sort((a,b)=>a-b);
  const predicted=1+packs*sorted[Math.ceil(sorted.length*.75)-1]/covered;
  const desired=Math.max(2,Math.min(8,Math.ceil(predicted)));
  if(desired>this.goal){
   this.goal=Math.min(desired,this.goal+2);
   this.lowSamples=0;
  }else if(desired<this.goal&&predicted<Math.max(1.9,(this.goal-1)*.8)){
   if(++this.lowSamples>=2){this.goal--;this.lowSamples=0;}
  }else this.lowSamples=0;
  return this.goal;
 }
}
