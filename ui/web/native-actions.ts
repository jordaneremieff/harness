import type {OperationView} from '../shared/api.ts';
export type NativeField=readonly [key:string,label:string,multiline?:boolean];
export type NativeOption={name:string;method:string;description:string;fields?:readonly NativeField[];warning?:string};
export const nativeOptions:readonly NativeOption[]=[
  {name:'Create agent',method:'spawn',description:'Create a native agent from this conversation',fields:[['name','Name (optional)'],['cwd','Working folder (optional)'],['handle','Handle (optional)'],['preset','Preset (optional)'],['prompt','Task (optional)',true]]},
  {name:'Open area agent',method:'place',description:'Use the native owner of a folder',fields:[['area','Area folder'],['topic','Topic (optional)'],['prompt','Task (optional)',true]]},
  {name:'Read agent profile',method:'profile-read',description:'Read role, expertise and exact revision'},
  {name:'Edit agent profile',method:'profile-update',description:'Update a profile at its exact revision',warning:'Read the current profile first. This replaces its role and expertise. Empty fields clear their stored values.',fields:[['expectedRevision','Revision from Read agent profile'],['role','Role',true],['expertise','Expertise',true]]},
  {name:'Compact native context',method:'compact',description:'Summarise context without stopping work',fields:[['instructions','Instructions (optional)',true]]},
  {name:'Reset native context',method:'reset',description:'Keep history and identity; replace active context',fields:[['handoff','Handoff (optional)',true]],warning:'This replaces active context at the next safe boundary. History and identity remain.'},
  {name:'Fork native conversation',method:'fork',description:'Create a new branch from retained history',fields:[['entryId','Entry ID (optional)'],['name','Name (optional)']]},
  {name:'Correct native branch',method:'rewind',description:'Create a corrected branch before an entry',fields:[['entryId','Entry ID'],['correction','Correction',true],['name','Name (optional)']]},
  {name:'Scheduled inputs',method:'timer-list',description:'Read the host schedule'},
  {name:'Cancel scheduled input',method:'timer-cancel',description:'Cancel one exact timer',fields:[['timerId','Timer ID']]},
  {name:'Schedule input',method:'timer-schedule',description:'Send a message at a fixed time',fields:[['deliverAt','Deadline (ISO 8601)'],['message','Message',true]]},
];
export function rpcValue(result:OperationView):unknown {return result.receipt?.kind==='rpc'?result.receipt.result?.value:result;}
export function creationIdentity(result:OperationView):string {
  const value=rpcValue(result);
  if(result.state!=='completed'||!value||typeof value!=='object'||!('identity' in value)||typeof value.identity!=='string')throw new Error(result.error?.message??'Creation was not confirmed. Inspect the operation before another creation.');
  return value.identity;
}
export function nonemptyFields(values:Record<string,string>):Record<string,string> {return Object.fromEntries(Object.entries(values).filter(([,value])=>value.length>0));}
export function nativeParameters(method:string,controls:readonly {key:string;field:{value:string}}[],identity:string):Record<string,unknown> {
  const params:Record<string,unknown>={};
  for(const control of controls){if(!control.field.value&&method!=='profile-update')continue;params[control.key]=['entryId','timerId'].includes(control.key)?Number(control.field.value):control.field.value;}
  if(method==='rewind')Object.assign(params,{origin:'operator',selfOwned:true,wait:false});
  if(method==='timer-schedule')Object.assign(params,{origin:'operator',ownerId:identity,selfOwned:true,mode:'followUp',scheduleId:`ui:${crypto.randomUUID()}`});
  if(method==='compact')params.wait=false;
  return params;
}
