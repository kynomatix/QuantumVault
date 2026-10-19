import {workerData} from 'node:worker_threads';
process.argv=[process.argv[0],'evaluate.mjs',...workerData.args];
await import('./evaluate.mjs');
