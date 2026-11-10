import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough,Readable,Writable} from 'node:stream';
import {afterEach,expect,it,vi} from 'vitest';
import {storageFailure,transferDeadline} from '../electron/upload-policy.mjs';
const {uploadNativeFile,uploadIpcResult}=createRequire(import.meta.url)('../electron/native-upload.cjs');

afterEach(()=>vi.useRealTimers());

function transport(){
 vi.useFakeTimers();
 const reader=new PassThrough();
 const socket=new EventEmitter();
 const request=new Writable({write(_data,_encoding,callback){callback()}}) as any;
 request.flushHeaders=()=>{};
 let respond:any;
 const operation=uploadNativeFile({
  target:new URL('https://r2.test/file'),file:{path:'image.png',size:3},headers:{},
  slot:{setRequest:()=>{}},deadlineAt:Date.now()+270000,onProgress:()=>{},
  request:(_target:any,_options:any,callback:any)=>{respond=callback;return request},
  createReadStream:()=>reader,
 });
 const settled=operation.then(()=>({ok:true}), (error:any)=>({ok:false,error}));
 request.emit('socket',socket);
 return {reader,socket,settled,respond:(code:number,body='',headers={})=>{
  const response=Readable.from(body?[Buffer.from(body)]:[]) as any;
  response.statusCode=code;
  response.headers=headers;
  respond(response);
 }};
}

it('keeps a progressing native transfer past 60 seconds',async()=>{
 const wire=transport();wire.socket.emit('secureConnect');
 for(const delay of [20000,20000,25000]){
  await vi.advanceTimersByTimeAsync(delay);
  wire.reader.write(Buffer.from('x'));
 }
 wire.reader.end();wire.respond(200);
 expect(await wire.settled).toEqual({ok:true});
});

it('bounds TLS connection and connected inactivity independently',async()=>{
 const connecting=transport();
 await vi.advanceTimersByTimeAsync(15000);
 expect(await connecting.settled).toMatchObject({ok:false,error:{kind:'timeout',message:expect.stringContaining('连接存储超时')}});
 const stalled=transport();stalled.socket.emit('secureConnect');
 await vi.advanceTimersByTimeAsync(34000);
 stalled.reader.write(Buffer.from('x'));
 await vi.advanceTimersByTimeAsync(35000);
 expect(await stalled.settled).toMatchObject({ok:false,error:{kind:'timeout',message:expect.stringContaining('没有传输进展')}});
});

it('keeps a safety window for confirmation and caps even large files at 270 seconds',()=>{
 const now=1_700_000_000_000;
 expect(transferDeadline(50*1024*1024,undefined,now)-now).toBe(270000);
 expect(transferDeadline(1,undefined,now)-now).toBeLessThan(100000);
 expect(transferDeadline(50*1024*1024,new Date(now+150000).toISOString(),now)-now).toBe(130000);
});

it('preserves storage status and expiry classification over a serializable IPC result',async()=>{
 const denied=transport();denied.respond(403,'<Error><Code>SignatureDoesNotMatch</Code></Error>');
 expect(await denied.settled).toMatchObject({ok:false,error:{kind:'auth',status:403,retryable:false}});
 const expired=transport();expired.respond(403,'<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>');
 expect(await expired.settled).toMatchObject({ok:false,error:{kind:'signature-expired',status:403,retryable:false}});
 const result=await uploadIpcResult(async()=>{throw storageFailure(429,'','3')});
 expect(structuredClone(result)).toMatchObject({ok:false,error:{kind:'http',status:429,retryAfter:3}});
 expect(storageFailure(403,'<Code>ExpiredToken</Code>').kind).toBe('auth');
});
