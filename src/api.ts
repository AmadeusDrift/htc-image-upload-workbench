let config:Promise<{apiBase:string,deviceId:string}>|undefined;
async function getConfig(){
 if(!config) config=(async()=>{
  const desktop=(window as any).desktop;
  const valid=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=120&&!/[\u0000-\u001f]/.test(value);
  if(desktop){const native=await desktop.getConfig();if(!valid(native?.deviceId))throw Error('本机设备标识异常，请完全退出软件后重新打开；仍失败请更新软件');return native}
  let id=localStorage.getItem('yuntu-device');if(!valid(id)){id=crypto.randomUUID();localStorage.setItem('yuntu-device',id)}return {apiBase:'',deviceId:id};
 })().catch(error=>{config=undefined;throw error});return config;
}
export async function getApiBase(){return (await getConfig()).apiBase.replace(/\/$/,'')}
export async function getDeviceId(){return (await getConfig()).deviceId}
export function getToken(){return sessionStorage.getItem('yuntu-token')}
export async function api(path:string,options:RequestInit={}){
 const requestToken=getToken();
 const controller=new AbortController();let timedOut=false;let timer:ReturnType<typeof setTimeout>|undefined;
 const externalAbort=()=>controller.abort(options.signal?.reason);
 if(options.signal?.aborted)externalAbort();else options.signal?.addEventListener('abort',externalAbort,{once:true});
 const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{timedOut=true;config=undefined;reject(new Error('连接超时，请检查网络后重试'));controller.abort()},15000)});
 const request=async()=>{
  const base=await getApiBase();const device=await getDeviceId();if(controller.signal.aborted)throw new DOMException('请求已取消','AbortError');
  const headers=new Headers(options.headers);headers.set('X-Device-Id',device);if(requestToken)headers.set('Authorization','Bearer '+requestToken);if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  let response:Response;try{response=await fetch(base+(path.startsWith('/api')?path:'/api'+path),{...options,headers,signal:controller.signal})}catch(error){if(timedOut)throw new Error('连接超时，请检查网络后重试');if(options.signal?.aborted)throw error;throw new Error('连接失败，请检查网络和服务地址后重试')}
  if(response.status===401&&requestToken&&getToken()===requestToken){sessionStorage.removeItem('yuntu-token');window.dispatchEvent(new Event('yuntu-session-expired'))}
  let data:any;try{data=await response.json()}catch{throw new Error('服务响应格式错误，请稍后重试')}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('服务响应格式错误，请稍后重试');
  if(!response.ok||data.error)throw new Error(data.error||`请求失败 (${response.status})`);return data;
 };
 try{return await Promise.race([request(),deadline])}finally{clearTimeout(timer);options.signal?.removeEventListener('abort',externalAbort)}
}
export function json(method:string,body:any):RequestInit{return {method,body:JSON.stringify(body)}}

// Start revocation while its original token is available, then always remove the
// local session immediately. A late response cannot clear a subsequent login.
export async function logoutSession(revoke:()=>Promise<unknown>,clearLocal:()=>void):Promise<void>{
 const token=getToken();let request:Promise<unknown>|undefined;
 try{request=revoke()}finally{const current=getToken();if(!current||current===token){sessionStorage.removeItem('yuntu-token');clearLocal()}}
 await request;
}
