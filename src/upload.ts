import type {NativeFile} from './desktop';
import {startUploadClock,storageFailure,transferDeadline,uploadFailure} from '../electron/upload-policy.mjs';
import { UploadSpeed, type UploadTelemetry } from './upload-telemetry';
import { CHECKPOINT_PAGE_SIZE, UploadCheckpoint } from './upload-checkpoint';

const MAX_UPLOAD_SLOTS = 20;
type BatchGrant = {fileId:string; leaseId:string; uploadUrl:string; headers:Record<string,string>; expiresAt?:string};
type BatchSlots = Pick<UploadTelemetry,'quota'|'globalUsed'|'globalLimit'|'uploadingDevices'>;
type QueuedUpload = {item:QueueItem; attempts:number; readyAt:number; signatureRefreshed?:boolean};
type ActiveUpload = {phase:'transferring'|'confirming'; loaded:number};
export type ItemStatus='pending'|'hashing'|'uploading'|'success'|'failed'|'cancelled';
export interface QueueItem {id:string;name:string;relativePath:string;size:number;contentType:string;status:ItemStatus;progress:number;error?:string;previewUrl?:string;url?:string;fileId?:string;nativeId?:string;sha256?:string;blocked?:boolean}
export interface UploadState {items:QueueItem[];status:'idle'|'scanning'|'ready'|'uploading'|'paused'|'completed'|'cancelled'|'error';taskId?:string;clientTaskId?:string;persistenceError?:string;error?:string;groupId?:string;batchMode?:'chunked-v1';telemetry?:UploadTelemetry;missingCheckpointItems?:number}
function aborted(signal:AbortSignal){if(signal.aborted)throw new DOMException('已暂停','AbortError')}
async function bounded<T>(operation:()=>Promise<T>,signal:AbortSignal|undefined,ms:number,message:string):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;let stop:(()=>void)|undefined;
 const limit=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);if(signal){stop=()=>reject(new DOMException('已暂停','AbortError'));if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true})}});
 try{if(signal)aborted(signal);return await Promise.race([Promise.resolve().then(()=>{if(signal)aborted(signal);return operation()}),limit])}finally{clearTimeout(timer);if(stop)signal?.removeEventListener('abort',stop)}
}
export function wait(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{aborted(signal);const stop=()=>{clearTimeout(timer);reject(new DOMException('已暂停','AbortError'))};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve()},ms);signal.addEventListener('abort',stop,{once:true})})}
function isRetryable(error:unknown) {
 const value=error as {status?:number; retryable?:boolean; name?:string};
 const status=Number(value?.status);
 return value?.retryable!==false && value?.name!=='AbortError'
  && (!(status>=400 && status<500) || status===408 || status===429);
}
function retryDelay(error:any,attempt:number,base=750){
 const retryAfter=Number(error?.retryAfter);
 return error?.status===429||error?.status===503&&retryAfter>0
  ?Math.min(30000,Math.max(1000,(retryAfter||2)*1000))
  :base*2**attempt;
}
function expiredSignature(error:unknown){
 return (error as {kind?:string})?.kind==='signature-expired';
}
export async function retryOperation<T>(operation:()=>Promise<T>,retries:number,signal:AbortSignal,delay=750):Promise<T>{
 for(let attempt=0;;attempt++){
  aborted(signal);
  try{return await operation()}
  catch(error){
   aborted(signal);
   if(attempt>=retries||!isRetryable(error))throw error;
   await wait(retryDelay(error,attempt,delay),signal);
  }
 }
}
export async function runLimited<T>(items:T[],operation:(item:T)=>Promise<void>,signal:AbortSignal,limit=5){let cursor=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(!signal.aborted&&cursor<items.length){const item=items[cursor++];await operation(item)}}))}
export class UploadEngine {
 state:UploadState={items:[],status:'idle'};
 private ownerEpoch=0;private ownerId='';private restored:any;private restoreReady:Promise<void>=Promise.resolve();private files=new Map<string,File>();private controller?:AbortController;private running=false;private options={retries:3,scanSubfolders:true,checkDuplicates:true,notify:true,batchUpload:false};private apiBase='';private deviceId='';private generation=0;
 private speed?:UploadSpeed;
 private checkpoint=new UploadCheckpoint();
 private checkpointFailure?:unknown;
 private transfers = new Map<QueueItem,ActiveUpload>();
 private nativeTransfers = new Map<string,QueueItem>();
 private selectionEpoch=0;private uiTimer?:ReturnType<typeof setTimeout>;private persistTimer?:ReturnType<typeof setTimeout>;private persistDirty=false;private saveInFlight?:Promise<void>;private drain?:Promise<void>;private resolveDrain?:()=>void;
 constructor(private callback:(state:UploadState)=>void,private config:{apiBase?:string;deviceId?:string;getToken?:()=>string|null}={}){
  if(typeof window!=='undefined'&&window.desktop){window.desktop.onUploadProgress(({fileId,loaded,total})=>{const item=this.speed ? this.nativeTransfers.get(fileId) : this.state.items.find(i=>i.nativeId===fileId);if(item&&item.status==='uploading')this.progress(item,loaded,total)});this.restoreReady=bounded(()=>window.desktop!.loadManifest(),undefined,8000,'本地任务读取超时，请检查磁盘状态').then(data=>{this.restored=data;if(data?.recoveryWarning)this.state.persistenceError=data.recoveryWarning}).catch(e=>{this.restored=null;this.state.persistenceError=String(e);this.emit(false,true)});window.desktop.onPrepareClose?.(async()=>{await this.pause();await this.flushManifest()})}
 }
 async bindUser(userId:string){
  const binding=++this.ownerEpoch;await this.restoreReady;if(binding!==this.ownerEpoch||this.ownerId===userId)return;this.selectionEpoch++;await this.pause();if(binding!==this.ownerEpoch)return;
  const desktop=typeof window!=='undefined'?window.desktop:undefined;
  if(desktop?.loadUserManifest){
   try{
    // pause() is best effort for close/pause controls; switching owners requires
    // a durable current checkpoint before native storage may replace it.
    if(this.ownerId)await this.flushManifest();
    if(binding!==this.ownerEpoch)return;
    if(userId){const checkpoint=await bounded(()=>desktop.loadUserManifest!(userId),undefined,8000,'本地任务读取超时，请检查磁盘状态');if(binding!==this.ownerEpoch)return;this.restored=checkpoint}
    else this.restored=undefined;
   }catch(error){if(binding!==this.ownerEpoch)return;this.state.persistenceError='本地任务切换失败：'+String(error);this.emit(false,true);throw error}
  }else if(userId&&this.restored===undefined&&desktop){
   try{const checkpoint=await bounded(()=>window.desktop!.loadManifest(),undefined,8000,'本地任务读取超时，请检查磁盘状态');if(binding!==this.ownerEpoch)return;this.restored=checkpoint}
   catch(error){if(binding!==this.ownerEpoch)return;this.restored=null;this.state.persistenceError=String(error)}
  }
  this.generation++;clearTimeout(this.uiTimer);for(const i of this.state.items)if(i.previewUrl)URL.revokeObjectURL(i.previewUrl);this.files.clear();const warning=this.state.persistenceError;this.ownerId=userId;
  if(userId&&this.restored?.ownerId===userId){const data=this.restored;this.state={...data,status:'paused',items:(data.items||[]).map((i:QueueItem)=>({...i,status:i.status==='success'?'success':'pending'})),persistenceError:data.recoveryWarning||warning}}else this.state={items:[],status:'idle',persistenceError:warning};const loaded=this.restored?.ownerId===userId?this.restored:undefined;
  if(loaded?.expectedCount>this.state.items.length)
   this.state.missingCheckpointItems=loaded.expectedCount-this.state.items.length;
  this.checkpoint.restore(this.state.items,loaded);
  this.checkpointFailure=undefined;
  this.restored=undefined;const migrated=this.splitFinishedBatch();this.emit(migrated,true);
 }
 private emit(persist=true,immediate?:boolean){
  const large=this.state.items.length>=1000;
  const publish=()=>{this.uiTimer=undefined;this.callback({...this.state,items:this.state.items.map(item=>({...item}))})};
  if(immediate??(persist&&!large)){clearTimeout(this.uiTimer);publish()}else if(!this.uiTimer)this.uiTimer=setTimeout(publish,large?250:100);
  if(persist&&typeof window!=='undefined'&&window.desktop){
   this.persistDirty=true;
   if(window.desktop.saveManifestPatch)this.scheduleCheckpoint(this.checkpoint.needsSeed(this.state.items)?0:large?1000:250);
   else if(!this.persistTimer)this.persistTimer=setTimeout(()=>{this.persistTimer=undefined;void this.flushManifest().catch(()=>{})},large?1000:250);
  }
 }
 private scheduleCheckpoint(delay:number) {
  if(!this.ownerId || this.persistTimer || this.checkpointFailure)return;
  this.persistTimer=setTimeout(async()=>{
   this.persistTimer=undefined;
   try {
    await this.writeCheckpoint('one');
    if(this.checkpoint.needsSeed(this.state.items))this.scheduleCheckpoint(0);
   } catch {}
  },delay);
 }

