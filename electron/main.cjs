const {app,BrowserWindow,dialog,ipcMain,Notification}=require('electron');
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const crypto=require('node:crypto');
const {startDesktop,loadDeviceId,installDiagnostics}=require('./startup.cjs');
const diagnostics=installDiagnostics(app,dialog);
const config=require('../server.json');
const {validateUploadTarget,assertTrustedSender}=require('./security.cjs');
const {pathToFileURL}=require('node:url');
const trustedIndex=path.join(__dirname,'../dist/index.html');
const trustedURL=pathToFileURL(trustedIndex).href;
const {createUploadGate,uploadNativeFile,uploadIpcResult,uploadHeaders}=require('./native-upload.cjs');
const {transferDeadline,uploadFailure}=require('./upload-policy.mjs');
const {installTitlebar}=require('./titlebar.cjs');
const {createCloseCoordinator}=require('./manifest.cjs');
const {createLocalCheckpoint}=require('./checkpoint.cjs');
const {createWorkQueue}=require('./work-queue.cjs');
const {pickPaths}=require('./picker.cjs');
const {createHashReader}=require('./hash.cjs');
const {createImagePreparer}=require('./compression.cjs');
const {createPackSpool}=require('./pack-spool.cjs');
const {createUpdaterController}=require('./updater.cjs');

