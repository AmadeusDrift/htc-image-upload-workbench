import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
const {assertTrustedSender}=createRequire(import.meta.url)('../electron/security.cjs');
describe('desktop IPC sender boundary',()=>{
 const url='file:///C:/app/dist/index.html';
 function context(){const mainFrame={url};const webContents={mainFrame,getURL:()=>url};return {win:{webContents},event:{sender:webContents,senderFrame:mainFrame}}}
 it('accepts the packaged main frame',()=>{const {win,event}=context();expect(()=>assertTrustedSender(event,win,url)).not.toThrow()});
 it('rejects a subframe in the same webContents',()=>{const {win,event}=context();event.senderFrame={url};expect(()=>assertTrustedSender(event,win,url)).toThrow()});
 it.each(['https://example.com','file:///C:/app/dist/other.html',url+'?untrusted=1'])('rejects a main frame navigated to %s',untrusted=>{const {win,event}=context();win.webContents.getURL=()=>untrusted;win.webContents.mainFrame.url=untrusted;expect(()=>assertTrustedSender(event,win,url)).toThrow()});
 it('rejects another webContents',()=>{const {win,event}=context();event.sender=context().win.webContents;expect(()=>assertTrustedSender(event,win,url)).toThrow()});
});
