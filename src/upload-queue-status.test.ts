import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { UploadQueueStatus } from './UploadQueueStatus';
import type { UploadState } from './upload';

it('shows current use, reduced quota, speed and company occupancy separately', () => {
  const queue: UploadState = {items:[],status:'uploading',telemetry:{
    quota:10,transferring:12,confirming:2,waiting:42,retrying:0,
    bytesPerSecond:6.8*1024*1024,phase:'transferring',globalUsed:20,globalLimit:20,uploadingDevices:2,
  }};
  const html=renderToStaticMarkup(React.createElement(UploadQueueStatus,{queue,online:true}));
  expect(html).toContain('已用 <b>14 路</b>');
  expect(html).toContain('已分配 <b>10 路</b>');
  expect(html).toContain('6.8 MB/s');
  expect(html).toContain('正在传的图片完成后调整并发');
  expect(html).toContain('2 台设备占用 · 20 / 20 路');
  const paused=renderToStaticMarkup(React.createElement(UploadQueueStatus,{
    queue:{...queue,status:'paused'},online:true,
  }));
  expect(paused).toContain('已暂停');
  expect(paused).toContain('已用 <b>0 路</b>');
  expect(paused).toContain('0 B/s');
});
