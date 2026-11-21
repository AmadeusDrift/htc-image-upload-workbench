const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {setImmediate: yieldToEvents} = require('node:timers/promises');

const MAX_FILES = 20000;
const MAX_BYTES = 50 * 1024 * 1024;
const STAT_CONCURRENCY = 24;
const PATHS_PER_TURN = 2048;
const types = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'],
]);
const imageType = file => types.get(path.extname(file).toLowerCase());
const pathKey = file => process.platform === 'win32' ? file.toLowerCase() : file;
const folderName = dir => path.basename(dir) || path.parse(dir).root.replace(/[\\/:]+/g, '') || '根目录';
const stamp = stat => [stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs].join(',');
const invalidCursor = () => Error('上传分组进度无效，请重新选择上传来源。');
const sourceChanged = dir => Error('源目录「' + dir + '」已变化，请检查后重新选择上传来源。');

function absolutePath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw Error('上传来源路径无效。');
  return path.resolve(file);
}

async function readExclusions(entries, fingerprint, signal) {
  const exact = new Set(), recursive = new Set();
  if (entries != null && !Array.isArray(entries)) throw Error('上传来源排除范围无效。');
  if (entries?.length) fingerprint.update('exclusions\0');
  let count = 0;
  for (const entry of entries || []) {
    if (++count % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
    if (!entry || typeof entry.recurse !== 'boolean') throw Error('上传来源排除范围无效。');
    const key = pathKey(absolutePath(entry.path));
    exact.add(key);
    if (entry.recurse) recursive.add(key);
    fingerprint.update(entry.recurse ? 'r' : 's').update(key).update('\0');
  }
  return {exact, recursive};
}

function hasSelectedAncestor(file, selected) {
  let parent = path.dirname(file);
  while (parent !== file) {
    if (selected.has(pathKey(parent))) return true;
    file = parent;
    parent = path.dirname(file);
  }
  return false;
}

// Replay display roots in import order. Earlier products keep their paths when
// a later source needs a longer prefix to distinguish an identical folder name.
async function exportNameFor(buckets, selection, fingerprint, signal) {
  const labels = new Map(), topDirectories = new Map();
  function appendRelative(prefix, root, dir) {
    const relative = path.relative(root, dir).split(path.sep).join('/');
    return relative ? prefix + '/' + relative : prefix;
  }
  function inherited(dir) {
    for (let current = dir;;) {
      const label = labels.get(pathKey(current));
      if (label) return appendRelative(label, current, dir);
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
  function register(dir) {
    const key = pathKey(dir);
    if (labels.has(key)) return;
    const earlier = inherited(dir);
    if (earlier) {labels.set(key, earlier); return}
    for (let top = dir;;) {
      const owner = pathKey(top), parent = path.dirname(top);
      const name = folderName(top);
      let label = name;
      let suffix = 2;
      // At a volume root every real parent component has already been used.
      while (parent === top && topDirectories.has(pathKey(label)) && topDirectories.get(pathKey(label)) !== owner) {
        label = name + ' (' + suffix++ + ')';
      }
      const occupied = topDirectories.get(pathKey(label));
      if (!occupied || occupied === owner) {
        topDirectories.set(pathKey(label), owner);
        labels.set(key, appendRelative(label, top, dir));
        return;
      }
      top = parent;
    }
  }
  let count = 0;
  const previous = selection.referenceRoots ?? [];
  if (!Array.isArray(previous) || selection.roots != null && !Array.isArray(selection.roots)) throw Error('上传来源目录无效。');
  if (previous.length) fingerprint.update('reference-roots\0');
  for (const root of previous) {
    if (++count % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
    const absolute = absolutePath(root);
    register(absolute);
    fingerprint.update(absolute).update('\0');
  }
  if (selection.roots?.length) {
    for (const root of selection.roots) {
      if (++count % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
      register(absolutePath(root));
    }
  } else {
    for (const bucket of buckets) {
      let hasPotentialFiles = false;
      for (const file of bucket.paths) {
        if (++count % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
        register(file);
        if (imageType(file)) hasPotentialFiles = true;
      }
      if (!bucket.parentSelected && hasPotentialFiles) register(bucket.dir);
    }
  }
  return (dir, fallback) => labels.get(pathKey(dir)) || fallback || inherited(dir) || folderName(dir);
}

// Only the paths the user explicitly selected are indexed. Direct files from
// the same parent form one product even if their selection order interleaves.
async function planSelection(selection, signal) {
  if (!selection || !Array.isArray(selection.paths)) throw Error('上传来源选择无效。');
  const recurse = selection.recurse !== false;
  const selected = new Map();
  const fingerprint = createHash('sha256').update(recurse ? 'recursive\0' : 'shallow\0');
  let count = 0;
  for (const file of selection.paths) {
    if (++count % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
    const absolute = absolutePath(file);
    const key = pathKey(absolute);
    if (selected.has(key)) continue;
    selected.set(key, absolute);
    fingerprint.update(absolute).update('\0');
  }
  const excluded = await readExclusions(selection.exclude, fingerprint, signal);
  const byParent = new Map();
  for (const file of selected.values()) {
    if (++count % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
    if (excluded.recursive.size && (excluded.recursive.has(pathKey(file)) || hasSelectedAncestor(file, excluded.recursive))) continue;
    if (recurse && hasSelectedAncestor(file, selected)) continue;
    const dir = path.dirname(file), key = pathKey(dir);
    let bucket = byParent.get(key);
    if (!bucket) {
      bucket = {dir, paths: [], parentSelected: selected.has(key) || excluded.exact.has(key)};
      byParent.set(key, bucket);
    }
    bucket.paths.push(file);
  }
  const buckets = [...byParent.values()];
  const exportName = await exportNameFor(buckets, selection, fingerprint, signal);
  for (const bucket of buckets) {
    bucket.excluded = excluded;
    bucket.exportName = exportName;
  }
  return {buckets, key: fingerprint.digest('base64url'), recurse};
}

async function verifyDirectory(frame) {
  let stat;
  try {stat = await fs.lstat(frame.dir)} catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw sourceChanged(frame.dir);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stamp(stat) !== frame.data.stamp) throw sourceChanged(frame.dir);
}

function selectedFrame(bucket, data = {stage: 'files', offset: 0}) {
  return {bucket, exportName: bucket.exportName, excluded: bucket.excluded, dir: bucket.dir, prefix: bucket.exportName(bucket.dir), data};
}

function directoryFrame(parent, dir, data) {
  const prefix = parent.exportName(dir, parent.bucket ? undefined : parent.prefix + '/' + data.name);
  return {dir, prefix, exportName: parent.exportName, excluded: parent.excluded, data};
}

async function restoreFrames(cursor, bucket, signal) {
  const stack = [];
  for (const saved of cursor.frames) {
    signal?.throwIfAborted();
    if (!saved || !['files', 'children'].includes(saved.stage) || !Number.isSafeInteger(saved.offset) || saved.offset < 0) throw invalidCursor();
    const data = {...saved};
    if (!stack.length) {
      if (data.offset > bucket.paths.length) throw invalidCursor();
      stack.push(selectedFrame(bucket, data));
      continue;
    }
    const parent = stack.at(-1);
    if (parent.data.stage !== 'children' || !parent.data.offset || typeof data.stamp !== 'string') throw invalidCursor();
    let dir;
    if (parent.bucket) {
      dir = bucket.paths[parent.data.offset - 1];
      if (data.name !== path.basename(dir)) throw invalidCursor();
    } else {
      if (!data.name || data.name === '.' || data.name === '..' || path.basename(data.name) !== data.name || data.name.includes('\0')) throw invalidCursor();
      dir = path.join(parent.dir, data.name);
    }
    const frame = directoryFrame(parent, dir, data);
    await verifyDirectory(frame);
    stack.push(frame);
  }
  return stack;
}

// Stop at the first supported image that cannot fit. Its entire product will
// be read from the start in the next group. File contents are never opened.
async function readProduct(frame, room, recurse, signal) {
  const files = [], pending = [];
  let hasChildren = false, imageNamedChild = false;
  if (!frame.bucket && frame.excluded.exact.has(pathKey(frame.dir))) {
    return {files, hasChildren: recurse};
  }

  async function flush() {
    if (!pending.length) return;
    signal?.throwIfAborted();
    const stats = await Promise.all(pending.map(file => fs.lstat(file)));
    signal?.throwIfAborted();
    for (let i = 0; i < stats.length; i++) {
      const stat = stats[i], file = pending[i];
      if (frame.bucket && stat.isDirectory() && !stat.isSymbolicLink()) {
        imageNamedChild = true;
        hasChildren = true;
        continue;
      }
      if (!frame.bucket && (stat.isSymbolicLink() || !stat.isFile())) throw sourceChanged(frame.dir);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) continue;
      const name = path.basename(file);
      files.push({path: file, relativePath: frame.prefix + '/' + name, name, size: stat.size, mtimeMs: stat.mtimeMs, contentType: imageType(name)});
    }
    pending.length = 0;
  }

  function needsFlush() {
    return pending.length >= Math.min(STAT_CONCURRENCY, room + 1 - files.length);
  }

  if (frame.bucket) {
    let count = 0;
    for (const file of frame.bucket.paths) {
      if (++count % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
      signal?.throwIfAborted();
      if (frame.bucket.parentSelected || !imageType(file)) {
        hasChildren = true;
        continue;
      }
      if (frame.excluded.exact.has(pathKey(file))) {
        // A shallow excluded path can itself be an explicitly selected folder
        // named e.g. "product.jpg". Inspect it only when reaching child roots.
        imageNamedChild = true;
        hasChildren = true;
        continue;
      }
      pending.push(file);
      if (needsFlush()) await flush();
      if (files.length > room) break;
    }
  } else {
    const directory = await fs.opendir(frame.dir);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && recurse) hasChildren = true;
      if (!entry.isFile() || !imageType(entry.name)) continue;
      const file = path.join(frame.dir, entry.name);
      if (frame.excluded.exact.size && frame.excluded.exact.has(pathKey(file))) continue;
      pending.push(file);
      if (needsFlush()) await flush();
      if (files.length > room) break;
    }
  }
  await flush();
  if (!frame.bucket) await verifyDirectory(frame);
  return {files, hasChildren, skipImageNames: !frame.bucket?.parentSelected && !imageNamedChild};
}

function hashEntry(hash, entry) {
  hash.update(entry.isDirectory() ? 'd' : 'f').update(entry.name).update('\0');
}

// fs.Dir handles stay open only for this call. Across calls, verify both the
// directory identity and its consumed entry prefix before continuing an offset.
async function openChildStream(frame, signal) {
  frame.stream = await fs.opendir(frame.dir);
  frame.hash = createHash('sha256');
  for (let i = 0; i < frame.data.offset; i++) {
    signal?.throwIfAborted();
    const entry = await frame.stream.read();
    if (!entry) throw sourceChanged(frame.dir);
    hashEntry(frame.hash, entry);
  }
  if (frame.data.offset && frame.hash.copy().digest('base64url') !== frame.data.digest) throw sourceChanged(frame.dir);
}

async function nextDirectory(frame, signal) {
  for (;;) {
    signal?.throwIfAborted();
    let dir;
    if (frame.bucket) {
      if (frame.data.offset >= frame.bucket.paths.length) return null;
      dir = frame.bucket.paths[frame.data.offset++];
      if (frame.data.offset % PATHS_PER_TURN === 0) await yieldToEvents(undefined, {signal});
      if (frame.data.skipImageNames && imageType(dir)) continue;
    } else {
      if (!frame.stream) await openChildStream(frame, signal);
      const entry = await frame.stream.read();
      if (!entry) {
        await verifyDirectory(frame);
        return null;
      }
      frame.data.offset++;
      hashEntry(frame.hash, entry);
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      dir = path.join(frame.dir, entry.name);
      if (frame.excluded.recursive.has(pathKey(dir))) continue;
    }
    const stat = await fs.lstat(dir);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      return directoryFrame(frame, dir, {name: path.basename(dir), stage: 'files', offset: 0, stamp: stamp(stat)});
    }
    if (!frame.bucket) throw sourceChanged(frame.dir);
  }
}

/**
 * Read whole product directories into the available slots. An empty unfinished
 * result with capacity < MAX_FILES lets an existing group close before retry.
 * Advance a stored cursor only after its returned files are safely persisted.
 */
async function nextGroup(selection, cursor, capacity = MAX_FILES, signal) {
  signal?.throwIfAborted();
  const {buckets, key, recurse} = await planSelection(selection, signal);
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw Error('上传分组容量无效。');
  capacity = Math.min(capacity, MAX_FILES);
  if (cursor != null) {
    if (cursor.version !== 1 || cursor.key !== key) throw Error('上传来源选择已变化，请重新选择。');
    if (!Number.isSafeInteger(cursor.bucket) || cursor.bucket < 0 || cursor.bucket >= buckets.length || !Array.isArray(cursor.frames)) throw invalidCursor();
  }
  let index = cursor?.bucket ?? 0;
  const stack = cursor ? await restoreFrames(cursor, buckets[index], signal) : [];
  const files = [];
  async function popFrame() {
    const frame = stack.at(-1);
    if (frame.stream) await frame.stream.close();
    stack.pop();
    if (!stack.length) index++;
  }
  try {
    while (index < buckets.length && files.length < capacity) {
      signal?.throwIfAborted();
      if (!stack.length) stack.push(selectedFrame(buckets[index]));
      const frame = stack.at(-1);
      if (frame.data.stage === 'files') {
        const room = capacity - files.length;
        const product = await readProduct(frame, room, recurse, signal);
        if (product.files.length > room) {
          if (room === MAX_FILES) throw Error('产品目录「' + frame.dir + '」超过单组 20000 张图片上限，请拆分此目录后重试。');
          break;
        }
        for (const file of product.files) files.push(file);
        if (product.hasChildren) {
          frame.data.stage = 'children';
          if (frame.bucket) frame.data.skipImageNames = product.skipImageNames;
        } else {
          await popFrame();
        }
      } else {
        const child = await nextDirectory(frame, signal);
        if (child) stack.push(child);
        else await popFrame();
      }
      if (stack.length === 1 && stack[0].data.stage === 'children' && stack[0].data.offset === buckets[index].paths.length) {
        await popFrame();
      }
    }
    signal?.throwIfAborted();
    if (index === buckets.length) return {files, cursor: null, done: true};
    for (const frame of stack) {
      if (!frame.bucket) await verifyDirectory(frame);
      if (frame.hash && frame.data.offset) frame.data.digest = frame.hash.copy().digest('base64url');
    }
    signal?.throwIfAborted();
    return {files, cursor: {version: 1, key, bucket: index, frames: stack.map(frame => frame.data)}, done: false};
  } finally {
    await Promise.all(stack.filter(frame => frame.stream).map(frame => frame.stream.close()));
  }
}

module.exports = {nextGroup};
