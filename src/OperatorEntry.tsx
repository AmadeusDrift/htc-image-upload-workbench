import React,{useEffect,useRef,useState} from 'react';
import {ArrowRight,LoaderCircle,RefreshCw,ShieldCheck} from 'lucide-react';
import {api} from './api';
import './operator-entry.css';

const names=['alpha','beta','gamma','delta'] as const;
interface Profile {id?:string;username:string;displayName?:string;available:boolean;onlineDevices:number;uploadingDevices:number;uploadSlots:number}
interface Props {busy:boolean;error?:string;onEnter:(username:string)=>Promise<unknown>|void;onAdmin:()=>void;resume?:{ownerId:string;unfinished:number}}
const placeholders:Profile[]=names.map(username=>({username,available:false,onlineDevices:0,uploadingDevices:0,uploadSlots:0}));
export function OperatorEntry({busy,error,onEnter,onAdmin,resume}:Props){
 const [profiles,setProfiles]=useState(placeholders),[globalSlots,setGlobalSlots]=useState(0),[loaded,setLoaded]=useState(false),[statusError,setStatusError]=useState(''),[entryError,setEntryError]=useState(''),[chosen,setChosen]=useState<string>(),[refresh,setRefresh]=useState(0);
 const mounted=useRef(false),entering=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
 useEffect(()=>{
  let active=true,pending=false,request:AbortController|undefined;
  async function load(){
   if(pending)return;pending=true;request=new AbortController();
   try{
    const data=await api('/operator-status',{signal:request.signal});
    if(!active)return;if(!Array.isArray(data.profiles))throw Error('账号状态响应异常，请刷新重试');
    const next=names.map(username=>{
     const p=data.profiles.find((p:any)=>p?.username===username);if(!p)return {...placeholders.find(p=>p.username===username)!};
     for(const key of ['onlineDevices','uploadingDevices','uploadSlots'])if(!Number.isSafeInteger(p[key])||p[key]<0)throw Error('账号占用信息异常，请刷新重试');
     return {...p,available:p.available===true&&typeof p.id==='string'} as Profile;
    });
    if(!Number.isSafeInteger(data.globalSlots)||data.globalSlots<0)throw Error('公司占用信息异常，请刷新重试');
    setProfiles(next);setGlobalSlots(data.globalSlots);setLoaded(true);setStatusError('');
   }catch(failure:any){if(active){setLoaded(false);setStatusError(failure?.message||'读取账号状态失败，请刷新重试')}}finally{pending=false}
  }
  void load();const timer=setInterval(()=>void load(),10000);
  return()=>{active=false;clearInterval(timer);request?.abort()};
 },[refresh]);
 async function enter(profile:Profile){
  if(entering.current||busy||!loaded||!profile.available)return;
  entering.current=true;setChosen(profile.username);setEntryError('');
  try{await onEnter(profile.username)}catch(failure:any){if(mounted.current)setEntryError(failure?.message||'进入失败，请重试')}
  finally{entering.current=false;if(mounted.current)setChosen(undefined)}
 }
 const saved=resume&&profiles.find(p=>p.id===resume.ownerId);
 const failure=error||entryError||statusError;
 return <section className="operator-entry" aria-label="选择运营账号">
  <header><h2>选择账号，开始上传</h2><p>点击直接进入工作台，无需输入密码。</p></header>
  <div className="operator-capacity"><span>公司共享上传额度</span><strong>{loaded?globalSlots:'—'} / 20 <small>路使用中</small></strong></div>
  <div className="operator-grid" aria-busy={!loaded&&!statusError}>
   {profiles.map(profile=>{
    const own=saved?.id===profile.id&&!!resume?.unfinished;
    const state=!loaded?'读取中':!profile.available?'不可用':profile.uploadSlots>0?'上传中':profile.onlineDevices>0?'在线':'空闲';
    return <button key={profile.username} type="button" data-operator={profile.username} className={'operator-card '+(own?'has-resume':'')} disabled={busy||!!chosen||!loaded||!profile.available} aria-busy={chosen===profile.username} onClick={()=>void enter(profile)}>
     <div className="operator-card-heading"><span className="operator-letter" aria-hidden="true">{profile.username[0].toUpperCase()}</span><div><strong>{profile.username}</strong><small>{profile.displayName||'运营账号'}</small></div><span className={'operator-state '+(state==='上传中'?'transferring':state==='空闲'?'idle':'')}>{state}</span></div>
     <div className="operator-card-metrics"><span>在线电脑 <b>{loaded?profile.onlineDevices:'—'}</b></span><span>上传占用 <b>{loaded?profile.uploadSlots:'—'} 路</b></span></div>
     <div className="operator-card-action"><span>{chosen===profile.username?'正在进入…':own?'继续本机任务':'点击进入'}</span>{chosen===profile.username?<LoaderCircle className="operator-spinner" size={17}/>:<ArrowRight size={17}/>}</div>
    </button>;
   })}
  </div>
  {saved&&resume!.unfinished>0&&<p className="operator-resume">本机 <b>{saved.username}</b> 有 {resume!.unfinished} 张未完成图片。各账号任务分别保存，切换后可继续。</p>}
  {failure&&<div role="alert" className="notice danger operator-error">{failure}</div>}
  <p className="operator-help">账号可由多台电脑使用，上传名额按设备自动分配。图片保留 7 天。</p>
  <footer><button type="button" className="text" disabled={busy||!!chosen} onClick={onAdmin}><ShieldCheck size={16}/>管理员登录</button><button type="button" className="text" disabled={busy||!!chosen} onClick={()=>setRefresh(n=>n+1)}><RefreshCw size={15}/>刷新占用</button></footer>
 </section>;
}
