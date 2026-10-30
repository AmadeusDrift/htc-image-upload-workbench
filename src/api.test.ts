import {beforeEach,afterEach,it,expect,vi} from 'vitest';
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();vi.stubGlobal('window',{desktop:{getConfig:()=>Promise.resolve({apiBase:'https://example.com',deviceId:'test-device'})},dispatchEvent:vi.fn()});vi.stubGlobal('sessionStorage',{getItem:()=>null,removeItem:vi.fn()})});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals()});
it('never sends a malformed native device configuration to the login service',async()=>{
 (window as any).desktop.getConfig=async()=>({apiBase:'https://example.com',deviceId:{id:'unexpected'}});vi.stubGlobal('fetch',vi.fn());
 const {api}=await import('./api');await expect(api('/login',{method:'POST',body:'{}'})).rejects.toThrow('设备');expect(fetch).not.toHaveBeenCalled();
});
it('ends an unreachable service request after15seconds',async()=>{
 vi.stubGlobal('fetch',vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))))));
 const {api}=await import('./api');let error='';void api('/health').catch(e=>{error=e.message});await vi.advanceTimersByTimeAsync(15000);expect(error).toContain('连接超时');
});
it('times out when native configuration IPC never answers',async()=>{
 (window as any).desktop.getConfig=()=>new Promise(()=>{});vi.stubGlobal('fetch',vi.fn());const {api}=await import('./api');let error='';void api('/health').catch(e=>{error=e.message});await vi.advanceTimersByTimeAsync(15000);expect(error).toContain('连接超时');expect(fetch).not.toHaveBeenCalled();
});
it('clears the deadline after successful health response',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}})));const {api}=await import('./api');expect(await api('/health')).toEqual({ok:true});expect(vi.getTimerCount()).toBe(0);
});
it('rejects malformed successful responses instead of reporting a save as successful',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>proxy error</html>',{status:200})));const {api}=await import('./api');await expect(api('/password',{method:'POST',body:'{}'})).rejects.toThrow('服务响应格式错误');
});
it('does not let a stale401 invalidate a newer employee session',async()=>{
 let token:string|null='old-token';const remove=vi.fn(()=>{token=null});(sessionStorage as any).getItem=()=>token;(sessionStorage as any).removeItem=remove;
 let respond:(value:Response)=>void=()=>{};vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{respond=resolve})));
 const {api}=await import('./api');const request=api('/me');const rejected=expect(request).rejects.toThrow('expired');await vi.advanceTimersByTimeAsync(0);token='new-token';respond(new Response(JSON.stringify({error:'expired'}),{status:401}));await rejected;
 expect(token).toBe('new-token');expect(remove).not.toHaveBeenCalled();expect(window.dispatchEvent).not.toHaveBeenCalled();
});
it('captures the token before awaiting desktop configuration',async()=>{
 let token:string|null='old-token';(sessionStorage as any).getItem=()=>token;let resolveConfig:(value:any)=>void=()=>{};(window as any).desktop.getConfig=()=>new Promise(resolve=>{resolveConfig=resolve});vi.stubGlobal('fetch',vi.fn(async()=>new Response('{}')));
 const {api}=await import('./api');const request=api('/me');token='new-token';resolveConfig({apiBase:'https://example.com',deviceId:'device'});await request;expect(new Headers((fetch as any).mock.calls[0][1].headers).get('Authorization')).toBe('Bearer old-token');
});
it('clears and announces expiry for the currently active session',async()=>{
 let token:string|null='current-token';(sessionStorage as any).getItem=()=>token;(sessionStorage as any).removeItem=vi.fn(()=>{token=null});vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error:'expired'}),{status:401})));
 const {api}=await import('./api');await expect(api('/me')).rejects.toThrow('expired');expect(token).toBe(null);expect(window.dispatchEvent).toHaveBeenCalledOnce();expect((window.dispatchEvent as any).mock.calls[0][0].type).toBe('yuntu-session-expired');
});
it('keeps external abort errors without invalidating a session',async()=>{
 vi.stubGlobal('fetch',vi.fn((_url,options)=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('caller cancelled','AbortError'))))));const {api}=await import('./api');const controller=new AbortController();const request=api('/me',{signal:controller.signal});const rejected=expect(request).rejects.toMatchObject({name:'AbortError'});await vi.advanceTimersByTimeAsync(0);controller.abort();await rejected;expect(window.dispatchEvent).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('locally clears logout in finally even when the server cannot be reached',async()=>{
 let token:string|null='current-token';(sessionStorage as any).getItem=()=>token;(sessionStorage as any).removeItem=vi.fn(()=>{token=null});const {logoutSession}=await import('./api');const clear=vi.fn();await expect(logoutSession(async()=>{throw new Error('offline')},clear)).rejects.toThrow('offline');expect(token).toBe(null);expect(clear).toHaveBeenCalledOnce();
});
it('does not clear a newer login while an older logout response is pending',async()=>{
 let token:string|null='old-token';(sessionStorage as any).getItem=()=>token;(sessionStorage as any).removeItem=vi.fn(()=>{token=null});const {logoutSession}=await import('./api');let finish:()=>void=()=>{};const clear=vi.fn();const request=logoutSession(()=>new Promise<void>(resolve=>{finish=resolve}),clear);expect(token).toBe(null);expect(clear).toHaveBeenCalledOnce();token='new-token';finish();await request;expect(token).toBe('new-token');expect(clear).toHaveBeenCalledOnce();
});

