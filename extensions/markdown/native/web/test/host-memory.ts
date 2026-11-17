(() => {
 type Fields=Record<string,unknown>;
 const api=(globalThis as unknown as {reader:ReaderNamespace}).reader;
 const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
 api.createMemoryHost=(input,render)=>{
  api.bridge.native({...input,v:1,type:'document'});
  let payload=clone(input),disposed=false,draft:ReaderDocument|undefined;
  let retained=clone(payload);
  const mirror:ReaderMirror={originalSource:input.source,source:input.source,generation:input.generation,meta:clone(input.meta)};
  const handlers=new Map<string,Set<(message:unknown)=>unknown>>(),responders=new Map<string,(fields:Fields)=>unknown>();
  const messages:ReaderHostMessage[]=[],sent:ReaderHostMessage[]=[],inbound:ReaderHostMessage[]=[];
  const capabilities:ReaderHostCapabilities={menuBar:input.chrome==='window',filePanels:true,returnFocus:input.chrome==='pane',windowChrome:String(input.chrome)};
  const emit=(type:string,fields:Fields={})=>{
   if(disposed)return false;const message=api.bridge.native({...fields,v:1,type});messages.push(message);inbound.push(message);
   for(const handler of handlers.get(type)??[])handler(message);return true;
  };
  function snapshot():ReaderDocument{return {...clone(payload),source:mirror.source,generation:mirror.generation,meta:clone(mirror.meta)};}
  function refuse(reason:string){emit('refused',{generation:mirror.generation,reason});emit('document',snapshot());}
  function mirrorEdit(m:ReaderHostMessage){
   if(m.baseGeneration!==mirror.generation){refuse('generation');return;}
   const edits=m.edits as ReaderEdit[];
   if(edits.some(e=>e.end>mirror.source.length||mirror.source.slice(e.start,e.end)!==e.expected)){refuse('expected');return;}
   let next='',cursor=0;for(const e of edits){next+=mirror.source.slice(cursor,e.start)+e.text;cursor=e.end;}next+=mirror.source.slice(cursor);
   if(new TextEncoder().encode(next).length>2*1024*1024){refuse('size');return;}
   if(mirror.meta.capturedSource)mirror.meta={...mirror.meta,kind:'draft',documentId:'memory-copy',shortId:'copy',copyOf:mirror.meta.documentId,capturedSource:false};
   mirror.source=next;mirror.generation=m.generation as number;payload=snapshot();retained=clone(payload);
   if(input.meta.capturedSource)draft=clone(payload);
   emit('ack',{generation:mirror.generation,digest:`memory-${mirror.generation}`,meta:clone(mirror.meta),recovery:'retained'});
  }
  function send(type:string,fields:Fields={}){
   if(disposed)throw new Error('Memory host is disposed.');const message=api.bridge.page({...fields,v:1,type});sent.push(message);messages.push(message);
   if(type==='edits')mirrorEdit(message);else if(type==='ready')emit('document',snapshot());else if(type==='lock')payload.settings.lock=fields.lock as 'reading'|'writing';
  }
  async function request(type:string,fields:Fields={}){
   if(disposed)throw new Error('Memory host is disposed.');const id=`memory-${messages.length}`;const message=api.bridge.page({...fields,v:1,type,id});messages.push(message);sent.push(message);
   const response=await responseFor(type,fields);
   return api.bridge.reply({v:1,type:'reply',id,ok:true,...response},id,type,fields);
  }
  function responseFor(type:string,fields:Fields):Fields|Promise<Fields>{
   const custom=responders.get(type);if(custom)return Promise.resolve(custom(fields)).then(value=>value as Fields);
   if(type==='render'){payload.blocks=render(mirror.source,mirror.generation);return {generation:mirror.generation,blocks:clone(payload.blocks)};}
   if(type==='prompt')return {accepted:true};
   if(type==='command')return fields.name==='pickImage'?{cancelled:true}:{};
   if(type==='query')return queryResponse(fields);throw new Error('Unsupported memory request.');
  }
  function queryResponse(fields:Fields):Fields{
   if(fields.kind==='review')return {summary:'Fixture review',html:'<p>No changes.</p>'};
   if(fields.kind==='details')return {rows:[{label:'Document',value:'Fixture'}],images:[]};
   if(fields.kind==='image')return {address:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E',facts:[],width:1,height:1};
   return {rows:[],limited:false};
  }
  const host:ReaderMemoryHost={capabilities,send,request,emit,messages,sent,inbound,mirror,
   get document(){return snapshot();},get source(){return mirror.source;},get generation(){return mirror.generation;},get draft(){return draft;},
   on(type,handler){let set=handlers.get(type);if(!set)handlers.set(type,set=new Set());set.add(handler);return()=>set.delete(handler);},
   recovery(){return clone(retained);},respond(type,handler){responders.set(type,handler);},dispose(){disposed=true;handlers.clear();responders.clear();},
  };return host;
 };
})();
