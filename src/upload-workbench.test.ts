// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UploadWorkbench } from './UploadWorkbench';
import App from './App';
import * as requests from './api';
import type { DesktopTask } from './desktop';
import type { QueueItem, UploadEngine, UploadState } from './upload';

const task = (id: string, other: Partial<DesktopTask> = {}): DesktopTask => ({
  id, name: id + '上架', paths: ['D:\\原素材\\' + id], groupId: '业务', groupNumber: 0, completed: 0, bytesDone: 0, ...other,
});
const photo = (i: number, status: QueueItem['status'] = 'pending'): QueueItem => ({
  id: String(i), name: i + '.jpg', relativePath: 'SKU/' + i + '.jpg', size: 500, contentType: 'image/jpeg', status, progress: 0,
});
const telemetry = { phase: 'transferring' as const, bytesPerSecond: 1000, quota: 5, used: 4, transferring: 4, confirming: 0, retrying: 0, waiting: 3 };
let host: HTMLDivElement, root: Root;
const selectImport = vi.fn<UploadEngine['selectDesktopImport']>();
const enqueue = vi.fn<UploadEngine['enqueueDesktopImport']>();
const discard = vi.fn<UploadEngine['discardDesktopImport']>();
const rename = vi.fn<UploadEngine['renameDesktopTask']>();
const start = vi.fn<UploadEngine['start']>();
const engine = { selectDesktopImport: selectImport, discardDesktopImport: discard, enqueueDesktopImport: enqueue, renameDesktopTask: rename, start } as unknown as UploadEngine;
const renderFiles = vi.fn(() => React.createElement('p', null, '当前组明细'));
const mount = (queue: UploadState) => act(async () => {
  root.render(React.createElement(UploadWorkbench, {
    engine, queue, group: '业务', online: true, settingsReady: true, storageReady: true,
    canUpload: () => true, canExport: () => true, onError: vi.fn(), notify: vi.fn(), onExport: vi.fn(), onRenameRecord: vi.fn(), renderFiles,
  }));
});
const button = (name: string) => [...host.querySelectorAll('button')].find(item => item.textContent === name)!;
const click = (element: HTMLElement) => act(async () => element.click());
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  sessionStorage.setItem('yuntu-token', 'employee');
  window.desktop = { selectImport: vi.fn() } as any;
  selectImport.mockResolvedValue({ id: 'selection', name: '新到素材', paths: ['D:\\新到素材'] });
  enqueue.mockResolvedValue(undefined); discard.mockResolvedValue(undefined); rename.mockResolvedValue(undefined); start.mockResolvedValue(undefined);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); sessionStorage.clear(); delete window.desktop; vi.unstubAllGlobals(); });

