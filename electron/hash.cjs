const fs=require('node:fs');const crypto=require('node:crypto');
function createHashReader({source,createReadStream=fs.createReadStream,timeoutMs=60000,limit=5}){
 const jobs=new Map();
 function abort(id,error=Error('文件校验已暂停')){const job=jobs.get(id);if(!job)return false;job.error=error;job.cancel(error);job.stream?.destroy(error);return true}
 return {jobs,abort,async hash(id){
  if(jobs.has(id))throw Error('该文件正在校验');if(jobs.size>=limit)throw Error('文件校验并发上限为 '+limit);
  let cancel;const cancelled=new Promise((_resolve,reject)=>{cancel=reject});const job={stream:null,error:null,cancel};jobs.set(id,job);
  const timer=setTimeout(()=>abort(id,Error('文件校验超过 60 秒，请检查源文件是否可访问')),timeoutMs);
  try{const file=await Promise.race([Promise.resolve().then(()=>source(id)),cancelled]);if(job.error)throw job.error;job.stream=createReadStream(file.path);const digest=crypto.createHash('sha256');for await(const chunk of job.stream){if(job.error)throw job.error;digest.update(chunk)}if(job.error)throw job.error;return digest.digest('hex')}
  finally{clearTimeout(timer);job.stream?.destroy();if(jobs.get(id)===job)jobs.delete(id)}
 }};
}
module.exports={createHashReader};
