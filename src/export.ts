export interface ExportFile {name:string;relativePath:string;url:string;size:number;createdAt:string;taskId?:string;groupId?:string}
export interface LinkTable {headers:string[];rows:(string|number)[][]}
const natural=(a:string,b:string)=>a.localeCompare(b,'zh-CN',{numeric:true})||a.localeCompare(b);

export function productTable(files:readonly ExportFile[]):LinkTable {
 const products=new Map<string,{owner:string;links:Map<number,string>}>();let largest=0;
 for(const file of files){
  const parts=file.relativePath.replaceAll('\\','/').split('/').filter(Boolean);const name=parts.pop()||file.name,folder=parts.join('/');
  if(!folder)throw Error('按产品导出需要产品文件夹，请选择“逐张明细”或按产品文件夹重新上传');
  const match=/^(\d+)\.(?:jpe?g|png|webp)$/i.exec(name);
  if(!match)throw Error(`图片 ${file.relativePath} 没有数字场景编号，请选择“逐张明细”导出`);
  const scene=Number(match[1]);
  if(!Number.isSafeInteger(scene)||scene<1||scene>1000)throw Error(`图片 ${file.relativePath} 的编号须为 1–1000，请选择“逐张明细”导出`);
  const owner=JSON.stringify([file.groupId||'',file.taskId||'']);let product=products.get(folder);
  if(product&&product.owner!==owner)throw Error(`产品目录 ${folder} 来自不同上传任务或业务账号，请在单个任务内导出，或选择“逐张明细”`);
  if(!product){product={owner,links:new Map()};products.set(folder,product)}
  if(product.links.has(scene))throw Error(`产品 ${folder} 的图片编号 ${scene} 重复，请检查文件或选择“逐张明细”`);
  product.links.set(scene,file.url);largest=Math.max(largest,scene);
 }
 const folders=[...products.keys()].sort(natural),paths=folders.map(folder=>folder.split('/'));
 // Remove shared selection-root directories, keeping each complete product identifier.
 let prefix=0;while(paths.length&&paths.every(parts=>parts.length>prefix+1&&parts[prefix]===paths[0][prefix]))prefix++;
 return {headers:['产品编号',...Array.from({length:largest},(_,i)=>'图片'+(i+1))],rows:folders.map(folder=>[folder.split('/').slice(prefix).join('/'),...Array.from({length:largest},(_,i)=>products.get(folder)!.links.get(i+1)||'')])};
}

export function detailTable(files:readonly ExportFile[],sort:string,formatDate:(date:string)=>string):LinkTable {
 const sorted=[...files].sort((a,b)=>sort==='createdAt'?a.createdAt.localeCompare(b.createdAt):natural(a.name,b.name)||natural(a.relativePath,b.relativePath));
 return {headers:['文件名','目录','图片链接','文件大小（字节）','上传时间'],rows:sorted.map(file=>[file.name,file.relativePath,file.url,file.size,formatDate(file.createdAt)])};
}
