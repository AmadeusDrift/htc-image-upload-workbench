import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {presign} from '../storage';

const {uploadHeaders}=createRequire(import.meta.url)('../../electron/native-upload.cjs');

it('binds a worker pack grant to the local SHA-256 before HTTP, while preserving ordinary image grants',async()=>{
 const body=Buffer.from('verified pack');
 const file={temporaryPack:true,size:body.length,sha256:createHash('sha256').update(body).digest('hex')};
 const storage={endpoint:'https://storage.test',bucket:'local-test',accessKeyId:'fixture',secretAccessKey:'fixture-secret'};
 const signed=await presign(storage,'images/packs/leader/lease','application/octet-stream',300,file.sha256);
 const target=new URL(signed.uploadUrl);
 const checksum=signed.headers['x-amz-checksum-sha256'];
 expect(uploadHeaders(file,target,signed.headers)).toEqual({'content-length':file.size,'content-type':'application/octet-stream','x-amz-checksum-sha256':checksum});
 expect(()=>uploadHeaders(file,target,{'Content-Type':'application/octet-stream'})).toThrow(/校验/);
 expect(()=>uploadHeaders(file,target,{...signed.headers,'x-amz-checksum-sha256':'wrong'})).toThrow(/校验/);
 expect(()=>uploadHeaders(file,target,{...signed.headers,'Content-Type':'image/png'})).toThrow(/类型/);
 expect(()=>uploadHeaders(file,target,{...signed.headers,'X-Amz-Checksum-Sha256':checksum})).toThrow(/请求头/);
 const ordinary=await presign(storage,'images/file','image/png');
 expect(uploadHeaders({size:5},new URL(ordinary.uploadUrl),ordinary.headers)).toMatchObject({'content-type':'image/png'});
 expect(()=>uploadHeaders({size:5},target,signed.headers)).toThrow(/原图/);
 target.searchParams.set('X-Amz-SignedHeaders','host');
 expect(()=>uploadHeaders(file,target,signed.headers)).toThrow(/签名/);
});
