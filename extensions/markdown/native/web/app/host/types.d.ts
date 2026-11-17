export {};
declare global {
 interface ReaderBlock extends ReaderMappedBlock {}
 interface ReaderDocument extends ReaderCoreDocument {}
 interface ReaderChange {baseGeneration:number;generation:number;origin:'person'|'agent'|'history';operationId?:string;edits:ReaderEdit[]}
 interface ReaderHostMessage {v:1;type:string;id?:string;[key:string]:unknown}
 interface ReaderHost extends ReaderCoreHost {}
 interface ReaderHostCapabilities {menuBar:boolean;filePanels:boolean;returnFocus:boolean;windowChrome:string}
 interface ReaderMirror {readonly originalSource:string;source:string;generation:number;meta:ReaderCoreDocument['meta']}
 interface ReaderMemoryHost extends ReaderHost {
  readonly document:ReaderDocument;readonly source:string;readonly generation:number;readonly mirror:ReaderMirror;
  readonly messages:ReaderHostMessage[];readonly sent:ReaderHostMessage[];readonly inbound:ReaderHostMessage[];
  readonly draft:ReaderDocument|undefined;
  emit(type:string,fields?:Record<string,unknown>):boolean;recovery():ReaderDocument;
  respond(type:string,handler:(fields:Record<string,unknown>)=>unknown):void;
 }
 type ReaderTransport=((message:ReaderHostMessage)=>unknown)|{postMessage(message:ReaderHostMessage):unknown};
 interface ReaderNamespace extends ReaderCoreAPI {
  createNativeHost(transport?:ReaderTransport):ReaderHost&{receive(message:unknown):boolean};
  receive(message:unknown):boolean;
  createMemoryHost(document:ReaderDocument,render:(source:string,generation:number)=>ReaderBlock[]):ReaderMemoryHost;
  bridge:{native(message:unknown):ReaderHostMessage;page(message:unknown):ReaderHostMessage;reply(message:unknown,id:string,kind:string,fields:Record<string,unknown>):Record<string,unknown>};
 }
 var reader:ReaderNamespace;
}
