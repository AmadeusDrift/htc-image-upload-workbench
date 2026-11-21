export interface NativeFile {id:string;name:string;relativePath:string;size:number;contentType:string;originalSize?:number;compressed?:boolean;compressionNote?:string}
export interface DesktopTask {id:string;name:string;paths:string[];groupId:string;groupNumber:number;completed:number;bytesDone:number;lastGroup?:boolean;finished?:boolean;remoteId?:string;ticket?:string}
export interface DesktopImport {id:string;name:string;paths:string[]}
export interface UpdateState {
 status:'idle'|'checking'|'available'|'downloading'|'ready'|'error'|'unsupported'|'installing';
 currentVersion:string;version?:string;percent?:number;error?:string;busy:boolean;
}
export type NativeUploadResult={ok:true}|{ok:false;error:{kind:string;message:string;status?:number;retryAfter?:number}};
export interface NativePack {
 id:string;size:number;sha256:string;
 entries:{id:string;offset:number;size:number;sha256:string}[];
}
export interface PackSpoolStats {
 bytes:number;peakBytes:number;packs:number;peakPacks:number;
 reservedBytes:number;peakReservedBytes:number;outstanding:number;peakOutstanding:number;
}
export interface DesktopAPI {
 selectImport?(owner:string,kind:'files'|'folders'|'drop',recurse:boolean,files?:File[]):Promise<DesktopImport|undefined>;
 discardImport?(owner:string,id:string):Promise<void>;
 enqueueImport?(owner:string,id:string,name:string,groupId:string,targetId?:string):Promise<DesktopTask[]>;
 listWork?(owner:string):Promise<DesktopTask[]>;
 renameWork?(owner:string,id:string,name:string):Promise<DesktopTask[]>;
 openWorkGroup?(owner:string):Promise<{worklist:DesktopTask[];files:NativeFile[];recovered?:boolean}>;
 stopWorkScan?(owner:string):Promise<void>;
 finishWorkGroup?(owner:string,id:string,ticket:string,taskId:string):Promise<DesktopTask[]>;
 removeWork?(owner:string,id:string):Promise<DesktopTask[]>;
 getUpdateState?():Promise<UpdateState>;
 checkForUpdates?():Promise<UpdateState>;
 installUpdate?():Promise<UpdateState>;
 onUpdateStateChanged?(callback:(state:UpdateState)=>void):()=>void;
 getWindowState():Promise<{maximized:boolean}>;
 minimizeWindow():Promise<void>;toggleMaximize():Promise<{maximized:boolean}>;closeWindow():Promise<void>;
 onWindowStateChanged(callback:(state:{maximized:boolean})=>void):()=>void;
 notifyCompletion?(success:number,failed:number):Promise<void>;
 getConfig():Promise<{apiBase:string;deviceId:string}>;
 chooseFiles():Promise<NativeFile[]>;chooseFolder(recurse?:boolean):Promise<NativeFile[]>;resolveDropped(files:File[],recurse?:boolean):Promise<NativeFile[]>;
 prepareImage(id:string,options:{enabled:boolean;quality:number}):Promise<NativeFile & {originalSize:number;compressed:boolean;compressionNote?:string}>;abortPreparation(id:string):Promise<boolean>;releasePrepared(ids:string[]):Promise<{released:number}>;
 preparePack?(key:string,nativeIds:string[],quota:number):Promise<NativePack>;
 releasePack?(key:string):Promise<boolean>;
 getPackSpoolStats?():Promise<PackSpoolStats>;
 hashFile(id:string):Promise<string>;abortHash?(id:string):Promise<boolean>;upload(options:{fileId:string;url:string;headers:Record<string,string>;deadlineAt?:number}):Promise<void|NativeUploadResult>;abortUpload(id:string):Promise<boolean>;
 onUploadProgress(callback:(progress:{fileId:string;loaded:number;total:number})=>void):()=>void;
 saveManifest(data:unknown):Promise<boolean>;saveManifestPatch?(data:unknown):Promise<number>;loadManifest():Promise<any>;loadUserManifest?(ownerId:string):Promise<any>;
 flushManifest():Promise<boolean>;setUploadActive(active:boolean):Promise<boolean>;
 onPrepareClose(callback:()=>Promise<void>):()=>void;
}
declare global {interface Window {desktop?:DesktopAPI}}
