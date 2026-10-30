import {describe,it,expect} from 'vitest';
import {productTable,detailTable} from './export';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {ExportDialog} from './App';
const image=(relativePath:string,url=relativePath,taskId='task-a')=>({name:relativePath.split('/').at(-1)!,relativePath,url,size:100,createdAt:'2026-10-29T00:00:00Z',taskId,groupId:'group-a'});
describe('product link export',()=>{
 it('defaults the export dialog to one product per row and Excel',()=>{
  const html=renderToStaticMarkup(React.createElement(ExportDialog,{request:{taskId:'task-a'},settings:{},onClose:()=>{},notify:()=>{}}));
  expect(html).toContain('name="export-layout" checked=""');expect(html).toContain('按产品（一行一套图）');expect(html).toContain('图片1、图片2');expect(html).toContain('逐张明细');expect(html).toContain('Excel (.xlsx)');
 });
 it('groups product folders and packs naturally sorted links without numeric gaps',()=>{
  const table=productTable([image('套图/002/3.jpg'),image('套图/001/2.jpg'),image('套图/002/1.jpg'),image('套图/001/1.jpg')]);
  expect(table).toEqual({headers:['文件夹名','图片1','图片2'],rows:[['001','套图/001/1.jpg','套图/001/2.jpg'],['002','套图/002/1.jpg','套图/002/3.jpg']]});
 });
 it('sorts image2 before image10 and preserves zero-padded folder names',()=>{
  const table=productTable([image('010/10.jpg'),image('002/01.png'),image('010/2.jpg')]);
  expect(table.headers.at(-1)).toBe('图片2');expect(table.rows[0]).toEqual(['002','002/01.png','']);expect(table.rows[1]).toEqual(['010','010/2.jpg','010/10.jpg']);
 });
 it('never merges folders sharing a leaf name under different roots',()=>{
  expect(productTable([image('A/001/1.jpg','first'),image('B/001/1.jpg','second')]).rows).toEqual([['001','first'],['001','second']]);
 });
 it('retains separate files with equivalent numeric names and different extensions',()=>{
  expect(productTable([image('001/1.png'),image('001/01.jpg')]).rows[0].slice(1).sort()).toEqual(['001/01.jpg','001/1.png']);
 });
 it('rejects combining the same folder from separate upload tasks even with disjoint scenes',()=>{
  expect(()=>productTable([image('001/1.jpg'),image('001/2.jpg','url','task-b')])).toThrow('不同');
 });
 it('still requires a parent folder but accepts arbitrary names, zero and large numbers',()=>{
  expect(()=>productTable([image('1.jpg')])).toThrow('明细');
  expect(productTable([image('001/front.jpg'),image('001/0.jpg'),image('001/999999.jpg')]).rows[0]).toEqual(['001','001/0.jpg','001/999999.jpg','001/front.jpg']);
 });
 it('exports the reported SKU-prefixed names and other product names into consecutive columns',()=>{
  const prefix='导出文件/HUNI-TLB7575-JIT-0327/';
  const table=productTable([image(prefix+'HUNI-TLB7575-JIT-0327_04_10.jpg','ten'),image('导出文件/另一产品/背面.jpg','back'),image(prefix+'HUNI-TLB7575-JIT-0327_04_4.jpg','four'),image(prefix+'HUNI-TLB7575-JIT-0327_04_2.jpg','two')]);
  expect(table.headers).toEqual(['文件夹名','图片1','图片2','图片3']);expect(table.rows).toContainEqual(['HUNI-TLB7575-JIT-0327','two','four','ten']);expect(table.rows).toContainEqual(['另一产品','back','','']);
 });
 it('uses the immediate parent with Windows separators and keeps input untouched',()=>{
  const file=Object.freeze(image('根目录\\上层\\商品007\\front.jpg','front'));
  expect(productTable(Object.freeze([file])).rows).toEqual([['商品007','front']]);expect(file.relativePath).toContain('\\');
 });
 it('exports 20000 arbitrary filenames as 2000 folder rows without losing links',()=>{
  const files=Array.from({length:20000},(_,i)=>image(`导出/商品${String(Math.floor(i/10)).padStart(4,'0')}/SKU_${10-i%10}_场景.jpg`,`https://example.com/${i}`));
  const table=productTable(files);expect(table.rows).toHaveLength(2000);expect(table.headers).toHaveLength(11);expect(new Set(table.rows.flatMap(row=>row.slice(1))).size).toBe(20000);expect(table.rows[0]).toEqual(['商品0000',...Array.from({length:10},(_,i)=>`https://example.com/${9-i}`)]);
 });
 it('does not mutate input or let per-image sort change product/scene correspondence',()=>{
  const files=Object.freeze([Object.freeze(image('002/2.jpg')),Object.freeze(image('001/1.jpg'))]);
  expect(productTable(files).rows[0]).toEqual(['001','001/1.jpg']);expect(files[0].relativePath).toBe('002/2.jpg');
 });
 it('retains detail export columns and natural filename order',()=>{
  const table=detailTable([image('001/10.jpg'),image('001/2.jpg')],'name',()=> '时间');
  expect(table.headers).toEqual(['文件名','目录','图片链接','文件大小（字节）','上传时间']);expect(table.rows[0]).toEqual(['2.jpg','001/2.jpg','001/2.jpg',100,'时间']);
 });
});
