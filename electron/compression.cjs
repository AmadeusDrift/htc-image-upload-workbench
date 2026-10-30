const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const sharp=require('sharp');
const MAX_BYTES=50*1024*1024;
function createImagePreparer({source,handles,cacheDirectory,io=fs.promises,timeoutMs=60000,limit=2}){
 const jobs=new Map(),cache=new Map(),queue=[];let active=0;
 function check(job){if(job.error)throw job.error}
 function describe(id,file,note){const name=file.name||path.basename(file.path);return {id,name,relativePath:file.relativePath||name,size:file.size,contentType:file.contentType||({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'}[path.extname(name).toLowerCase()]),originalSize:file.originalSize||file.size,compressed:!!file.compressed,compressionNote:note||file.compressionNote}}
 function cancel(job,error){if(job.error)return;job.error=error;job.rejectCancellation(error);for(const pipeline of job.pipelines)pipeline.destroy(error);if(!job.started){const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);jobs.delete(job.key);clearTimeout(job.timer);job.cleanupDone()}}
 function abort(id,error=Error('本地图片处理已暂停')){let found=false;for(const job of jobs.values())if(job.id===id){found=true;cancel(job,error)}return found}
 function pipelineFor(job,file){check(job);const pipeline=sharp(file,{failOn:'error'}).timeout({seconds:Math.max(1,Math.ceil(timeoutMs/1000))});pipeline.on('error',()=>{});job.pipelines.add(pipeline);return pipeline}
 async function usePipeline(job,pipeline,operation){try{const result=await operation(pipeline);check(job);return result}finally{job.pipelines.delete(pipeline)}}
 async function run(job){let temporary,output,committed=false;
  try{
   const file=await Promise.race([Promise.resolve().then(()=>source(job.id)),job.cancelled]);check(job);
   if(!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_BYTES)throw Error('单图最大 50 MB');
   const original=describe(job.id,file);
   if(!job.enabled)return {...original,compressionNote:'已关闭本地压缩，保留原图'};
   if(original.compressed)return original;
   if(!['image/png','image/jpeg'].includes(original.contentType))return {...original,compressionNote:'非 PNG/JPEG 图片，保留原图'};
   const cacheKey=job.id+':'+file.mtimeMs+':'+job.quality;const cached=cache.get(cacheKey);if(cached){try{await Promise.race([source(cached.id),job.cancelled]);check(job);return {...cached}}catch(error){check(job);cache.delete(cacheKey)}}
   const keepOriginal=note=>{const result={...original,compressionNote:note};cache.set(cacheKey,Object.freeze({...result}));return result};
   const metadata=await usePipeline(job,pipelineFor(job,file.path),pipeline=>pipeline.metadata());
   if(!['png','jpeg'].includes(metadata.format))return keepOriginal('文件内容不是 PNG/JPEG，保留原图');
   if(metadata.format==='png'){const stats=await usePipeline(job,pipelineFor(job,file.path),pipeline=>pipeline.stats());if(!stats.isOpaque)return keepOriginal('图片包含真实透明像素，保留 PNG')}
   await io.mkdir(cacheDirectory,{recursive:true});check(job);
   output=path.join(cacheDirectory,crypto.randomUUID()+'.jpg');temporary=output+'.tmp';
   await usePipeline(job,pipelineFor(job,file.path),pipeline=>pipeline.removeAlpha().withIccProfile('srgb').jpeg({quality:job.quality,chromaSubsampling:'4:4:4'}).toFile(temporary));
   const prepared=await io.stat(temporary);check(job);
   if(prepared.size>=file.size||prepared.size>MAX_BYTES)return keepOriginal('JPEG 未缩小体积，保留原图');
   const durable=await io.open(temporary,'r+');try{await durable.sync()}finally{await durable.close()}check(job);
   await io.rename(temporary,output);check(job);
   await Promise.race([source(job.id),job.cancelled]);check(job);
   const current=await io.stat(output);check(job);
   const id=crypto.randomUUID();const toJpeg=name=>name.replace(/\.[^./\\]+$/,'')+'.jpg';
   const result={id,name:toJpeg(original.name),relativePath:toJpeg(original.relativePath),size:current.size,contentType:'image/jpeg',originalSize:original.originalSize,compressed:true,compressionNote:'本地 JPEG 压缩，质量 '+job.quality+'，保留原尺寸'};
   handles.set(id,{path:output,size:current.size,mtimeMs:current.mtimeMs,name:result.name,relativePath:result.relativePath,contentType:result.contentType,originalSize:result.originalSize,compressed:true,preparedImage:true,compressionNote:result.compressionNote});cache.set(cacheKey,Object.freeze({...result}));committed=true;return result;
  }finally{if(temporary)await io.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error});if(output&&!committed)await io.unlink(output).catch(error=>{if(error.code!=='ENOENT')throw error})}
 }
 function pump(){while(active<limit&&queue.length){const job=queue.shift();if(job.error)continue;job.started=true;active++;void run(job).then(job.resolve,job.reject).finally(()=>{active--;clearTimeout(job.timer);if(jobs.get(job.key)===job)jobs.delete(job.key);job.cleanupDone();pump()})}}
 async function release(ids){
  if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||id.length>150))throw Error('无效的缓存回收请求');let released=0;
  for(const id of new Set(ids)){const file=handles.get(id);if(!file?.preparedImage||typeof file.path!=='string')continue;const relative=path.relative(path.resolve(cacheDirectory),path.resolve(file.path));if(path.dirname(relative)!=='.'||!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.jpg$/i.test(relative))continue;try{await io.unlink(file.path);released++}catch(error){if(error.code!=='ENOENT')throw error}for(const [key,result] of cache)if(result.id===id)cache.delete(key)}
  return {released};
 }
 return {jobs,abort,release,abortAll(){for(const job of jobs.values())cancel(job,Error('应用退出，本地图片处理已取消'))},async drain(){while(jobs.size)await Promise.all([...jobs.values()].map(job=>job.cleaned))},prepare(id,options){
  if(typeof id!=='string'||id.length>150||!options||typeof options.enabled!=='boolean'||options.quality!==undefined&&!Number.isFinite(options.quality))return Promise.reject(Error('无效的本地图片处理选项'));
  const quality=Math.max(80,Math.min(95,Math.round(options.quality??90)));const key=id+':'+quality+':'+options.enabled;
  if(jobs.has(key))return jobs.get(key).promise;
  let resolve,reject,rejectCancellation,cleanupDone;const actual=new Promise((yes,no)=>{resolve=yes;reject=no});const cancelled=new Promise((_yes,no)=>{rejectCancellation=no});const cleaned=new Promise(yes=>{cleanupDone=yes});const promise=Promise.race([actual,cancelled]);
  const job={id,key,enabled:options.enabled,quality,resolve,reject,rejectCancellation,cancelled,cleaned,cleanupDone,promise,pipelines:new Set(),error:null,started:false};job.timer=setTimeout(()=>cancel(job,Error('本地图片处理超过 60 秒，请检查源文件是否可访问')),timeoutMs);jobs.set(key,job);queue.push(job);pump();return promise;
 }};
}
module.exports={createImagePreparer};


