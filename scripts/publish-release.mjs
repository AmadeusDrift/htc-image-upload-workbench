import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),updaterRequire=createRequire(require.resolve('electron-updater/package.json')),{load}=updaterRequire('js-yaml');
const PART_SIZE=8*1024*1024;
const hashFile=async(file)=>{const hash=createHash('sha512');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('base64')};

export async function publishRelease({directory,channel='stable',config,fetchImpl=fetch,log=console.log}){
 if(!/^(stable|acceptance-[a-z0-9-]{1,60})$/.test(channel))throw Error('Invalid release channel');
 const base=new URL(config?.baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||typeof config?.publishToken!=='string'||!/^[a-f0-9]{64}$/.test(config.publishToken))throw Error('Invalid private release configuration');
 const manifestText=await fsp.readFile(path.join(directory,'latest.yml'),'utf8'),manifest=load(manifestText),version=String(manifest?.version||'');
 if(!/^\d+\.[0-9]\.[0-9]$/.test(version))throw Error('Version must use decimal rollover');
 const name=`Yuntu-Workbench-Setup-${version}-x64.exe`,entry=manifest?.files?.[0];
 if(manifest.files?.length!==1||entry?.url!==name||manifest.path!==name||manifest.sha512!==entry.sha512||!Number.isSafeInteger(entry.size)||entry.size<1)throw Error('Unexpected installer metadata');
 const artifacts=[];
 for(const fileName of [name,name+'.blockmap']){
  const file=path.join(directory,fileName),stat=await fsp.stat(file);if(!stat.isFile()||stat.size<1)throw Error('Missing release file');const sha512=await hashFile(file);
  if(fileName===name&&(stat.size!==entry.size||sha512!==entry.sha512))throw Error('Local installer checksum/size mismatch');
  artifacts.push({name:fileName,file,size:stat.size,sha512});
 }
 const journalPath=path.join(directory,`.publish-${channel}.json`);let journal={};try{journal=JSON.parse(await fsp.readFile(journalPath,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
 const persist=async()=>{await fsp.writeFile(journalPath+'.tmp',JSON.stringify(journal,null,2));await fsp.rename(journalPath+'.tmp',journalPath)};
 const route=(type,file)=>new URL(`/api/releases/${channel}/${type}/${file}`,base).href;
 async function request(url,init={},publishing=true,timeoutMs=60000){
  for(let attempt=0;;attempt++){
   try{
    const headers=new Headers(init.headers);if(publishing)headers.set('X-Release-Token',config.publishToken);
    const response=await fetchImpl(url,{...init,headers,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok){const error=Object.assign(Error('Release request HTTP '+response.status),{status:response.status});throw error}return response;
   }catch(error){if(attempt>=3||error.status&&error.status<500&&error.status!==408&&error.status!==429)throw error;await new Promise(resolve=>setTimeout(resolve,500*2**attempt))}
  }
 }
 async function verify(artifact,missingAllowed=false){
  let response;try{response=await request(new URL(`/updates/${channel}/${artifact.name}`,base).href,{},false,300000)}catch(error){if(missingAllowed&&error.status===404)return false;throw error}
  const hash=createHash('sha512');let bytes=0;for await(const chunk of response.body){bytes+=chunk.length;hash.update(chunk)}
  if(bytes!==artifact.size||hash.digest('base64')!==artifact.sha512)throw Error('Public artifact checksum/size mismatch');return true;
 }
 for(const artifact of artifacts){
  if(await verify(artifact,true)){delete journal[artifact.name];await persist();log(`Verified existing ${artifact.name}`);continue}
  const headers={'Content-Type':'application/octet-stream','X-Release-Size':String(artifact.size),'X-Release-Sha512':artifact.sha512};
  if(artifact.size<=PART_SIZE){
   try{await request(route('files',artifact.name),{method:'PUT',headers,body:await fsp.readFile(artifact.file)})}catch(error){if(error.status!==409)throw error}
  }else{
   let upload=journal[artifact.name];
   if(!upload||upload.sha512!==artifact.sha512||upload.size!==artifact.size){
    // Start is intentionally not blindly retried: server claims make it idempotent.
    const started=await(await request(route('multipart',artifact.name),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({size:artifact.size,sha512:artifact.sha512})})).json();
    if(typeof started.uploadId!=='string'||started.partSize!==PART_SIZE)throw Error('Invalid multipart response');
    upload=journal[artifact.name]={uploadId:started.uploadId,size:artifact.size,sha512:artifact.sha512,parts:[]};await persist();
   }
   const handle=await fsp.open(artifact.file,'r');
   try{for(let i=0;i<Math.ceil(artifact.size/PART_SIZE);i++){
    if(upload.parts[i]?.partNumber===i+1)continue;
    const length=Math.min(PART_SIZE,artifact.size-i*PART_SIZE),buffer=Buffer.allocUnsafe(length);let read=0;
    while(read<length){const result=await handle.read(buffer,read,length-read,i*PART_SIZE+read);if(!result.bytesRead)throw Error('Release file changed during upload');read+=result.bytesRead}
    const u=new URL(route('multipart',artifact.name));u.searchParams.set('uploadId',upload.uploadId);u.searchParams.set('partNumber',String(i+1));
    const part=await(await request(u.href,{method:'PUT',headers,body:buffer})).json();if(part.partNumber!==i+1||typeof part.etag!=='string'||!part.etag)throw Error('Invalid part receipt');upload.parts[i]=part;await persist();log(`${artifact.name}: part ${i+1}/${Math.ceil(artifact.size/PART_SIZE)}`);
   }}finally{await handle.close()}
   try{await request(route('multipart',artifact.name)+'/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({uploadId:upload.uploadId,parts:upload.parts})})}
   catch(error){if(!await verify(artifact,true))throw error}
  }
  await verify(artifact);delete journal[artifact.name];await persist();log(`Verified uploaded ${artifact.name}`);
 }
 // Re-check local bytes so a build overwritten during publishing cannot promote a mixed release.
 for(const artifact of artifacts)if(await hashFile(artifact.file)!==artifact.sha512)throw Error('Release file changed during publishing');
 await request(route('files','latest.yml'),{method:'PUT',headers:{'Content-Type':'text/yaml'},body:manifestText});
 const published=await(await request(new URL(`/updates/${channel}/latest.yml`,base).href,{},false)).text();if(published!==manifestText)throw Error('Published manifest mismatch');
 const report={version,channel,artifacts:artifacts.map(({name,size,sha512})=>({name,size,sha512})),feed:new URL(`/updates/${channel}/`,base).href,publishedAt:new Date().toISOString()};
 await fsp.writeFile(path.join(directory,`publication-${channel}.json`),JSON.stringify(report,null,2));log(`Published ${version} to ${channel}`);return report;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const [directory,channel='stable',configFile=process.env.YUNTU_RELEASE_CONFIG]=process.argv.slice(2);
 if(!directory||!configFile){console.error('Usage: node scripts/publish-release.mjs <build-directory> [channel] <private-config.json>');process.exitCode=1}
 else{try{const config=JSON.parse(await fsp.readFile(configFile,'utf8'));await publishRelease({directory,channel,config})}catch(error){console.error(error.message);process.exitCode=1}}
}
