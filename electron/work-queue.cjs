const path = require('node:path');
const crypto = require('node:crypto');
const {DatabaseSync} = require('node:sqlite');
const {nextGroup} = require('./upload-groups.cjs');

const CAPACITY = 20000;
const pathKey = p => process.platform === 'win32' ? p.toLowerCase() : p;

function insideSelection(file, paths) {
  for (let current = file;;) {
    const parent = path.dirname(current);
    if (parent === current) return false;
    if (paths.has(parent)) return true;
    current = parent;
  }
}

function addSource(target, entry) {
  const known = new Set(), recursive = new Set();
  for (const input of target.inputs) {
    for (const file of input.paths) {
      const key = pathKey(file);
      known.add(key);
      if (input.recurse) recursive.add(key);
    }
  }
  const paths = entry.paths.filter(file => {
    const key = pathKey(file);
    if (recursive.has(key) || insideSelection(key, recursive)) return false;
    if (entry.kind === 'files' && known.has(path.dirname(key))) return false;
    return !known.has(key) || entry.recurse && entry.kind !== 'files';
  });
  if (!paths.length) throw Error('此任务已包含所选来源');

  // A cursor is valid for precisely its original selection. Only combine
  // selections that have not started, so photos selected twice from one SKU
  // can still enter the same indivisible directory set.
  let input = target.inputs.at(-1);
  if (!input || input.cursor || input.done || input.recurse !== entry.recurse) {
    input = {paths:[], roots:[], recurse:entry.recurse, cursor:null, done:false};
    target.inputs.push(input);
  }
  input.paths = [...new Set([...input.paths, ...paths])];
  input.roots = [...new Set([...input.roots, ...entry.roots])];
  // If a newly selected parent contains a source reserved by an earlier
  // group, the scanner skips that source even after the app restarts.
  const selected = new Set(input.paths.map(pathKey));
  const parents = new Set([...selected].map(file => path.dirname(file)));
  const excluded = new Map();
  const earlierRoots = new Set();
  for (const earlier of target.inputs) {
    if (earlier === input) break;
    for (const root of earlier.roots) earlierRoots.add(root);
    for (const file of earlier.paths) {
      const key = pathKey(file);
      if (selected.has(key) || insideSelection(key, selected) || !earlier.recurse && parents.has(key)) {
        excluded.set(key, {path:file, recurse:earlier.recurse || excluded.get(key)?.recurse === true});
      }
    }
  }
  if (excluded.size) input.exclude = [...excluded.values()];
  if (earlierRoots.size) input.referenceRoots = [...earlierRoots];
}

