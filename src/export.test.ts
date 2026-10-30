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
 it('groups full product folders, sorts numbers naturally and leaves missing slots empty',()=>{
  const table=productTable([image('套图/002/3.jpg'),image('套图/001/2.jpg'),image('套图/002/1.jpg'),image('套图/001/1.jpg')]);
  expect(table).toEqual({headers:['产品编号','图片1','图片2','图片3'],rows:[['001','套图/001/1.jpg','套图/001/2.jpg',''],['002','套图/002/1.jpg','','套图/002/3.jpg']]});
 });
 it('keeps image10 in the tenth slot and preserves zero-padded product identifiers',()=>{
  const table=productTable([image('010/10.jpg'),image('002/01.png')]);
  expect(table.headers.at(-1)).toBe('图片10');expect(table.rows[0][0]).toBe('002');expect(table.rows[0][1]).toBe('002/01.png');expect(table.rows[1][10]).toBe('010/10.jpg');
 });
 it('never merges folders sharing a leaf name under different roots',()=>{
  expect(productTable([image('A/001/1.jpg'),image('B/001/1.jpg')]).rows.map(row=>row[0])).toEqual(['A/001','B/001']);
 });
 it('rejects ambiguous duplicate scene numbers rather than overwriting a link',()=>{
  expect(()=>productTable([image('001/1.png'),image('001/01.jpg')])).toThrow('重复');
 });
 it('rejects combining the same folder from separate upload tasks even with disjoint scenes',()=>{
  expect(()=>productTable([image('001/1.jpg'),image('001/2.jpg','url','task-b')])).toThrow('不同');
 });
 it('explains how to export files without product folders or numeric scene names',()=>{
  expect(()=>productTable([image('1.jpg')])).toThrow('明细');expect(()=>productTable([image('001/front.jpg')])).toThrow('明细');
  expect(()=>productTable([image('001/0.jpg')])).toThrow('编号');expect(()=>productTable([image('001/999999.jpg')])).toThrow('编号');
 });
 it('does not mutate input or let per-image sort change product/scene correspondence',()=>{
  const files=Object.freeze([Object.freeze(image('002/2.jpg')),Object.freeze(image('001/1.jpg'))]);
  expect(productTable(files).rows[0]).toEqual(['001','001/1.jpg','']);expect(files[0].relativePath).toBe('002/2.jpg');
 });
 it('retains detail export columns and natural filename order',()=>{
  const table=detailTable([image('001/10.jpg'),image('001/2.jpg')],'name',()=> '时间');
  expect(table.headers).toEqual(['文件名','目录','图片链接','文件大小（字节）','上传时间']);expect(table.rows[0]).toEqual(['2.jpg','001/2.jpg','001/2.jpg',100,'时间']);
 });
});
