import React, { useEffect, useId, useRef, useState } from 'react';
import { Copy, Folder, X } from 'lucide-react';
import type { UploadEngine, UploadState } from './upload';

export type WorklistTask = NonNullable<UploadState['worklist']>[number];
export type DesktopSelection = NonNullable<Awaited<ReturnType<UploadEngine['selectDesktopImport']>>>;

export function TaskDialog({ title, onClose, children, wide = false, busy = false }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
  busy?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={ref} className={'workbench-dialog' + (wide ? ' wide-dialog' : '')} aria-labelledby={id}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2 id={id}>{title}</h2><button type="button" className="icon" aria-label="关闭弹窗" onClick={onClose} disabled={busy}><X size={18}/></button></header>
    {children}
  </dialog>;
}

export function RenameTaskDialog({ name, onClose, onSave }: {
  name: string;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextName = value.trim();
    if (!nextName || pending.current) return;
    if (nextName === name) { onClose(); return; }
    pending.current = true;
    setSaving(true);
    setError('');
    try { await onSave(nextName); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setSaving(false); }
  };
  return <TaskDialog title="重命名任务" onClose={onClose} busy={saving}>
    <form onSubmit={save}>
      <label>任务名称<input autoFocus required maxLength={200} value={value} disabled={saving}
        onFocus={event => event.currentTarget.select()} onChange={event => setValue(event.target.value)}/></label>
      {error && <p className="task-form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={saving}>取消</button>
        <button className="primary" disabled={saving || !value.trim()}>{saving ? '保存中…' : '保存名称'}</button></div>
    </form>
  </TaskDialog>;
}

export function SourcesDialog({ paths, name, onClose, onCopy, relative = false }: {
  paths: string[]; name: string; onClose: () => void; onCopy: (paths: string[]) => Promise<boolean>; relative?: boolean;
}) {
  const perPage = 50;
  const [page, setPage] = useState(0);
  const [message, setMessage] = useState('');
  const lastPage = Math.max(0, Math.ceil(paths.length / perPage) - 1);
  const index = Math.min(page, lastPage);
  const copy = async (sources: string[]) => setMessage(await onCopy(sources) ? '已复制来源路径' : '复制失败，请选中完整路径后手动复制。');
  return <TaskDialog title={relative ? '来源目录（相对路径）' : '原始上传路径'} onClose={onClose}>
    <p className="dialog-description">{name} · {paths.length.toLocaleString('zh-CN')} 个来源</p>
    <ul className="upload-sources">{paths.slice(index * perPage, (index + 1) * perPage).map(path =>
      <li key={path}><Folder size={17}/><code>{path}</code><button className="icon" type="button" aria-label={'复制 ' + path} onClick={() => void copy([path])}><Copy size={15}/></button></li>)}</ul>
    {lastPage > 0 && <div className="pagination"><span>每页 {perPage} 个来源</span><div>
      <button aria-label="来源上一页" disabled={index === 0} onClick={() => setPage(index - 1)}>‹</button>
      <span>{index + 1} / {lastPage + 1}</span><button aria-label="来源下一页" disabled={index === lastPage} onClick={() => setPage(index + 1)}>›</button>
    </div></div>}
    {message && <p role="status" className="dialog-description">{message}</p>}
    <div className="modal-actions"><button type="button" onClick={() => void copy(paths)} disabled={!paths.length}><Copy size={15}/>复制全部路径</button><button type="button" className="primary" onClick={onClose}>完成</button></div>
  </TaskDialog>;
}

export function ImportTaskDialog({ selection, targets, activeId, onClose, onConfirm }: {
  selection: DesktopSelection;
  targets: WorklistTask[];
  activeId?: string;
  onClose: () => void;
  onConfirm: (name: string, targetId?: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'new' | 'merge'>('new');
  const [name, setName] = useState(selection.name.slice(0, 200));
  const [targetId, setTargetId] = useState(targets[0]?.id || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const target = targets.find(task => task.id === targetId);
  const valid = mode === 'merge' ? Boolean(target) : Boolean(name.trim());
  const confirm = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try { await onConfirm(mode === 'merge' ? target!.name : name.trim(), mode === 'merge' ? targetId : undefined); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { pending.current = false; setSaving(false); }
  };
  return <TaskDialog title="将图片加入任务" onClose={onClose} busy={saving}>
    <p className="dialog-description"><strong>{selection.name}</strong>{selection.paths.length > 0 && <> · {selection.paths.length.toLocaleString('zh-CN')} 个来源</>}</p>
    <form onSubmit={confirm}>
      <fieldset className="import-modes" disabled={saving}><legend>任务归属</legend>
        <label><input type="radio" name="upload-destination" checked={mode === 'new'} onChange={() => setMode('new')}/>创建新的排队任务</label>
        <label><input type="radio" name="upload-destination" checked={mode === 'merge'} disabled={!targets.length} onChange={() => setMode('merge')}/>并入已有任务</label>
      </fieldset>
      {mode === 'new' ? <label>新任务名称<input required maxLength={200} value={name} disabled={saving} onChange={event => setName(event.target.value)}/></label>
        : <label>并入哪个任务<select value={target?.id || ''} disabled={saving} onChange={event => setTargetId(event.target.value)}>
          {!target && <option value="">请选择可合并的任务</option>}
          {targets.map(task => <option key={task.id} value={task.id}>{task.name} · {task.id === activeId ? '当前任务' : '排队中'}</option>)}
        </select></label>}
      {mode === 'merge' && !target && <p className="task-form-error" role="status">原任务已结束，请选择其他任务或创建新任务。</p>}
      <p className="import-group-note">每组最多 20,000 张。当前组完成后，自动处理下一组。</p>
      {error && <p className="task-form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={saving}>取消</button><button className="primary" disabled={!valid || saving}>{saving ? '保存中…' : mode === 'merge' ? '确认并入' : '加入队列'}</button></div>
    </form>
  </TaskDialog>;
}