 private async writeCheckpoint(mode:'all'|'one'|'progress'|number) {
  const desktop=window.desktop;
  if(!desktop?.saveManifestPatch || !this.ownerId)return;
  const state=this.state,owner=this.ownerId;
  try {
   await this.checkpoint.write(owner,state,mode,
    data=>bounded(()=>desktop.saveManifestPatch!(data),undefined,8000,'本地清单写入超时'),
    ()=>this.state===state&&this.ownerId===owner);
   if(this.state===state&&!this.checkpointFailure&&state.persistenceError){
    state.persistenceError=undefined;
    this.emit(false,true);
   }
  } catch(error) {
   if(this.state===state){
    this.checkpointFailure=error;
    state.persistenceError='本地任务保存失败：'+String(error);
    this.emit(false,true);
   }
   throw error;
  }
 }

 private markCheckpoint(item:QueueItem) { this.checkpoint.mark(this.state.items,item); }

 private async saveThrough(batch:QueueItem[]) {
  if(window.desktop?.saveManifestPatch){
   if(this.checkpointFailure)throw this.checkpointFailure;
   await this.writeCheckpoint(this.checkpoint.through(this.state.items,batch));
  }else await this.flushManifest();
 }

 async flushManifest():Promise<void>{
  const desktop=typeof window!=='undefined'?window.desktop:undefined;if(!desktop)return;clearTimeout(this.persistTimer);this.persistTimer=undefined;
  if(desktop.saveManifestPatch){
   await this.writeCheckpoint('all');
   this.checkpointFailure=undefined;
   this.state.persistenceError=undefined;
   if(desktop.flushManifest)await bounded(()=>desktop.flushManifest!(),undefined,8000,'本地任务保存超时，请检查磁盘状态');
   return;
  }
  if(!this.ownerId){this.persistDirty=false;if(this.saveInFlight)await this.saveInFlight;if(desktop.flushManifest)await bounded(()=>desktop.flushManifest!(),undefined,8000,'本地任务保存超时，请检查磁盘状态');return}
  this.persistDirty=true;if(this.saveInFlight)return this.saveInFlight;
  this.saveInFlight=(async()=>{do{while(this.persistDirty){this.persistDirty=false;const {telemetry: _live,...checkpoint}=this.state;const snapshot={...checkpoint,ownerId:this.ownerId,items:this.state.items.map(({previewUrl,...item})=>({...item}))};await bounded(()=>desktop.saveManifest(snapshot),undefined,8000,'本地任务保存超时，请检查磁盘状态')}this.state.persistenceError=undefined;if(desktop.flushManifest)await bounded(()=>desktop.flushManifest!(),undefined,8000,'本地任务保存超时，请检查磁盘状态')}while(this.persistDirty)})().catch(e=>{this.state.persistenceError='本地任务保存失败：'+String(e);this.emit(false,true);throw e}).finally(()=>{this.saveInFlight=undefined});return this.saveInFlight;
 }
 setOptions(options:Partial<typeof this.options>){this.options={...this.options,...options,retries:Math.max(0,Math.min(3,options.retries??this.options.retries))}}
 private async init(){
  if(this.apiBase)return;const desktop=typeof window!=='undefined'?window.desktop:undefined;const native=desktop?await desktop.getConfig():undefined;
  const valid=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=120&&!/[\u0000-\u001f]/.test(value);
  if(desktop&&!valid(this.config.deviceId??native?.deviceId))throw Object.assign(Error('本机设备标识异常，请完全退出软件后重新打开；仍失败请更新软件'),{retryable:false});
  const base=this.config.apiBase||native?.apiBase||location.origin;const parsed=new URL(base);if(desktop&&(parsed.protocol!=='https:'||parsed.username||parsed.password))throw Object.assign(Error('本机服务地址异常，请更新软件'),{retryable:false});
  let device=this.config.deviceId||native?.deviceId;if(!desktop&&!valid(device)){device=localStorage.getItem('yuntu-device');if(!valid(device)){device=crypto.randomUUID();localStorage.setItem('yuntu-device',device)}}
  this.apiBase=base.replace(/\/$/,'');this.deviceId=device!;
 }
 private async api(path:string,body?:unknown,signal?:AbortSignal):Promise<any>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;const token=this.config.getToken?.()??sessionStorage.getItem('yuntu-token');const stop=()=>controller.abort(signal?.reason);if(signal?.aborted)stop();else signal?.addEventListener('abort',stop,{once:true});
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{reject(Error('上传服务连接超时，请稍后重试'));controller.abort()},(/\/(fail|release)$/.test(path)||path==='/uploads/activity'&&(body as any)?.active===false)?3000:15000)});
  const cancelled=new Promise<never>((_resolve,reject)=>{if(controller.signal.aborted)reject(new DOMException('已暂停','AbortError'));else controller.signal.addEventListener('abort',()=>reject(new DOMException('已暂停','AbortError')),{once:true})});
  const request=async()=>{await this.init();aborted(controller.signal);const res=await fetch(this.apiBase+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+(token||''),'X-Device-Id':this.deviceId},body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal});const data=await res.json().catch(()=>({}));if(!res.ok)throw Object.assign(Error(data.error||'请求失败 '+res.status),{status:res.status,retryAfter:Number(res.headers.get('Retry-After')||2)});return data};
  try{return await Promise.race([request(),deadline,cancelled])}finally{clearTimeout(timer);signal?.removeEventListener('abort',stop)}
 }
 private control(path:string,body:unknown,signal:AbortSignal){return retryOperation(()=>this.api(path,body,signal),this.options.retries,signal)}
 private newBatch(items:QueueItem[]=[]){const keep=new Set(items.map(item=>item.id));for(const item of this.state.items)if(!keep.has(item.id)){if(item.previewUrl)URL.revokeObjectURL(item.previewUrl);this.files.delete(item.id)}this.state={items,status:'ready',persistenceError:this.state.persistenceError}}
 private splitFinishedBatch(){if(this.state.missingCheckpointItems||this.state.batchMode==='chunked-v1')return false;const registered=this.state.items.filter(item=>item.fileId),fresh=this.state.items.filter(item=>!item.fileId);if(this.state.taskId&&registered.length&&fresh.length&&registered.every(item=>item.status==='success')){this.newBatch(fresh);return true}return false}
 private addNative(files:NativeFile[]){
  if(!files.length)return;
  const missing=this.state.missingCheckpointItems??0;
  if(!missing&&this.state.items.length&&this.state.items.every(item=>item.status==='success'))this.newBatch();
  const previousCount=this.state.items.length;
  const seen=this.options.checkDuplicates||missing?new Set(this.state.items.map(item=>JSON.stringify([item.relativePath,item.size]))):undefined;
  for(const file of files){const key=JSON.stringify([file.relativePath,file.size]);if(seen?.has(key))continue;seen?.add(key);this.state.items.push({...file,id:crypto.randomUUID(),nativeId:file.id,status:'pending',progress:0})}
  if(missing)this.state.missingCheckpointItems=Math.max(0,missing-(this.state.items.length-previousCount));
  this.state.status='ready';this.emit();
 }
 async addDesktopFolder(){if(this.running)return;const epoch=this.selectionEpoch,previous=this.state.status;this.state.status='scanning';this.emit(false);try{const files=await window.desktop!.chooseFolder(this.options.scanSubfolders);if(epoch===this.selectionEpoch){if(files.length)this.addNative(files);else{this.state.status=previous;this.emit(false,true)}}}catch(e){if(epoch===this.selectionEpoch){this.state.status='error';this.state.error=String(e);this.emit()}}}
 async addDesktopFiles(){if(this.running)return;const epoch=this.selectionEpoch;const files=await window.desktop!.chooseFiles();if(epoch===this.selectionEpoch)this.addNative(files)}
 async addDesktopDropped(files:File[]){if(this.running)return;const epoch=this.selectionEpoch;const selected=await window.desktop!.resolveDropped(files,this.options.scanSubfolders);if(epoch===this.selectionEpoch)this.addNative(selected)}
 addBrowserFiles(files:File[]){if(this.running)return;files=files.filter(file=>/\.(jpe?g|png|webp)$/i.test(file.name)&&file.size>0&&file.size<=50*1024*1024&&(this.options.scanSubfolders||(file.webkitRelativePath||file.name).split('/').length<=2));if(!files.length)return;if(this.state.items.length&&this.state.items.every(item=>item.status==='success'))this.newBatch();const seen=this.options.checkDuplicates?new Set(this.state.items.map(item=>JSON.stringify([item.relativePath,item.size]))):undefined;for(const file of files){if(!/\.(jpe?g|png|webp)$/i.test(file.name)||file.size<1||file.size>50*1024*1024)continue;const relativePath=file.webkitRelativePath||file.name;if(!this.options.scanSubfolders&&relativePath.split('/').length>2)continue;const key=JSON.stringify([relativePath,file.size]);if(seen?.has(key))continue;seen?.add(key);const id=crypto.randomUUID();this.files.set(id,file);this.state.items.push({id,name:file.name,relativePath,size:file.size,contentType:file.type||(/\.png$/i.test(file.name)?'image/png':/\.webp$/i.test(file.name)?'image/webp':'image/jpeg'),status:'pending',progress:0,previewUrl:URL.createObjectURL(file)})}this.state.status='ready';this.emit()}
 private async hash(item:QueueItem,signal:AbortSignal){
  if(item.sha256)return item.sha256;
  const desktop=window.desktop;
  if(item.nativeId&&desktop){
   const id=item.nativeId;
   let stopped:Promise<unknown>|undefined;
   const stop=()=>stopped??=(desktop.abortHash?.(id)??desktop.abortUpload(id)).catch(()=>{});
   signal.addEventListener('abort',stop,{once:true});
   try{return await bounded(()=>desktop.hashFile(id),signal,60000,'图片读取超时，请检查源文件')}
   catch(error){void stop();throw error}
   finally{signal.removeEventListener('abort',stop)}
  }
  const file=this.files.get(item.id);
  if(!file)throw Error('请重新选择源文件');
  return bounded(async()=>{
   const bytes=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
   return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
  },signal,60000,'图片读取超时，请检查源文件');
 }
 private applyRemote(item:QueueItem,file:any){
  item.blocked=false;if(file.status==='success'&&typeof file.url==='string'&&(file.url.startsWith('https://')||file.url.startsWith('http://'))){if(item.status!=='success'||item.url!==file.url)this.markCheckpoint(item);item.status='success';item.progress=100;item.url=file.url;item.error=undefined;return true}if(file.status==='deleted'||file.status==='expired'){this.markCheckpoint(item);item.status='failed';item.progress=0;item.url=undefined;item.blocked=true;item.error=file.status==='deleted'?'服务器文件已删除，请清空队列后重新选择图片':'服务器文件已过期，请清空队列后重新选择图片'}return false}
 private async reconcile(signal:AbortSignal){
  const byId=new Map<string,any>(),byClientId=new Map<string,any>(),seenCursors=new Set<string>();let cursor:string|undefined;
  do{
   const query=new URLSearchParams({limit:'500'});if(cursor)query.set('cursor',cursor);
   const data=await this.control('/tasks/'+this.state.taskId+'?'+query.toString(),undefined,signal);aborted(signal);
   if(!Array.isArray(data.files))throw Error('任务文件清单响应异常，请稍后重试');
   for(const file of data.files){if(typeof file.id==='string')byId.set(file.id,file);if(typeof file.clientId==='string')byClientId.set(file.clientId,file)}
   const next=data.nextCursor;if(next!==undefined&&next!==null&&typeof next!=='string')throw Error('任务分页响应异常，请稍后重试');
   if(next&&seenCursors.has(next))throw Error('任务分页游标重复，请稍后重试');if(next)seenCursors.add(next);cursor=next||undefined;
  }while(cursor);
  for(const item of this.state.items){const file=(item.fileId?byId.get(item.fileId):undefined)||byClientId.get(item.id);if(file){if(item.fileId!==file.id)this.markCheckpoint(item);item.fileId=file.id;this.applyRemote(item,file)}else if(item.fileId){this.markCheckpoint(item);item.status='failed';item.blocked=true;item.error='服务器文件记录不存在，请清空队列后重新选择图片'}}this.emit();
 }
 private async recoverCompleted(item:QueueItem,signal:AbortSignal){const data=await this.control('/files/'+item.fileId,undefined,signal);aborted(signal);if(data.file&&this.applyRemote(item,data.file)){this.emit(true,false);return true}return false}
 private async uploadItem(item:QueueItem,signal:AbortSignal,runId?:string){
  let signatureRefreshed=false;
  try{
   await retryOperation(async()=>{
    for(;;){
     let lease:any;
     let confirming=false;
     try{
      for(;;){
       aborted(signal);
       try{lease=await this.api('/files/'+item.fileId+'/lease',runId?{runId}:{},signal);break}
       catch(error:any){if(error.status!==429)throw error;await wait(retryDelay(error,0),signal)}
      }
      aborted(signal);item.status='uploading';item.progress=0;this.emit(false);
      await this.put(item,lease,signal);aborted(signal);
      confirming=true;
      const done=await this.api('/files/'+item.fileId+'/complete',{leaseId:lease.leaseId},signal);
      if(!done.file||!this.applyRemote(item,done.file))
       throw Object.assign(Error(item.error||'服务器尚未确认图片上传成功，请重试'),{retryable:false});
      this.emit(true,false);
      return;
     }catch(error){
      if(confirming&&!signal.aborted){
       try{if(await this.recoverCompleted(item,signal))return}catch{}
      }
      const refresh=!signal.aborted&&expiredSignature(error)&&!signatureRefreshed;
      if(lease)await this.api('/files/'+item.fileId+(signal.aborted||refresh?'/release':'/fail'),{
       leaseId:lease.leaseId,error:String(error),
      }).catch(()=>{});
      if(refresh){signatureRefreshed=true;continue}
      throw error;
     }
    }
   },this.options.retries,signal);
  }catch(error){
   if(signal.aborted){item.status='pending';item.progress=0}
   else{item.status='failed';item.error=String(error)}
   this.emit(true,false);
  }finally{this.markCheckpoint(item)}
 }

 private async put(item:QueueItem,lease:BatchGrant,signal:AbortSignal):Promise<void>{
  aborted(signal);
  const deadlineAt=transferDeadline(item.size,lease.expiresAt);
  if(deadlineAt<=Date.now())throw uploadFailure('signature-expired','上传签名已过期');
  const desktop=window.desktop;
  if(item.nativeId&&desktop){
   const id=item.nativeId;
   let stopped:Promise<unknown>|undefined;
   const stop=()=>stopped??=desktop.abortUpload(id).catch(()=>{});
   signal.addEventListener('abort',stop,{once:true});
   try{
    const result=await bounded(()=>desktop.upload({fileId:id,url:lease.uploadUrl,headers:lease.headers||{},deadlineAt}),
     signal,deadlineAt-Date.now(),'图片上传达到本次传输时限，请重试');
    aborted(signal);
    if(typeof result==='object'&&result?.ok===false){
     const {kind,message,status,retryAfter}=result.error;
     throw uploadFailure(kind,message,status,retryAfter);
    }
   }catch(error){
    await bounded(stop,undefined,3000,'停止上传超时').catch(()=>{});
    // Older preload/test doubles may still reject an Error instead of returning the envelope.
    const legacyStatus=String(error).match(/上传返回\s+([1-5]\d{2})\b/)?.[1];
    throw legacyStatus?storageFailure(Number(legacyStatus)):error;
   }finally{signal.removeEventListener('abort',stop)}
   return;
  }
  const file=this.files.get(item.id);
  if(!file)throw uploadFailure('local','请重新选择源文件');
  return new Promise((resolve,reject)=>{
   const xhr=new XMLHttpRequest();
   let settled=false,loaded=0;
   const clock=startUploadClock(deadlineAt,(error:Error)=>{finish(error);xhr.abort()});
   const stop=()=>{finish(new DOMException('已暂停','AbortError'));xhr.abort()};
   function finish(error?:Error){
    if(settled)return;
    settled=true;
    clock.stop();
    signal.removeEventListener('abort',stop);
    error?reject(error):resolve();
   }
   try{
    xhr.open('PUT',lease.uploadUrl);
    Object.entries(lease.headers||{}).forEach(([key,value])=>xhr.setRequestHeader(key,String(value)));
    xhr.upload.onprogress=event=>{
     if(event.loaded>loaded){loaded=event.loaded;clock.activity()}
     if(event.lengthComputable)this.progress(item,event.loaded,event.total);
    };
    xhr.upload.onload=()=>clock.activity();
    xhr.onreadystatechange=()=>{if(xhr.readyState===2)clock.activity()};
    xhr.onprogress=event=>{if(event.loaded>0)clock.activity()};
    xhr.onload=()=>finish(xhr.status>=200&&xhr.status<300?undefined:
     xhr.status?storageFailure(xhr.status,xhr.responseText,xhr.getResponseHeader?.('Retry-After')):
      uploadFailure('network','网络上传失败，请重试'));
    xhr.onerror=()=>finish(uploadFailure('network','网络上传失败，请重试'));
    xhr.onabort=()=>finish(new DOMException('已暂停','AbortError'));
    signal.addEventListener('abort',stop,{once:true});
    if(signal.aborted){stop();return}
    xhr.send(file);
   }catch{finish(uploadFailure('local','无法发起存储上传，请检查上传地址或请求参数'))}
  });
 }
 private progress(item:QueueItem,loaded:number,total:number) {
  const transfer = this.transfers.get(item);
  if (transfer?.phase==='transferring' && loaded>transfer.loaded) {
   this.speed?.add(loaded-transfer.loaded);
   transfer.loaded=loaded;
  }
  item.progress=Math.min(99,Math.round(loaded/Math.max(1,total)*100));
  this.emit(false);
 }

 private preparing(waiting:number) {
  this.state.telemetry = {
   ...this.state.telemetry,quota:this.state.telemetry?.quota??null,
   transferring:0,confirming:0,waiting,retrying:0,bytesPerSecond:0,phase:'preparing',
  };
  this.emit(false);
 }

 private async transferGranted(
  entry:QueuedUpload, grant:BatchGrant, queue:QueuedUpload[], signal:AbortSignal,
  update:()=>void,
 ) {
  const {item} = entry;
  const transfer:ActiveUpload = {phase:'transferring',loaded:0};
  this.transfers.set(item,transfer);
  if (item.nativeId) this.nativeTransfers.set(item.nativeId,item);
  item.status='uploading';
  item.progress=0;
  update();
  try {
   await this.put(item,grant,signal);
   if (transfer.loaded<item.size) this.speed?.add(item.size-transfer.loaded);
   transfer.phase='confirming';
   update();
   const result = await this.control('/files/'+grant.fileId+'/complete',{leaseId:grant.leaseId},signal);
   if (!result.file || !this.applyRemote(item,result.file)) {
    throw Object.assign(Error(item.error||'服务器尚未确认图片上传成功'),{retryable:false});
   }
  } catch (error) {
   if (transfer.phase==='confirming'&&!signal.aborted) {
    try { if (await this.recoverCompleted(item,signal)) return; } catch {}
   }
   const refresh=!signal.aborted&&expiredSignature(error)&&!entry.signatureRefreshed;
   await this.api('/files/'+grant.fileId+(signal.aborted||refresh?'/release':'/fail'),{
    leaseId:grant.leaseId,error:String(error),
   }).catch(()=>{});
   if (signal.aborted) {
    item.status='pending';
    item.progress=0;
   } else if (refresh||isRetryable(error)&&entry.attempts<this.options.retries) {
    if(refresh){entry.signatureRefreshed=true;entry.readyAt=Date.now()}
    else entry.readyAt=Date.now()+retryDelay(error,entry.attempts++);
    item.status='pending';
    item.progress=0;
    queue.push(entry);
   } else {
    item.status='failed';
    item.error=String(error);
   }
  } finally {
   this.markCheckpoint(item);
   this.transfers.delete(item);
   if(item.nativeId)this.nativeTransfers.delete(item.nativeId);
   this.emit(true,false);
  }
 }

 private async preparePage(batch:QueueItem[],signal:AbortSignal) {
  aborted(signal);
  if(window.desktop?.saveManifestPatch)await this.saveThrough(batch);
  aborted(signal);
  await runLimited(batch,async item=>{
   try{
    aborted(signal);
    if(!item.fileId){item.status='hashing';this.emit(false);item.sha256=await this.hash(item,signal)}
    aborted(signal);
    item.status='pending';
   }catch(error){if(signal.aborted){item.status='pending';item.progress=0}else{item.status='failed';item.error=String(error)}}
   this.markCheckpoint(item);
  },signal);
  aborted(signal);
  if(this.checkpointFailure)throw this.checkpointFailure;
  const unregistered=batch.filter(item=>!item.fileId&&item.status!=='failed');
  if(unregistered.length){
   const data=await this.control('/tasks/'+this.state.taskId+'/files',{files:unregistered.map(item=>({
    clientId:item.id,name:item.name,relativePath:item.relativePath,size:item.size,
    contentType:item.contentType,sha256:item.sha256,
   }))},signal);
   aborted(signal);
   if(!Array.isArray(data.files))throw Error('文件登记响应异常，请重试当前任务');
   const byClientId=new Map<string,any>(data.files.map((file:any)=>[file.clientId,file]));
   for(const item of unregistered){
    const file=byClientId.get(item.id);
    if(!file||typeof file.id!=='string'||!file.id)throw Error('部分图片尚未确认登记，请重试当前任务');
    item.fileId=file.id;
    this.applyRemote(item,file);
    this.markCheckpoint(item);
   }
   this.emit();
   if(window.desktop?.saveManifestPatch)await this.writeCheckpoint('progress');
   else await this.flushManifest();
  }
  aborted(signal);
  if(this.checkpointFailure)throw this.checkpointFailure;
  return batch.filter(item=>item.fileId&&item.status!=='failed'&&item.status!=='success'&&!item.blocked);
 }

 private async uploadBatch(items:QueueItem[], pending:QueueItem[], runId:string, signal:AbortSignal) {
  const queue:QueuedUpload[] = items.map(item=>({item,attempts:0,readyAt:0}));
  const active = new Set<Promise<void>>();
  let offset=Math.min(CHECKPOINT_PAGE_SIZE,pending.length), preparing=0;
  let preparation:Promise<void>|undefined;
  let next:{items:QueueItem[]}|{error:unknown}|undefined;
  let newlyPrepared=new Set<string>();
  const remaining=()=>pending.length-offset+preparing;
  const prefetch=()=>{
   if(offset>=pending.length)return;
   const page=pending.slice(offset,offset+CHECKPOINT_PAGE_SIZE);
   offset+=page.length;
   preparing=page.length;
   preparation=this.preparePage(page,signal).then(
    ready=>{next={items:ready}},
    error=>{next={error}},
   );
  };
  prefetch();
  const speed = this.speed = new UploadSpeed();
  let slots:BatchSlots = {quota:this.state.telemetry?.quota??null};
  let nextPoll=0, blockedUntil=0, retryingControl=false;
  const publish = () => {
   if (signal.aborted) return;
   const transfers=[...this.transfers.values()];
   const confirming=transfers.filter(t=>t.phase==='confirming').length;
   const transferring=transfers.length-confirming;
   const retrying=queue.filter(entry=>entry.readyAt>Date.now()).length;
   const bytesPerSecond=speed.sample();
   this.state.telemetry={
    ...slots,transferring,confirming,waiting:queue.length+remaining(),retrying,
    bytesPerSecond:transferring?bytesPerSecond:0,
    phase:transferring?'transferring':confirming?'confirming':
     retryingControl||retrying?'retrying':!queue.length&&preparing?'preparing':'waiting',
   };
   this.emit(false);
  };
  const timer=setInterval(publish,500);
  const refill = async (fileIds:string[]) => {
   const demand=Math.min(MAX_UPLOAD_SLOTS,queue.length+active.size+remaining());
   const result=await retryOperation(async()=>{
    try{
     const response=await this.api('/tasks/'+this.state.taskId+'/upload-leases',{runId,fileIds,demand},signal);
     retryingControl=false;
     return response;
    }catch(error){
     retryingControl=isRetryable(error);
     publish();
     throw error;
    }
   },this.options.retries,signal);
   aborted(signal);
   if(this.checkpointFailure)throw this.checkpointFailure;
   slots={quota:result.quota,globalUsed:result.globalUsed,globalLimit:result.globalLimit,
    uploadingDevices:result.uploadingDevices};
   for (const unavailable of result.unavailable) {
    const index=queue.findIndex(entry=>entry.item.fileId===unavailable.fileId);
    if(index<0)continue;
    const [{item}]=queue.splice(index,1);
    if (!unavailable.file || !this.applyRemote(item,unavailable.file)) {
     item.status='failed';
     item.error='文件已过期、删除或无法继续上传';
    }
    this.markCheckpoint(item);
    newlyPrepared.delete(unavailable.fileId);
    this.emit(true,false);
   }
   for (const grant of result.grants as BatchGrant[]) {
    const index=queue.findIndex(entry=>entry.item.fileId===grant.fileId);
    if(index<0)continue;
    const [entry]=queue.splice(index,1);
    const operation=this.transferGranted(entry,grant,queue,signal,publish)
     .finally(()=>{active.delete(operation);publish()});
    active.add(operation);
    if(newlyPrepared.has(grant.fileId)){
     newlyPrepared.clear();
     prefetch();
    }
   }
   if(!newlyPrepared.size && !preparation)prefetch();
   return result.grants.length>0 || result.unavailable.length>0;
  };
  try {
   publish();
   while (queue.length || active.size || preparation) {
    aborted(signal);
    if(this.checkpointFailure)throw this.checkpointFailure;
    if(next&&'error' in next)throw next.error;
    if(next&&'items' in next&&queue.length+active.size<=MAX_UPLOAD_SLOTS){
     const prepared=next.items;
     queue.push(...prepared.map(item=>({item,attempts:0,readyAt:0})));
     newlyPrepared=new Set(prepared.map(item=>item.fileId!));
     next=undefined;
     preparation=undefined;
     preparing=0;
     if(!newlyPrepared.size)prefetch();
    }
    if(!queue.length&&!active.size){
     if(!preparation)break;
     publish();
     await preparation;
     continue;
    }
    const now=Date.now();
    const ready=queue.filter(entry=>entry.readyAt<=now).slice(0,MAX_UPLOAD_SLOTS-active.size);
    const polling=now>=nextPoll;
    const canRefill=ready.length>0 && now>=blockedUntil && active.size<(slots.quota??MAX_UPLOAD_SLOTS);
    if (polling || canRefill) {
     const candidateIds=(now>=blockedUntil?ready:[]).map(entry=>entry.item.fileId!);
     const moved=await refill(candidateIds);
     nextPoll=Date.now()+2000;
     if(candidateIds.length&&!moved)blockedUntil=Date.now()+350+Math.floor(Math.random()*300);
     publish();
     continue;
    }
    // A short coalescing window batches nearby completions into one request.
    const waitMs=ready.length&&active.size<(slots.quota??MAX_UPLOAD_SLOTS)
     ? Math.max(40,Math.min(250,blockedUntil-now)) : Math.min(250,nextPoll-now);
    if(active.size){
     await Promise.race([...active,...(preparation&&!next?[preparation]:[]),wait(waitMs,signal)]);
     if (queue.length) await wait(65,signal);
    } else await wait(waitMs,signal);
   }
  } finally {
   clearInterval(timer);
   await Promise.allSettled(active);
   await preparation;
   this.speed=undefined;
   this.transfers.clear();
   this.nativeTransfers.clear();
  }
 }

 async start(groupId:string,onlyIds?:Set<string>){if(this.running)return;if(this.state.missingCheckpointItems)throw Error('本地清单缺少 '+this.state.missingCheckpointItems+' 张，请重新选择原来的图片或文件夹');this.checkpointFailure=undefined;this.splitFinishedBatch();if(!groupId)throw Error('请选择业务账号');if(this.state.taskId&&this.state.groupId&&this.state.groupId!==groupId)throw Error('当前队列属于另一个业务账号，请先清空队列再切换上传');if(!this.state.items.length)return;this.running=true;this.drain=new Promise(resolve=>{this.resolveDrain=resolve});this.state.groupId=groupId;const generation=++this.generation;const controller=this.controller=new AbortController(),signal=controller.signal;this.state.status='uploading';this.state.error=undefined;this.emit(true,true);let uploadRunId:string|undefined=crypto.randomUUID();try{
  await bounded(async()=>{await window.desktop?.setUploadActive?.(true)},signal,5000,'软件任务状态响应超时，请重启软件');aborted(signal);
  let useBatch = this.options.batchUpload;
  if (useBatch) this.state.telemetry = {
   quota:null,transferring:0,confirming:0,waiting:0,retrying:0,bytesPerSecond:0,phase:'preparing',
  };
  const initialDemand = Math.min(MAX_UPLOAD_SLOTS,this.state.items.filter(item =>
   item.status!=='success' && !item.blocked && (!onlyIds || onlyIds.has(item.id))).length);
  try{await this.control('/uploads/activity',{
   active:true,runId:uploadRunId,...(useBatch?{demand:initialDemand}:{}),
  },signal)}catch(error:any){if(error.status===404){uploadRunId=undefined;useBatch=false}else throw error}aborted(signal);
  if(this.state.taskId){await this.reconcile(signal);if(this.splitFinishedBatch()){this.state.groupId=groupId;this.state.status='uploading';this.emit()}}
  this.state.batchMode='chunked-v1';
  if(!this.state.taskId)this.state.clientTaskId ||= crypto.randomUUID();
  this.emit();
  await this.saveThrough(this.state.items.slice(0,CHECKPOINT_PAGE_SIZE));
  aborted(signal);
  if(!this.state.taskId){
   const data=await this.control('/tasks',{groupId,clientTaskId:this.state.clientTaskId,name:'图片上传 '+new Date().toLocaleString()},signal);
   aborted(signal);
   this.state.taskId=data.task.id;
   this.emit();
   if(window.desktop?.saveManifestPatch)await this.writeCheckpoint('progress');
   else await this.flushManifest();
  }
  const pending=this.state.items.filter(item=>item.status!=='success'&&!item.blocked&&(!onlyIds||onlyIds.has(item.id)));
  if(useBatch&&uploadRunId&&pending.length){
   this.preparing(pending.length);
   const first=await this.preparePage(pending.slice(0,CHECKPOINT_PAGE_SIZE),signal);
   await this.uploadBatch(first,pending,uploadRunId,signal);
  }else{
   for(let offset=0;offset<pending.length;offset+=CHECKPOINT_PAGE_SIZE){
    const ready=await this.preparePage(pending.slice(offset,offset+CHECKPOINT_PAGE_SIZE),signal);
    await runLimited(ready,item=>{
     if(this.checkpointFailure)throw this.checkpointFailure;
     return this.uploadItem(item,signal,uploadRunId);
    },signal,MAX_UPLOAD_SLOTS);
    aborted(signal);
    if(window.desktop?.saveManifestPatch)await this.writeCheckpoint('progress');
    else await this.flushManifest();
   }
  }
  if(!signal.aborted){this.state.status=this.state.items.some(i=>i.status==='pending'||i.status==='hashing'||i.status==='uploading')?'paused':'completed';if(this.options.notify){const success=this.state.items.filter(i=>i.status==='success').length,failed=this.state.items.filter(i=>i.status==='failed').length;if(window.desktop)void window.desktop.notifyCompletion?.(success,failed);else if(typeof Notification!=='undefined'&&Notification.permission==='granted')new Notification('云图工作台',{body:'上传结束：成功 '+success+' 张，失败 '+failed+' 张'})}}
 }catch(e){if(!signal.aborted){this.state.status='error';this.state.error=String(e);this.emit(false,true)}}finally{try{if(this.apiBase)await this.api('/uploads/activity',{active:false,...(uploadRunId?{runId:uploadRunId}:{})}).catch(()=>{});if(generation===this.generation){this.state.telemetry=undefined;this.emit();await this.flushManifest().catch(()=>{});await bounded(async()=>{await window.desktop?.setUploadActive?.(false)},undefined,5000,'软件任务状态响应超时').catch(()=>{});this.emit(false,true)}}finally{this.running=false;this.resolveDrain?.();this.resolveDrain=undefined;this.drain=undefined}}}
 async pause(){this.selectionEpoch++;if(!this.running){if(this.persistTimer||this.saveInFlight)await this.flushManifest().catch(()=>{});return}this.state.status='paused';this.controller?.abort();this.emit(true,true);await this.drain}
 async resume(){if(this.running)return;await this.start(this.state.groupId!)}
 async retryFailed(){if(this.running)return;const failedIds=new Set(this.state.items.filter(i=>i.status==='failed').map(i=>i.id));for(const i of this.state.items)if(failedIds.has(i.id)){i.status='pending';i.error=undefined}await this.start(this.state.groupId!,failedIds)}
 async retryTask(taskId:string){if(taskId!==this.state.taskId)throw Error('本机未保留该任务源文件，请重新选择原图片文件夹');await this.retryFailed()}
 cancel(){this.state.status='cancelled';this.controller?.abort();this.emit(true,true)}
 clear(){this.selectionEpoch++;if(this.running){this.cancel();return}for(const i of this.state.items)if(i.previewUrl)URL.revokeObjectURL(i.previewUrl);this.files.clear();this.state={items:[],status:'idle'};this.emit()}
}
