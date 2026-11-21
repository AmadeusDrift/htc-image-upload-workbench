import type {QueueItem,UploadState} from './upload';

export const CHECKPOINT_PAGE_SIZE=100;
type CheckpointMode='all'|'one'|'progress'|number;
type Layout={
 items:QueueItem[]; key:string; saved:number; positions:Map<QueueItem,number>;
 dirty:Set<number>; indexed:number; header?:string;
};

export class UploadCheckpoint {
 private layout?:Layout;
 private chain:Promise<unknown>=Promise.resolve();

 restore(items:QueueItem[], data?:{checkpointKey?:string;savedCount?:number}) {
  this.layout=undefined;
  if(data?.checkpointKey && typeof data.savedCount==='number' && data.savedCount<=items.length){
   this.layout={items,key:data.checkpointKey,saved:data.savedCount,positions:new Map(),dirty:new Set(),indexed:0};
  }
 }

 private index(items:QueueItem[]) {
  if(this.layout?.items!==items){
   this.layout={items,key:crypto.randomUUID(),saved:0,positions:new Map(),dirty:new Set(),indexed:0};
  }
  const layout=this.layout;
  while(layout.indexed<items.length){
   layout.positions.set(items[layout.indexed],layout.indexed);
   layout.indexed++;
  }
  return layout;
 }

 mark(items:QueueItem[], item:QueueItem) {
  if(this.layout?.items!==items)return;
  const position=this.layout.positions.get(item);
  if(position!==undefined)this.layout.dirty.add(position);
 }

 through(items:QueueItem[], batch:QueueItem[]) {
  const {positions}=this.index(items);
  return Math.max(0,...batch.map(item=>(positions.get(item)??-1)+1));
 }

 needsSeed(items:QueueItem[]) {
  return (this.layout?.items===items?this.layout.saved:0)<items.length;
 }

 write(ownerId:string,state:UploadState,mode:CheckpointMode,save:(data:unknown)=>Promise<number>,current:()=>boolean) {
  const operation=this.chain.then(async()=>{
   if(!current())return;
   const layout=this.index(state.items);
   const {items}=layout;
   const limit=mode==='all'?items.length:mode==='one'?Math.min(items.length,layout.saved+CHECKPOINT_PAGE_SIZE)
    :mode==='progress'?layout.saved:Math.min(items.length,mode);
   const meta={
    ownerId,batchMode:state.batchMode,transportMode:state.transportMode,taskId:state.taskId,clientTaskId:state.clientTaskId,groupId:state.groupId,groupTicket:state.groupTicket,
   };
   const expected=items.length+(state.missingCheckpointItems??0);
   const header=JSON.stringify({expected,meta});
   while(current()){
    const positions=Array.from(layout.dirty).filter(position=>position<layout.saved).slice(0,CHECKPOINT_PAGE_SIZE);
    for(let i=layout.saved;i<limit&&positions.length<CHECKPOINT_PAGE_SIZE;i++)positions.push(i);
    if(!positions.length&&layout.header===header)break;
    positions.sort((a,b)=>a-b);
    const changes=positions.map(position=>{
     const {previewUrl:_preview,...item}=items[position];
     return {position,item};
    });
    for(const position of positions)layout.dirty.delete(position);
    try{
     const saved=await save({key:layout.key,expected,meta,changes});
     if(!Number.isInteger(saved)||saved<layout.saved||saved>items.length||
      positions.some(position=>position>=saved))throw Error('本地清单保存回执不完整');
     layout.saved=saved;
     layout.header=header;
    }catch(error){
     for(const position of positions)layout.dirty.add(position);
     throw error;
    }
    if(mode==='one')break;
   }
  });
  this.chain=operation.catch(()=>{});
  return operation;
 }
}
