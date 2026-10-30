import React,{useEffect,useState} from 'react';
import {Cloud,Minus,Square,Copy,X} from 'lucide-react';
import './titlebar.css';
import UpdateStatus from './UpdateStatus';
export default function TitleBar(){
 const desktop=typeof window==='undefined'?undefined:window.desktop;
 const [maximized,setMaximized]=useState(false);
 useEffect(()=>{if(!desktop)return;let active=true;desktop.getWindowState().then(state=>{if(active)setMaximized(state.maximized)}).catch(()=>{});const unsubscribe=desktop.onWindowStateChanged(state=>setMaximized(state.maximized));return()=>{active=false;unsubscribe()}},[desktop]);
 if(!desktop)return null;
 const toggle=()=>{void desktop.toggleMaximize().then(state=>setMaximized(state.maximized)).catch(()=>{})};
 return <header className="desktop-titlebar" onDoubleClick={toggle}>
  <div className="desktop-titlebar-brand"><Cloud size={19} aria-hidden="true"/><span>云图工作台</span></div>
  <div className="desktop-titlebar-drag" aria-hidden="true"/>
  <UpdateStatus/>
  <div className="desktop-window-controls" onDoubleClick={event=>event.stopPropagation()}>
   <button type="button" aria-label="最小化" title="最小化" onClick={()=>void desktop.minimizeWindow().catch(()=>{})}><Minus size={17}/></button>
   <button type="button" aria-label={maximized?'还原窗口':'最大化'} title={maximized?'还原窗口':'最大化'} onClick={toggle}>{maximized?<Copy className="restore-icon" size={14}/>:<Square size={14}/>}</button>
   <button type="button" className="desktop-window-close" aria-label="关闭窗口" title="关闭窗口" onClick={()=>void desktop.closeWindow().catch(()=>{})}><X size={18}/></button>
  </div>
 </header>
}
