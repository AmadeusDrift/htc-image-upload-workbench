const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {normalizeManifest}=require('./manifest.cjs');
const {createProfileManifestStore}=require('./profile-manifest.cjs');

function createLocalCheckpoint(legacyFile,handles) {
 const legacy=createProfileManifestStore(legacyFile,handles);
 const file=path.join(path.dirname(legacyFile),'upload-checkpoints.sqlite');
 let worker, nextId=0, latest, failure;
 const waiting=new Map();
 function request(method,data) {
  if(!worker){
   const instance=new Worker(path.join(__dirname,'checkpoint-worker.cjs'),{workerData:{file}});
   worker=instance;
   const stop=error=>{
    if(worker!==instance)return;
    worker=undefined;
    for(const {reject} of waiting.values())reject(error);
    waiting.clear();
   };
   instance.on('message',({id,result,error})=>{
    const job=waiting.get(id);
    if(!job)return;
    waiting.delete(id);
    if(!waiting.size)instance.unref();
    if(error)job.reject(Error(error));else job.resolve(result);
   });
   instance.on('error',stop);
   instance.on('exit',code=>stop(Error('本地清单保存线程已退出 ('+code+')')));
  }
  const id=++nextId;
  return new Promise((resolve,reject)=>{
   worker.ref();
   waiting.set(id,{resolve,reject});
   worker.postMessage({id,method,data});
  });
 }
 async function load(owner) {
  const current=await request('load',owner);
  if(!current)return owner===undefined?legacy.load():legacy.loadUserManifest(owner);
  if(current.expectedCount<=current.savedCount)return current;
  // If a one-time migration was interrupted, a compatible legacy copy can
  // still supply the untouched tail. Keep SQLite's newer rows and task state.
  let previous;
  try{previous=await legacy.loadUserManifest(current.ownerId)}catch{return current}
  if(!previous || previous.items.length!==current.expectedCount ||
   (previous.clientTaskId && previous.clientTaskId!==current.clientTaskId) ||
   (previous.taskId && previous.taskId!==current.taskId) ||
   !current.savedCount ||
   !current.items.every((item,index)=>item.id===previous.items[index]?.id))return current;
  const sources=new Map(previous.sources.map(source=>[source.id,source]));
  for(const source of current.sources)sources.set(source.id,source);
  return {...current,items:[...current.items,...previous.items.slice(current.savedCount)],sources:[...sources.values()]};
 }
 return {
  save:legacy.save,
  async savePatch(input){
   const {key,expected,meta,changes}=input??{};
   if(typeof key!=='string'||!/^[a-z0-9-]{1,80}$/i.test(key)||
    !Number.isInteger(expected)||expected<0||expected>20000||
    !Array.isArray(changes)||changes.length>100)
    throw Error('本地清单分段格式无效');
   let previous=-1;
   for(const change of changes){
    if(!change||!Number.isInteger(change.position)||change.position<=previous||change.position>=expected)
     throw Error('本地清单位置无效');
    previous=change.position;
   }
   const normalized=normalizeManifest({...meta,items:changes.map(row=>row.item)},id=>handles.get(id));
   if(!normalized.ownerId)throw Error('本地清单缺少员工标识');
   const {items,sources,...header}=normalized;
   const byNative=new Map(sources.map(source=>[source.id,source]));
   latest=request('save',{
    key,expected,meta:header,changes:items.map((item,index)=>({
     position:changes[index].position,item,source:byNative.get(item.nativeId),
    })),
   }).then(value=>{failure=undefined;return value},error=>{failure=error;throw error});
   return latest;
  },
  async flush(){
   await latest;
   if(failure)throw failure;
   return legacy.flush();
  },
  load:()=>load(),
  async loadUserManifest(owner){
   if(typeof owner!=='string'||!owner.trim()||owner.length>150||owner.includes('\0'))
    throw Error('上传进度格式无效：员工标识');
   return load(owner);
  },
 };
}
module.exports={createLocalCheckpoint};
