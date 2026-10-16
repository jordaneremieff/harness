import {createServer, createConnection, type Socket} from 'node:net';
import {chmod, unlink} from 'node:fs/promises';
import type {ReleaseControl} from '../shared/release.ts';
const FRAME_BYTES = 4096;
function parse(value: unknown): ReleaseControl {
  const v = value as ReleaseControl;
  if (!v || typeof v !== 'object' || !['status','switch','rollback','stop'].includes(v.kind) || Object.keys(v).some(key => !['kind','release'].includes(key)) || v.kind === 'switch' && (typeof v.release !== 'string' || !/^[a-f0-9]{64}$/.test(v.release))) throw new Error('Invalid release control request.');
  return v;
}
export function assertControlPath(path: string) {if (Buffer.byteLength(path) > 103) throw new Error(`The selected state root produces an unsupported Unix socket path length: ${Buffer.byteLength(path)} bytes; maximum 103.`);}
export async function listenReleaseControl(path: string, handle: (request: ReleaseControl) => Promise<unknown>) {
  assertControlPath(path); const sockets = new Set<Socket>();
  const server = createServer(socket => {
    if (sockets.size >= 16) {socket.destroy(); return;}
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.setTimeout(5000, () => socket.destroy());
    let buffer = Buffer.alloc(0), received = false;
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (received) {socket.destroy(); return;}
      if (buffer.length + chunk.length > FRAME_BYTES) {socket.destroy(); return;}
      buffer = Buffer.concat([buffer, chunk]); const newline = buffer.indexOf(10); if (newline === -1) return;
      received = true;
      if (newline !== buffer.length - 1) {socket.destroy(); return;}
      void (async () => {
        try {const request = parse(JSON.parse(buffer.subarray(0, newline).toString('utf8'))); socket.end(`${JSON.stringify({ok:true,value:await handle(request)})}\n`);}
        catch (error) {socket.end(`${JSON.stringify({ok:false,error:error instanceof Error ? error.message : 'Release control failed.'})}\n`);}
      })();
    });
  });
  await new Promise<void>((accept,reject) => {server.once('error',reject);server.listen(path,()=>{server.off('error',reject);accept();});});
  await chmod(path,0o600);
  return {close: async () => {for (const socket of sockets) socket.destroy(); await new Promise<void>((accept,reject)=>server.close(error=>error?reject(error):accept())); await unlink(path).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}};
}
export function requestReleaseControl(path: string, request: ReleaseControl): Promise<unknown> {
  assertControlPath(path);
  return new Promise((accept,reject) => {
    const socket = createConnection(path); let bytes = Buffer.alloc(0), done = false;
    socket.setTimeout(60000,()=>socket.destroy(new Error('The release control request deadline expired.')));
    socket.once('connect',()=>socket.write(`${JSON.stringify(request)}\n`)); socket.once('error',reject);
    socket.on('data',chunk=>{if(bytes.length+chunk.length>64*1024){socket.destroy(new Error('Release control response exceeds its bound.'));return;}bytes=Buffer.concat([bytes,chunk]);});
    socket.once('end',()=>{try {const value=JSON.parse(bytes.toString('utf8'));done=true;if(value.ok)accept(value.value);else reject(new Error(value.error));}catch(error){reject(error);}finally{socket.destroy();}});
    socket.once('close',()=>{if(!done)reject(new Error('The release control connection closed without a receipt.'));});
  });
}
