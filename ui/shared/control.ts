import {validFileTab, type ConversationLayout, type WorkspaceTab, type Target} from './api.ts';

export const CONTROL_LIMITS = {payloadBytes:16*1024,idChars:200,actorChars:120,pathChars:4096,noticeChars:512,burst:8,perSecond:1,outstanding:8,receipts:64,executionMs:5000,cliMs:8000} as const;
export const CONTROL_ROUTES = {layout:'/api/control/layout',requests:'/api/control/requests',ack:'/api/control/ack'} as const;
export type ControlIntent =
  | {action:'show';rootId:string;path:string;paneId?:string;preview?:boolean}
  | {action:'split';paneId:string;axis:'x'|'y';view:WorkspaceTab}
  | {action:'focus';paneId:string;view?:WorkspaceTab}
  | {action:'resize';splitId:string;ratio:number}
  | {action:'swap';splitId:string}
  | {action:'notice';text:string};
export type ControlProvenance = {requestId:string;bootId:string;workspaceId:string;pageId:string;connectionId:string};
export type ControlRequest = ControlProvenance & {expectedRevision:number;expiresAt:number;actor:string;intent:ControlIntent;primary?:Extract<Target,{kind:'primary'}>};
export type ControlAck = ControlProvenance & ({result:'applied';appliedRevision:number}|{result:'refused';refusalCode:string}|{result:'unconfirmed'});
export type ControlReceipt = {requestId:string;workspaceId:string;actor:string;action:ControlIntent['action'];state:'pending'|'applied'|'refused'|'unconfirmed';createdAt:string;appliedRevision?:number;code?:string};
export type ControlDescriptor = {origin:string;bootId:string};
export type ControlWorkspace = {id:string;revision:number;enabled:boolean;pages:number;layout?:ConversationLayout;primary?:Extract<Target,{kind:'primary'}>;roots?:{id:string;name:string;path:string}[]};
export type ControlLayout = {bootId:string;workspaces:ControlWorkspace[]};
function record(value:unknown):Record<string,unknown> {if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Use a control object.');return value as Record<string,unknown>;}
function fields(value:Record<string,unknown>,required:string[],optional:string[]=[]):void {if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw new Error('The control fields are invalid.');}
export function controlText(value:unknown,name:string,max:number=CONTROL_LIMITS.idChars):string {if(typeof value!=='string'||!value||Array.from(value).length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error(`The ${name} is invalid.`);return value;}
function tab(value:unknown):WorkspaceTab {const input=record(value);if(input.kind==='file'){controlText(input.rootId,'root ID');if(!validFileTab(input)||input.path.length>CONTROL_LIMITS.pathChars)throw new Error('The file view is invalid.');return {...input};}if(input.kind==='primary'){fields(input,['kind']);return {kind:'primary'};}if(input.kind==='agent'){fields(input,['kind','identity']);return {kind:'agent',identity:controlText(input.identity,'agent identity')};}throw new Error('The control view is invalid.');}
function revision(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<0)throw new Error('The control revision is invalid.');return value as number;}
function show(input:Record<string,unknown>):Extract<ControlIntent,{action:'show'}> {
  fields(input,['action','rootId','path'],['paneId','preview']);const rootId=controlText(input.rootId,'root ID'),path=controlText(input.path,'file path',CONTROL_LIMITS.pathChars);
  if(!validFileTab({kind:'file',rootId,path})||input.preview!==undefined&&typeof input.preview!=='boolean')throw new Error('The file view is invalid.');
  return {action:'show',rootId,path,...(input.paneId!==undefined?{paneId:controlText(input.paneId,'pane ID')}:{}),...(input.preview!==undefined?{preview:input.preview as boolean}:{})};
}
export function readControlIntent(value:unknown):ControlIntent {
  const input=record(value),action=input.action;
  if(action==='show')return show(input);
  if(action==='split'){fields(input,['action','paneId','axis','view']);if(input.axis!=='x'&&input.axis!=='y')throw new Error('The split axis is invalid.');return {action,paneId:controlText(input.paneId,'pane ID'),axis:input.axis,view:tab(input.view)};}
  if(action==='focus'){fields(input,['action','paneId'],['view']);return {action,paneId:controlText(input.paneId,'pane ID'),...(input.view!==undefined?{view:tab(input.view)}:{})};}
  if(action==='resize'){fields(input,['action','splitId','ratio']);if(!Number.isInteger(input.ratio)||(input.ratio as number)<20||(input.ratio as number)>80)throw new Error('The split ratio must be an integer from 20 through 80.');return {action,splitId:controlText(input.splitId,'split ID'),ratio:input.ratio as number};}
  if(action==='swap'){fields(input,['action','splitId']);return {action,splitId:controlText(input.splitId,'split ID')};}
  if(action==='notice'){fields(input,['action','text']);return {action,text:controlText(input.text,'notice text',CONTROL_LIMITS.noticeChars)};}
  throw new Error('The control action is invalid.');
}
export function readControlProvenance(value:unknown):ControlProvenance {const input=record(value);fields(input,['requestId','bootId','workspaceId','pageId','connectionId']);return {requestId:controlText(input.requestId,'request ID'),bootId:controlText(input.bootId,'boot ID'),workspaceId:controlText(input.workspaceId,'workspace ID'),pageId:controlText(input.pageId,'page ID'),connectionId:controlText(input.connectionId,'connection ID')};}
export function readControlAck(value:unknown):ControlAck {const input=record(value),result=input.result;const keys=['requestId','bootId','workspaceId','pageId','connectionId','result'];if(result==='applied')fields(input,[...keys,'appliedRevision']);else if(result==='refused')fields(input,[...keys,'refusalCode']);else if(result==='unconfirmed')fields(input,keys);else throw new Error('The control result is invalid.');const {result:_,appliedRevision:__,refusalCode:___,...identity}=input;const provenance=readControlProvenance(identity);return result==='applied'?{...provenance,result,appliedRevision:revision(input.appliedRevision)}:result==='refused'?{...provenance,result,refusalCode:controlText(input.refusalCode,'refusal code',80)}:{...provenance,result};}
