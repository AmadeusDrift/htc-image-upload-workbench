import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronRight, CloudUpload, Copy, Download, Ellipsis, Folder, Image as ImageIcon, List, Pause, Pencil, Play, RotateCcw } from 'lucide-react';
import { api, getToken } from './api';
import type { QueueItem, UploadEngine, UploadState } from './upload';
import { UploadQueueStatus } from './UploadQueueStatus';
import { ImportTaskDialog, RenameTaskDialog, SourcesDialog, TaskDialog, type DesktopSelection, type WorklistTask } from './UploadTaskDialogs';

const count = new Intl.NumberFormat('zh-CN');
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const shortDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });
const statusText: Record<UploadState['status'], string> = {
  idle: '等待选择', ready: '待上传', scanning: '正在扫描', uploading: '上传中',
  paused: '已暂停', completed: '已完成', cancelled: '已取消', error: '上传已停止',
};
function bytes(value: number) {
  const scale = value >= 1024 ** 3 ? 3 : value >= 1024 ** 2 ? 2 : value >= 1024 ? 1 : 0;
  return (value / 1024 ** scale).toFixed(scale ? 1 : 0) + ' ' + ['B', 'KB', 'MB', 'GB'][scale];
}

function groupStats(items: QueueItem[], includeRelativeRoots: boolean) {
  let totalBytes = 0, transmittedBytes = 0, completed = 0, failed = 0, transferring = 0;
  const roots = new Set<string>();
  for (const item of items) {
    totalBytes += item.size;
    if (item.status === 'success') { completed++; transmittedBytes += item.size; }
    else if (item.status === 'failed') failed++;
    else if (item.status === 'uploading') {
      transferring++;
      transmittedBytes += item.size * Math.max(0, Math.min(100, item.progress || 0)) / 100;
    }
    if (includeRelativeRoots) {
      const root = item.relativePath?.match(/^([^/\\]+)[/\\]/);
      if (root) roots.add(root[1]);
    }
  }
  return { totalBytes, transmittedBytes, completed, failed, transferring, roots: [...roots] };
}

function finishEstimate(seconds: number) {
  const now = new Date();
  const finish = new Date(now.getTime() + seconds * 1000);
  if (!Number.isFinite(finish.getTime())) return { time: '正在估算', remaining: '' };
  const days = Math.ceil(seconds / 86400);
  const duration = seconds < 3600 ? Math.ceil(seconds / 60) + ' 分钟'
    : seconds < 86400 ? (seconds / 3600).toFixed(1) + ' 小时' : days + ' 天';
  const datePrefix = now.toDateString() === finish.toDateString() ? '' : shortDate.format(finish) + ' ';
  return { time: datePrefix + clock.format(finish), remaining: seconds < 60 ? '剩余不到 1 分钟' : '剩余约 ' + duration };
}

function useMeasuredRate(enabled: boolean, groupKey: string, transferred: number) {
  const latest = useRef(transferred);
  latest.current = transferred;
  const [reading, setReading] = useState({ key: '', rate: 0 });
  useEffect(() => {
    setReading({ key: groupKey, rate: 0 });
    if (!enabled) return;
    let samples = [{ time: performance.now(), bytes: latest.current }];
    const timer = setInterval(() => {
      const sample = { time: performance.now(), bytes: latest.current };
      // A retry can roll back the progress of an incomplete transfer.
      if (sample.bytes < samples[samples.length - 1].bytes) samples = [];
      samples.push(sample);
      while (samples.length > 1 && samples[1].time <= sample.time - 5000) samples.shift();
      const elapsed = sample.time - samples[0].time;
      const rate = elapsed > 0 ? Math.round((sample.bytes - samples[0].bytes) * 1000 / elapsed) : 0;
      setReading(last => last.key === groupKey && last.rate === rate ? last : { key: groupKey, rate });
    }, 1000);
    return () => clearInterval(timer);
  }, [enabled, groupKey]);
  return enabled && reading.key === groupKey ? reading.rate : 0;
}

