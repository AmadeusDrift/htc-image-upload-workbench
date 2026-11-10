const {DatabaseSync}=require('node:sqlite');

function openCheckpointDb(file) {
 const db=new DatabaseSync(file,{timeout:3000});
 db.exec(`
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=FULL;
  PRAGMA wal_autocheckpoint=256;
  CREATE TABLE IF NOT EXISTS checkpoint (
   owner TEXT PRIMARY KEY, queueKey TEXT NOT NULL, expected INTEGER NOT NULL,
   saved INTEGER NOT NULL, meta TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS checkpoint_item (
   owner TEXT NOT NULL, position INTEGER NOT NULL, itemId TEXT NOT NULL,
   data TEXT NOT NULL, source TEXT,
   PRIMARY KEY(owner,position), UNIQUE(owner,itemId)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS checkpoint_active (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL);
 `);
 const get=db.prepare('SELECT * FROM checkpoint WHERE owner=?');
 const getActive=db.prepare('SELECT owner FROM checkpoint_active WHERE id=1');
 const deleteRows=db.prepare('DELETE FROM checkpoint_item WHERE owner=?');
 const getRows=db.prepare('SELECT position,data,source FROM checkpoint_item WHERE owner=? ORDER BY position');
 const upsert=db.prepare(`INSERT INTO checkpoint_item(owner,position,itemId,data,source) VALUES(?,?,?,?,?)
  ON CONFLICT(owner,position) DO UPDATE SET data=excluded.data,source=excluded.source
  WHERE checkpoint_item.itemId=excluded.itemId AND
   (checkpoint_item.data IS NOT excluded.data OR checkpoint_item.source IS NOT excluded.source)`);
 const at=db.prepare('SELECT itemId FROM checkpoint_item WHERE owner=? AND position=?');
 const writeHeader=db.prepare(`INSERT INTO checkpoint(owner,queueKey,expected,saved,meta) VALUES(?,?,?,?,?)
  ON CONFLICT(owner) DO UPDATE SET queueKey=excluded.queueKey,expected=excluded.expected,saved=excluded.saved,meta=excluded.meta
  WHERE checkpoint.queueKey IS NOT excluded.queueKey OR checkpoint.expected IS NOT excluded.expected
   OR checkpoint.saved IS NOT excluded.saved OR checkpoint.meta IS NOT excluded.meta`);
 const setActive=db.prepare(`INSERT INTO checkpoint_active VALUES(1,?)
  ON CONFLICT(id) DO UPDATE SET owner=excluded.owner WHERE checkpoint_active.owner IS NOT excluded.owner`);
 return {
  save({key,expected,meta,changes}) {
   const owner=meta.ownerId;
   db.exec('BEGIN IMMEDIATE');
   try {
    const current=get.get(owner);
    const replacing=current?.queueKey!==key;
    if(replacing && current)deleteRows.run(owner);
    let saved=replacing?0:current.saved;
    if(saved>expected)throw Error('本地清单的图片数量不能缩减');
    for(const {position,item,source} of changes){
     if(position>saved || position>=expected)throw Error('本地清单缺少前面的记录');
     const result=upsert.run(owner,position,item.id,JSON.stringify(item),source?JSON.stringify(source):null);
     if(!result.changes && at.get(owner,position)?.itemId!==item.id)throw Error('本地清单中的图片编号已变化');
     if(position===saved)saved++;
    }
    writeHeader.run(owner,key,expected,saved,JSON.stringify(meta));
    setActive.run(owner);
    db.exec('COMMIT');
    return saved;
   } catch(error) {
    if(db.isTransaction)db.exec('ROLLBACK');
    if(error.errcode===13)throw Error('本地进度写入失败：磁盘空间不足，请释放空间后继续');
    throw error;
   }
  },
  load(owner) {
   owner ??= getActive.get()?.owner;
   if(!owner)return null;
   const header=get.get(owner);
   if(!header)return null;
   const items=[], sources=new Map();
   for(const row of getRows.iterate(owner)){
    if(row.position!==items.length)throw Error('本地上传清单不完整');
    items.push(JSON.parse(row.data));
    if(row.source){const source=JSON.parse(row.source);sources.set(source.id,source)}
   }
   if(items.length!==header.saved)throw Error('本地上传清单记录数不符');
   return {...JSON.parse(header.meta),items,sources:[...sources.values()],
    checkpointKey:header.queueKey,savedCount:header.saved,expectedCount:header.expected};
  },
  close:()=>db.close(),
  connection:db,
 };
}

module.exports={openCheckpointDb};
