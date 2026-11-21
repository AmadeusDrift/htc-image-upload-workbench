const fs=require('node:fs');
const https=require('node:https');
const {startUploadClock,storageFailure,uploadFailure}=require('./upload-policy.mjs');

function uploadHeaders(file,target,headers) {
 const verified={'content-length':file.size};
 for(const [key,value] of Object.entries(headers||{})){
  const name=key.toLowerCase();
  if(!/^(content-type|x-amz-[a-z0-9-]+)$/.test(name)||typeof value!=='string'||/[\r\n]/.test(value)||Object.hasOwn(verified,name))
   throw uploadFailure('local','上传请求头无效，请联系管理员');
  verified[name]=value;
 }
 const checksum='x-amz-checksum-sha256';
 if(file.temporaryPack){
  const signed=target.searchParams.get('X-Amz-SignedHeaders')?.split(';')||[];
  if(verified['content-type']!=='application/octet-stream'||!signed.includes('content-type')||!signed.includes(checksum)||
    !/^[a-f\d]{64}$/.test(file.sha256)||verified[checksum]!==Buffer.from(file.sha256,'hex').toString('base64'))
   throw uploadFailure('local','临时上传包的签名、类型或校验值与本机记录不符');
 }else if(Object.hasOwn(verified,checksum)){
  throw uploadFailure('local','原图上传请求包含意外的图片包校验值');
 }
 return verified;
}

function createUploadGate(limit=20,slots=new Map(),sourceTimeoutMs=15000){
 return {slots,async run(id,prepare,transfer){
  if(slots.has(id))throw uploadFailure('local','该文件正在上传');
  if(slots.size>=limit)throw uploadFailure('local','客户端并发上限为 '+limit);
  let rejectCancellation;
  const cancelled=new Promise((_resolve,reject)=>{rejectCancellation=reject});
  void cancelled.catch(()=>{});
  const slot={
   cancelled:null,request:null,
   destroy(error=Error('上传已暂停')){
    if(this.cancelled)return;
    this.cancelled=error;
    rejectCancellation(error);
    this.request?.destroy(error);
   },
   setRequest(request){
    this.request=request;
    if(this.cancelled)request.destroy(this.cancelled);
   },
  };
  slots.set(id,slot);
  const timer=setTimeout(()=>slot.destroy(uploadFailure('timeout','源文件读取超时，请检查磁盘')),sourceTimeoutMs);
  try{
   const source=await Promise.race([Promise.resolve(prepare()),cancelled]);
   clearTimeout(timer);
   if(slot.cancelled)throw slot.cancelled;
   return await Promise.race([Promise.resolve(transfer(source,slot)),cancelled]);
  }finally{
   clearTimeout(timer);
   if(slots.get(id)===slot)slots.delete(id);
  }
 }};
}

const NETWORK_ERRORS=new Set(['ECONNRESET','ETIMEDOUT','EPIPE','EAI_AGAIN','ECONNREFUSED','ENOTFOUND','ENETUNREACH','EHOSTUNREACH','ECONNABORTED','ERR_STREAM_PREMATURE_CLOSE']);
function uploadNativeFile({target,file,headers,slot,deadlineAt,onProgress,request= https.request,createReadStream=fs.createReadStream}){
 return new Promise((resolve,reject)=>{
  let req,reader,settled=false,loaded=0,lastReport=0;
  const clock=startUploadClock(deadlineAt,error=>done(error));
  function done(error){
   if(settled)return;
   settled=true;
   clock.stop();
   reader?.destroy();
   if(error){req?.destroy();reject(error)}else resolve();
  }
  function connected(){
   if(settled||reader)return;
   clock.activity();
   try{reader=createReadStream(file.path)}catch{done(uploadFailure('local','无法读取源文件，请重新选择'));return}
   reader.on('error',()=>done(uploadFailure('local','无法读取源文件，请重新选择')));
   reader.on('data',chunk=>{
    if(!chunk.length)return;
    loaded+=chunk.length;
    clock.activity();
    if(Date.now()-lastReport>100||loaded===file.size){
     lastReport=Date.now();
     onProgress(loaded,file.size);
    }
   });
   reader.pipe(req);
  }
  try{
   req=request(target,{method:'PUT',headers},response=>{
    clock.activity();
    const status=response.statusCode||0;
    const success=status>=200&&status<300;
    let body='';
    if(!success){reader?.unpipe(req);reader?.destroy()}
    response.on('data',chunk=>{
     clock.activity();
     if(!success&&body.length<8192)body+=chunk.toString().slice(0,8192-body.length);
    });
    response.on('end',()=>done(success?undefined:storageFailure(status,body,response.headers['retry-after'])));
    response.on('aborted',()=>done(uploadFailure('network','存储连接中断，请重试')));
    response.on('error',()=>done(uploadFailure('network','存储连接中断，请重试')));
    response.resume();
   });
   req.on('error',error=>done(error.kind||slot.cancelled?error:
    NETWORK_ERRORS.has(error.code)?uploadFailure('network','存储网络连接失败，请重试'):
     uploadFailure('local','无法连接存储，请检查网络安全设置或上传地址')));
   req.on('socket',socket=>{
    if(req.reusedSocket)connected();
    else socket.once('secureConnect',connected);
   });
   slot.setRequest(req);
   if(slot.cancelled){done(slot.cancelled);return}
   req.flushHeaders();
  }catch{done(uploadFailure('local','无法发起存储上传，请检查上传地址或请求参数'))}
 });
}

async function uploadIpcResult(operation){
 try{await operation();return {ok:true}}
 catch(error){
  return {ok:false,error:{kind:error?.kind||'local',message:error?.kind?error.message:'本地上传未能启动，请重试或重启软件',status:error?.status,retryAfter:error?.retryAfter}};
 }
}
module.exports={createUploadGate,uploadNativeFile,uploadIpcResult,uploadHeaders};
