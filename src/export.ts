export interface ExportFile {name:string;relativePath:string;url:string;size:number;createdAt:string;taskId?:string;groupId?:string}
export interface LinkTable {headers:string[];rows:(string|number)[][]}
const numericOrder=new Intl.Collator('zh-CN',{numeric:true});
const natural=(a:string,b:string)=>a===b?0:numericOrder.compare(a,b)||a.localeCompare(b);

export function productTable(files:readonly ExportFile[]):LinkTable {
 const products=new Map<string,{owner:string;files:{name:string;url:string}[]}>();let largest=0;
 for(const file of files){
  const parts=file.relativePath.replaceAll('\\','/').split('/').filter(Boolean);const name=parts.pop()||file.name,folder=parts.join('/');
  if(!folder)throw Error('按产品导出需要产品文件夹，请选择“逐张明细”或按产品文件夹重新上传');
  const owner=JSON.stringify([file.groupId||'',file.taskId||'']);let product=products.get(folder);
  if(product&&product.owner!==owner)throw Error(`产品目录 ${folder} 来自不同上传任务或业务账号，请在单个任务内导出，或选择“逐张明细”`);
  if(!product){product={owner,files:[]};products.set(folder,product)}
  product.files.push({name,url:file.url});largest=Math.max(largest,product.files.length);
 }
 // Group by full directory to avoid merging same-named folders under different roots.
 // The visible first column is always the immediate parent folder's name.
 const folders=[...products.keys()].sort(natural);
 return {headers:['文件夹名',...Array.from({length:largest},(_,i)=>'图片'+(i+1))],rows:folders.map(folder=>{
  const links=products.get(folder)!.files.sort((a,b)=>natural(a.name,b.name)||natural(a.url,b.url));
  return [folder.split('/').at(-1)!,...Array.from({length:largest},(_,i)=>links[i]?.url||'')];
 })};
}

function localDateFormatter() {
 const formatter=new Intl.DateTimeFormat('zh-CN',{
  year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric',hour12:false,
 });
 return (value:string)=>{
  if(!value)return '—';
  const instant=new Date(value);
  return Number.isNaN(instant.getTime())?instant.toString():formatter.format(instant);
 };
}

export function detailTable(files:readonly ExportFile[],sort:string,formatDate=localDateFormatter()):LinkTable {
 const sorted=[...files].sort((a,b)=>sort==='createdAt'?a.createdAt.localeCompare(b.createdAt):natural(a.name,b.name)||natural(a.relativePath,b.relativePath));
 return {headers:['文件名','目录','图片链接','文件大小（字节）','上传时间'],rows:sorted.map(file=>[file.name,file.relativePath,file.url,file.size,formatDate(file.createdAt)])};
}
