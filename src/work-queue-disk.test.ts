import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect, it} from 'vitest';

// Each call exits its Node process. All queue connections, handles and scanner
// state are lost. Only SQLite and the actual selected directories survive.
function runProcess(state: any, operation: string) {
  const program = `
    const fs = require('node:fs');
    const {nextGroup} = require('./electron/upload-groups.cjs');
    const {createWorkQueue} = require('./electron/work-queue.cjs');
    const state = JSON.parse(fs.readFileSync(0, 'utf8'));
    const handles = new Map();
    const scan = (source, cursor, capacity, signal) => nextGroup(source, cursor, Math.min(2, capacity), signal);
    const queue = createWorkQueue(state.db, handles, scan);
    const employee = 'operator';
    function describe(page) {
      const job = page.worklist[0];
      return {
        jobId: job.id, ticket: job.ticket, number: job.groupNumber, recovered: page.recovered,
        files: page.files.map(file => ({id: file.id, source: handles.get(file.id).path, relativePath: file.relativePath})),
      };
    }
    (async () => {${operation}})().then(value => process.stdout.write(JSON.stringify(value)))
      .catch(error => {console.error(error); process.exitCode = 1});
  `;
  const result = execFileSync(process.execPath, ['--no-warnings', '-e', program], {
    input: JSON.stringify(state), encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  return JSON.parse(result);
}

it('retains file IDs and the directory cursor across process restarts and appends overlapping sources once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuntu-disk-work-'));
  try {
    const catalog = path.join(dir, '拍摄'), sku = path.join(catalog, 'SKU-A');
    const detail = path.join(sku, '细节'), extra = path.join(catalog, 'SKU-B');
    await fs.mkdir(detail, {recursive: true}); await fs.mkdir(extra);
    const photos = [path.join(sku, '1.jpg'), path.join(sku, '2.png'), path.join(detail, '3.webp'), path.join(extra, '4.jpeg')];
    for (const file of photos) await fs.writeFile(file, 'image');
    const state = {db: path.join(dir, 'queue.sqlite'), catalog, sku};
    const first = runProcess(state, `
      const source = queue.stage(employee, [state.sku], 'folders', true);
      const [job] = await queue.enqueue(employee, source.id, '商品摄影', 'account');
      const first = describe(await queue.open(employee));
      const duplicate = queue.stage(employee, [state.sku], 'folders', true);
      const duplicateError = await queue.enqueue(employee, duplicate.id, job.name, job.groupId, job.id)
        .then(() => '', error => error.message);
      const parent = queue.stage(employee, [state.catalog], 'folders', true);
      await queue.enqueue(employee, parent.id, job.name, job.groupId, job.id);
      return {first, duplicateError};
    `);
    expect(first.duplicateError).toMatch(/已包含|重复/);
    expect(first.first.number).toBe(1);
    expect(first.first.files.map((f: any) => f.source).sort()).toEqual(photos.slice(0, 2).sort());

    const afterRestart = runProcess({...state, first: first.first}, `
      const restored = describe(await queue.open(employee));
      await queue.finish(employee, state.first.jobId, state.first.ticket, 'remote-task');
      return {restored, next: describe(await queue.open(employee))};
    `);
    expect(afterRestart.restored).toEqual({...first.first, recovered: true});
    expect(afterRestart.next).toMatchObject({jobId: first.first.jobId, number: 2});
    expect(afterRestart.next.ticket).not.toBe(first.first.ticket);
    expect(afterRestart.next.files.map((f: any) => f.source).sort()).toEqual(photos.slice(2).sort());

    const final = runProcess({...state, next: afterRestart.next}, `
      const restored = describe(await queue.open(employee));
      const [job] = await queue.finish(employee, state.next.jobId, state.next.ticket, 'remote-task');
      return {restored, job, remainingHandles: handles.size};
    `);
    expect(final.restored).toEqual({...afterRestart.next, recovered: true});
    expect(final.job).toMatchObject({id: first.first.jobId, remoteId: 'remote-task', finished: true, completed: 4, bytesDone: 20});
    expect(final.remainingHandles).toBe(0);
    expect(new Set([...first.first.files, ...afterRestart.next.files].map(file => file.id)).size).toBe(4);
  } finally {
    const target = path.resolve(dir);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yuntu-disk-work-')) throw Error('Unexpected test path');
    await fs.rm(target, {recursive: true, force: true});
  }
});

it('appends same-named export roots across restarts while preserving one product for each physical folder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuntu-disk-names-'));
  try {
    const firstSku = path.join(dir, '第一天', '货品'), nextSku = path.join(dir, '第二天', '货品');
    await fs.mkdir(firstSku, {recursive: true}); await fs.mkdir(nextSku, {recursive: true});
    const photos = [path.join(firstSku, '1.jpg'), path.join(firstSku, '2.jpg'), path.join(nextSku, '3.jpg'), path.join(nextSku, '4.jpg')];
    for (const file of photos) await fs.writeFile(file, 'x');
    const state = {db: path.join(dir, 'queue.sqlite'), photos};
    const group1 = runProcess(state, `
      const a = queue.stage(employee, [state.photos[0]], 'files', true);
      const [job] = await queue.enqueue(employee, a.id, '分批选图', 'account');
      const first = describe(await queue.open(employee));
      const mixed = queue.stage(employee, [state.photos[2], state.photos[1]], 'files', true);
      await queue.enqueue(employee, mixed.id, job.name, job.groupId, job.id);
      return first;
    `);
    expect(group1.files.map((f: any) => f.relativePath)).toEqual(['货品/1.jpg']);
    const group2 = runProcess({...state, group1}, `
      await queue.finish(employee, state.group1.jobId, state.group1.ticket, 'remote-task');
      const second = describe(await queue.open(employee));
      const later = queue.stage(employee, [state.photos[3]], 'files', true);
      await queue.enqueue(employee, later.id, '分批选图', 'account', state.group1.jobId);
      return second;
    `);
    expect(group2.files.map((f: any) => f.relativePath).sort()).toEqual(['货品/2.jpg', '第二天/货品/3.jpg'].sort());
    const group3 = runProcess({...state, group2}, `
      const restored = describe(await queue.open(employee));
      await queue.finish(employee, state.group2.jobId, state.group2.ticket, 'remote-task');
      return {restored, final: describe(await queue.open(employee))};
    `);
    expect(group3.restored).toEqual({...group2, recovered: true});
    expect(group3.final.files.map((f: any) => f.relativePath)).toEqual(['第二天/货品/4.jpg']);
  } finally {
    const target = path.resolve(dir);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yuntu-disk-names-')) throw Error('Unexpected test path');
    await fs.rm(target, {recursive: true, force: true});
  }
});
