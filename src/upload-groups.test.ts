import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {expect, it} from 'vitest';

const require = createRequire(import.meta.url);
const scan = (...args: any[]) => require('../electron/upload-groups.cjs').nextGroup(...args);

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yuntu-product-groups-'));
  try {await run(dir)} finally {
    const target = path.resolve(dir);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith('yuntu-product-groups-')) throw Error('Unexpected test path');
    await fs.rm(target, {recursive: true, force: true});
  }
}

it('preserves export directories, filters files and ignores overlapping selections', async () => {
  await fixture(async dir => {
    const root = path.join(dir, '货品');
    const child = path.join(root, '商品一');
    await fs.mkdir(child, {recursive: true});
    const image = path.join(child, '侧面.WEBP');
    await fs.writeFile(image, 'four');
    await fs.writeFile(path.join(root, '封面.JPEG'), '123');
    await fs.writeFile(path.join(child, '空.png'), '');
    await fs.writeFile(path.join(child, '说明.txt'), 'text');
    const oversize = await fs.open(path.join(child, '过大.jpg'), 'w');
    try {await oversize.truncate(50 * 1024 * 1024 + 1)} finally {await oversize.close()}
    const recursive = await scan({paths: [image, child, root, image], recurse: true}, null);
    expect(recursive.done).toBe(true);
    expect(recursive.files.map((file: any) => file.relativePath).sort()).toEqual(['货品/商品一/侧面.WEBP', '货品/封面.JPEG']);
    expect(recursive.files.find((file: any) => file.path === image)).toMatchObject({
      name: '侧面.WEBP', size: 4, mtimeMs: (await fs.lstat(image)).mtimeMs, contentType: 'image/webp',
    });
    const shallow = await scan({paths: [root], recurse: false}, null);
    expect(shallow.files.map((file: any) => file.relativePath)).toEqual(['货品/封面.JPEG']);
    const explicit = await scan({paths: [image, child, root], recurse: false}, null);
    expect(explicit.files.map((file: any) => file.path).sort()).toEqual([image, path.join(root, '封面.JPEG')].sort());
  });
});

it('skips scanned and explicitly selected directory links', async context => {
  await fixture(async dir => {
    const root = path.join(dir, '货品'), outside = path.join(dir, '外部'), link = path.join(root, '链接.jpg');
    await fs.mkdir(root); await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, '1.png'), 'x');
    await fs.writeFile(path.join(root, '2.jpg'), 'x');
    try {await fs.symlink(outside, link, 'junction')} catch (error) {
      if (process.platform === 'win32' && error.code === 'EPERM') return context.skip('This Windows policy prevents creating a test junction');
      throw error;
    }
    expect((await scan({paths: [link], recurse: true}, null)).files).toEqual([]);
    const result = await scan({paths: [root], recurse: true}, null);
    expect(result.files.map((file: any) => file.relativePath)).toEqual(['货品/2.jpg']);
  });
});

it('keeps identically named products under separate relative directories across picked roots', async () => {
  await fixture(async dir => {
    const first = path.join(dir, '场次甲', '同款'), second = path.join(dir, '场次乙', '同款');
    const third = path.join(dir, '补拍', '场次乙');
    for (const folder of [first, second, path.join(third, '同款')]) {
      await fs.mkdir(folder, {recursive: true});
      await fs.writeFile(path.join(folder, '1.jpg'), 'x');
    }
    const result = await scan({paths: [first, second, third], recurse: true}, null);
    expect(result.files.map((file: any) => file.relativePath).sort()).toEqual(
      ['同款/1.jpg', '场次乙/同款/1.jpg', '补拍/场次乙/同款/1.jpg'].sort(),
    );
  });
});

it('keeps a previously selected file and later photos in its parent under the same export product', async () => {
  await fixture(async dir => {
    const root = path.join(dir, '新合集'), sku = path.join(root, 'SKU');
    await fs.mkdir(sku, {recursive: true});
    const first = path.join(sku, '1.jpg'), later = path.join(sku, '2.jpg');
    await fs.writeFile(first, 'x'); await fs.writeFile(later, 'x');
    expect((await scan({paths: [first], recurse: true}, null)).files[0].relativePath).toBe('SKU/1.jpg');
    const selection = {paths: [root], roots: [root], referenceRoots: [sku], recurse: true, exclude: [{path: first, recurse: true}]};
    const appended = await scan(selection, null);
    expect(appended.files.map((file: any) => file.relativePath)).toEqual(['SKU/2.jpg']);
  });
});

