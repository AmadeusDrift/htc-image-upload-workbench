// @vitest-environment happy-dom
import React,{act} from 'react';import {createRoot,Root} from 'react-dom/client';import {vi,it,expect,beforeEach,afterEach} from 'vitest';
import App,{DeleteDialog,ExportDialog} from './App';import {api,getToken} from './api';
vi.mock('./api',()=>({api:vi.fn(),getToken:vi.fn(()=>null),getDeviceId:async()=> 'device-test',json:(method:string,body:unknown)=>({method,body:JSON.stringify(body)}),logoutSession:async(revoke:()=>Promise<void>,clear:()=>void)=>{await revoke();vi.mocked(getToken).mockReturnValue(null);clear()}}));
let root:Root,host:HTMLDivElement;
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.mocked(getToken).mockReturnValue(null);host=document.createElement('div');document.body.append(host);root=createRoot(host)});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals()});
const exportCoverage={snapshot:'snapshot-token',snapshotAt:'2026-10-30T00:00:00.000Z',eligibleCount:2,unfinishedCount:3};
const button=(text:string)=>[...host.querySelectorAll('button')].find(element=>element.textContent===text)!;
it('keeps deletion failures visible inside the confirmation dialog',async()=>{await act(async()=>root.render(React.createElement(DeleteDialog,{count:2,onClose:vi.fn(),onDelete:async()=>{throw Error('没有删除权限')}})));await act(async()=>{button('确认删除').click()});expect(host.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('没有删除权限')});
it('does not repeat deletion or close the dialog while the request is pending',async()=>{let finish!:()=>void;const close=vi.fn(),remove=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve}));await act(async()=>root.render(React.createElement(DeleteDialog,{count:2,onClose:close,onDelete:remove})));await act(async()=>{button('确认删除').click()});await act(async()=>{host.querySelector('.overlay')!.dispatchEvent(new MouseEvent('click',{bubbles:true}))});expect(close).not.toHaveBeenCalled();expect(remove).toHaveBeenCalledOnce();expect(host.querySelector<HTMLButtonElement>('.danger-button')!.disabled).toBe(true);await act(async()=>{finish()})});
it.each(['cancel','session'])('does not download an export after %s while its request is pending',async(reason)=>{
 let finish!:(value:unknown)=>void;vi.mocked(api).mockImplementation(()=>new Promise(resolve=>{finish=resolve}));vi.mocked(getToken).mockReturnValue('alice');
 const notify=vi.fn(),close=vi.fn(),download=vi.fn();vi.stubGlobal('URL',class extends URL {static createObjectURL=download;static revokeObjectURL=vi.fn()});
 await act(async()=>root.render(React.createElement(ExportDialog,{request:{taskId:'task-a'},settings:{exportFormat:'csv'},onClose:close,notify})));
 await act(async()=>{button('导出').click()});
 if(reason==='cancel')await act(async()=>{button('取消').click()});else vi.mocked(getToken).mockReturnValue('bob');
 await act(async()=>{finish({files:[{name:'1.jpg',relativePath:'001/1.jpg',url:'https://example.com/image',size:1,createdAt:'2026-10-29'}]})});
 expect(download).not.toHaveBeenCalled();expect(notify).not.toHaveBeenCalled();
});
it('collects bounded export pages before creating the selected product workbook',async()=>{
 const paths:string[]=[];vi.mocked(getToken).mockReturnValue('alice');vi.mocked(api).mockImplementation(async(route:string)=>{paths.push(route);const query=new URL('https://example.test'+route).searchParams;if(query.get('verify')==='1')return {verified:true};const cursor=query.get('cursor');return cursor?{...exportCoverage,files:[{name:'SKU_2.jpg',relativePath:'导出/001/SKU_2.jpg',url:'https://example.com/second',size:1,createdAt:'2026-10-30'}],nextCursor:null}:{...exportCoverage,files:[{name:'SKU_10.jpg',relativePath:'导出/001/SKU_10.jpg',url:'https://example.com/first',size:1,createdAt:'2026-10-30'}],nextCursor:'cursor-1'}});
 let exported:Blob|undefined;const notify=vi.fn();vi.stubGlobal('URL',class extends URL {static createObjectURL=(blob:Blob)=>{exported=blob;return 'blob:export'};static revokeObjectURL=vi.fn()});
 await act(async()=>root.render(React.createElement(ExportDialog,{request:{taskId:'task-a'},settings:{exportFormat:'csv'},onClose:vi.fn(),notify})));await act(async()=>{button('导出').click()});
 expect(paths).toHaveLength(3);expect(new URL('https://example.test'+paths[0]).searchParams.get('snapshot')).toBe('new');expect(new URL('https://example.test'+paths[1]).searchParams.get('snapshot')).toBe('snapshot-token');expect(new URL('https://example.test'+paths[2]).searchParams.get('verify')).toBe('1');expect(paths.every(route=>new URL('https://example.test'+route).searchParams.get('limit')==='500')).toBe(true);expect(new URL('https://example.test'+paths[1]).searchParams.get('cursor')).toBe('cursor-1');const csv=await exported!.text();expect(csv).toContain('"文件夹名","图片1","图片2"');expect(csv).toContain('"001","https://example.com/second","https://example.com/first"');expect(notify).toHaveBeenCalledWith('已导出 1 个产品、2 张图片链接，快照中另有 3 张未完成');
});
it('returns to login rather than first-admin setup after initial setup and logout',async()=>{
 vi.mocked(api).mockImplementation(async(route:string)=>{
  if(route==='/health')return {ok:true,initialized:false,storageReady:true};
  if(route==='/setup'){vi.mocked(getToken).mockReturnValue('new-session');return {token:'new-session',user:{id:'first',username:'first',role:'employee',displayName:'First',permissions:{}},groups:[]}}
  if(route==='/settings')return {settings:{},storage:{ready:true}};return {};
 });
 await act(async()=>root.render(React.createElement(App)));expect(host.textContent).toContain('创建首位管理员');
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
 await act(async()=>{[...host.querySelectorAll('button')].find(element=>element.textContent?.includes('First'))!.click()});
 await act(async()=>{button('退出登录').click()});expect(host.textContent).toContain('登录云图工作台');expect(host.textContent).not.toContain('创建首位管理员');
});
it('ignores the prior employee settings after logout and blocks upload until the new settings arrive',async()=>{
 let aliceSettings!:(value:unknown)=>void,bobSettings!:(value:unknown)=>void;
 const user=(id:string)=>({id,username:id,displayName:id,role:'employee',permissions:{view:false,upload:true}}),groups=[{id:'group',name:'Group'}];vi.mocked(getToken).mockReturnValue('alice');
 vi.mocked(api).mockImplementation(async(route:string)=>{
  if(route==='/health')return {ok:true,initialized:true,storageReady:true};
  if(route==='/me')return {user:user('alice'),groups};
  if(route==='/login'){vi.mocked(getToken).mockReturnValue('bob');return {token:'bob',user:user('bob'),groups}}
  if(route==='/settings')return new Promise(resolve=>{if(getToken()==='alice')aliceSettings=resolve;else bobSettings=resolve});return {};
 });
 await act(async()=>root.render(React.createElement(App)));
 await act(async()=>{[...host.querySelectorAll('button')].find(element=>element.textContent?.includes('alice'))!.click()});await act(async()=>{button('退出登录').click()});
 await act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
 expect(button('选择图片').disabled).toBe(true);
 await act(async()=>{bobSettings({settings:{retries:1},storage:{ready:true}})});
 expect(button('选择图片').disabled).toBe(false);
 await act(async()=>{aliceSettings({settings:{retries:3},storage:{ready:false}})});
 expect(button('选择图片').disabled).toBe(false);
 await act(async()=>{button('设置').click()});expect(host.querySelector<HTMLInputElement>('input.number')?.value).toBe('1');
});
it('does not expose file selection until the employee checkpoint has finished loading',async()=>{
 let restore!:(value:unknown)=>void;vi.mocked(getToken).mockReturnValue('employee');
 (window as any).desktop={onUploadProgress:()=>{},onPrepareClose:()=>{},loadManifest:()=>new Promise(resolve=>{restore=resolve}),saveManifest:async()=>{},flushManifest:async()=>{}};
 vi.mocked(api).mockImplementation(async(route:string)=>{if(route==='/health')return {ok:true,initialized:true};if(route==='/me')return {user:{id:'employee',username:'employee',role:'employee',permissions:{}},groups:[]};if(route==='/settings')return {settings:{},storage:{ready:true}};return {}});
 try{await act(async()=>root.render(React.createElement(App)));expect(host.textContent).not.toContain('选择图片');await act(async()=>{restore(null)});expect(host.textContent).toContain('选择图片')}finally{delete (window as any).desktop}
});
it('does not download when canceled during XLSX serialization',async()=>{
 let finish!:(value:Uint8Array)=>void,started=false;
 vi.doMock('exceljs',()=>({Workbook:class {addWorksheet(){return {addRow:()=>{},getRow:()=>({}),getColumn:()=>({}),columns:[],views:[]}} xlsx={writeBuffer:()=>{started=true;return new Promise<Uint8Array>(resolve=>{finish=resolve})}}}}));
 vi.mocked(api).mockResolvedValue({...exportCoverage,eligibleCount:1,nextCursor:null,files:[{name:'1.jpg',relativePath:'001/1.jpg',url:'https://example.com/image',size:1,createdAt:'2026-10-29'}]});vi.mocked(getToken).mockReturnValue('alice');
 const download=vi.fn(),notify=vi.fn();vi.stubGlobal('URL',class extends URL {static createObjectURL=download;static revokeObjectURL=vi.fn()});
 await act(async()=>root.render(React.createElement(ExportDialog,{request:{taskId:'task-a'},settings:{exportFormat:'xlsx'},onClose:vi.fn(),notify})));
 await act(async()=>{button('导出').click()});await vi.waitFor(()=>expect(started).toBe(true));
 await act(async()=>{button('取消').click();finish(new Uint8Array([1,2]))});expect(download).not.toHaveBeenCalled();expect(notify).not.toHaveBeenCalled();
});

it('does not download a truncated snapshot and shows both coverage counts',async()=>{
 vi.mocked(getToken).mockReturnValue('alice');
 vi.mocked(api).mockResolvedValue({...exportCoverage,files:[{name:'1.jpg',relativePath:'001/1.jpg',url:'https://example.com/image',size:1,createdAt:'2026-10-29'}],nextCursor:null});
 const download=vi.fn();vi.stubGlobal('URL',class extends URL {static createObjectURL=download});
 await act(async()=>root.render(React.createElement(ExportDialog,{request:{taskId:'task-a'},settings:{exportFormat:'csv'},onClose:vi.fn(),notify:vi.fn()})));
 await act(async()=>{button('导出').click()});
 expect(download).not.toHaveBeenCalled();expect(host.querySelector('[role="alert"]')?.textContent).toContain('导出期间有图片到期或被删除');
 expect(host.textContent).toContain('可导出 2 张');expect(host.textContent).toContain('未完成 3 张');
});
