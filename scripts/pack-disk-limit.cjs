// Opt-in physical spool test. Run with: node scripts/pack-disk-limit.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createPackSpool, MAX_PACK_BYTES} = require('../electron/pack-spool.cjs');

async function measure(directory) {
  const names = await fs.readdir(directory);
  const files = await Promise.all(names.map(name => fs.stat(path.join(directory, name))));
  return {fileCount: files.length, fileBytes: files.reduce((n, file) => n + file.size, 0)};
}

async function exercise(root, handles, quota) {
  const directory = path.join(root, 'spool-' + quota);
  async function source(id) {
    const file = handles.get(id);
    const info = await fs.lstat(file.path);
    assert.ok(info.isFile());
    assert.equal(info.size, file.size);
    assert.equal(info.mtimeMs, file.mtimeMs);
    return file;
  }
  const spool = createPackSpool({source, handles, directory});
  await spool.initialize();
  const count = quota + 3;
  try {
    const pending = Array.from({length: count}, (_, i) => spool.prepare('pack-' + i, ['original-a', 'original-b'], quota));
    const packs = await Promise.all(pending);
    assert.ok(packs.every(pack => pack.size === MAX_PACK_BYTES && pack.sha256 === packs[0].sha256));
    await assert.rejects(spool.prepare('extra', ['original-a', 'original-b'], quota), /容量/);
    const full = await measure(directory);
    assert.deepEqual(full, {fileCount: count, fileBytes: count * MAX_PACK_BYTES});
    const highWater = spool.stats();
    assert.equal(highWater.peakBytes, full.fileBytes);
    assert.equal(highWater.peakReservedBytes, full.fileBytes);
    await spool.clear();
    const released = await measure(directory);
    assert.deepEqual(released, {fileCount: 0, fileBytes: 0});
    assert.equal(spool.stats().outstanding, 0);
    return {quota, memberCount: 2, packBytes: MAX_PACK_BYTES, full, extraPackRejected: true, highWater, released};
  } finally { await spool.clear(); }
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yuntu-disk-limit-'));
  try {
    const handles = new Map();
    for (const [index, id] of ['original-a', 'original-b'].entries()) {
      const file = path.join(root, id + '.png');
      await fs.writeFile(file, Buffer.alloc(MAX_PACK_BYTES / 2, index + 1), {flag: 'wx'});
      const {size, mtimeMs} = await fs.stat(file);
      handles.set(id, {path: file, size, mtimeMs, contentType: 'image/png'});
    }
    const runs = [];
    for (const quota of [5, 20]) runs.push(await exercise(root, handles, quota));
    const result = {measuredAt: new Date().toISOString(), node: process.version, platform: process.platform,
      measurement: 'Sum of stat.size for all files in the dedicated spool directory, in bytes',
      runs};
    const json = JSON.stringify(result, null, 2) + '\n';
    const build = path.resolve(__dirname, '../build');
    await fs.mkdir(build, {recursive: true});
    await fs.writeFile(path.join(build, 'pack-disk-limits.json'), json);
    process.stdout.write(json);
  } finally {
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('yuntu-disk-limit-'))
      throw Error('Unexpected capacity-test cleanup path');
    await fs.rm(resolved, {recursive: true, force: true});
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