it('excludes a previous file, a recursive subtree and only direct files of a shallow source', async () => {
  await fixture(async dir => {
    const root = path.join(dir, '合集');
    const old = path.join(root, '已上传'), shallow = path.join(root, '浅层.jpg');
    const previous = path.join(root, '旧封面.jpg'), cover = path.join(root, '新封面.jpg');
    const deeper = path.join(shallow, '子目录', '新图.png'), direct = path.join(shallow, '旧图.png');
    await fs.mkdir(old, {recursive: true}); await fs.mkdir(path.dirname(deeper), {recursive: true});
    for (const file of [previous, cover, deeper, direct, path.join(old, '已经完成.jpg')]) await fs.writeFile(file, 'x');
    const exclude = [{path: previous, recurse: true}, {path: old, recurse: true}, {path: shallow, recurse: false}];
    const selection = {paths: [root], recurse: true, exclude};
    const first = await scan(selection, null, 1);
    expect(first.files.map((file: any) => file.path)).toEqual([cover]);
    await expect(scan({...selection, exclude: []}, first.cursor)).rejects.toThrow(/选择/);
    const rest = await scan(selection, first.cursor);
    expect(rest.files.map((file: any) => file.path)).toEqual([deeper]);
    const specific = await scan({paths: [previous, direct, deeper, path.join(old, '已经完成.jpg')], recurse: true, exclude}, null);
    expect(specific.files.map((file: any) => file.path)).toEqual([deeper]);
    const shallowDirectory = await scan({paths: [shallow], recurse: true, exclude}, null);
    expect(shallowDirectory.files.map((file: any) => file.path)).toEqual([deeper]);
  });
});

it('groups interleaved individually selected siblings and preserves a folder with an image suffix', async () => {
  await fixture(async dir => {
    const a = path.join(dir, 'A'), b = path.join(dir, 'B'), folder = path.join(b, '商品.png');
    await fs.mkdir(a); await fs.mkdir(folder, {recursive: true});
    const first = path.join(a, '1.jpg'), second = path.join(a, '2.png'), extra = path.join(b, '3.jpg');
    for (const file of [first, second, extra, path.join(folder, '4.png')]) await fs.writeFile(file, 'x');
    const selection = {paths: [first, extra, second, folder, first], recurse: true};
    const full = await scan(selection, null, 2);
    expect(full.files.map((file: any) => file.relativePath).sort()).toEqual(['A/1.jpg', 'A/2.png']);
    const saved = JSON.parse(JSON.stringify(full.cursor));
    const rest = await scan(selection, saved);
    expect(rest.files.map((file: any) => file.relativePath).sort()).toEqual(['B/3.jpg', '商品.png/4.png']);
    expect(await scan(selection, saved)).toEqual(rest);
    expect(saved).toEqual(full.cursor);
    const noSpace = await scan(selection, null, 1);
    expect(noSpace).toMatchObject({files: [], done: false});
    expect((await scan(selection, noSpace.cursor, 2)).files).toEqual(full.files);
  });
});

it('stops explicit recovery when a checkpointed directory or the selection changes', async () => {
  await fixture(async dir => {
    const root = path.join(dir, '货品');
    await fs.mkdir(path.join(root, '子目录'), {recursive: true});
    await fs.writeFile(path.join(root, '封面.jpg'), 'x');
    await fs.writeFile(path.join(root, '子目录', '1.jpg'), 'x');
    const selection = {paths: [root], recurse: true};
    const first = await scan(selection, null, 1);
    expect(first.done).toBe(false);
    await expect(scan({...selection, recurse: false}, first.cursor)).rejects.toThrow(/选择/);
    await fs.mkdir(path.join(root, '新目录'));
    const changed = new Date(Date.now() + 5000);
    await fs.utimes(root, changed, changed);
    await expect(scan(selection, first.cursor)).rejects.toThrow(/目录.*变化|目录.*变更/);
  });
});
