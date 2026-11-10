const CONNECT_MS=15_000;
const IDLE_MS=35_000;
const MAX_TOTAL_MS=270_000;
const CONFIRM_RESERVE_MS=20_000;

export function transferDeadline(size,expiresAt,now=Date.now()){
 const bytes=Math.max(0,Number(size)||0);
 const duration=Math.min(MAX_TOTAL_MS,90_000+Math.ceil(bytes/262_144*1000));
 const expires=typeof expiresAt==='string'?Date.parse(expiresAt):NaN;
 return Math.min(now+duration,Number.isFinite(expires)?expires-CONFIRM_RESERVE_MS:Infinity);
}

export function uploadFailure(kind,message,status,retryAfter){
 const retryable=kind==='network'||kind==='timeout'
  ||kind==='http'&&(status===408||status===429||status>=500&&status<600);
 return Object.assign(Error(message),{kind,status,retryAfter,retryable});
}

export function storageFailure(status,body='',retryAfter){
 const xml=String(body).slice(0,8192);
 const expired=/<Code>\s*RequestExpired\s*<\/Code>/i.test(xml)
  ||(/<Code>\s*AccessDenied\s*<\/Code>/i.test(xml)&&/<Message>\s*(?:Request has expired|Request is expired)\b/i.test(xml));
 if(status===403&&expired)return uploadFailure('signature-expired','上传签名已过期',status);
 if(status===401||status===403)return uploadFailure('auth','存储拒绝上传授权（HTTP '+status+'），请检查存储签名或权限',status);
 const seconds=Number(retryAfter);
 const retryDate=typeof retryAfter==='string'?Date.parse(retryAfter):NaN;
 const delay=Number.isFinite(seconds)&&seconds>0?seconds:
  Number.isFinite(retryDate)?Math.max(1,(retryDate-Date.now())/1000):undefined;
 return uploadFailure('http','存储返回 HTTP '+status,status,delay);
}

export function startUploadClock(deadlineAt,onTimeout){
 let stopped=false,connected=false,idleTimer;
 const fail=message=>{
  if(stopped)return;
  stop();
  onTimeout(uploadFailure('timeout',message));
 };
 const connectTimer=setTimeout(()=>fail('连接存储超时，请检查网络'),CONNECT_MS);
 const totalTimer=setTimeout(()=>fail('图片上传达到本次传输时限，请重试'),Math.max(0,deadlineAt-Date.now()));
 function activity(){
  if(stopped)return;
  if(!connected){connected=true;clearTimeout(connectTimer)}
  clearTimeout(idleTimer);
  idleTimer=setTimeout(()=>fail('上传长时间没有传输进展，请检查网络或源文件'),IDLE_MS);
 }
 function stop(){stopped=true;clearTimeout(connectTimer);clearTimeout(idleTimer);clearTimeout(totalTimer)}
 return {activity,stop};
}