function nonempty(value, limit, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || value.includes('\0')) throw Error(label + '无效');
  return value.trim();
}
function createWorkQueue(file, handles, scan = nextGroup) {
  let db;
  let chain = Promise.resolve();
  const scans = new Map();
  const pending = new Map();
  function database() {
    if (!db) {
      db = new DatabaseSync(file);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS plans(owner TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pages(owner TEXT PRIMARY KEY,ticket TEXT NOT NULL, files TEXT NOT NULL)');
    }
    return db;
  }
  function serialized(owner, operation) {
    nonempty(owner,150,'员工标识');
    const work = chain.then(() => operation(database()));
    chain = work.catch(() => {});
    return work;
  }
  function read(owner) { return JSON.parse(db.prepare('SELECT data FROM plans WHERE owner=?').get(owner)?.data || '[]'); }
  function save(owner,jobs) { db.prepare('INSERT INTO plans VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET data=excluded.data').run(owner,JSON.stringify(jobs)); }
  function mutate(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function view(jobs) {
    return jobs.map(({inputs,...job}) => ({...job, paths:[...new Set(inputs.flatMap(i=>i.roots))], lastGroup:inputs.every(i=>i.done)}));
  }
  function loadFiles(files) {
    return files.map(f => {
      handles.set(f.id,f);
      return {id:f.id,name:f.name,relativePath:f.relativePath,size:f.size,contentType:f.contentType};
    });
  }
  return {
    stage(owner, paths, kind, recurse) {
      nonempty(owner,150,'员工标识');
      if (!paths.length) return;
      if (paths.some(p=>typeof p!=='string'||!path.isAbsolute(p)||p.includes('\0'))) throw Error('素材路径无效');
      const selected = [...new Set(paths.map(p=>path.normalize(p)))];
      const roots = [...new Set(selected.map(p=>kind==='files'||(kind==='drop'&&/\.(jpe?g|png|webp)$/i.test(p)) ? path.dirname(p) : p))];
      const id = crypto.randomUUID();
      for (const [key,entry] of pending) if (entry.owner===owner) pending.delete(key);
      pending.set(id,{owner,paths:selected,roots,recurse,kind});
      return {id,paths:roots,name:(path.basename(roots[0])||'图片')+'上架'};
    },
    list(owner) { return serialized(owner,()=>view(read(owner))); },
    discard(owner,id) { if(pending.get(id)?.owner===owner) pending.delete(id); },
    stop(owner) { scans.get(owner)?.controller.abort(); },
    get scanning() { return scans.size>0; },
    enqueue(owner, id, name, groupId, targetId) {
      return serialized(owner,()=>{
        const entry = pending.get(id);
        if (!entry || entry.owner !== owner) throw Error('素材选择已过期，请重新选择');
        const jobs = read(owner).filter(j=>!j.finished);
        let target = jobs.find(j=>j.id===targetId);
        groupId = nonempty(groupId,150,'业务账号');
        if (targetId && (!target || target.groupId!==groupId)) throw Error('所选任务已结束或属于其他业务账号');
        if (!target) {
          target = {id:crypto.randomUUID(),name:nonempty(name,200,'任务名称'),groupId,groupNumber:0,completed:0,bytesDone:0,inputs:[]};
          jobs.push(target);
        }
        addSource(target,entry);
        save(owner,jobs);
        pending.delete(id);
        return view(jobs);
      });
    },
    rename(owner,id,name) {
      return serialized(owner,()=>{
        const jobs=read(owner), job=jobs.find(j=>j.id===id);
        if (!job) throw Error('本地任务不存在');
        job.name=nonempty(name,200,'任务名称'); save(owner,jobs);
        return view(jobs);
      });
    },
    open(owner) {
      if (scans.has(owner)) return scans.get(owner).work;
      const controller=new AbortController();
      const work=serialized(owner,async()=>{
        controller.signal.throwIfAborted();
        const jobs=read(owner), job=jobs[0];
        const result = files=>({worklist:view(jobs),files});
        if (!job || job.finished) return result([]);
        const existing=db.prepare('SELECT * FROM pages WHERE owner=?').get(owner);
        if (existing) {
          if (existing.ticket!==job.ticket) throw Error('当前分组与本地任务不一致');
          return {...result(loadFiles(JSON.parse(existing.files))),recovered:true};
        }
        const files=[];
        for (const input of job.inputs) {
          if (input.done) continue;
          const page=await scan(input,input.cursor,CAPACITY-files.length,controller.signal);
          controller.signal.throwIfAborted();
          if (page.files.length+files.length>CAPACITY) throw Error('分组超过 20,000 张');
          for (const item of page.files) files.push({...item,id:crypto.randomUUID()});
          input.cursor=page.cursor; input.done=page.done;
          if (!page.done || files.length===CAPACITY) break;
        }
        if (!files.length) {
          if (!job.inputs.every(i=>i.done)) throw Error('整套图片无法装入一个分组');
          if (!job.completed) throw Error('所选来源没有可上传的图片，请更换来源或移除此任务');
          job.finished=true;
          if (jobs.length>1) jobs.shift();
          save(owner,jobs);
          return result([]);
        }
        job.ticket=crypto.randomUUID(); job.groupNumber++;
        mutate(()=>{
          db.prepare('INSERT INTO pages VALUES(?,?,?)').run(owner,job.ticket,JSON.stringify(files));
          save(owner,jobs);
        });
        return result(loadFiles(files));
      }).finally(()=>scans.delete(owner));
      scans.set(owner,{controller,work});
      return work;
    },
    finish(owner,id,ticket,remoteId) {
      return serialized(owner,()=>{
        const jobs=read(owner), job=jobs[0];
        if (!job||job.id!==id||job.ticket!==ticket) throw Error('分组已切换，请重新读取任务');
        const page=db.prepare('SELECT files FROM pages WHERE owner=? AND ticket=?').get(owner,ticket);
        if (!page) throw Error('分组清单缺失');
        const files=JSON.parse(page.files);
        job.remoteId=nonempty(remoteId,150,'服务端任务');
        job.completed+=files.length;
        job.bytesDone+=files.reduce((n,f)=>n+f.size,0);
        delete job.ticket;
        job.finished=job.inputs.every(i=>i.done);
        if (job.finished && jobs.length>1) jobs.shift();
        mutate(()=>{ db.prepare('DELETE FROM pages WHERE owner=?').run(owner); save(owner,jobs); });
        for (const f of files) handles.delete(f.id);
        return view(jobs);
      });
    },
    clear(owner,id) {
      return serialized(owner,()=>{
        const jobs=read(owner);
        if (!jobs[0] || jobs[0].id!==id) return view(jobs);
        const page=db.prepare('SELECT files FROM pages WHERE owner=?').get(owner);
        jobs.shift();
        mutate(()=>{db.prepare('DELETE FROM pages WHERE owner=?').run(owner);save(owner,jobs);});
        if(page) for(const f of JSON.parse(page.files)) handles.delete(f.id);
        return view(jobs);
      });
    },
  };
}
module.exports={createWorkQueue};
