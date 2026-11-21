import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
function fixture(options: any = {}) {
 const updater = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(async () => null), quitAndInstall: vi.fn(), autoDownload: false, autoInstallOnAppQuit: true });
 const changes: any[] = [];
 const dependencies = { updater, supported: true, currentVersion: '1.1.1', isBusy: () => false, prepare: vi.fn(async () => {}), flush: vi.fn(async () => {}), onState: (state: any) => changes.push(state), ...options };
 const { createUpdaterController } = require('../electron/updater.cjs');
 return { updater, changes, dependencies, controller: createUpdaterController(dependencies) };
}
afterEach(() => vi.useRealTimers());
describe('native updater safety', () => {
 it('downloads in background but only installs after explicit idle prepare and durable flush', async () => {
  const { controller, updater, dependencies } = fixture();
  expect(updater.autoDownload).toBe(true); expect(updater.autoInstallOnAppQuit).toBe(false);
  expect(await controller.install()).toBe(false);
  updater.emit('update-downloaded', { version: '1.1.2' });
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(await controller.install()).toBe(true);
  expect(dependencies.prepare).toHaveBeenCalledOnce(); expect(dependencies.flush).toHaveBeenCalledOnce();
  expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
 });
 it('refuses active work and reserves the gate throughout preparation and installation', async () => {
  let busy = true, release!: () => void;
  const { controller, updater } = fixture({ isBusy: () => busy, prepare: () => new Promise<void>(resolve => { release = resolve; }) });
  updater.emit('update-downloaded', { version: '1.1.2' });
  expect(await controller.install()).toBe(false); busy = false;
  const installing = controller.install();
  expect(() => controller.assertCanStart()).toThrow(/更新/);
  expect(await controller.install()).toBe(false);
  release(); expect(await installing).toBe(true); expect(() => controller.assertCanStart()).toThrow();
 });
 it.each(['prepare', 'flush'])('cancels installation when %s fails and permits work again', async field => {
  const { controller, updater } = fixture({ [field]: async () => { throw Error('disk failure'); } });
  updater.emit('update-downloaded', { version: '1.1.2' });
  expect(await controller.install()).toBe(false);
  expect(updater.quitAndInstall).not.toHaveBeenCalled(); expect(controller.getState()).toMatchObject({ status: 'ready', error: 'disk failure' });
  expect(() => controller.assertCanStart()).not.toThrow();
 });
 it('rechecks busy after renderer preparation before installing', async () => {
  let busy = false;
  const { controller, updater } = fixture({ isBusy: () => busy, prepare: async () => { busy = true; } });
  updater.emit('update-downloaded', { version: '1.1.2' }); expect(await controller.install()).toBe(false); expect(updater.quitAndInstall).not.toHaveBeenCalled();
 });
 it('releases the installation gate when the installer declines or synchronously emits an error', async () => {
  const declined = fixture({ quitAndInstall: () => false });
  declined.updater.emit('update-downloaded', { version: '1.1.2' });
  expect(await declined.controller.install()).toBe(false); expect(() => declined.controller.assertCanStart()).not.toThrow();
  const failed = fixture(); failed.updater.quitAndInstall.mockImplementation(() => { failed.updater.emit('error', Error('missing artifact')); });
  failed.updater.emit('update-downloaded', { version: '1.1.2' });
  expect(await failed.controller.install()).toBe(false); expect(() => failed.controller.assertCanStart()).not.toThrow();
  expect(failed.controller.getState()).toMatchObject({ status: 'ready', error: 'missing artifact' });
 });
 it.each(['prepare', 'flush'])('bounds a stalled %s and never installs after its late resolution', async field => {
  vi.useFakeTimers(); let release!: () => void;
  const { controller, updater } = fixture({ prepareTimeoutMs: 50, flushTimeoutMs: 80, [field]: () => new Promise<void>(resolve => { release = resolve; }) });
  updater.emit('update-downloaded', { version: '1.1.2' }); const install = controller.install();
  await vi.advanceTimersByTimeAsync(100);
  expect(controller.getState()).toMatchObject({ status: 'ready' });
  expect(controller.getState().error).toMatch(/超时/); expect(() => controller.assertCanStart()).not.toThrow();
  expect(await install).toBe(false); release(); await Promise.resolve();
  expect(updater.quitAndInstall).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); controller.dispose();
 });
 it('coalesces concurrent checks and recovers errors without rejecting', async () => {
  let reject!: (error: Error) => void;
  const { controller, updater } = fixture();
  updater.checkForUpdates.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  const first = controller.check(); const second = controller.check();
  expect(updater.checkForUpdates).toHaveBeenCalledOnce(); reject(Error('offline'));
  await expect(first).resolves.toMatchObject({ status: 'error' }); await second;
  await controller.check(); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
 });
 it('observes a rejected background download and permits manual retry', async () => {
  let reject!: (error: Error) => void;
  const { controller, updater } = fixture();
  updater.checkForUpdates.mockResolvedValueOnce({ downloadPromise: new Promise((_resolve, fail) => { reject = fail; }) } as any);
  await controller.check(); reject(Error('download disconnected')); await Promise.resolve();
  expect(controller.getState()).toMatchObject({ status: 'error', error: 'download disconnected' });
  await controller.check(); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
 });
 it('does not install if disposed during preparation or busy work appears during flush', async () => {
  let busy = false;
  const { controller, updater } = fixture({ isBusy: () => busy, flush: async () => { busy = true; } });
  updater.emit('update-downloaded', { version: '1.1.2' }); expect(await controller.install()).toBe(false); expect(updater.quitAndInstall).not.toHaveBeenCalled();
  let release!: () => void;
  const second = fixture({ prepare: () => new Promise<void>(resolve => { release = resolve; }) });
  second.updater.emit('update-downloaded', { version: '1.1.2' }); const install = second.controller.install(); second.controller.dispose(); release();
  expect(await install).toBe(false); expect(second.updater.quitAndInstall).not.toHaveBeenCalled();
 });
 it('bounds event data and reports progress, busy changes, recoverable download errors and readiness', async () => {
  let busy = false;
  const { controller, updater, changes } = fixture({ isBusy: () => busy });
  updater.emit('update-available', { version: 'x'.repeat(500), releaseNotes: 'private' });
  expect(controller.getState().version.length).toBeLessThanOrEqual(100); expect(controller.getState()).not.toHaveProperty('releaseNotes');
  updater.emit('download-progress', { percent: 120 }); expect(controller.getState()).toMatchObject({ status: 'downloading', percent: 100 });
  busy = true; controller.refreshBusy(); expect(changes.at(-1).busy).toBe(true);
  updater.emit('error', Error('a'.repeat(5000))); expect(controller.getState().error.length).toBeLessThanOrEqual(1000);
  updater.emit('update-downloaded', { version: '1.1.2' }); expect(controller.getState()).toMatchObject({ status: 'ready', version: '1.1.2' });
 });
 it('checks on start and hourly and removes timers/listeners on dispose', async () => {
  vi.useFakeTimers(); const { controller, updater } = fixture();
  controller.start(); controller.start(); await vi.advanceTimersByTimeAsync(0); expect(updater.checkForUpdates).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(3600000); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  controller.dispose(); await vi.advanceTimersByTimeAsync(3600000); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2); expect(updater.listenerCount('download-progress')).toBe(0);
  await controller.check(); expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
 });
 it('leaves unpackaged and unsupported platforms inert', async () => {
  const { controller, updater } = fixture({ supported: false }); controller.start();
  expect(await controller.check()).toMatchObject({ status: 'unsupported' }); expect(await controller.install()).toBe(false); expect(updater.checkForUpdates).not.toHaveBeenCalled(); controller.dispose();
 });
});

