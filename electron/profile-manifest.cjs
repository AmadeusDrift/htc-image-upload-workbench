const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createManifestStore}=require('./manifest.cjs');

// Keep the original primary file/schema. Owner checkpoints use the same validated,
// atomic and backed-up store, with serialized switches so saves cannot interleave.
function createProfileManifestStore(file,trustedHandles,{io=fs.promises}={}){
 const primary=createManifestStore(file,trustedHandles,{io});
 const directory=path.join(path.dirname(file),'upload-manifest-profiles');
 let chain=Promise.resolve();
 function serial(operation){const result=chain.then(operation);chain=result.catch(()=>{});return result}
 function ownerFile(ownerId){return path.join(directory,crypto.createHash('sha256').update(ownerId).digest('hex')+'.json')}
 function sourceHandles(data){return new Map(data.sources.map(source=>[source.id,source]))}
 async function switchOwner(ownerId){
  if(typeof ownerId!=='string'||!ownerId.trim()||ownerId.length>150||ownerId.includes('\0'))throw Error('上传进度格式无效：员工标识');
  await primary.flush();
  const current=await primary.load();
  if(current?.ownerId===ownerId)return current;
  if(current?.ownerId){
   const archive=createManifestStore(ownerFile(current.ownerId),sourceHandles(current),{io});
   await archive.save(current);await archive.flush();
  }
  const selected=await createManifestStore(ownerFile(ownerId),new Map(),{io}).load();
  if(!selected)return null;
  if(selected.ownerId!==ownerId)throw Error('上传进度员工标识不匹配，请保留备份并检查本地任务');
  // All reads and the outgoing archive finish before touching the primary.
  const restore=createManifestStore(file,sourceHandles(selected),{io});
  await restore.save(selected);await restore.flush();
  return selected;
 }
 return {save:input=>serial(()=>primary.save(input)),load:()=>serial(()=>primary.load()),flush:()=>serial(()=>primary.flush()),loadUserManifest:ownerId=>serial(()=>switchOwner(ownerId))};
}
module.exports={createProfileManifestStore};
