import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
const require = createRequire(import.meta.url);
const {createPackSpool, MAX_PACK_BYTES} = require('../electron/pack-spool.cjs');
const {normalizeManifest} = require('../electron/manifest.cjs');
const roots:string[] = [];
const hash = (data:Buffer) => createHash('sha256').update(data).digest('hex');

async function fixture() {
 const root = await fs.mkdtemp(path.join(os.tmpdir(),'yuntu-native-packs-'));
 roots.push(root);
 const directory = path.join(root,'packs'), handles = new Map<string,any>();
 async function add(id:string,bytes:Buffer|number) {
  const file = path.join(root,id+'.png');
  await fs.writeFile(file,typeof bytes==='number' ? '' : bytes);
  if(typeof bytes==='number')await fs.truncate(file,bytes);
  const info=await fs.stat(file);
  handles.set(id,{path:file,size:info.size,mtimeMs:info.mtimeMs,contentType:'image/png'});
 }
 async function source(id:string) {
  const h=handles.get(id);
  if(!h)throw Error('unknown handle');
  const info=await fs.lstat(h.path);
  if(!info.isFile() || info.size!==h.size || info.mtimeMs!==h.mtimeMs)throw Error('source changed');
  return h;
 }
 const options={directory,handles,source};
 return {...options,root,add,spool:createPackSpool(options)};
}

afterEach(async()=>{
 for (const root of roots.splice(0)){
  if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('yuntu-native-packs-'))throw Error('Invalid fixture');
  await fs.rm(root,{recursive:true,force:true});
 }
});

it('streams selected originals in caller order and returns one opaque upload handle for concurrent retries',async()=>{
 const {add,spool,handles,directory}=await fixture();
 const first=Buffer.from([0,254,255,0]),second=Buffer.alloc(700000,7);
 await add('a',first);await add('b',second);
 const ids=['b','a'];
 const [pack,retry]=await Promise.all([spool.prepare('key',ids,1),spool.prepare('key',ids,1)]);
 const expected=Buffer.concat([second,first]);
 expect(pack).toEqual({id:retry.id,size:expected.length,sha256:hash(expected),entries:[
  {id:'b',offset:0,size:second.length,sha256:hash(second)},
  {id:'a',offset:second.length,size:first.length,sha256:hash(first)},
 ]});
 expect(await fs.readFile(handles.get(pack.id).path)).toEqual(expected);
 expect(handles.get(pack.id).sha256).toBe(hash(expected));
 expect(await fs.readdir(directory)).toHaveLength(1);
 await expect(spool.prepare('key',['a','b'],1)).rejects.toThrow(/成员/);
 await expect(spool.prepare('nested',[pack.id],1)).rejects.toThrow(/原始图片/);
 await expect(spool.prepare('bad',['unknown'],1)).rejects.toThrow(/unknown/);
 expect(await spool.release('key')).toBe(true);
 expect(await spool.release('key')).toBe(false);
 expect(handles.has(pack.id)).toBe(false);
 expect(await fs.readFile(handles.get('b').path)).toEqual(second);
 const rebuilt=await spool.prepare('key',ids,1);
 expect(rebuilt.id).not.toBe(pack.id);
 expect(rebuilt.sha256).toBe(pack.sha256);
 expect(await spool.release('key',pack.id)).toBe(false);
 await spool.clear();
 expect(spool.stats()).toMatchObject({bytes:0,packs:0,peakPacks:1,peakBytes:expected.length});
});

it('allows exactly 12 files and 24 MiB, rejects oversized members, invalid quotas and prepared images',async()=>{
 const {add,spool,handles}=await fixture();
 await add('large',MAX_PACK_BYTES);await add('over',MAX_PACK_BYTES+1);await add('one',Buffer.from('1'));
 expect((await spool.prepare('exact',['large'],20)).size).toBe(MAX_PACK_BYTES);
 expect((await spool.prepare('dozen',Array(12).fill('one'),20)).entries).toHaveLength(12);
 for(const ids of [['large','one'],['over'],Array(13).fill('one'),[]])
  await expect(spool.prepare('invalid',ids,20)).rejects.toThrow();
 for(const quota of [-1,0,21,1.5,NaN,Infinity])await expect(spool.prepare('invalid',['one'],quota)).rejects.toThrow();
 handles.get('one').preparedImage=true;
 await expect(spool.prepare('prepared',['one'],20)).rejects.toThrow(/原始图片/);
 await spool.clear();
});


