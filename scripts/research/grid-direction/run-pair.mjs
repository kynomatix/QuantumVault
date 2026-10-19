// At most two active evaluations; the second pauses between launch windows below 1.8 GiB free.
import {Worker} from 'node:worker_threads';
import {freemem} from 'node:os';
const [evidence,...tasks]=process.argv.slice(2);if(tasks.length<1||tasks.length>2)throw Error('One or two YEAR:MARKET tasks required');
const gate=new SharedArrayBuffer(4),state=new Int32Array(gate);
const update=()=>{const slots=freemem()<1.8*1024**3?1:2;Atomics.store(state,0,slots);Atomics.notify(state,0);};update();const timer=setInterval(update,1000);
try{await Promise.all(tasks.map((task,rank)=>new Promise((resolve,reject)=>{
 const [year,market]=task.split(':');if(!/^(2022|2023|2024|2025)$/.test(year)||!['BTC','ETH','SOL'].includes(market))return reject(Error('Invalid task'));
 const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{rank,gate,args:[evidence,year,market]},execArgv:process.execArgv});
 worker.once('error',reject);worker.once('exit',code=>code?reject(Error(task+' exited '+code)):resolve());
})));}finally{clearInterval(timer);}