it('keeps twenty thousand files behind one aggregate row and names the ETA scope until the final group is scanned', async () => {
  const items = Array.from({length: 20000}, (_, i) => photo(i, i < 10000 ? 'success' : 'pending'));
  const active = task('当前', { groupNumber: 2, completed: 20000, bytesDone: 10000000 });
  const queue: UploadState = { items, status: 'uploading', telemetry, worklist: [active, task('下一个')] };
  await mount(queue);
  expect(host.querySelectorAll('.task-overview')).toHaveLength(1);
  expect(host.querySelectorAll('.queue-item')).toHaveLength(0);
  expect(renderFiles).not.toHaveBeenCalled();
  expect(host.querySelector('.task-overview')?.textContent).toContain('本组预计完成时间');
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('50');
  expect(host.textContent).toContain('累计完成 30,000 张');
  expect(host.querySelector('.path-preview')?.textContent).toBe('D:\\原素材\\当前');
  await mount({ ...queue, worklist: [{ ...active, lastGroup: true }] });
  expect(host.querySelector('.task-overview')?.textContent).toContain('任务总进度');
  expect(host.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')).toBe('75');
  expect(host.textContent).toContain('30,000 / 40,000 张');
  expect(host.textContent).not.toContain('本组预计完成时间');
});

it('can start a queued task before its first directory has been scanned', async () => {
  await mount({items: [], status: 'ready', worklist: [task('刚选择')]});
  expect(host.textContent).toContain('等待分组');
  expect(host.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false);
  await click(button('开始上传'));
  expect(start).toHaveBeenCalledWith('业务');
});

it('shows cumulative confirmed images while a restored final group is still being loaded', async () => {
  await mount({items: [], status:'ready', worklist:[task('已恢复', {groupNumber: 2, lastGroup:true, completed:20000, bytesDone:10000000})]});
  expect(host.querySelector('[role=progressbar]')?.hasAttribute('aria-valuenow')).toBe(false);
  expect(host.textContent).toContain('累计完成 20,000 张');
  expect(host.querySelector('.workbench-badge')?.textContent).toBe('待上传');
});

it('distinguishes a completed group from a completed task while its checkpoint is being committed', async () => {
  const head = task('还在执行', {groupNumber:1});
  await mount({items:[photo(1,'success')],status:'completed',worklist:[head]});
  expect(host.querySelector('.workbench-badge')?.textContent).toBe('准备下一组');
  expect(host.querySelector('.main-action')?.textContent).toBe('暂停上传');
  await mount({items:[],status:'completed',worklist:[{...head,completed:1,bytesDone:500,finished:true}]});
  expect(host.querySelector('.workbench-badge')?.textContent).toBe('已完成');
  expect(host.querySelector('.main-action')?.textContent).toBe('选择下一批');
});

it('estimates speed from completed transfer bytes without batch telemetry, resets on pause or a new group, and ages out a stalled transfer', async () => {
  vi.useFakeTimers();
  const active = task('当前', {groupNumber: 1});
  const queue = (progress: number, status: UploadState['status'] = 'uploading', groupNumber = 1): UploadState =>
    ({ status, worklist:[{...active,groupNumber}], items:[{...photo(1,'uploading'),size:1024 * 1024,progress}] });
  const speed = () => host.querySelector('.dock-metrics strong')?.textContent;
  try {
    await mount(queue(0));
    expect(speed()).toBe('0 B/s');
    await mount(queue(50));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(speed()).toBe('512.0 KB/s');
    expect(host.querySelectorAll('.task-field')[3].querySelector('strong')?.textContent).toMatch(/\d{2}:\d{2}/);
    await mount(queue(50, 'paused'));
    expect(speed()).toBe('0 B/s');
    await mount(queue(50));
    expect(speed()).toBe('0 B/s');
    await mount(queue(75));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(speed()).toBe('256.0 KB/s');
    await mount(queue(20, 'uploading', 2));
    expect(speed()).toBe('0 B/s');
    await mount(queue(30, 'uploading', 2));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(speed()).not.toBe('0 B/s');
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(speed()).toBe('0 B/s');
    expect(host.querySelectorAll('.task-field')[3].textContent).toContain('正在估算');
  } finally { vi.clearAllTimers(); vi.useRealTimers(); }
});

it.each(['new', 'merge'])('can import into a %s task while another one is uploading', async mode => {
  await mount({ items: [photo(1)], status: 'uploading', worklist: [task('当前'), task('排队'), task('其他账号', {groupId:'其他'})] });
  await click(button('选择文件夹'));
  expect(selectImport).toHaveBeenCalledWith('folders', undefined);
  expect(host.querySelector('dialog')?.textContent).toContain('每组最多 20,000 张');
  if (mode === 'merge') {
    await click(host.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]);
    const select = host.querySelector('dialog select') as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(['当前', '排队']);
    await act(async () => { select.value = '排队'; select.dispatchEvent(new Event('change', {bubbles: true})); });
  }
  await click(button(mode === 'new' ? '加入队列' : '确认并入'));
  expect(enqueue).toHaveBeenCalledWith('selection', mode === 'new' ? '新到素材' : '排队上架', '业务', mode === 'new' ? undefined : '排队');
  expect(host.querySelector('dialog')).toBeNull();
  expect(discard).not.toHaveBeenCalled();
});

it('does not merge into a different task when the selected destination finishes, and releases a cancelled selection', async () => {
  await mount({ items: [photo(1)], status: 'uploading', worklist: [task('当前'), task('排队')] });
  await click(button('选择图片'));
  await click(host.querySelectorAll<HTMLInputElement>('input[type=radio]')[1]);
  await mount({ items: [], status: 'ready', worklist: [task('排队')] });
  expect(button('确认并入').disabled).toBe(true);
  expect(host.querySelector('dialog')?.textContent).toContain('原任务已结束');
  await click(button('取消'));
  expect(discard).toHaveBeenCalledWith('selection');
  expect(enqueue).not.toHaveBeenCalled();
});

it('keeps a recovered legacy queue in front of all staged desktop tasks', async () => {
  await mount({ items: [photo(9)], status: 'paused', legacyAhead: true, worklist: [task('新素材')] });
  expect(host.querySelector('.overview-name')?.textContent).toBe('SKU');
  expect(host.querySelector('.task-overview')?.textContent).toContain('来源目录（相对路径）');
  expect(host.querySelector('.waiting-list li')?.textContent).toContain('新素材上架');
  await click(host.querySelector('[aria-label="重命名 新素材上架"]')! as HTMLElement);
  const input = host.querySelector('dialog input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '排队的商品');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await click(button('保存名称'));
  expect(rename).toHaveBeenCalledWith('新素材', '排队的商品');
});

it('updates the account dot after authenticated heartbeats fail and recover while the browser is online', async () => {
  delete window.desktop;
  vi.useFakeTimers();
  let reachable = true;
  const api = vi.spyOn(requests, 'api').mockImplementation(async route => {
    if (route === '/health') return {ok:true, initialized:true, storageReady:true};
    if (route === '/me') return {user:{id:'operator',username:'alpha',displayName:'运营甲',permissions:{}},groups:[{id:'业务',name:'商品'}]};
    if (route === '/settings') return {settings:{},storage:{ready:true}};
    if (route === '/presence' && !reachable) throw Error('服务连接超时');
    return {ok:true};
  });
  try {
    await act(async () => root.render(React.createElement(App)));
    const dot = host.querySelector('.profile .account-presence')!;
    expect(dot.getAttribute('data-state')).toBe('online');
    reachable = false;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(dot.getAttribute('data-state')).toBe('offline');
    reachable = true;
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(dot.getAttribute('data-state')).toBe('online');
  } finally { api.mockRestore(); vi.clearAllTimers(); vi.useRealTimers(); }
});