it.each([1,5,20])('admits at most quota+3 across writing and completed files at quota %i',async quota=>{
 const {add,spool,directory}=await fixture();
 await add('one',Buffer.from('1'));
 await spool.initialize();
 const promises=Array.from({length:quota+3},(_,i)=>spool.prepare('slot'+i,['one'],quota));
 await expect(spool.prepare('extra',['one'],quota)).rejects.toThrow(/容量/);
 await Promise.all(promises);
 await expect(spool.prepare('extra',['one'],quota)).rejects.toThrow(/容量/);
 expect(await fs.readdir(directory)).toHaveLength(quota+3);
 expect(spool.stats()).toMatchObject({bytes:quota+3,packs:quota+3,peakOutstanding:quota+3});
 await spool.release('slot0');
 await spool.prepare('extra',['one'],quota);
 await spool.clear();
 expect(spool.stats().reservedBytes).toBe(0);
});

it('reclaims partial writes and identifies disk-full errors',async()=>{
 const {directory,handles,add,source}=await fixture();
 await add('one',Buffer.alloc(900000,13));
 let writes=0;
 const io={...fs,async open(file:string,flags:string,mode?:number){
  const fd=await fs.open(file,flags,mode);
  if(flags!=='wx')return fd;
  const write=fd.write.bind(fd);
  fd.write=(async (...args:any[])=>{
   if(++writes===2)throw Object.assign(Error('full'),{code:'ENOSPC'});
   return write(...args);
  }) as any;
  return fd;
 }};
 const spool=createPackSpool({directory,handles,source,io});
 await expect(spool.prepare('k',['one'],1)).rejects.toThrow(/磁盘空间不足/);
 expect(await fs.readdir(directory)).toEqual([]);
 expect(await source('one')).toHaveProperty('size',900000);
 expect(spool.stats()).toMatchObject({bytes:0,packs:0,outstanding:0,peakBytes:256*1024});
 await spool.prepare('k',['one'],1);
 await spool.clear();
});

it('retains capacity for busy leftovers, retries unlink, and cleans crash remnants on relaunch',async()=>{
 const {directory,handles,add,source}=await fixture();
 await add('one',Buffer.from('x'));
 let busy=true;
 const spool=createPackSpool({directory,handles,source,io:{...fs,async unlink(file:string){
  if(busy)throw Object.assign(Error('locked'),{code:'EBUSY'});await fs.unlink(file);
 }}});
 await Promise.all([1,2,3,4].map(i=>spool.prepare('k'+i,['one'],1)));
 await expect(spool.release('k1')).rejects.toThrow('locked');
 expect(spool.stats()).toMatchObject({bytes:4,packs:4,outstanding:4});
 await expect(spool.prepare('k5',['one'],1)).rejects.toThrow(/容量/);
 busy=false;await spool.release('k1');
 const abandoned=await fs.readdir(directory);expect(abandoned).toHaveLength(3);
 const restarted=createPackSpool({directory,handles:new Map(),source});
 await restarted.initialize();
 expect(await fs.readdir(directory)).toEqual([]);
 expect(restarted.stats()).toMatchObject({bytes:0,packs:0,peakPacks:3});
});

it('will not write until all startup remnants have been removed, even after a failed first sweep',async()=>{
 const {directory,handles,add,source}=await fixture();
 await add('one',Buffer.from('x'));await fs.mkdir(directory);
 const leftovers=Array.from({length:4},()=>randomUUID()+'.pack');
 await Promise.all(leftovers.map(name=>fs.writeFile(path.join(directory,name),'old')));
 let busy=true;
 const spool=createPackSpool({directory,handles,source,io:{...fs,async unlink(file:string){
  if(busy)throw Object.assign(Error('locked'),{code:'EBUSY'});await fs.unlink(file);
 }}});
 await expect(spool.initialize()).rejects.toThrow('locked');
 await expect(spool.prepare('new',['one'],1)).rejects.toThrow('locked');
 expect((await fs.readdir(directory)).sort()).toEqual(leftovers.sort());
 busy=false;await spool.prepare('new',['one'],1);
 expect(spool.stats()).toMatchObject({bytes:1,packs:1,peakBytes:12});
 await spool.clear();
});

