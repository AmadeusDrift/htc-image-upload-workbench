// @vitest-environment happy-dom
import React,{act} from 'react';import {createRoot,Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';import App from './App';import {api} from './api';
vi.mock('./api',()=>({api:vi.fn(),getToken:()=>sessionStorage.getItem('yuntu-token'),getDeviceId:async()=> 'card-device',json:(method:string,body:unknown)=>({method,body:JSON.stringify(body)}),logoutSession:async(revoke:()=>Promise<unknown>,clear:()=>void)=>{const promise=revoke();sessionStorage.removeItem('yuntu-token');clear();await promise}}));
let root:Root,host:HTMLDivElement;
const profiles=['alpha','beta','gamma','delta'].map((username,i)=>({id:'owner-'+username,username,displayName:'运营'+(i+1),available:true,onlineDevices:0,uploadingDevices:0,uploadSlots:0}));
beforeEach(()=>{sessionStorage.clear();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);
 vi.mocked(api).mockImplementation(async(route:string,options:any)=>{
  if(route==='/health')return {ok:true,initialized:true,storageReady:true,operatorEntryEnabled:true};
  if(route==='/operator-status')return {profiles,globalSlots:0,globalLimit:20};
  if(route==='/operator-entry'){const b=JSON.parse(options.body);return {token:'operator-token',user:{id:'owner-'+b.username,username:b.username,role:'employee',displayName:'运营',permissions:{upload:true,view:true},mustChangePassword:true},groups:[{id:'group',name:'业务',status:'active'}]};}
  if(route==='/login')return {token:'admin-token',user:{id:'admin',username:'admin',role:'admin',displayName:'管理员'},groups:[]};
  if(route==='/settings')return {settings:{notify:false},storage:{ready:true}};
  return {ok:true};
 });
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete window.desktop;vi.unstubAllGlobals();vi.clearAllMocks();sessionStorage.clear()});
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
it('replaces the initialized password screen with four direct-entry cards',async()=>{
 await act(async()=>root.render(React.createElement(App)));expect(host.querySelectorAll('[data-operator]')).toHaveLength(4);expect(host.querySelector('input[type="password"]')).toBeNull();
 await act(async()=>{host.querySelector<HTMLButtonElement>('[data-operator="alpha"]')!.click()});
 expect(host.querySelector('.workspace')).toBeTruthy();expect(sessionStorage.getItem('yuntu-token')).toBe('operator-token');
 const entry=vi.mocked(api).mock.calls.find(c=>c[0]==='/operator-entry')!;expect(JSON.parse(String(entry[1]!.body))).toEqual({username:'alpha',deviceId:'card-device'});
 expect(vi.mocked(api).mock.calls.some(c=>c[0]==='/login')).toBe(false);expect(host.textContent).not.toContain('请修改初始密码');
});
it('exposes administrator password login only after selecting its separate entry',async()=>{
 await act(async()=>root.render(React.createElement(App)));await act(async()=>{button('管理员登录').click()});
 expect(host.querySelector('input[type="password"]')).toBeTruthy();expect(host.textContent).toContain('管理员账号');
 await act(async()=>{button('返回账号选择').click()});expect(host.querySelectorAll('[data-operator]')).toHaveLength(4);
});
it('keeps the chooser visible until the selected owner checkpoint is restored',async()=>{
 let finish!:(value:any)=>void;
 window.desktop={onUploadProgress:()=>()=>{},onPrepareClose:()=>()=>{},loadManifest:async()=>null,loadUserManifest:()=>new Promise(resolve=>{finish=resolve}),saveManifest:async()=>true,flushManifest:async()=>true} as any;
 await act(async()=>root.render(React.createElement(App)));await act(async()=>{host.querySelector<HTMLButtonElement>('[data-operator="alpha"]')!.click()});
 expect(host.querySelector('.workspace')).toBeNull();expect(host.textContent).toContain('正在进入');
 await act(async()=>{finish(null)});expect(host.querySelector('.workspace')).toBeTruthy();
});
it('revokes an entry session when its local checkpoint cannot be restored',async()=>{
 window.desktop={onUploadProgress:()=>()=>{},onPrepareClose:()=>()=>{},loadManifest:async()=>null,loadUserManifest:async()=>{throw Error('进度无法恢复')},saveManifest:async()=>true,flushManifest:async()=>true} as any;
 await act(async()=>root.render(React.createElement(App)));await act(async()=>{host.querySelector<HTMLButtonElement>('[data-operator="alpha"]')!.click()});
 expect(host.querySelector('.workspace')).toBeNull();expect(host.querySelector('[role="alert"]')?.textContent).toContain('进度无法恢复');expect(sessionStorage.getItem('yuntu-token')).toBeNull();
});
