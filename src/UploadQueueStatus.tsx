import React from 'react';
import type { UploadState } from './upload';
import './upload-queue-status.css';

const phases = {
  preparing:'准备图片',
  waiting:'等待上传名额',
  transferring:'正在上传',
  confirming:'确认图片链接',
  retrying:'连接异常，正在重试',
};
const states:Partial<Record<UploadState['status'],string>> = {
  ready:'准备就绪',scanning:'正在扫描文件',uploading:'正在准备上传',
  paused:'已暂停',cancelled:'已取消',completed:'本次上传结束',error:'上传已停止',
};
function speedText(speed:number) {
  if(speed>=1024*1024)return (speed/(1024*1024)).toFixed(1)+' MB/s';
  if(speed>=1024)return (speed/1024).toFixed(1)+' KB/s';
  return Math.round(speed)+' B/s';
}

export function UploadQueueStatus({queue, online}:{
  queue:Pick<UploadState,'items'|'status'|'telemetry'>; online:boolean;
}) {
  const running=queue.status==='uploading';
  const metrics=running?queue.telemetry:undefined;
  const transferring=metrics?.transferring ?? (running?queue.items.filter(item=>item.status==='uploading').length:0);
  const confirming=metrics?.confirming??0;
  const used=transferring+confirming;
  const status=running&&!online?'网络已断开'
    : metrics?phases[metrics.phase]
    : transferring?'正在上传':states[queue.status]??'等待上传';
  return <div className="queue-live" aria-label="本机上传状态">
    <div className="queue-live-main">
      <strong className="queue-live-state"><i aria-hidden="true" data-active={running&&online}/><span role="status">{status}</span></strong>
      <span>已用 <b>{used} 路</b></span>
      <span>已分配 <b>{metrics?.quota==null?'—':metrics.quota+' 路'}</b></span>
      <span>实时速度 <b>{speedText(metrics?.bytesPerSecond??0)}</b></span>
    </div>
    {metrics&&<div className="queue-live-meta">
      <span>传输 {transferring} 张</span>
      <span>确认 {confirming} 张</span>
      <span>待传 {metrics.waiting} 张</span>
      {!!metrics.retrying&&<span>{metrics.retrying} 张等待重试</span>}
      {metrics.quota!=null&&used>metrics.quota&&<span>正在传的图片完成后调整并发</span>}
      {metrics.globalLimit!=null&&<details>
        <summary>公司占用</summary>
        <span>{metrics.uploadingDevices} 台设备占用 · {metrics.globalUsed} / {metrics.globalLimit} 路</span>
      </details>}
    </div>}
  </div>;
}
