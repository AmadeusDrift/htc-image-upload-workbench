const fs=require('node:fs');
const path=require('node:path');
const ITEM_STATUSES=new Set(['pending','hashing','uploading','success','failed','cancelled']);
const MAX_BYTES=50*1024*1024;
function text(value,label,max,optional=false){
 if(optional&&value===undefined)return undefined;
 if(typeof value!=='string'||value.length>max||(!optional&&!value.length)||value.includes('\0'))throw Error('上传进度格式无效：'+label);
 return value;
}
function normalizeManifest(input,getSource){
 if(!input||typeof input!=='object'||Array.isArray(input)||input.schemaVersion!==undefined&&input.schemaVersion!==1||!Array.isArray(input.items)||input.items.length>20000)throw Error('上传进度格式无效');
 const ownerId=text(input.ownerId??'','员工标识',150,true);
 const seen=new Set(),referenced=new Map();
 const items=input.items.map(item=>{
  if(!item||typeof item!=='object')throw Error('上传进度格式无效：文件');
  const id=text(item.id,'文件标识',150);if(seen.has(id))throw Error('上传进度格式无效：重复文件标识');seen.add(id);
  if(!Number.isSafeInteger(item.size)||item.size<1||item.size>MAX_BYTES||!Number.isFinite(item.progress)||item.progress<0||item.progress>100||!ITEM_STATUSES.has(item.status)||!['image/jpeg','image/png','image/webp'].includes(item.contentType))throw Error('上传进度格式无效：文件大小或状态');
  const output={id,name:text(item.name,'文件名',512),relativePath:text(item.relativePath,'相对目录',4096),size:item.size,contentType:item.contentType,status:item.status,progress:item.progress};
  if(item.originalSize!==undefined){if(!Number.isSafeInteger(item.originalSize)||item.originalSize<1||item.originalSize>MAX_BYTES)throw Error('上传进度格式无效：原图大小');output.originalSize=item.originalSize}
  if(item.compressed!==undefined){if(typeof item.compressed!=='boolean'||item.compressed&&(item.contentType!=='image/jpeg'||!item.originalSize||item.originalSize<item.size))throw Error('上传进度格式无效：压缩标记');output.compressed=item.compressed}
  if(item.compressionNote!==undefined)output.compressionNote=text(item.compressionNote,'压缩说明',512,true);
  for(const field of ['fileId','nativeId'])if(item[field]!==undefined)output[field]=text(item[field],field,150);
  if(item.sha256!==undefined){if(typeof item.sha256!=='string'||!/^[a-f\d]{64}$/i.test(item.sha256))throw Error('上传进度格式无效：SHA256');output.sha256=item.sha256}
  if(item.url!==undefined){text(item.url,'图片链接',4096);const url=new URL(item.url);if(url.protocol!=='https:'||url.username||url.password||url.searchParams.has('X-Amz-Signature'))throw Error('上传进度格式无效：图片链接');output.url=url.href}
  if(output.nativeId){const source=getSource(output.nativeId);if(!source||typeof source.path!=='string'||source.path.length>32768||!path.isAbsolute(source.path)||source.path.includes('\0')||source.size!==output.size||!Number.isFinite(source.mtimeMs)||source.mtimeMs<0)throw Error('上传进度缺少可信的源文件记录，请重新选择图片');referenced.set(output.nativeId,{id:output.nativeId,path:source.path,size:source.size,mtimeMs:source.mtimeMs,...(source.preparedImage===true?{preparedImage:true}:{})})}
  return output;
 });
 return {schemaVersion:1,ownerId,taskId:text(input.taskId,'任务标识',150,true),clientTaskId:text(input.clientTaskId,'客户端任务标识',150,true),groupId:text(input.groupId,'业务账号标识',150,true),items,sources:[...referenced.values()]};
}
function parseManifest(raw){
 const input=JSON.parse(raw);const sources=new Map();
 if(!Array.isArray(input.sources)||input.sources.length>20000)throw Error('上传进度格式无效：源文件清单');
 for(const source of input.sources){if(!source||typeof source.id!=='string'||sources.has(source.id))throw Error('上传进度格式无效：源文件标识');sources.set(source.id,source)}
 return normalizeManifest(input,id=>sources.get(id));
}
function createManifestStore(file,trustedHandles,{io=fs.promises}={}){
 let pending=null,running=null,scheduled=false,version=0,lastFailure=null;
 const waiters=[];
 async function readValid(target){
  let raw;try{raw=await io.readFile(target,'utf8')}catch(error){if(error.code==='ENOENT')return {missing:true};throw error}
  try{if(Buffer.byteLength(raw)>128*1024*1024)throw Error('上传进度文件过大');return {manifest:parseManifest(raw),raw}}catch(error){return {invalid:true,error}}
 }
 async function atomicWrite(target,raw){
  const temporary=target+'.tmp';await io.writeFile(temporary,raw,'utf8');
  const handle=await io.open(temporary,'r+');try{await handle.sync()}finally{await handle.close()}
  await io.rename(temporary,target);
 }
 async function write(snapshot){
  await io.mkdir(path.dirname(file),{recursive:true});
  const previous=await readValid(file);const raw=JSON.stringify(snapshot);
  if(previous.manifest)await atomicWrite(file+'.bak',JSON.stringify(previous.manifest));
  else {const backup=await readValid(file+'.bak');if(!backup.manifest)await atomicWrite(file+'.bak',raw)}
  await atomicWrite(file,raw);
 }
 function settle(upTo,error){for(let i=waiters.length-1;i>=0;i--)if(waiters[i].version<=upTo){const waiter=waiters.splice(i,1)[0];error?waiter.reject(error):waiter.resolve(true)}}
 function start(){
  scheduled=false;if(running)return running;
  running=(async()=>{while(pending){const current=pending;pending=null;try{await write(current.snapshot);lastFailure=null;settle(current.version)}catch(error){lastFailure=error;settle(current.version,error)}}})();
  const completion=running;void completion.then(()=>{if(running===completion)running=null;if(pending)start()});return completion;
 }
 return {
  save(input){let snapshot;try{snapshot=normalizeManifest(input,id=>trustedHandles.get(id))}catch(error){return Promise.reject(error)}const current=++version;pending={snapshot,version:current};const promise=new Promise((resolve,reject)=>waiters.push({version:current,resolve,reject}));if(!running&&!scheduled){scheduled=true;queueMicrotask(start)}return promise},
  async flush(){while(pending||running){if(!running)start();await running}if(lastFailure)throw lastFailure;return true},
  async load(){const primary=await readValid(file);if(primary.manifest)return primary.manifest;const backup=await readValid(file+'.bak');if(backup.manifest)return {...backup.manifest,recoveryWarning:'上传进度主文件缺失或损坏，已从上一份备份恢复；最近进度将与服务器重新核对。'};if(primary.missing&&backup.missing)return null;throw Error('上传进度文件和备份均已损坏，无法自动恢复。请保留日志并重新选择原图片文件夹。')}
 };
}
function deadline(promise,ms,label){let timer;return Promise.race([promise,new Promise((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(label)),ms)})]).finally(()=>clearTimeout(timer))}
function createCloseCoordinator({isActive,confirm,prepare,abort,flush,confirmFailure,close,timeoutMs=5000}){
 let inFlight=null,approved=false;
 const coordinator={get approved(){return approved},request(){
  if(approved)return Promise.resolve(true);if(inFlight)return inFlight;
  inFlight=(async()=>{if(isActive()&&!await confirm())return false;let failure;
   try{await deadline(Promise.resolve().then(prepare),timeoutMs,'界面未及时保存最新进度；仅能保留主进程已收到的进度。')}catch(error){failure=error}
   abort();try{await deadline(Promise.resolve().then(flush),timeoutMs,'磁盘写入未及时完成；最近上传进度可能未保存。')}catch(error){failure=error}
   if(failure&&!await confirmFailure(failure))return false;
   approved=true;close();return true;
  })().finally(()=>{inFlight=null});return inFlight;
 }};return coordinator;
}
module.exports={createManifestStore,createCloseCoordinator,normalizeManifest,parseManifest};




