import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
const require=createRequire(import.meta.url);
const {validateUploadTarget}=require('../electron/security.cjs');
describe('native upload boundary',()=>{
 const host='e4ae0f44249c105791d1e64969abc669.r2.cloudflarestorage.com';
 it('allows only signed HTTPS URLs on the exact account',()=>{expect(validateUploadTarget('https://'+host+'/bucket/image?X-Amz-Signature=abc',host).hostname).toBe(host)});
 it.each(['http://'+host+'/?X-Amz-Signature=x','https://evil.example/?X-Amz-Signature=x','https://'+host+'.evil.example/?X-Amz-Signature=x','https://'+host+':444/?X-Amz-Signature=x','https://user:pass@'+host+'/?X-Amz-Signature=x','https://'+host+'/unsigned'])('blocks unsafe upload destination %s',url=>expect(()=>validateUploadTarget(url,host)).toThrow());
});