let uploadActive=false,rendererAvailable=true,closeCoordinator,pendingClose,updateController,nativeClosing=false,updateQuitApproved=false;
function requestClose(){if(updateController?.installing)return Promise.resolve(false);nativeClosing=true;return closeCoordinator.request().finally(()=>{nativeClosing=false;updateController?.refreshBusy()})}
function isBusy(){return nativeClosing||picking||workQueue.scanning||uploadActive||requests.size>0||hashReader.jobs.size>0||imagePreparer.jobs.size>0||packSpool.stats().outstanding>0}
async function startNativeWork(operation){updateController?.assertCanStart();try{const work=operation();updateController?.refreshBusy();return await work}finally{updateController?.refreshBusy()}}
const service=new URL(config.apiBase);if(service.protocol!=='https:')throw Error('Service requires HTTPS');
const uploadHost=config.uploadHost||'e4ae0f44249c105791d1e64969abc669.r2.cloudflarestorage.com';
const types={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
const handles=new Map(),requests=new Map();const uploadGate=createUploadGate(20,requests);let win,deviceId;
const manifestStore=createLocalCheckpoint(path.join(app.getPath('userData'),'upload-manifest.json'),handles);
const workQueue=createWorkQueue(path.join(app.getPath('userData'),'upload-worklist.sqlite'),handles);
let picking=false;
const lastPickerDirectory=new Map();
async function choosePaths(kind,owner=''){
 if(picking)throw Error('已有文件选择窗口打开');
 updateController?.assertCanStart();
 picking=true;
 updateController?.refreshBusy();
 try{
  if(process.platform==='win32'){
   const selected=await pickPaths(win,kind,app.isPackaged,lastPickerDirectory.get(owner));
   if(selected.length)lastPickerDirectory.set(owner,path.dirname(selected[0]));
   return selected;
  }
  const folder=kind==='folders';
  const result=await dialog.showOpenDialog(win,{properties:[folder?'openDirectory':'openFile','multiSelections'],...(!folder?{filters:[{name:'图片',extensions:['jpg','jpeg','png','webp']}]}:{})});
  return result.canceled?[]:result.filePaths;
 }finally{picking=false;updateController?.refreshBusy()}
}
function sender(event){assertTrustedSender(event,win,trustedURL)}
function handle(name,fn){ipcMain.handle(name,(event,...args)=>{sender(event);return fn(...args)})}
async function scan(paths,recurse=true){const files=[];const visit=async(p,root,depth=0)=>{let s;try{s=await fsp.lstat(p)}catch{return}if(s.isSymbolicLink())return;if(s.isDirectory()){if(depth>0&&!recurse)return;for(const entry of await fsp.readdir(p))await visit(path.join(p,entry),root,depth+1);return}const type=types[path.extname(p).toLowerCase()];if(!s.isFile()||!type||s.size<1||s.size>50*1024*1024)return;if(files.length>=20000)throw Error('单次最多选择 20000 张图片');const id=crypto.randomUUID();const name=path.basename(p),relativePath=path.relative(root,p).split(path.sep).join('/');handles.set(id,{path:p,size:s.size,mtimeMs:s.mtimeMs,name,relativePath,contentType:type});files.push({id,name,relativePath,size:s.size,contentType:type})};for(const p of paths){if(typeof p!=='string'||!path.isAbsolute(p))throw Error('Invalid selection');await visit(p,path.dirname(p))}return files}
async function source(id){const h=handles.get(id);if(!h)throw Error('请重新选择源文件');const s=await fsp.lstat(h.path);if(!s.isFile()||s.isSymbolicLink()||s.size!==h.size||s.mtimeMs!==h.mtimeMs)throw Error('源文件已变化，请重新选择');return h}
const hashReader=createHashReader({source});
const imagePreparer=createImagePreparer({source,handles,cacheDirectory:path.join(app.getPath('userData'),'prepared-images')});
const packSpool=createPackSpool({source,handles,directory:path.join(app.getPath('userData'),'upload-packs')});
async function packOperation(operation){
 try{return await operation()}catch(error){
  if(!error?.code)throw error;
  diagnostics.log('pack-spool-error',error);
  throw Error('无法读写临时上传包，请检查源文件、磁盘空间和缓存目录是否可用');
 }
}
async function hash(id){return hashReader.hash(id)}
async function upload(options){
 const {fileId,url,headers,deadlineAt}=options||{};
 let target;
 try{target=validateUploadTarget(url,uploadHost)}catch{throw uploadFailure('local','上传地址验证失败，请联系管理员')}
 return uploadGate.run(fileId,async()=>{
  try{return await source(fileId)}catch{throw uploadFailure('local','源文件已移动、变化或无法读取，请重新选择')}
 },async(file,slot)=>{
  const safeHeaders=uploadHeaders(file,target,headers);
  const limit=Math.min(transferDeadline(file.size),Number.isFinite(deadlineAt)?deadlineAt:Infinity);
  if(limit<=Date.now())throw uploadFailure('signature-expired','上传签名已过期');
  await uploadNativeFile({target,file,headers:safeHeaders,slot,deadlineAt:limit,onProgress:(loaded,total)=>{
   if(win&&!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('upload-progress',{fileId,loaded,total});
  }});
  if(file.temporaryPack)await packSpool.release(file.packKey,fileId).catch(error=>diagnostics.log('pack-release-after-put',error));
 });
}
startDesktop({app,log:diagnostics.log,fail:diagnostics.fail,getWindow:()=>win,createWindow:async()=>{
 app.setAppUserModelId('com.yuntu.workbench');
 await packSpool.initialize().catch(error=>diagnostics.log('pack-startup-cleanup',error));
 deviceId=await loadDeviceId(app.getPath('userData'));diagnostics.log('device-ready',{type:typeof deviceId,length:deviceId.length});
 win=new BrowserWindow({frame:false,width:1440,height:940,minWidth:1080,minHeight:720,title:'云图工作台',icon:path.join(__dirname,'../assets/app.ico'),backgroundColor:'#f3f7fd',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
 installTitlebar(win,handle);
 diagnostics.log('window-created');
 win.once('ready-to-show',()=>{diagnostics.log('ready-to-show');win.show();win.focus()});
 win.webContents.on('did-fail-load',(_event,code,description,_url,isMainFrame)=>{if(isMainFrame)diagnostics.log('main-load-failed',{code,description})});
 win.webContents.on('render-process-gone',(_event,detail)=>{rendererAvailable=false;diagnostics.log('renderer-crashed',detail);if(closeCoordinator)void requestClose().catch(error=>diagnostics.log('close-error',error));else diagnostics.fail(Error('界面进程退出：'+detail.reason))});
 win.on('unresponsive',()=>diagnostics.log('window-unresponsive'));
 win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
 win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 handle('config',()=>({apiBase:service.origin,deviceId}));
 handle('notify-completion',(success,failed)=>{if(Number.isSafeInteger(success)&&Number.isSafeInteger(failed)&&success>=0&&failed>=0&&Number.isSafeInteger(success+failed)&&Notification.isSupported())new Notification({title:'云图工作台',icon:path.join(__dirname,'../assets/app.png'),body:'上传结束：成功 '+success+' 张，失败 '+failed+' 张'}).show()});
 handle('choose-files',async()=>scan(await choosePaths('files')));
 handle('choose-folder',async(recurse=true)=>scan(await choosePaths('folders'),recurse===true));
 handle('select-import',async(owner,kind,recurse,paths)=>{
  if(!['drop','files','folders'].includes(kind))throw Error('素材选择类型无效');
  const selected=kind==='drop'?paths:await choosePaths(kind,owner);
  if(!Array.isArray(selected))throw Error('素材选择无效');
  return workQueue.stage(owner,selected,kind,recurse===true);
 });
 handle('discard-import',(owner,id)=>workQueue.discard(owner,id));
 handle('enqueue-import',(...args)=>workQueue.enqueue(...args));
 handle('list-work',(owner)=>workQueue.list(owner));
 handle('rename-work',(...args)=>workQueue.rename(...args));
 handle('open-work-group',owner=>startNativeWork(()=>workQueue.open(owner)));
 handle('stop-work-scan',owner=>workQueue.stop(owner));
 handle('finish-work-group',(...args)=>workQueue.finish(...args));
 handle('remove-work',(...args)=>workQueue.clear(...args));
 handle('dropped',(paths,recurse=true)=>{if(!Array.isArray(paths)||paths.length>20000)throw Error('Invalid selection');return scan(paths,recurse===true)});
 handle('hash',id=>startNativeWork(()=>hash(id)));handle('upload',options=>startNativeWork(()=>uploadIpcResult(()=>upload(options))));
 handle('abort-hash',id=>hashReader.abort(id));
 handle('abort',id=>{requests.get(id)?.destroy(Error('上传已暂停'));return true});
 handle('prepare-image',(id,options)=>startNativeWork(()=>imagePreparer.prepare(id,options)));
 handle('abort-preparation',id=>imagePreparer.abort(id));
 handle('release-prepared',ids=>imagePreparer.release(ids));
 handle('prepare-pack',(key,ids,quota)=>startNativeWork(()=>packOperation(()=>packSpool.prepare(key,ids,quota))));
 handle('release-pack',key=>packOperation(()=>packSpool.release(key)).finally(()=>updateController?.refreshBusy()));
 handle('pack-spool-stats',()=>packSpool.stats());
 handle('manifest-save',data=>manifestStore.save(data));
 handle('manifest-save-patch',data=>manifestStore.savePatch(data));
 handle('manifest-flush',()=>manifestStore.flush());
 handle('upload-active',active=>{
  if(typeof active!=='boolean')throw Error('Invalid active flag');
  if(active)updateController?.assertCanStart();
  uploadActive=active;
  updateController?.refreshBusy();
  if(active)return true;
  return packOperation(()=>packSpool.clear()).then(()=>true).finally(()=>updateController?.refreshBusy());
 });
 async function visibleManifest(data){
  if(!data)return null;
  if(data.groupTicket){
   const [head]=await workQueue.list(data.ownerId);
   if(head?.ticket!==data.groupTicket)
    return {ownerId:data.ownerId,groupTicket:data.groupTicket,items:[]};
  }
  const {sources,...visible}=data;
  const itemsByNative=new Map(data.items.filter(item=>item.nativeId).map(item=>[item.nativeId,item]));
  for(const source of sources){
   const item=itemsByNative.get(source.id)||{};
   handles.set(source.id,{path:source.path,size:source.size,mtimeMs:source.mtimeMs,preparedImage:source.preparedImage===true,name:item.name,relativePath:item.relativePath,contentType:item.contentType,originalSize:item.originalSize,compressed:item.compressed,compressionNote:item.compressionNote});
  }
  if(data.recoveryWarning)diagnostics.log('manifest-recovered',data.recoveryWarning);
  return visible;
 }
 handle('manifest-load',async()=>visibleManifest(await manifestStore.load()));
 handle('manifest-load-user',async ownerId=>visibleManifest(await manifestStore.loadUserManifest(ownerId)));
 handle('ready-to-close',data=>{if(!pendingClose||!data||data.id!==pendingClose.id)return false;const pending=pendingClose;pendingClose=undefined;clearTimeout(pending.timer);if(data.error)pending.reject(Error(String(data.error).slice(0,1000)));else pending.resolve();return true});
 function prepareRendererClose(){
  if(!rendererAvailable||win.webContents.isDestroyed())return Promise.reject(Error('界面进程已退出，仅能保留主进程已收到的最近进度；尚未提交的界面状态无法恢复。'));
  return new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{if(pendingClose?.id===id)pendingClose=undefined;reject(Error('界面未及时确认保存完成，仅能保留主进程已收到的最近进度。'))},5000);pendingClose={id,timer,resolve,reject};win.webContents.send('prepare-close',{id})});
 }
 closeCoordinator=createCloseCoordinator({
  isActive:()=>picking||workQueue.scanning||uploadActive||requests.size>0||hashReader.jobs.size>0||imagePreparer.jobs.size>0||packSpool.stats().outstanding>0,
  confirm:async()=>{const result=await dialog.showMessageBox(win,{type:'question',buttons:['继续使用','暂停并退出'],defaultId:0,cancelId:0,message:'上传任务仍在处理，确定暂停并退出？',detail:'软件会暂停处理、释放上传名额，并保存已提交的上传进度。'});return result.response===1},
  prepare:prepareRendererClose,
  abort:()=>{for(const request of requests.values())request.destroy(Error('应用退出'));for(const id of hashReader.jobs.keys())hashReader.abort(id,Error('应用退出'));imagePreparer.abortAll();uploadActive=false},
  flush:async()=>{await Promise.all([packSpool.clear(),imagePreparer.drain(),manifestStore.flush()])},
  confirmFailure:async error=>{diagnostics.log('close-persistence-warning',error);const result=await dialog.showMessageBox(win,{type:'warning',buttons:['取消退出','仍然退出'],defaultId:0,cancelId:0,message:'最近进度未能完整保存',detail:String(error.message||error)+'\n\n取消退出可保留当前窗口继续处理。仍然退出后，未保存的最新进度可能需要重新核对。'});return result.response===1},
  close:()=>win.close(),
 });
 const {autoUpdater}=require('electron-updater');
 updateController=createUpdaterController({updater:autoUpdater,supported:app.isPackaged&&process.platform==='win32',currentVersion:app.getVersion(),isBusy,
  prepare:prepareRendererClose,
  flush:async()=>{await Promise.all([packSpool.clear(),imagePreparer.drain(),manifestStore.flush()])},
  onState:state=>{if(state.status!=='installing')updateQuitApproved=false;if(!win.isDestroyed()&&!win.webContents.isDestroyed())win.webContents.send('update-state-changed',state)},
  // Bypass normal close only after strict persistence succeeds; the coordinator's close would quit too early.
  quitAndInstall:(...args)=>{updateQuitApproved=true;try{const result=autoUpdater.quitAndInstall(...args);if(result===false)updateQuitApproved=false;return result}catch(error){updateQuitApproved=false;throw error}},
 });
 handle('update-state',()=>updateController.getState());handle('update-check',()=>updateController.check());handle('update-install',async()=>{await updateController.install();return updateController.getState()});
 win.on('closed',()=>updateController.dispose());
 win.on('close',event=>{if(updateQuitApproved||closeCoordinator.approved)return;event.preventDefault();void requestClose().catch(error=>diagnostics.log('close-error',error))});
 diagnostics.log('load-index');await win.loadFile(trustedIndex);diagnostics.log('index-loaded');updateController.start();return win;
}});app.on('window-all-closed',()=>app.quit());
