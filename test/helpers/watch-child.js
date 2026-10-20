import fs from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, CLI, ADDRESS } from './fake-rpc.js';

export const cancelled = 'Error [WATCH_CANCELLED]: Watch stopped; committed observations were retained and unfinished output was removed.\n';
export const cleanup = 'Error [WATCH_CLEANUP]: Watch output cleanup or close was incomplete; inspect the retained directory and retry in a new directory.\n';
export const watchArgs = (output, extra = []) => ['watch','--address',ADDRESS,'--chain-id','1',
  '--out-dir',output,'--interval-ms','100','--count','2',...extra];

// These hooks run only in disposable test children. IPC positions cancellation
// at real writer/transport/wait boundaries without guessing elapsed I/O time.
export async function watchPreload(dir, point, ordinal = 2, more = '') {
  const path = join(dir, 'gate.mjs');
  await fs.writeFile(path, `
import fs from 'node:fs/promises';
import timers from 'node:timers/promises';
import http from 'node:http';
import {performance} from 'node:perf_hooks';
import {syncBuiltinESMExports} from 'node:module';
const point=${JSON.stringify(point)}, ordinal=${ordinal};
let gated=false, writes=0, offset=0, requests=0;
const request=http.request;
http.request=function(...a){requests++;return request.apply(this,a);};
const now=performance.now.bind(performance);
performance.now=()=>now()+offset;
async function gate(name,n) {
  if(point!==name||gated||(n!==undefined&&n!==ordinal))return;
  gated=true;
  await new Promise(resolve=>{
    process.once('message',m=>{if(m==='expire')offset+=600000;resolve();});
    process.send({point:name});
  });
}
const on=process.on;
process.on=function(name,fn){
  if(name==='SIGINT'||name==='SIGTERM')return on.call(this,name,(...a)=>{fn(...a);process.send({signal:name});});
  return on.call(this,name,fn);
};
const sleep=timers.setTimeout;
timers.setTimeout=(ms,...a)=>{
  if(point==='interval'&&ms===60000)process.send({point});
  if(point==='backoff'&&ms<=100&&requests>8||point==='rate-limit'&&ms>1000)process.send({point});
  return sleep(ms,...a);
};
const immediate=timers.setImmediate;
let turns=0;
timers.setImmediate=async(...a)=>{if(++turns===3)await gate('report');return immediate(...a);};
const open=fs.open;
fs.open=async(...a)=>{
  const f=await open(...a);
  const isOutput=String(a[0]).includes('.observation-');
  if(a[1]==='wx'&&isOutput){
    const n=++writes; await gate('open',n);
    const write=f.writeFile.bind(f),sync=f.sync.bind(f),close=f.close.bind(f);
    f.writeFile=async(text,opts)=>{
      if(point==='write'&&n===ordinal){await write(text.slice(0,100),opts);await gate('write',n);}
      return write(text,opts);
    };
    f.sync=async()=>{await gate('before-sync',n);const r=await sync();await gate('after-sync',n);return r;};
    f.close=async()=>{await gate('close',n);return close();};
  } else if(isOutput) {
    const close=f.close.bind(f),n=writes;
    f.close=async()=>{await gate('pin-close',n);return close();};
  }
  return f;
};
const link=fs.link;
fs.link=async(...a)=>{await gate('before-link',writes);const r=await link(...a);await gate('after-link',writes);return r;};
const unlink=fs.unlink;
fs.unlink=async(...a)=>{if(String(a[0]).endsWith('.tmp'))await gate('temp-cleanup',writes);return unlink(...a);};
const mkdir=fs.mkdir;
fs.mkdir=async(...a)=>{const r=await mkdir(...a);await gate('mkdir');return r;};
${more}
syncBuiltinESMExports();
`);
  return path;
}

export function watchChild(t, args, env = {}) {
  const p = spawn(process.execPath, [CLI,...args], { cwd: ROOT,
    env: {...process.env,CONTRACT_WATCH_RPC_URL:'',...env}, stdio:['ignore','pipe','pipe','ipc'] });
  let stdout='',stderr='',ended=false; const messages=[],waiters=[];
  p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
  p.on('message',m=>{messages.push(m);for(const wake of waiters.splice(0))wake();});
  const result = new Promise((resolve,reject)=>{
    p.once('error',reject);
    p.once('close',(code,signal)=>{ended=true;for(const wake of waiters.splice(0))wake();resolve({code,signal,stdout,stderr});});
  });
  t.after(()=>{if(p.exitCode===null&&p.signalCode===null)p.kill('SIGKILL');});
  const message = async predicate => {
    for(;;){
      const index=messages.findIndex(predicate);
      if(index!==-1)return messages.splice(index,1)[0];
      if(ended)throw Error('Child exited before expected IPC barrier: '+stderr);
      await new Promise(resolve=>waiters.push(resolve));
    }
  };
  return {p,result,message};
}
