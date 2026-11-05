// @vitest-environment happy-dom
import React,{act} from 'react';
import {createRoot,Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OperatorEntry} from './OperatorEntry';
import {api} from './api';
vi.mock('./api',()=>({api:vi.fn()}));
let root:Root,host:HTMLDivElement;
const profiles=['alpha','beta','gamma','delta'].map((username,i)=>({id:'user-'+i,username,displayName:'运营'+(i+1),available:true,onlineDevices:i===0?2:0,uploadingDevices:i===0?1:0,uploadSlots:i===0?5:0}));
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);vi.mocked(api).mockResolvedValue({profiles,globalSlots:5,globalLimit:20})});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.useRealTimers();vi.clearAllMocks()});
async function mount(props:any={}){await act(async()=>root.render(React.createElement(OperatorEntry,{busy:false,error:'',onEnter:vi.fn(),onAdmin:vi.fn(),...props})))}
const card=(name:string)=>host.querySelector<HTMLButtonElement>(`[data-operator="${name}"]`)!;
it('shows four account cards and live occupancy without any password input',async()=>{
 await mount();expect(host.querySelectorAll('[data-operator]')).toHaveLength(4);expect(host.querySelector('input[type="password"]')).toBeNull();
 expect(card('alpha').textContent).toContain('2');expect(card('alpha').textContent).toContain('5 路');expect(card('alpha').disabled).toBe(false);
 expect(card('beta').textContent).toContain('空闲');expect(host.textContent).toContain('5 / 20');
});
it('enters an occupied account directly and prevents duplicate clicks',async()=>{
 let finish!:()=>void;const enter=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}));await mount({onEnter:enter});
 await act(async()=>{card('alpha').click();card('alpha').click()});expect(enter).toHaveBeenCalledExactlyOnceWith('alpha');expect(card('beta').disabled).toBe(true);
 await act(async()=>{finish()});expect(card('beta').disabled).toBe(false);
});
it('keeps entry failures in the chooser and allows retry',async()=>{
 await mount({onEnter:vi.fn(async()=>{throw Error('账号已停用')})});await act(async()=>{card('beta').click()});
 expect(host.querySelector('[role="alert"]')?.textContent).toContain('账号已停用');expect(card('beta').disabled).toBe(false);
});
it('keeps administrator entry separate from the four profiles',async()=>{
 const admin=vi.fn();await mount({onAdmin:admin});await act(async()=>{[...host.querySelectorAll('button')].find(b=>b.textContent?.includes('管理员登录'))!.click()});expect(admin).toHaveBeenCalledOnce();expect(host.querySelector('[data-operator="admin"]')).toBeNull();
});
it('marks the saved owner for resuming while allowing other profiles to keep their own queues',async()=>{
 await mount({resume:{ownerId:'user-0',unfinished:7}});expect(card('alpha').textContent).toContain('继续本机任务');expect(card('beta').disabled).toBe(false);expect(host.textContent).toContain('7 张');
});
it('refreshes status and disables a profile that the server disabled',async()=>{
 vi.useFakeTimers();await mount();vi.mocked(api).mockResolvedValue({profiles:profiles.map(p=>p.username==='beta'?{...p,available:false}:p),globalSlots:0,globalLimit:20});
 await act(async()=>{await vi.advanceTimersByTimeAsync(10000)});expect(card('beta').disabled).toBe(true);expect(card('beta').textContent).toContain('不可用');
});
it('shows status errors and never enables stale cards after a failed refresh',async()=>{
 vi.mocked(api).mockRejectedValue(Error('连接超时'));await mount();expect(host.querySelector('[role="alert"]')?.textContent).toContain('连接超时');expect(card('alpha').disabled).toBe(true);
});