function estimate(queue: UploadState, task: WorklistTask | undefined, online: boolean, stats: ReturnType<typeof groupStats>, hasTask: boolean, speed: number) {
  if (!hasTask) return { time: '—', remaining: '' };
  if (task?.finished || !task && queue.status === 'completed') return { time: stats.failed ? '待重试' : '已完成', remaining: '' };
  if (queue.status === 'completed') return { time: stats.failed ? '待重试' : '本组已完成', remaining: '' };
  if (queue.status === 'cancelled') return { time: '已取消', remaining: '' };
  if (queue.status === 'error') return { time: '已停止', remaining: '' };
  if (queue.status === 'paused') return { time: '已暂停', remaining: '' };
  if (!online) return { time: '等待连接', remaining: '' };
  if (queue.status === 'scanning') return { time: '扫描中', remaining: '' };
  if (queue.status !== 'uploading') return { time: '待上传', remaining: '' };
  const remainingBytes = stats.totalBytes - stats.transmittedBytes;
  if (!remainingBytes && queue.items.length > 0) return { time: '等待确认', remaining: '' };
  if (speed > 0 && Number.isFinite(speed) && remainingBytes > 0) return finishEstimate(remainingBytes / speed);
  return { time: '正在估算', remaining: '等待传输速度' };
}

type WorkbenchProps = {
  engine: UploadEngine;
  queue: UploadState;
  group: string;
  online: boolean;
  settingsReady: boolean;
  storageReady: boolean;
  canUpload: (group: string) => boolean;
  canExport: (group: string) => boolean;
  onError: (message: string) => void;
  notify: (message: string) => void;
  onExport: (request: { taskId: string }) => void;
  onRenameRecord: (id: string, name: string) => Promise<void>;
  renderFiles: () => React.ReactNode;
  children?: React.ReactNode;
};
type View = { kind: 'sources' | 'rename' | 'details' | 'actions'; id: string };

