const {contextBridge,ipcRenderer,webUtils}=require('electron');
let prepareCloseHandler;
ipcRenderer.on('prepare-close',async(_event,data)=>{let error;try{if(!prepareCloseHandler)throw Error('界面尚未准备好保存最新进度。');await prepareCloseHandler()}catch(failure){error=String(failure?.message||failure).slice(0,1000)}await ipcRenderer.invoke('ready-to-close',{id:data.id,error}).catch(()=>{})});
contextBridge.exposeInMainWorld('desktop',Object.freeze({
 getConfig:()=>ipcRenderer.invoke('config'),
 getUpdateState:()=>ipcRenderer.invoke('update-state'),
 checkForUpdates:()=>ipcRenderer.invoke('update-check'),
 installUpdate:()=>ipcRenderer.invoke('update-install'),
 onUpdateStateChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('update-state-changed',listener);return()=>ipcRenderer.removeListener('update-state-changed',listener)},
 getWindowState:()=>ipcRenderer.invoke('window-state'),
 minimizeWindow:()=>ipcRenderer.invoke('window-minimize'),
 toggleMaximize:()=>ipcRenderer.invoke('window-toggle-maximize'),
 closeWindow:()=>ipcRenderer.invoke('window-close'),
 onWindowStateChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('window-state-changed',listener);return()=>ipcRenderer.removeListener('window-state-changed',listener)},
 notifyCompletion:(success,failed)=>ipcRenderer.invoke('notify-completion',success,failed),
 chooseFiles:()=>ipcRenderer.invoke('choose-files'),
 chooseFolder:recurse=>ipcRenderer.invoke('choose-folder',recurse),
 resolveDropped:(files,recurse)=>ipcRenderer.invoke('dropped',Array.from(files).map(f=>webUtils.getPathForFile(f)).filter(Boolean),recurse),
 hashFile:id=>ipcRenderer.invoke('hash',id),
 abortHash:id=>ipcRenderer.invoke('abort-hash',id),
 prepareImage:(id,options)=>ipcRenderer.invoke('prepare-image',id,options),
 abortPreparation:id=>ipcRenderer.invoke('abort-preparation',id),
 releasePrepared:ids=>ipcRenderer.invoke('release-prepared',ids),
 upload:options=>ipcRenderer.invoke('upload',options),
 abortUpload:id=>ipcRenderer.invoke('abort',id),
 saveManifest:data=>ipcRenderer.invoke('manifest-save',data),
 saveManifestPatch:data=>ipcRenderer.invoke('manifest-save-patch',data),
 loadManifest:()=>ipcRenderer.invoke('manifest-load'),
 loadUserManifest:ownerId=>ipcRenderer.invoke('manifest-load-user',ownerId),
 flushManifest:()=>ipcRenderer.invoke('manifest-flush'),
 setUploadActive:active=>ipcRenderer.invoke('upload-active',active),
 onPrepareClose:callback=>{prepareCloseHandler=callback;return()=>{if(prepareCloseHandler===callback)prepareCloseHandler=undefined}},
 onUploadProgress:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('upload-progress',listener);return()=>ipcRenderer.removeListener('upload-progress',listener)}
}));
