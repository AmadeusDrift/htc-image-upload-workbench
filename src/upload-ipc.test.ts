import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
const {assertTrustedSender}=createRequire(import.meta.url)('../electron/security.cjs');
describe('desktop IPC sender boundary',()=>{
 const url='file:///C:/app/dist/index.html';
 function context(){const mainFrame={url};const webContents={mainFrame,getURL:()=>url};return {win:{webContents},event:{sender:webContents,senderFrame:mainFrame}}}
 it('accepts the packaged main frame',()=>{const {win,event}=context();expect(()=>assertTrustedSender(event,win,url)).not.toThrow()});
 it.each([
  ['file:///C:/Users/USER%7E1/AppData/Local/Temp/app/resources/app.asar/dist/index.html','file:///C:/Users/USER~1/AppData/Local/Temp/app/resources/app.asar/dist/index.html'],
  ['file:///C:/Users/a%5Bb%5D/app.asar/dist/index.html','file:///C:/Users/a[b]/app.asar/dist/index.html'],
 ])('accepts the same local file with Chromium path encoding', (expected,actual)=>{const {win,event}=context();win.webContents.getURL=()=>actual;win.webContents.mainFrame.url=actual;expect(()=>assertTrustedSender(event,win,expected)).not.toThrow()});
 it.each([url+'#unexpected','file://remote/C:/app/dist/index.html','file:///C:/app/dist/%2Findex.html','file:///C:/app/dist/%00index.html','file:///C:/app/dist/%broken.html'])('rejects ambiguous or nonlocal file URLs %s',actual=>{const {win,event}=context();win.webContents.getURL=()=>actual;win.webContents.mainFrame.url=actual;expect(()=>assertTrustedSender(event,win,url)).toThrow()});
 it('rejects a subframe in the same webContents',()=>{const {win,event}=context();event.senderFrame={url};expect(()=>assertTrustedSender(event,win,url)).toThrow()});
 it.each(['https://example.com','file:///C:/app/dist/other.html',url+'?untrusted=1'])('rejects a main frame navigated to %s',untrusted=>{const {win,event}=context();win.webContents.getURL=()=>untrusted;win.webContents.mainFrame.url=untrusted;expect(()=>assertTrustedSender(event,win,url)).toThrow()});
 it('rejects another webContents',()=>{const {win,event}=context();event.sender=context().win.webContents;expect(()=>assertTrustedSender(event,win,url)).toThrow()});
});