export function UploadWorkbench({ engine, queue, group, online, settingsReady, storageReady, canUpload, canExport,
  onError, notify, onExport, onRenameRecord, renderFiles, children }: WorkbenchProps) {
  const list = queue.worklist || [];
  const active = queue.legacyAhead ? undefined : list[0];
  const waiting = queue.legacyAhead ? list : list.slice(1);
  const account = active?.groupId || queue.groupId || group;
  const hasTask = Boolean(active || queue.items.length);
  const stats = useMemo(() => groupStats(queue.items, !active), [queue.items, Boolean(active)]);
  const closingGroup = active && !active.finished && queue.status === 'completed' && !stats.failed;
  const running = queue.status === 'uploading' || queue.status === 'scanning' || closingGroup;
  const [legacyName, setLegacyName] = useState<{ id: string; name: string }>();
  const groupKnown = !active || active.finished || active.lastGroup && active.groupNumber > 0 && queue.items.length > 0;
  const previousCount = active?.completed || 0, previousBytes = active?.bytesDone || 0;
  const total = (groupKnown ? previousCount : 0) + queue.items.length;
  const completed = (groupKnown ? previousCount : 0) + stats.completed;
  const totalBytes = (groupKnown ? previousBytes : 0) + stats.totalBytes;
  const sentBytes = (groupKnown ? previousBytes : 0) + stats.transmittedBytes;
  const percent = active?.finished || (total > 0 && completed === total) ? 100
    : totalBytes > 0 ? Math.min(99.9, Math.max(0, sentBytes / totalBytes * 100)) : 0;
  const hasProgress = total > 0 || active?.finished;
  const groupKey = JSON.stringify([active?.id || queue.clientTaskId || queue.taskId || queue.items[0]?.id, active?.groupNumber, queue.groupTicket]);
  const measuredRate = useMeasuredRate(queue.status === 'uploading' && online && !queue.telemetry, groupKey, stats.transmittedBytes);
  const speed = online && queue.status === 'uploading' ? queue.telemetry?.bytesPerSecond ?? measuredRate : 0;
  const eta = estimate(queue, active, online, stats, hasTask, speed);
  const paths = active?.paths || stats.roots;
  const activeName = active?.name || (queue.taskId && queue.taskId === legacyName?.id && legacyName.name)
    || stats.roots[0] || queue.items[0]?.name || '等待添加图片';
  const activeId = active?.id || queue.taskId || queue.clientTaskId || queue.items[0]?.id || '';
  const canStart = settingsReady && storageReady && online && hasTask && account && canUpload(account) && !queue.missingCheckpointItems;
  const selectNew = Boolean(window.desktop?.selectImport) && !queue.missingCheckpointItems;
  const [view, setView] = useState<View>();
  const [draft, setDraft] = useState<DesktopSelection>();
  const [picking, setPicking] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const dropTarget = useRef<HTMLDivElement>(null);
  const selecting = useRef(false), starting = useRef(false), committing = useRef(false);
  const mounted = useRef(false), pendingSelection = useRef<string | undefined>(undefined);
  const filesInput = useRef<HTMLInputElement>(null), folderInput = useRef<HTMLInputElement>(null);
  const canSelect = settingsReady && !picking && !draft && (selectNew || !running);
  const phase = !online && running ? '等待连接' : closingGroup ? (active.lastGroup ? '正在完成任务' : '准备下一组')
    : stats.failed && queue.status === 'completed' ? '部分失败' : statusText[queue.status];
  const phaseStyle = !online && running ? 'offline' : stats.failed && queue.status === 'completed' ? 'partial' : queue.status;
  useEffect(() => {
    mounted.current = true;
    const preventNavigation = (event: DragEvent) => {
      if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault();
      if (event.type === 'dragover' && !dropTarget.current?.contains(event.target as Node)) event.dataTransfer.dropEffect = 'none';
      if (event.type === 'drop') { dragDepth.current = 0; setDragging(false); }
    };
    document.addEventListener('dragover', preventNavigation);
    document.addEventListener('drop', preventNavigation);
    return () => {
      mounted.current = false;
      document.removeEventListener('dragover', preventNavigation);
      document.removeEventListener('drop', preventNavigation);
      if (pendingSelection.current && !committing.current) void engine.discardDesktopImport(pendingSelection.current).catch(() => {});
    };
  }, [engine]);
  useEffect(() => {
    if (active || !queue.taskId) return;
    const id = queue.taskId, token = getToken(), controller = new AbortController();
    void api('/tasks/' + encodeURIComponent(id) + '?limit=1', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted && getToken() === token && data.task?.name) setLegacyName({ id, name: data.task.name });
    }).catch(() => {});
    return () => controller.abort();
  }, [Boolean(active), queue.taskId]);
  const run = async (action: () => unknown) => {
    const token = getToken();
    try { await action(); }
    catch (error) { if (mounted.current && token === getToken()) onError(error instanceof Error ? error.message : String(error)); }
  };
  const select = async (kind: 'files' | 'folders' | 'drop', files?: File[]) => {
    if (!canSelect || selecting.current) return;
    if (selectNew && (!group || !canUpload(group))) { onError(group ? '当前账号没有上传权限' : '请先选择业务账号'); return; }
    if (!window.desktop && kind !== 'drop') { (kind === 'files' ? filesInput : folderInput).current?.click(); return; }
    const owner = getToken();
    selecting.current = true;
    setPicking(true);
    try {
      if (selectNew) {
        const selection = await engine.selectDesktopImport(kind, files);
        if (!selection) return;
        if (!mounted.current || getToken() !== owner) { await engine.discardDesktopImport(selection.id); return; }
        pendingSelection.current = selection.id;
        setDraft(selection);
      } else if (kind === 'folders') await engine.addDesktopFolder();
      else if (kind === 'files') await engine.addDesktopFiles();
      else await engine.addDesktopDropped(files || []);
    } finally { selecting.current = false; if (mounted.current) setPicking(false); }
  };
  const closeDraft = () => {
    const id = pendingSelection.current;
    if (committing.current) return;
    pendingSelection.current = undefined;
    setDraft(undefined);
    if (id) void run(() => engine.discardDesktopImport(id));
  };
  const confirmDraft = async (name: string, targetId?: string) => {
    const id = pendingSelection.current;
    if (!id || committing.current) return;
    const owner = getToken();
    committing.current = true;
    try {
      await engine.enqueueDesktopImport(id, name, group, targetId);
      pendingSelection.current = undefined;
      if (mounted.current && owner === getToken()) { setDraft(undefined); notify(targetId ? '图片已并入任务' : '任务已加入队列'); }
    } finally {
      committing.current = false;
      if (!mounted.current && pendingSelection.current === id) void engine.discardDesktopImport(id).catch(() => {});
    }
  };
  const onDrop = (event: React.DragEvent) => {
    event.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (!canSelect) return;
    const transfer = event.dataTransfer;
    if (window.desktop) void run(() => select('drop', Array.from(transfer.files)));
    else void run(() => addBrowserDropForSession(() => readDroppedFiles(transfer), files => mounted.current && engine.addBrowserFiles(files)));
  };
  const start = async () => {
    if (starting.current || !canStart) return;
    starting.current = true;
    try { if (queue.status === 'paused' && (active || queue.groupId)) await engine.resume(); else await engine.start(account); }
    finally { starting.current = false; }
  };
  const pause = async () => {
    setPausing(true);
    try { await engine.pause(); } finally { if (mounted.current) setPausing(false); }
  };
  const copyPaths = async (sources: string[], inDialog = false) => {
    try { await navigator.clipboard.writeText(sources.join('\n')); if (!inDialog) notify('已复制来源路径'); return true; }
    catch { if (!inDialog) onError('复制失败，请打开来源目录并手动复制完整路径。'); return false; }
  };
  const taskView = view ? list.find(task => task.id === view.id) : undefined;
  const currentView = !!view && activeId === view.id;
  const viewPaths = taskView?.paths || (currentView ? paths : []);
  const viewName = taskView?.name || (currentView ? activeName : '');
  const closeView = () => setView(undefined);
  const targets = list.filter(task => !task.finished && task.groupId === group && (task.id !== active?.id || queue.status !== 'cancelled'));
  const quota = queue.status === 'uploading' ? queue.telemetry : undefined;
  const used = quota?.used ?? ((quota?.transferring ?? stats.transferring) + (quota?.confirming ?? 0));
  const exportLabel = '导出 Excel';
  const uploadDone = Boolean(active?.finished || !active && queue.status === 'completed' && !stats.failed);
  return <>
    <input hidden multiple type="file" accept=".jpg,.jpeg,.png,.webp" ref={filesInput}
      onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (canSelect) void run(() => engine.addBrowserFiles(files)); }}/>
    <input hidden multiple type="file" {...{ webkitdirectory: '' }} ref={folderInput}
      onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; if (canSelect) void run(() => engine.addBrowserFiles(files)); }}/>
    <div ref={dropTarget} className={'upload-drop' + (dragging ? ' dragging' : '')}
      onDragEnter={event => { if (canSelect && Array.from(event.dataTransfer.types).includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
      onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = canSelect ? 'copy' : 'none'; }} onDrop={onDrop}>
      <span className="upload-drop-icon"><CloudUpload size={24}/></span>
      <div className="upload-drop-copy"><strong>{dragging ? '松开以添加图片' : '拖入图片或文件夹'}</strong><small>JPG、PNG、WebP · 单张上限 50 MB</small></div>
      <div className="upload-pick-actions"><button onClick={() => void run(() => select('folders'))} disabled={!canSelect}><Folder size={16}/>选择文件夹</button>
        <button onClick={() => void run(() => select('files'))} disabled={!canSelect}><ImageIcon size={16}/>选择图片</button></div>
    </div>
    {children}
    <section className="upload-section" aria-labelledby="upload-section-title">
      <div className="upload-section-head"><h2 id="upload-section-title">本次上传</h2><span className={'workbench-badge ' + phaseStyle}><i/>{phase}</span></div>
      <article className="card task-overview" aria-label="当前任务总览">
        <div className="task-field"><span className="field-label">上架任务名称</span>
          <div className="field-value"><strong className="overview-name" title={activeName}>{activeName}</strong>
            {(active || queue.taskId) && canUpload(account) && <button className="icon" aria-label="重命名当前任务" title="重命名任务" onClick={() => setView({ kind: 'rename', id: activeId })}><Pencil size={14}/></button>}</div>
          <div className="field-note">{active && !active.finished
            ? queue.items.length ? '第 ' + active.groupNumber + ' 组 · ' + count.format(queue.items.length) + ' 张 · ' + bytes(stats.totalBytes) : '等待分组'
            : hasProgress ? count.format(total) + ' 张 · ' + bytes(totalBytes) : ''}</div>
        </div>
        <div className="task-field"><span className="field-label">{!active && paths.length ? '来源目录（相对路径）' : '原始上传路径'}</span>
          <div className="field-value">{paths.length ? <button className="path-preview" onClick={() => setView({ kind: 'sources', id: activeId })} title={paths[0]}>{paths[0]}</button>
            : <span className="field-empty">{!hasTask ? '—' : '未提供目录路径'}</span>}</div>
          {paths.length > 0 && <div className="field-note path-tools"><button className="text" onClick={() => setView({ kind: 'sources', id: activeId })}>{count.format(paths.length)} 个来源</button>
            <span>·</span><button className="text" onClick={() => void copyPaths(paths)}><Copy size={12}/>复制路径</button></div>}
        </div>
        <div className="task-field"><span className="field-label">{groupKnown ? '任务总进度' : '本组进度'}{hasProgress && ' · 按字节'}</span>
          <div className="field-value"><strong className="upload-metric progress-number">{hasProgress ? <>{percent.toFixed(1)}<small>%</small></> : '—'}</strong></div>
          <div className="field-note">{hasProgress ? count.format(completed) + ' / ' + count.format(total) + ' 张' : hasTask ? '等待扫描' : ''}
            {!groupKnown && previousCount > 0 && <> · 累计完成 {count.format(previousCount + stats.completed)} 张</>}</div>
        </div>
        <div className="task-field"><span className="field-label">{groupKnown ? '预计完成时间' : '本组预计完成时间'}</span>
          <div className="field-value"><strong className={'upload-metric' + (!eta.time.includes(':') ? ' text-metric' : '')}>{eta.time}</strong></div>
          <div className="field-note">{eta.remaining || (!groupKnown && hasTask ? '后续分组尚待扫描' : '')}</div>
        </div>
        <div key={activeId + '/' + (active?.groupNumber || 0)} role="progressbar" aria-label={groupKnown ? '本次上传总进度' : '当前分组上传进度'} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={hasProgress ? Number(percent.toFixed(1)) : undefined} className={'workbench-progress ' + queue.status}><i style={{ width: percent.toFixed(2) + '%' }}/></div>
      </article>
      <div className="card workbench-waiting"><div className="waiting-heading"><strong>等待队列</strong><span>{count.format(waiting.length)} 个任务</span><small>按加入顺序自动开始</small></div>
        {waiting.length > 0 && <ol className="waiting-list" aria-label="等待上传的任务">{waiting.map((task, index) => <li key={task.id}>
          <span className="queue-position">{String(index + 1).padStart(2, '0')}</span><Folder size={16}/><strong title={task.name}>{task.name}</strong>
          <button className="icon" disabled={!canUpload(task.groupId)} title="重命名任务" aria-label={'重命名 ' + task.name} onClick={() => setView({ kind: 'rename', id: task.id })}><Pencil size={13}/></button>
          <button className="text queue-source" onClick={() => setView({ kind: 'sources', id: task.id })}>{count.format(task.paths.length)} 个来源<ChevronRight size={13}/></button>
        </li>)}</ol>}
      </div>
      {queue.error && <div className="notice danger" role="alert">{queue.error}</div>}
    </section>
    <footer className="upload-dock"><div className="upload-dock-inner">
      <div className="dock-metrics"><Activity size={27} aria-hidden="true"/><div><small>实时速度</small><strong>{bytes(speed)}/s</strong></div>
        <div className="dock-quota"><small>并发通道</small><strong>{queue.status === 'uploading' ? used : 0} / {quota?.quota ?? '—'} 路</strong></div></div>
      <div className="dock-buttons">{stats.failed > 0 && <button className="text retry-failed" disabled={running || !canStart} onClick={() => void run(() => engine.retryFailed())}><RotateCcw size={15}/>重试失败 {count.format(stats.failed)} 张</button>}
        <button className="dock-export" disabled={!queue.taskId || !canExport(account)} onClick={() => onExport({ taskId: queue.taskId! })}><Download size={16}/>{exportLabel}</button>
        <button className="dock-more" disabled={!hasTask} title="更多操作" aria-label="更多操作" onClick={() => setView({ kind: 'actions', id: activeId })}><Ellipsis size={18}/></button>
        {running ? <button className="primary main-action" disabled={pausing || !active && queue.status === 'scanning'} onClick={() => void run(pause)}><Pause size={16}/>{pausing ? '正在暂停…' : !active && queue.status === 'scanning' ? '正在扫描' : '暂停上传'}</button>
          : uploadDone ? <button className="primary main-action" disabled={!canSelect} onClick={() => void run(() => select('folders'))}><Folder size={16}/>选择下一批</button>
          : <button className="primary main-action" disabled={!canStart || pausing} onClick={() => void run(start)}
            title={!account ? '请先选择业务账号' : !storageReady ? '请先连接存储' : !online ? '请先恢复网络连接' : undefined}><Play size={16}/>{queue.status === 'paused' ? '继续上传' : '开始上传'}</button>}
      </div>
    </div></footer>
    {draft && <ImportTaskDialog selection={draft} targets={targets} activeId={active?.id} onClose={closeDraft} onConfirm={confirmDraft}/>}
    {view?.kind === 'sources' && (taskView || currentView) && <SourcesDialog paths={viewPaths} name={viewName} relative={!taskView} onCopy={sources => copyPaths(sources, true)} onClose={closeView}/>}
    {view?.kind === 'rename' && (taskView || currentView && queue.taskId) && <RenameTaskDialog name={viewName} onClose={closeView}
      onSave={async name => { if (taskView) await engine.renameDesktopTask(taskView.id, name); else { await onRenameRecord(queue.taskId!, name); setLegacyName({ id: queue.taskId!, name }); } }}/>}
    {view?.kind === 'actions' && currentView && <TaskDialog title="任务操作" onClose={closeView}>
      <p className="dialog-description">{activeName}</p>
      <UploadQueueStatus queue={queue} online={online} measuredBytesPerSecond={measuredRate}/>
      <div className="workbench-other-actions">
        <button disabled={!queue.items.length} onClick={() => setView({ kind: 'details', id: activeId })}><List size={16}/>查看本组图片</button>
        <button disabled={!queue.taskId || !canExport(account)} onClick={() => { closeView(); onExport({ taskId: queue.taskId! }); }}><Download size={16}/>{exportLabel}</button>
        <button disabled={!stats.failed || running || !canStart} onClick={() => { closeView(); void run(() => engine.retryFailed()); }}>仅重试失败</button>
        <button disabled={!['uploading', 'scanning', 'paused', 'ready'].includes(queue.status)} onClick={() => { closeView(); void run(() => engine.cancel()); }}>取消任务</button>
        <button disabled={running} onClick={() => { closeView(); void run(() => engine.clear()); }}>清空当前任务</button>
      </div>
    </TaskDialog>}
    {view?.kind === 'details' && currentView && <TaskDialog title="本组图片明细" wide onClose={closeView}>{renderFiles()}</TaskDialog>}
  </>;
}

async function readDroppedFiles(data: DataTransfer): Promise<File[]> {
  const entries = Array.from(data.items || []).map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(data.files);
  const result: File[] = [];
  const visit = async (entry: FileSystemEntry, path: string) => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
      Object.defineProperty(file, 'webkitRelativePath', { value: path + file.name, configurable: true });
      result.push(file);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, path + entry.name + '/');
      }
    }
  };
  for (const entry of entries) await visit(entry!, '');
  return result;
}

export async function addBrowserDropForSession(readFiles: () => Promise<File[]>, addFiles: (files: File[]) => unknown, currentToken: () => string | null = getToken): Promise<boolean> {
  const initiatingToken = currentToken();
  const files = await readFiles();
  if (!initiatingToken || currentToken() !== initiatingToken) return false;
  await addFiles(files);
  return true;
}
