// Keep updater failures separate from fatal application diagnostics. No update installs on ordinary quit.
function createUpdaterController({updater,supported,currentVersion,isBusy,prepare,flush,onState=()=>{},quitAndInstall=(...args)=>updater.quitAndInstall(...args),prepareTimeoutMs=6000,flushTimeoutMs=8000}){
 let state={status:supported?'idle':'unsupported',currentVersion:String(currentVersion).slice(0,100)},checking=null,downloading=false,ready=false,reserved=false,disposed=false,started=false,timer;
 updater.autoDownload=true;updater.autoInstallOnAppQuit=false;updater.allowDowngrade=false;
 const listeners=[];
 function getState(){return {...state,busy:!!isBusy()}}
 function publish(patch){if(disposed)return;state={...state,...patch};onState(getState())}
 function failure(error){publish({status:ready?'ready':'error',error:String(error?.message||error||'更新失败').slice(0,1000)})}
 function bounded(operation,ms,label){let timeout;return Promise.race([Promise.resolve(operation),new Promise((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error(label)),ms)})]).finally(()=>clearTimeout(timeout))}
 function listen(name,handler){const guarded=(...args)=>{if(!disposed)handler(...args)};updater.on(name,guarded);listeners.push([name,guarded])}
 listen('checking-for-update',()=>{if(!ready&&!reserved)publish({status:'checking',error:undefined})});
 listen('update-available',info=>{downloading=true;publish({status:'available',version:String(info?.version||'').slice(0,100),percent:undefined,error:undefined})});
 listen('update-not-available',()=>{if(!ready&&!reserved)publish({status:'idle',version:undefined,percent:undefined,error:undefined})});
 listen('download-progress',progress=>{const percent=Number(progress?.percent);publish({status:'downloading',percent:Number.isFinite(percent)?Math.min(100,Math.max(0,percent)):0,error:undefined})});
 listen('update-downloaded',info=>{downloading=false;ready=true;publish({status:'ready',version:String(info?.version||'').slice(0,100),percent:100,error:undefined})});
 listen('error',error=>{downloading=false;failure(error);if(reserved){reserved=false}});
 function check(){
  if(disposed||!supported||reserved||ready||downloading)return Promise.resolve(getState());if(checking)return checking;
  publish({status:'checking',error:undefined});
  // Attach the background download rejection immediately: diagnostics treats unhandled rejections as fatal.
  let operation;try{operation=updater.checkForUpdates()}catch(error){failure(error);return Promise.resolve(getState())}
  checking=Promise.resolve(operation).then(result=>{if(result?.downloadPromise)void Promise.resolve(result.downloadPromise).catch(error=>{downloading=false;failure(error)});return getState()},error=>{failure(error);return getState()}).finally(()=>{checking=null});return checking;
 }
 async function install(){
  if(disposed||!supported||!ready||reserved||isBusy())return false;
  reserved=true;publish({status:'installing',error:undefined});
  try{
   await bounded(prepare(),prepareTimeoutMs,'保存界面进度超时，请稍后重试更新');if(disposed||isBusy()||!reserved)throw Error('任务仍在处理中，请稍后重启更新');
   await bounded(flush(),flushTimeoutMs,'磁盘保存超时，请稍后重试更新');if(disposed||isBusy()||!reserved)throw Error('任务仍在处理中，请稍后重启更新');
   if(quitAndInstall(false,true)===false)throw Error('安装程序未能启动，请重试更新');
   // BaseUpdater can report a missing artifact synchronously through its error event.
   return reserved;
  }catch(error){reserved=false;failure(error);return false}
 }
 return {getState,check,install,get installing(){return reserved},assertCanStart(){if(reserved)throw Error('正在准备重启更新，请稍后再开始上传')},refreshBusy(){publish({})},start(){if(started||disposed||!supported)return;started=true;void check();timer=setInterval(()=>void check(),3600000);timer.unref?.()},dispose(){disposed=true;clearInterval(timer);for(const [name,handler]of listeners)updater.removeListener(name,handler);listeners.length=0}};
}
module.exports={createUpdaterController};
