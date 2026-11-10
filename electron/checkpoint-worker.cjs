const fs=require('node:fs');
const {parentPort,workerData}=require('node:worker_threads');
const {openCheckpointDb}=require('./checkpoint-db.cjs');
let store;
parentPort.on('message',({id,method,data})=>{
 try{
  if(!store && (method==='save'||fs.existsSync(workerData.file)))store=openCheckpointDb(workerData.file);
  const result=store?store[method](data):null;
  parentPort.postMessage({id,result});
 }catch(error){
  const message=error.errcode===13||error.code==='ENOSPC'
   ?'本地进度写入失败：磁盘空间不足，请释放空间后继续'
   :error.errcode===14?'无法打开本地任务清单，请检查磁盘空间和目录权限':String(error.message||error);
  parentPort.postMessage({id,error:message});
 }
});
