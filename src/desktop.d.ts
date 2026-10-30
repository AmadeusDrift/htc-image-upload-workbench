export interface NativeFile {id:string;name:string;relativePath:string;size:number;contentType:string;originalSize?:number;compressed?:boolean;compressionNote?:string}
export interface DesktopAPI {
 getWindowState():Promise<{maximized:boolean}>;
 minimizeWindow():Promise<void>;toggleMaximize():Promise<{maximized:boolean}>;closeWindow():Promise<void>;
 onWindowStateChanged(callback:(state:{maximized:boolean})=>void):()=>void;
 notifyCompletion?(success:number,failed:number):Promise<void>;
 getConfig():Promise<{apiBase:string;deviceId:string}>;
 chooseFiles():Promise<NativeFile[]>;chooseFolder(recurse?:boolean):Promise<NativeFile[]>;resolveDropped(files:File[],recurse?:boolean):Promise<NativeFile[]>;
 prepareImage(id:string,options:{enabled:boolean;quality:number}):Promise<NativeFile & {originalSize:number;compressed:boolean;compressionNote?:string}>;abortPreparation(id:string):Promise<boolean>;releasePrepared(ids:string[]):Promise<{released:number}>;
 hashFile(id:string):Promise<string>;upload(options:{fileId:string;url:string;headers:Record<string,string>}):Promise<void>;abortUpload(id:string):Promise<boolean>;
 onUploadProgress(callback:(progress:{fileId:string;loaded:number;total:number})=>void):()=>void;
 saveManifest(data:unknown):Promise<boolean>;loadManifest():Promise<any>;
 flushManifest():Promise<boolean>;setUploadActive(active:boolean):Promise<boolean>;
 onPrepareClose(callback:()=>Promise<void>):()=>void;
}
declare global {interface Window {desktop?:DesktopAPI}}







