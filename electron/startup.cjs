const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
async function loadDeviceId(directory,io=fs.promises,uuid=crypto.randomUUID){
 await io.mkdir(directory,{recursive:true});const devicePath=path.join(directory,'device-id');
 const valid=value=>typeof value==='string'&&!!value.trim()&&value.length<=120&&!/[\u0000-\u001f]/.test(value);
 let existing,missing=false;try{existing=(await io.readFile(devicePath,'utf8')).trim()}catch(error){if(error.code!=='ENOENT')throw error;missing=true}
 if(valid(existing))return existing;
 const id=uuid();if(!valid(id))throw Error('设备标识初始化失败，请重新启动软件');
 try{await io.writeFile(devicePath,id,{encoding:'utf8',flag:missing?'wx':'w'});return id}catch(error){if(error.code!=='EEXIST')throw error;const current=(await io.readFile(devicePath,'utf8')).trim();if(!valid(current))throw Error('设备标识初始化失败，请完全退出软件后重试');return current}
}
function focusWindow(window){if(!window||window.isDestroyed())return;if(window.isMinimized())window.restore();window.show();window.focus()}
async function startDesktop({app,createWindow,log,fail,getWindow}){
 if(!app.requestSingleInstanceLock()){log('secondary-instance-exit');app.quit();return false}
 let window;
 app.on('second-instance',()=>{log('second-instance-focus');focusWindow(window||getWindow?.())});
 app.on('activate',()=>focusWindow(window||getWindow?.()));
 try{await app.whenReady();log('app-ready');window=await createWindow();focusWindow(window);log('window-visible');return true}catch(error){fail(error);return false}
}
function installDiagnostics(app,dialog){
 let logPath;let reported=false;
 try{const directory=app.getPath('userData');fs.mkdirSync(directory,{recursive:true});logPath=path.join(directory,'startup.log')}catch{logPath=path.join(app.getPath('temp'),'yuntu-startup.log')}
 const log=(stage,detail)=>{try{fs.appendFileSync(logPath,JSON.stringify({time:new Date().toISOString(),pid:process.pid,stage,detail:detail instanceof Error?detail.stack:detail})+'\n')}catch{}};
 const fail=error=>{log('fatal',error instanceof Error?error:Error(String(error)));if(reported)return;reported=true;try{dialog.showErrorBox('云图工作台启动失败','软件未能正常启动。请将诊断日志提供给管理员。\n\n日志：'+logPath+'\n\n错误：'+(error?.message||String(error)))}catch{}app.quit()};
 process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
 app.on('child-process-gone',(_event,detail)=>log('child-process-gone',{type:detail.type,reason:detail.reason,exitCode:detail.exitCode}));
 log('process-start',{version:app.getVersion(),electron:process.versions.electron,arch:process.arch,packaged:app.isPackaged});
 return {log,fail,logPath};
}
module.exports={loadDeviceId,startDesktop,installDiagnostics};