describe('updater bridge', () => {
 it('exposes named update IPC and removes the exact subscription listener', async () => {
  const { readFileSync } = await import('node:fs'); const { runInNewContext } = await import('node:vm');
  const ipc = Object.assign(new EventEmitter(), { invoke: vi.fn(async (..._args: any[]) => null) }); let desktop: any;
  runInNewContext(readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), { require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, api: any) => { desktop = api; } }, ipcRenderer: ipc, webUtils: {} }) });
  expect(desktop.getUpdateState).toBeTypeOf('function');
  await desktop.getUpdateState(); await desktop.checkForUpdates(); await desktop.installUpdate();
  expect(ipc.invoke.mock.calls.map(call => call[0])).toEqual(['update-state', 'update-check', 'update-install']);
  const callback = vi.fn(); const stop = desktop.onUpdateStateChanged(callback);
  ipc.emit('update-state-changed', {}, { status: 'ready' }); expect(callback).toHaveBeenCalledWith({ status: 'ready' }); stop();
  ipc.emit('update-state-changed', {}, { status: 'idle' }); expect(callback).toHaveBeenCalledOnce();
 });
});

describe('main process update integration', () => {
 async function mainFixture() {
  const { readFileSync } = await import('node:fs'); const { runInNewContext } = await import('node:vm');
  const handlers = new Map<string, Function>(); const jobs = new Map(); const preparationJobs = new Map();
  const packSpool = {initialize:vi.fn(async()=>{}),clear:vi.fn(async()=>{}),stats:vi.fn(()=>({outstanding:0}))};
  const updater = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(async () => null), quitAndInstall: vi.fn() });
  const flush = vi.fn(async () => {}); const closeRequest = vi.fn(async () => true); const guard = vi.fn();
  let window: any, start: Promise<any>, prepareMessage: any, nativeSlots: Map<any, any>;
  const app = { isPackaged: true, getPath: () => 'C:/test-profile', getVersion: () => '1.1.1', setAppUserModelId: vi.fn(), on: vi.fn(), quit: vi.fn() };
  class Window extends EventEmitter {
   webContents: any; constructor() { super(); window = this; this.webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, setWindowOpenHandler: vi.fn(), session: { setPermissionRequestHandler: vi.fn() }, send: vi.fn((channel, value) => { if (channel === 'prepare-close') prepareMessage = value; }) }); }
   isDestroyed() { return false; } loadFile() { return Promise.resolve(); } show() {} focus() {} close() { this.emit('close', { preventDefault: vi.fn() }); }
  }
  const mocks: any = {
   electron: { app, BrowserWindow: Window, ipcMain: { handle: (name: string, fn: Function) => handlers.set(name, fn) }, dialog: {}, Notification: {} },
   './startup.cjs': { installDiagnostics: () => ({ log: vi.fn(), fail: vi.fn() }), loadDeviceId: async () => 'device', startDesktop: ({ createWindow }: any) => { start = createWindow(); } },
   './security.cjs': { assertTrustedSender: guard }, './titlebar.cjs': { installTitlebar: vi.fn() },
   './manifest.cjs': { createManifestStore: () => ({ flush }), createCloseCoordinator: () => ({ approved: false, request: closeRequest }) },
   './checkpoint.cjs': { createLocalCheckpoint: () => ({ flush }) },
   './work-queue.cjs': { createWorkQueue: () => ({scanning:false}) },
   './picker.cjs': { pickPaths: vi.fn(async () => []) },
   './upload-policy.mjs': require('../electron/upload-policy.mjs'),
   './hash.cjs': { createHashReader: () => ({ jobs, hash: vi.fn(async () => 'hash') }) },
   './compression.cjs': { createImagePreparer: () => ({ jobs: preparationJobs, drain: async () => {} }) },
   './pack-spool.cjs': { createPackSpool: () => packSpool },
   './updater.cjs': require('../electron/updater.cjs'), './native-upload.cjs': { ...require('../electron/native-upload.cjs'), createUploadGate: (limit: number, slots: Map<any, any>) => { nativeSlots = slots; return require('../electron/native-upload.cjs').createUploadGate(limit, slots); } },
   '../server.json': { apiBase: 'https://example.com' }, 'electron-updater': { autoUpdater: updater },
  };
  runInNewContext(readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8'), { require: (name: string) => mocks[name] || require(name), __dirname: 'C:/app/electron', process: { platform: 'win32' }, setTimeout, clearTimeout, setInterval, clearInterval, URL });
  await start!;
  const invoke = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
  return { window, updater, invoke, jobs, preparationJobs, packSpool, nativeSlots: nativeSlots!, flush, closeRequest, guard, prepare: () => prepareMessage };
 }
 it('rejects new uploads and native jobs while install preparation is pending, and bypasses ordinary close only after flush', async () => {
  const f = await mainFixture(); f.updater.emit('update-downloaded', { version: '1.1.2' });
  const installing = f.invoke('update-install'); expect(f.prepare()).toHaveProperty('id');
  expect(() => f.invoke('upload-active', true)).toThrow(/更新/);
  await expect(f.invoke('hash', 'file')).rejects.toThrow(/更新/); await expect(f.invoke('upload', {})).rejects.toThrow(/更新/);
  await expect(f.invoke('prepare-pack','key',['file'],1)).rejects.toThrow(/更新/);
  await expect(f.invoke('open-work-group','owner')).rejects.toThrow(/更新/);
  await expect(f.invoke('select-import','owner','files',true)).rejects.toThrow(/更新/);
  f.window.close(); expect(f.closeRequest).not.toHaveBeenCalled(); expect(f.updater.quitAndInstall).not.toHaveBeenCalled();
  f.invoke('ready-to-close', { id: f.prepare().id }); expect(await installing).toMatchObject({ status: 'installing' }); expect(f.flush).toHaveBeenCalledOnce();
  f.window.close(); expect(f.closeRequest).not.toHaveBeenCalled(); expect(f.guard).toHaveBeenCalled(); f.window.emit('closed');
 });
 it('includes upload activity, native upload slots, hashing and image preparation in its busy state', async () => {
  const f = await mainFixture(); f.invoke('upload-active', true); expect(f.invoke('update-state').busy).toBe(true); f.invoke('upload-active', false);
  f.nativeSlots.set('upload', {}); expect(f.invoke('update-state').busy).toBe(true); f.nativeSlots.clear();
  f.packSpool.stats.mockReturnValueOnce({outstanding:1});expect(f.invoke('update-state').busy).toBe(true);
  f.jobs.set('hash', {}); expect(f.invoke('update-state').busy).toBe(true); f.jobs.clear(); f.preparationJobs.set('image', {});
  f.updater.emit('update-downloaded', { version: '1.1.2' }); expect(await f.invoke('update-install')).toMatchObject({ status: 'ready', busy: true, version: '1.1.2' }); expect(f.prepare()).toBeUndefined();
  f.window.emit('closed');
 });
 it('does not bypass ordinary close after persistence failure', async () => {
  const f = await mainFixture(); f.flush.mockRejectedValueOnce(Error('disk full')); f.updater.emit('update-downloaded', { version: '1.1.2' });
  const installing = f.invoke('update-install'); f.invoke('ready-to-close', { id: f.prepare().id }); expect(await installing).toMatchObject({ status: 'ready', error: 'disk full' });
  expect(f.updater.quitAndInstall).not.toHaveBeenCalled(); f.window.close(); expect(f.closeRequest).toHaveBeenCalledOnce(); f.window.emit('closed');
 });
});
