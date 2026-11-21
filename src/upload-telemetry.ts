export type UploadTelemetry = {
  quota: number | null;
  transferring: number;
  used?: number;
  confirming: number;
  waiting: number;
  retrying: number;
  bytesPerSecond: number;
  globalUsed?: number;
  globalLimit?: number;
  uploadingDevices?: number;
  phase: 'preparing' | 'waiting' | 'transferring' | 'confirming' | 'retrying';
};

export class UploadSpeed {
  private total = 0;
  private samples: {time:number; bytes:number}[] = [{time:performance.now(),bytes:0}];

  add(bytes:number) {
    this.total += Math.max(0,bytes);
  }

  sample() {
    const time = performance.now();
    while (this.samples.length > 1 && this.samples[1].time <= time - 5000) this.samples.shift();
    const first = this.samples[0];
    this.samples.push({time,bytes:this.total});
    return Math.round((this.total - first.bytes) * 1000 / Math.max(250,time - first.time));
  }
}
