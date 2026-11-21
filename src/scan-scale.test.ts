import {createRequire} from 'node:module';
import path from 'node:path';
import {expect, it} from 'vitest';

const require = createRequire(import.meta.url);
const io = require('node:fs/promises');
const root = path.resolve('virtual-product-photos');
const selection = {paths: [root], recurse: true};

// Generate directory entries only when read, including a trailing unsupported file.
// Counters distinguish listing a parent from touching the images of a later product.
async function withProducts(counts: number[], run: (activity: any) => Promise<void>) {
  const original = {opendir: io.opendir, lstat: io.lstat};
  const activity = {products: new Set<number>(), handles: 0, onImage: () => {}};
  const dirent = (name: string, directory: boolean) => ({
    name, isDirectory: () => directory, isFile: () => !directory, isSymbolicLink: () => false,
  });
  io.lstat = async (file: string) => {
    const parts = path.relative(root, file).split(path.sep);
    const directory = file === root || file === path.dirname(root) || parts.length === 1;
    if (!directory) activity.onImage();
    return {...dirent(path.basename(file), directory), size: 4, dev: 1, ino: 1, mtimeMs: 1, ctimeMs: 1};
  };
  io.opendir = async (dir: string) => {
    const product = dir === root ? -1 : Number(path.basename(dir).slice(1));
    if (product >= 0) activity.products.add(product);
    function* entries() {
      const length = product < 0 ? counts.length : counts[product];
      for (let i = 0; i < length; i++) yield dirent(product < 0 ? 'p' + i : i + '.jpg', product < 0);
      yield dirent('notes.txt', false);
    }
    const items = entries();
    let closed = false;
    activity.handles++;
    const close = async () => {if (!closed) {closed = true; activity.handles--}};
    return {
      read: async () => items.next().value ?? null,
      close,
      async *[Symbol.asyncIterator]() {try {yield* items} finally {await close()}},
    };
  };
  try {await run(activity)} finally {Object.assign(io, original)}
}

it('streams 160003 images in complete product directories across serialized group cursors', async () => {
  const {nextGroup} = require('../electron/upload-groups.cjs');
  const counts = [19996, 7, ...Array(20000).fill(7)];
  await withProducts(counts, async activity => {
    const paths = new Set<string>();
    const owners = new Map<string, number>();
    const sizes: number[] = [];
    let cursor = null;
    for (;;) {
      const group = await nextGroup(selection, cursor);
      sizes.push(group.files.length);
      if (sizes.length === 1) {
        expect(group.files).toHaveLength(19996);
        expect([...activity.products]).toEqual([0, 1]);
      }
      for (const file of group.files) {
        if (paths.has(file.path)) throw Error('Duplicate path ' + file.path);
        paths.add(file.path);
        const product = path.dirname(file.path);
        if (owners.has(product) && owners.get(product) !== sizes.length) throw Error('Split product ' + product);
        owners.set(product, sizes.length);
      }
      expect(activity.handles).toBe(0);
      if (group.done) break;
      const encoded = JSON.stringify(group.cursor);
      expect(encoded.length).toBeLessThan(1400);
      cursor = JSON.parse(encoded);
    }
    expect(sizes).toEqual([19996, ...Array(7).fill(19999), 14]);
    expect(paths.size).toBe(160003);
    expect(owners.size).toBe(counts.length);
  });
});

it('accepts exactly 20000 and opens the next oversized product only when requested', async () => {
  const {nextGroup} = require('../electron/upload-groups.cjs');
  await withProducts([20000, 20001], async activity => {
    const first = await nextGroup(selection, null, 50000);
    expect(first.files).toHaveLength(20000);
    expect([...activity.products]).toEqual([0]);
    expect(first.done).toBe(false);
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(nextGroup(selection, JSON.parse(JSON.stringify(first.cursor)))).rejects.toThrow(/p1.*20000|20000.*p1/);
      expect(activity.handles).toBe(0);
    }
  });
});

it('retries a partially scanned group from the same durable position after abort', async () => {
  const {nextGroup} = require('../electron/upload-groups.cjs');
  await withProducts([10, 17, 3], async activity => {
    const first = await nextGroup(selection, null, 10);
    const cursor = JSON.parse(JSON.stringify(first.cursor));
    const abort = new AbortController();
    let images = 0;
    activity.onImage = () => {if (++images === 5) abort.abort()};
    await expect(nextGroup(selection, cursor, 20, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
    expect(activity.handles).toBe(0);
    const next = await nextGroup(selection, cursor, 20);
    expect(next.files).toHaveLength(20);
    expect(new Set(next.files.map((file: any) => path.basename(path.dirname(file.path))))).toEqual(new Set(['p1', 'p2']));
    expect(cursor).toEqual(first.cursor);
  });
});

it('lets a close or pause interrupt indexing a large explicit selection', async () => {
  const {nextGroup} = require('../electron/upload-groups.cjs');
  const paths = Array.from({length: 16000}, (_, i) => path.join(root, 'SKU' + (i >> 2), i + '.jpg'));
  const abort = new AbortController();
  setImmediate(() => abort.abort());
  await expect(nextGroup({paths, recurse: true}, null, 0, abort.signal)).rejects.toMatchObject({name: 'AbortError'});
});
