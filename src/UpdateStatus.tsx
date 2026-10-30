import React,{useEffect,useId,useRef,useState} from 'react';
import type {UpdateState} from './desktop';
import './update-status.css';

const labels:Record<UpdateState['status'],string>={idle:'检查更新',checking:'检查中…',available:'发现新版本',downloading:'下载中',ready:'更新可安装',error:'更新失败',unsupported:'',installing:'正在重启…'};
export default function UpdateStatus(){
 const desktop=typeof window==='undefined'?undefined:window.desktop;
 const supported=!!(desktop?.getUpdateState&&desktop.checkForUpdates&&desktop.installUpdate&&desktop.onUpdateStateChanged);
 const [state,setState]=useState<UpdateState|null>(null),[open,setOpen]=useState(false),[pending,setPending]=useState<'check'|'install'|null>(null);
 const alive=useRef(false),inFlight=useRef(false),revision=useRef(0),generation=useRef(0),container=useRef<HTMLDivElement>(null),panelId=useId();
 useEffect(()=>{
  if(!supported)return;
  alive.current=true;generation.current++;setPending(null);let active=true,changed=false;
  const fail=(error:unknown)=>{if(active&&!changed)setState({status:'error',currentVersion:'',busy:false,error:error instanceof Error?error.message:String(error)})};
  const unsubscribe=desktop!.onUpdateStateChanged!(next=>{if(active){changed=true;revision.current++;setState(next)}});
  Promise.resolve().then(()=>desktop!.getUpdateState!()).then(next=>{if(active&&!changed)setState(next)},fail);
  return()=>{active=false;alive.current=false;revision.current++;inFlight.current=false;unsubscribe()};
 },[desktop,supported]);
 useEffect(()=>{
  if(!open)return;
  const close=(event:PointerEvent)=>{if(!container.current?.contains(event.target as Node))setOpen(false)};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);container.current?.querySelector<HTMLButtonElement>('button')?.focus()}};
  document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape)};
 },[open]);
 async function run(action:'check'|'install'){
  if(inFlight.current||!state||action==='install'&&state.busy)return;
  inFlight.current=true;setPending(action);const started=revision.current,connection=generation.current;
  try{
   const next=await (action==='install'?desktop!.installUpdate!():desktop!.checkForUpdates!());
   if(alive.current&&connection===generation.current&&revision.current===started)setState(next);
  }catch(error){
   if(alive.current&&connection===generation.current){setState(current=>({...current!,status:'error',error:error instanceof Error?error.message:String(error)}));setOpen(true)}
  }finally{if(alive.current&&connection===generation.current){inFlight.current=false;setPending(null)}}
 }
 if(!supported||!state||state.status==='unsupported')return null;
 const progress=Math.max(0,Math.min(100,Math.round(Number.isFinite(state.percent)?state.percent!:0)));
 const working=!!pending||['checking','available','downloading','installing'].includes(state.status);
 const label=pending==='check'?'检查中…':pending==='install'?'正在重启…':labels[state.status];
 return <div className="desktop-update" ref={container} onDoubleClick={event=>event.stopPropagation()}>
  <button type="button" className="desktop-update-summary" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>
   <span>{state.currentVersion?`v${state.currentVersion}`:'版本更新'}</span><span aria-live="polite">{label}{state.status==='downloading'?` ${progress}%`:''}</span>
  </button>
  {state.status==='downloading'&&<progress className="desktop-update-progress" aria-label="更新下载进度" max={100} value={progress}/>}
  {open&&<section id={panelId} className="desktop-update-panel" aria-label="软件更新">
   <strong>软件更新{state.version?` · v${state.version}`:''}</strong>
   {(state.error||state.status==='error')&&<p role="alert">{state.error||'更新失败，请重试'}</p>}
   {state.status!=='error'&&<p aria-live="polite">{state.status==='ready'?'更新已下载，重启后完成安装。':state.status==='idle'?'启动时自动检查并在后台下载更新。':label}</p>}
   {state.status==='ready'&&state.busy&&<p className="desktop-update-wait">请等待上传或图片处理完成后再安装。</p>}
   {state.status==='ready'?<button type="button" disabled={state.busy||!!pending} onClick={()=>void run('install')}>重启并安装</button>:<button type="button" disabled={working} onClick={()=>void run('check')}>{working?label:state.status==='error'?'重试':'检查更新'}</button>}
  </section>}
 </div>
}
