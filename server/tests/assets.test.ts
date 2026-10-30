import {afterAll,it,expect} from 'vitest';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
let mf:Miniflare;
afterAll(async()=>{await mf?.dispose()});
it('serves precompressed HTML and JavaScript decoded exactly once',async()=>{
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:readFileSync('build/worker.js','utf8'),compatibilityDate:'2026-10-29'}));
 const html=await (await mf.dispatchFetch('http://localhost/',{headers:{'Accept-Encoding':'gzip'}})).text();
 expect(html).toMatch(/^<!doctype html>/);
 const match=html.match(/src="\.([^\"]+\.js)"/);expect(match).toBeTruthy();
 const js=await (await mf.dispatchFetch('http://localhost'+match![1],{headers:{'Accept-Encoding':'gzip'}})).text();
 expect(js.startsWith('\u001f')).toBe(false);expect(js).toContain('云图工作台');
});
