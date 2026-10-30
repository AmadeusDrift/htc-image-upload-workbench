// @vitest-environment happy-dom
import React,{act} from 'react';
import {createRoot,Root} from 'react-dom/client';
import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import App,{Password} from './App';
import {api} from './api';
vi.mock('./api',()=>({api:vi.fn(),getToken:()=> 'test-session',getDeviceId:async()=> 'test-device',json:(method:string,body:unknown)=>({method,body:JSON.stringify(body)}),logoutSession:vi.fn()}));
let host:HTMLDivElement,root:Root;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host)});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()});
async function mount(save:()=>Promise<void>){await act(async()=>root.render(React.createElement(Password,{onClose:vi.fn(),onSave:save,initialPassword:true})))}
function fill(old='initial-password',next='new-password-123',confirm=next){for(const [name,value] of Object.entries({old,new:next,confirm})){const input=host.querySelector<HTMLInputElement>(`input[name="${name}"]`);if(input)input.value=value}}
async function submit(){await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await Promise.resolve()})}
it('shows a server rejection inside the password dialog and keeps the form open',async()=>{const save=vi.fn(async()=>{throw Error('原密码不正确')});await mount(save);fill();await submit();expect(save).toHaveBeenCalledOnce();expect(host.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('原密码不正确');expect(host.querySelector('form')).not.toBeNull();expect(host.textContent).toContain('本次登录使用的密码')});
it('checks the confirmation before making a password change request',async()=>{const save=vi.fn(async()=>{});await mount(save);fill('initial-password','new-password-123','different-password');await submit();expect(save).not.toHaveBeenCalled();expect(host.querySelector('[role="alert"]')?.textContent).toContain('两次');});
it('does not submit twice while saving and does not dismiss on background click',async()=>{let finish!:()=>void;const save=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}));await mount(save);fill();await submit();await submit();expect(save).toHaveBeenCalledOnce();expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);await act(async()=>{finish()})});
it('submits old and new passwords exactly as typed without trimming',async()=>{const save=vi.fn(async()=>{});await mount(save);fill(' old password ',' new password ');await submit();expect(save).toHaveBeenCalledWith({oldPassword:' old password ',newPassword:' new password '})});
it('allows an eight-character password and rejects seven characters before saving',async()=>{const save=vi.fn(async()=>{});await mount(save);fill('initial-password','1234567');await submit();expect(save).not.toHaveBeenCalled();fill('initial-password','12345678');await submit();expect(save).toHaveBeenCalledWith({oldPassword:'initial-password',newPassword:'12345678'})});
it('keeps password errors in the real application modal, then closes only after confirmed success',async()=>{
 let rejectPassword=true;
 vi.mocked(api).mockImplementation(async(route:string)=>{
  if(route==='/health')return {initialized:true,ok:true,storageReady:true};
  if(route==='/me')return {user:{id:'employee',username:'operator',displayName:'Operator',role:'employee',mustChangePassword:true,permissions:{view:false,upload:true}},groups:[]};
  if(route==='/settings')return {settings:{},storage:{ready:true}};
  if(route==='/password'){if(rejectPassword)throw Error('原密码不正确');return {ok:true}}
  return {};
 });
 await act(async()=>root.render(React.createElement(App)));
 const open=[...host.querySelectorAll('button')].find(button=>button.textContent==='修改密码')!;
 await act(async()=>{open.click()});fill();await submit();
 expect(host.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('原密码不正确');
 expect(host.querySelector('main > [role="alert"]')).toBeNull();
 rejectPassword=false;await submit();
 expect(host.querySelector('[role="dialog"]')).toBeNull();expect(host.textContent).toContain('密码修改成功');expect(host.textContent).not.toContain('请修改初始密码后继续使用');
});
