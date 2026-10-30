function createUploadGate(limit=5,slots=new Map(),timeoutMs=60000){
 return {slots,async run(id,prepare,transfer){
  if(slots.has(id))throw Error('该文件正在上传');
  if(slots.size>=limit)throw Error('客户端并发上限为 '+limit);
  let rejectCancellation;const cancelled=new Promise((_resolve,reject)=>{rejectCancellation=reject});
  const slot={cancelled:null,request:null,destroy(error=Error('上传已暂停')){if(this.cancelled)return;this.cancelled=error;rejectCancellation(error);this.request?.destroy(error)},setRequest(request){this.request=request;if(this.cancelled)request.destroy(this.cancelled)}};
  slots.set(id,slot);const timer=setTimeout(()=>slot.destroy(Error('上传超过 60 秒，请检查网络和源文件')),timeoutMs);
  try{const source=await Promise.race([Promise.resolve(prepare()),cancelled]);if(slot.cancelled)throw slot.cancelled;return await Promise.race([Promise.resolve(transfer(source,slot)),cancelled])}finally{clearTimeout(timer);if(slots.get(id)===slot)slots.delete(id)}
 }};
}
module.exports={createUploadGate};
