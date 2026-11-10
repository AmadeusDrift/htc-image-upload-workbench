import {createRequire} from 'node:module';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect,it} from 'vitest';
const require = createRequire(import.meta.url);

it('restores a partial selection, updates one row durably and preserves the prior checkpoint on SQLITE_FULL', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'yuntu-checkpoint-'));
  try {
    const {openCheckpointDb} = require('../electron/checkpoint-db.cjs');
    const file = path.join(dir,'queue.sqlite');
    let db = openCheckpointDb(file);
    const meta = {ownerId:'alpha',taskId:'task',clientTaskId:'client',groupId:'group',batchMode:'chunked-v1'};
    const items = Array.from({length:100},(_,i)=>({
      position:i,item:{id:'image-'+i,name:i+'.jpg',relativePath:'A/'+i+'.jpg',
      size:42,contentType:'image/jpeg',status:'pending',progress:0},
    }));
    db.save({key:'new-key',expected:200,meta,changes:items});
    db.close();
    db = openCheckpointDb(file);
    try {
      expect(db.load('alpha')).toMatchObject({taskId:'task',expectedCount:200,savedCount:100});
      expect(db.load('beta')).toBeNull();
      const row = {...items[0],item:{...items[0].item,fileId:'f0',status:'success',progress:100}};
      db.save({key:'new-key',expected:200,meta,changes:[row]});
      expect(db.load().items[0]).toMatchObject({fileId:'f0',status:'success'});
      expect(()=>db.save({key:'new-key',expected:200,meta,changes:[{...items[1],position:101}]})).toThrow();
      db.connection.exec('PRAGMA max_page_count='+db.connection.prepare('PRAGMA page_count').get().page_count);
      const huge = items.map(({position,item})=>({position:100+position,item:{
        ...item,id:'second-'+position,relativePath:'A/'.padEnd(3900,'x'),
      }}));
      expect(()=>db.save({key:'new-key',expected:200,meta,changes:huge})).toThrow(/空间|full/i);
      expect(db.load('alpha')).toMatchObject({taskId:'task',expectedCount:200,savedCount:100});
      expect(db.load('alpha').items[0]).toMatchObject({fileId:'f0',status:'success'});
    } finally {db.close()}
  } finally {
    const resolved=path.resolve(dir);
    if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('yuntu-checkpoint-'))throw Error('Unsafe test cleanup path');
    await fs.rm(resolved,{recursive:true,force:true});
  }
});
