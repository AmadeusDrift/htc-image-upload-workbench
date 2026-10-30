import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {build} from 'esbuild';
const root=process.cwd();
const assets={};
function visit(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())visit(full);else{const key='/'+path.relative(path.join(root,'dist'),full).split(path.sep).join('/');const ext=path.extname(full);const type={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'}[ext]||'application/octet-stream';assets[key]={type,data:gzipSync(fs.readFileSync(full)).toString('base64')};}}}
visit(path.join(root,'dist'));
fs.mkdirSync('build',{recursive:true});
fs.writeFileSync('build/ui-assets.json',JSON.stringify(assets));
fs.writeFileSync('build/entry.ts',`import backend from '../server/index';
import assets from './ui-assets.json';
export default {
 async fetch(request:Request,env:Env){
  const url=new URL(request.url);
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/img/'))return backend.fetch(request,env);
  if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
  const map=assets as Record<string,{type:string,data:string}>;
  const asset=map[url.pathname==='/'?'/index.html':url.pathname]||(!url.pathname.split('/').pop()?.includes('.')?map['/index.html']:undefined);
  if(!asset)return new Response('Not found',{status:404});
  const body=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
  return new Response(request.method==='HEAD'?null:body,{encodeBody:'manual',headers:{'Content-Type':asset.type,'Content-Encoding':'gzip','Cache-Control':url.pathname.startsWith('/assets/')?'public,max-age=31536000,immutable':'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: blob: data:; connect-src 'self' https://e4ae0f44249c105791d1e64969abc669.r2.cloudflarestorage.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"}});
 },scheduled:backend.scheduled
};`);
await build({entryPoints:['build/entry.ts'],outfile:'build/worker.js',bundle:true,format:'esm',platform:'browser',external:['cloudflare:workers'],minify:true});
console.log('Bundled backend and '+Object.keys(assets).length+' web assets; '+fs.statSync('build/worker.js').size+' bytes');

