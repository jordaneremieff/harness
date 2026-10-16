import {parentPort} from 'node:worker_threads';

if(!parentPort)throw new Error('An owner decoder requires a parent port.');
parentPort.on('message',(message:{id:number;bytes:Uint8Array})=> {
  try {const value:unknown=JSON.parse(Buffer.from(message.bytes).toString('utf8').replace(/\r$/,''));parentPort?.postMessage({id:message.id,value});}
  catch {parentPort?.postMessage({id:message.id,error:true});}
});
