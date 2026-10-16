import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {OwnerWire,type WireEndpoint} from './owner-wire.mts';
import {OwnerConnection} from './owner-client.mts';
import type {PrimaryOwner} from './primary-owner.mts';
import type {OwnerRequest} from '../shared/owner.ts';
export type TestOwner=Pick<PrimaryOwner,'connect'|'grant'|'handle'|'detach'>&Partial<Pick<PrimaryOwner,'deliveryReady'>>;
export class TestEndpoint extends EventEmitter {
  other?:TestEndpoint;hold=false;held:(()=>void)[]=[];
  send(value:unknown,callback:(error:Error|null)=>void){const deliver=()=>{this.other?.emit('message',value);callback(null);};if(this.hold)this.held.push(deliver);else queueMicrotask(deliver);return true;}
  drain(){this.hold=false;for(const deliver of this.held.splice(0))queueMicrotask(deliver);}
}
export function connectTestOwner(owner:TestOwner,Wire:typeof OwnerWire=OwnerWire,Connection:typeof OwnerConnection=OwnerConnection){
  const parent=new TestEndpoint(),backend=new TestEndpoint();parent.other=backend;backend.other=parent;const attachment=randomUUID();let wire:OwnerWire;
  const hello=owner.connect(attachment,notice=>wire.send({kind:'notice',notice}));owner.grant(attachment);
  wire=new Wire(parent as unknown as WireEndpoint,value=>{const v=value as {kind:string;request:OwnerRequest};if(v.kind==='request')void owner.handle(attachment,v.request).then(reply=>wire.send({kind:'reply',id:v.request.requestId,reply}));},()=>owner.deliveryReady?.(attachment));
  return{connection:Connection.connect(backend as unknown as WireEndpoint,hello),parent,wire,detach:()=>{wire.close();owner.detach(attachment);}};
}
export const ownerTurn=()=>new Promise<void>(resolve=>setImmediate(resolve));