it('cancels a pending source lookup without opening a file and clears outstanding slots',async()=>{
 const {directory,handles}=await fixture();
 let started:()=>void;
 const reading=new Promise<void>(resolve=>{started=resolve});
 const spool=createPackSpool({directory,handles,source:()=>{started();return new Promise(()=>{})}});
 const pending=spool.prepare('k',['one'],1);
 await reading;
 const cancelled=expect(pending).rejects.toThrow(/暂停/);
 await spool.clear();await cancelled;
 expect(spool.stats()).toMatchObject({bytes:0,packs:0,outstanding:0});
});

it('waits for an in-flight disk write before unlink and holds the slot throughout pause',async()=>{
 const {directory,handles,add,source}=await fixture();
 await add('one',Buffer.alloc(900000,3));
 let writing:()=>void, resume:()=>void, first=true;
 const started=new Promise<void>(resolve=>{writing=resolve});
 const blocked=new Promise<void>(resolve=>{resume=resolve});
 const io={...fs,async open(file:string,flags:string,mode?:number){
  const fd=await fs.open(file,flags,mode);
  if(flags!=='wx')return fd;
  const write=fd.write.bind(fd);
  fd.write=(async (...args:any[])=>{
   if(first){first=false;writing();await blocked}
   return write(...args);
  }) as any;
  return fd;
 }};
 const spool=createPackSpool({directory,handles,source,io});
 const pending=spool.prepare('key',['one'],1);
 await started;
 const clearing=spool.clear();
 const cancelled=expect(pending).rejects.toThrow(/暂停/);
 expect(spool.stats()).toMatchObject({outstanding:1,packs:1,reservedBytes:900000});
 await expect(spool.prepare('key',['one'],1)).rejects.toThrow(/回收/);
 resume();await clearing;await cancelled;
 expect(spool.stats()).toMatchObject({outstanding:0,packs:0,bytes:0});
 expect(await fs.readdir(directory)).toEqual([]);
});

it('rejects a source changed during copying, drops the partial pack and preserves the modified original',async()=>{
 const {directory,handles,add,source}=await fixture();
 await add('one',Buffer.alloc(900000,3));
 let reads=0;
 const spool=createPackSpool({directory,handles,async source(id:string){
  if(++reads===2)await fs.appendFile(handles.get(id).path,'!');
  return source(id);
 }});
 await expect(spool.prepare('key',['one'],1)).rejects.toThrow(/source changed/);
 expect((await fs.stat(handles.get('one').path)).size).toBe(900001);
 expect(await fs.readdir(directory)).toEqual([]);
 expect(spool.stats()).toMatchObject({outstanding:0,packs:0});
});

it('checkpoints ordered membership with original handles while rejecting temporary handles',async()=>{
 const {spool,add,handles}=await fixture();await add('one',Buffer.from('x'));
 const pack=await spool.prepare('key',['one'],1);
 const item={id:'key',name:'one.png',relativePath:'one.png',nativeId:'one',size:1,
  contentType:'image/png',status:'pending',progress:0,packKey:'key',packPosition:0,packLeaseId:'lease',packRunId:'run'};
 const normalize=(row:any,mode='packed-v1')=>normalizeManifest({transportMode:mode,items:[row]},id=>handles.get(id));
 expect(normalize(item)).toMatchObject({transportMode:'packed-v1',items:[item],sources:[{id:'one'}]});
 expect(()=>normalize({...item,nativeId:pack.id})).toThrow(/源文件记录/);
 expect(()=>normalize({...item,packPosition:12})).toThrow(/成员/);
 expect(()=>normalize({...item,packLeaseId:undefined})).toThrow(/租约/);
 expect(()=>normalize({...item,packRunId:'x'.repeat(121)})).toThrow(/运行标识/);
 expect(()=>normalize(item,'unknown')).toThrow(/模式/);
 await spool.clear();
});
