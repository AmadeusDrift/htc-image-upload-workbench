const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MAX_ENTRIES = 12;
const MAX_PACK_BYTES = 24 * 1024 * 1024;
const MAX_PUTS = 20;
const LOOKAHEAD = 3;
const SPOOL_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pack$/i;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function createPackSpool({source, handles, directory, io = fs.promises}) {
  const jobs = new Map();
  const orphans = new Map();
  const peaks = {peakBytes: 0, peakPacks: 0, peakReservedBytes: 0, peakOutstanding: 0};
  let initialized, clearing;

  function stats() {
    let bytes = 0, packs = orphans.size, reservedBytes = 0;
    for (const size of orphans.values()) bytes += size;
    reservedBytes += bytes;
    for (const job of jobs.values()) {
      bytes += job.bytes;
      reservedBytes += job.reserved;
      if (job.created) packs++;
    }
    const outstanding = jobs.size + orphans.size;
    peaks.peakBytes = Math.max(peaks.peakBytes, bytes);
    peaks.peakPacks = Math.max(peaks.peakPacks, packs);
    peaks.peakReservedBytes = Math.max(peaks.peakReservedBytes, reservedBytes);
    peaks.peakOutstanding = Math.max(peaks.peakOutstanding, outstanding);
    return {bytes, packs, reservedBytes, outstanding, ...peaks};
  }

  async function sweep() {
    await io.mkdir(directory, {recursive: true, mode: 0o700});
    if (!(await io.lstat(directory)).isDirectory()) throw Error('临时上传目录无效');
    // The application holds its single-instance lock before initializing this directory.
    for (const name of await io.readdir(directory)) {
      const file = path.join(directory, name);
      if (!SPOOL_NAME.test(name)) throw Error('临时上传目录包含未知文件，请检查缓存目录');
      const info = await io.lstat(file);
      if (!info.isFile()) throw Error('临时上传文件无效，请检查缓存目录');
      orphans.set(name, info.size);
    }
    stats();
    for (const name of orphans.keys()) {
      await unlink(path.join(directory, name));
      orphans.delete(name);
    }
  }

  function initialize() {
    if (!initialized) initialized = sweep().catch(error => { initialized = undefined; throw error; });
    return initialized;
  }

  async function unlink(file) {
    try { await io.unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  function check(job) {
    if (job.cancelled) throw Error('临时上传包制作已暂停');
  }

  function checkFile(file, info) {
    if (!info.isFile() || info.size !== file.size || info.mtimeMs !== file.mtimeMs)
      throw Error('源文件已变化，请重新选择');
  }

  async function copyEntry(job, output, id, file, wholeHash, buffer) {
    const selected = await io.lstat(file.path);
    checkFile(file, selected);
    const reader = await io.open(file.path, 'r');
    const digest = createHash('sha256');
    const start = job.bytes;
    try {
      const opened = await reader.stat();
      checkFile(file, opened);
      if (opened.dev !== selected.dev || opened.ino !== selected.ino) throw Error('源文件已变化，请重新选择');
      while (job.bytes - start < file.size) {
        check(job);
        const length = Math.min(buffer.length, file.size - (job.bytes - start));
        const {bytesRead} = await reader.read(buffer, 0, length, null);
        if (!bytesRead) throw Error('源文件已变化，请重新选择');
        const chunk = buffer.subarray(0, bytesRead);
        digest.update(chunk);
        wholeHash.update(chunk);
        let written = 0;
        while (written < bytesRead) {
          check(job);
          const {bytesWritten} = await output.write(chunk, written, bytesRead - written, null);
          if (!bytesWritten) throw Error('临时包写入失败，请检查磁盘空间');
          written += bytesWritten;
          job.bytes += bytesWritten;
          stats();
        }
      }
      checkFile(file, await reader.stat());
      await Promise.race([source(id), job.stopped]);
      return {id, offset: start, size: file.size, sha256: digest.digest('hex')};
    } finally { await reader.close(); }
  }

  async function remove(job) {
    handles.delete(job.id);
    if (job.created) await unlink(job.path);
    // A failed unlink keeps the slot and its byte reservation until a later release succeeds.
    jobs.delete(job.key);
  }

  async function build(job) {
    try {
      await initialize();
      const inputs = [];
      for (const id of job.ids) {
        check(job);
        const file = await Promise.race([source(id), job.stopped]);
        if (file.temporaryPack || file.preparedImage || !IMAGE_TYPES.has(file.contentType))
          throw Error('上传包只能包含已选择的原始图片');
        if (!Number.isSafeInteger(file.size) || file.size < 1 || job.reserved + file.size > MAX_PACK_BYTES)
          throw Error('上传包最多 24 MiB，超大图片请单独上传');
        job.reserved += file.size;
        inputs.push(file);
      }
      check(job);
      stats();
      const output = await io.open(job.path, 'wx', 0o600);
      job.created = true;
      stats();
      const entries = [], wholeHash = createHash('sha256');
      let info;
      try {
        const buffer = Buffer.allocUnsafe(Math.min(job.reserved, 256 * 1024));
        for (const [index, file] of inputs.entries())
          entries.push(await copyEntry(job, output, job.ids[index], file, wholeHash, buffer));
        info = await output.stat();
        if (info.size !== job.reserved) throw Error('临时上传包大小不符');
      } finally { await output.close(); }
      check(job);
      const sha256 = wholeHash.digest('hex');
      handles.set(job.id, {path: job.path, size: info.size, mtimeMs: info.mtimeMs,
        contentType: 'application/octet-stream', temporaryPack: true, packKey: job.key, sha256});
      return {id: job.id, size: info.size, sha256, entries};
    } catch (error) {
      await remove(job);
      if (error.code === 'ENOSPC' || error.code === 'EDQUOT')
        throw Error('临时上传包写入失败：磁盘空间不足，请释放空间后继续');
      throw error;
    }
  }

  async function prepare(key, ids, quota) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(key) ||
        !Array.isArray(ids) || !ids.length || ids.length > MAX_ENTRIES ||
        ids.some(id => typeof id !== 'string' || !id.length || id.length > 150) ||
        !Number.isInteger(quota) || quota < 1 || quota > MAX_PUTS) throw Error('上传包参数无效');
    if (clearing) throw Error('正在回收临时上传包');
    const existing = jobs.get(key);
    if (existing) {
      if (existing.cancelled || ids.length !== existing.ids.length || ids.some((id, i) => existing.ids[i] !== id))
        throw Error('上传包已取消或成员发生变化');
      return existing.promise;
    }
    // Each outstanding key owns exactly one pathname, at most 24 MiB, until unlink succeeds.
    // Reserve synchronously before any source lookup or open can interleave with another request.
    // A failed startup sweep blocks every writer in initialize() until all orphans are gone.
    if (jobs.size >= quota + LOOKAHEAD) throw Error('临时上传包已达到并发容量，请等待上传完成');
    const id = randomUUID();
    const job = {key, id, ids: [...ids], path: path.join(directory, id + '.pack'),
      bytes: 0, reserved: 0, created: false, cancelled: false};
    job.stopped = new Promise((_resolve, reject) => { job.stop = reject; });
    void job.stopped.catch(() => {});
    jobs.set(key, job);
    stats();
    job.promise = build(job);
    return job.promise;
  }

  async function release(key, expectedId) {
    const job = jobs.get(key);
    if (!job || (expectedId !== undefined && job.id !== expectedId)) return false;
    if (!job.releasing) {
      job.cancelled = true;
      job.stop(Error('临时上传包制作已暂停'));
      job.releasing = (async () => {
        try { await job.promise; } catch { /* build also rolls back partial writes */ }
        if (jobs.get(key) === job) await remove(job);
        return true;
      })().finally(() => { job.releasing = undefined; });
    }
    return job.releasing;
  }

  function clear() {
    if (!clearing) clearing = Promise.allSettled([...jobs.keys()].map(key => release(key))).then(results => {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    }).finally(() => { clearing = undefined; });
    return clearing;
  }
  return {initialize, prepare, release, clear, stats};
}

module.exports = {createPackSpool, MAX_PACK_BYTES, MAX_ENTRIES};
