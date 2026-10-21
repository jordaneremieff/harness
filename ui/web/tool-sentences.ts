import type {JoinedTool} from './transcript-tools.ts';
import type {PartView} from '../shared/api.ts';
import {plainPreviewWords} from './format.ts';

export type NamedDestination = {text: string; name?: string; provenance?: 'reported' | 'supplied' | 'handle'; derived?: boolean; fallback?: string; title?: string; open?: () => void};
export type SentenceContext = {nestedCount?:number; cwd?: string; subject?: (identity: string) => NamedDestination | undefined};
type Words = {done: string; active: string; action: string};
const text = (value: unknown): string => typeof value === 'string' ? value : '';
function first(value: unknown, limit = 60): string {
  const source = text(value), line = source.split(/\r?\n/, 1)[0] ?? '';
  return line.slice(0, limit) + (line.length > limit || source.length > line.length ? '…' : '');
}
function quote(value: unknown): string {
  const source = text(value), raw = source.split(/\r?\n/, 1)[0] ?? '', words = plainPreviewWords(raw);
  const line = words.slice(0, 60) + (words.length > 60 || source.length > raw.length ? '…' : '');
  return line ? `: “${line}”` : '';
}
function pathName(value: unknown, cwd?: string): string {
  const path = text(value);if (!path) return '';
  const root = cwd?.replace(/\/$/, '');
  if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  if (!path.startsWith('/')) return first(path, 100);
  return `…/${path.split('/').filter(Boolean).slice(-2).join('/')}`;
}
const leadingCd = /^\s*cd\s+(?:"([^"$`\\]+)"|'([^']+)'|([^\s;&|<>()$`"'\\]+))\s*(?:&&|;)\s*(?=\S)/;
/** A command title is one line: every run of white space, line breaks included, folds to one space before the cut. */
function oneLine(value: string, limit = 60): string {
  const folded = value.replace(/\s+/g, ' ').trim();
  return folded.slice(0, limit) + (folded.length > limit ? '…' : '');
}
function commandSentence(value: unknown, cwd?: string): string {
  const command = text(value);if (!command) return ' a command';
  const match = leadingCd.exec(command), folder = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!match || !folder || folder === '-') return ` ${oneLine(command)}`;
  const trim = (path: string): string => path.length > 1 ? path.replace(/\/+$/, '') : path;
  const shown = oneLine(command.slice(match[0].length)), root = cwd === undefined ? undefined : trim(cwd);
  return trim(folder) === root ? ` ${shown}` : ` ${shown} in ${pathName(trim(folder), root)}`;
}
function words(done: string, active: string, action: string, object = ''): Words {
  return {done: `${done}${object}`, active: `${active}${object}`, action: `${action}${object}`};
}
function argsOf(tool: JoinedTool): Record<string, unknown> {
  const value = tool.args?.value;
  if (tool.args?.truncated || !value || typeof value !== 'object' || Array.isArray(value)) return {};
  const args: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 64)) {
    const own = Object.getOwnPropertyDescriptor(value, key);if (own && 'value' in own) args[key] = own.value;
  }
  return args;
}
type SentenceInput = {tool:JoinedTool;context:SentenceContext;args:Record<string,unknown>;identity:string;name:string;target:string};
function destinationName(caption?:NamedDestination):string {
  if(!caption?.name||!caption.provenance)return 'another conversation';
  return caption.text===caption.name||caption.text.startsWith(`${caption.name} · `)?caption.text:caption.name;
}
function sendWords({tool,args,identity,name}:SentenceInput):Words {
  const subject=identity?` ${name}`:'';
  if(typeof args.deliverAt==='string')return words('Scheduled a message to','Scheduling a message to','Schedule a message to',subject+quote(args.message));
  if(tool.name==='agent_steer'||args.mode==='steer')return words('Redirected','Redirecting','Redirect',subject+quote(args.message));
  if(args.mode==='report')return words('Reported to','Reporting to','Report to',subject+quote(args.message));
  return identity?words('Sent a message to','Sending a message to','Send a message to',subject+quote(args.message)):words('Sent a message','Sending a message','Send a message');
}
function inspectWords({args,name}:SentenceInput):Words {
  if(args.view==='result')return words('Checked a task result from','Checking a task result from','Check a task result from',` ${name}`);
  if(args.view==='search')return words('Searched history from','Searching history from','Search history from',` ${name}${quote(args.query)}`);
  if(args.view==='exact')return words('Read one entry from','Reading one entry from','Read one entry from',` ${name}`);
  if(args.view==='history'||args.view==='activity')return words('Read recent history from','Reading recent history from','Read recent history from',` ${name}`);
  return words('Checked','Checking','Check',` ${name}`);
}
function awaitWords({args}:SentenceInput):Words {
  const count=Array.isArray(args.results)?args.results.length:undefined;
  const suffix=count===undefined?' agent results':` ${count} agent ${count===1?'result':'results'}`;
  return words('Waited for','Waiting for','Wait for',suffix);
}
function collaborateWords({args}:SentenceInput):Words {
  switch(args.action){
    case 'post':return words('Posted to a thread','Posting to a thread','Post to a thread',quote(args.message));
    case 'create':return words('Created a thread','Creating a thread','Create a thread',quote(args.title));
    case 'revise':return words('Revised a thread','Revising a thread','Revise a thread',quote(args.title));
    case 'read':return words('Read a thread','Reading a thread','Read a thread');
    case 'join':return words('Joined a thread','Joining a thread','Join a thread');
    case 'leave':return words('Left a thread','Leaving a thread','Leave a thread');
    case 'close':return words('Closed a thread','Closing a thread','Close a thread');
    case 'list':return words('Listed threads','Listing threads','List threads');
    default:return words('Used a thread','Using a thread','Use a thread');
  }
}
function readImages(parts:readonly PartView[], types = new Set<string>()): {count:number;types:Set<string>} {
  let count=0;for(const part of parts){if(part.type==='image'){count++;types.add(part.mimeType==='image/png'?'PNG':'JPEG');}else if(part.type==='toolResult')count+=readImages(part.parts,types).count;}return {count,types};
}
function readWords({tool,args,target}:SentenceInput):Words {
  const images=readImages(tool.result??[]);
  if(images.count){const object=`${images.count===1?'image':'images'} · ${[...images.types].join('/')}`;return words(`Read ${object}`,`Reading ${object}`,`Read ${object}`);}
  const range=typeof args.offset==='number'&&typeof args.limit==='number'&&args.offset>0&&args.limit>0?` (lines ${args.offset}–${args.offset+args.limit-1})`:'';
  return words('Read','Reading','Read',(target||' a file')+range);
}
function editWords({args,target}:SentenceInput):Words {
  const n=Array.isArray(args.edits)?args.edits.length:undefined;
  return words('Edited','Editing','Edit',(target||' a file')+(n===undefined?'':` (${n} ${n===1?'change':'changes'})`));
}
function writeWords({args,target}:SentenceInput):Words {
  const n=typeof args.content==='string'?args.content.split('\n').length:undefined;
  return words('Wrote','Writing','Write',(target||' a file')+(n===undefined?'':` (${n} ${n===1?'line':'lines'})`));
}
function pillarWords({args}:SentenceInput):Words {
  if(!args.resource)return words('Listed pillars','Listing pillars','List pillars');
  const title=text(args.resource).replace(/^(principle|pattern|heuristic)-/,'').replace(/-/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase());
  return args.draft?words('Checked a draft against pillar:','Checking a draft against pillar:','Check a draft against pillar:',` ${title}`):words('Read pillar:','Reading pillar:','Read pillar:',` ${title}`);
}
function webWords({args}:SentenceInput):Words {
  let url:URL|undefined;try{url=args.url?new URL(text(args.url)):undefined;}catch{/* Invalid supplied URL has no display destination. */}
  if(args.find)return words('Looked for','Looking for','Look for',` ${quote(args.find).slice(2)}${url?` on ${url.host}`:''}`);
  return words('Read','Reading','Read',url?` ${url.host}${first(url.pathname,80)}`:' a web page');
}
function registryWords({args}:SentenceInput):Words {
  if(Object.hasOwn(args,'search')){const quoted=quote(args.search);return words('Searched tools and resources','Searching tools and resources','Search tools and resources',quoted?` for ${quoted.slice(2)}`:'');}
  if(args.name)return words('Looked up','Looking up','Look up',` ${first(args.name)}`);
  if(args.kind)return words('Listed','Listing','List',` ${first(args.kind)}s`);
  return words('Checked the model and context','Checking the model and context','Check the model and context');
}
function historySearchWords({args}:SentenceInput):Words {
  if(!Object.hasOwn(args,'query'))return words('Listed recent conversation entries','Listing recent conversation entries','List recent conversation entries');
  const quoted=quote(args.query);return words('Searched this conversation','Searching this conversation','Search this conversation',quoted?` for ${quoted.slice(2)}`:'');
}
function placeWords({args}:SentenceInput):Words {
  const folder=first(text(args.area).split('/').filter(Boolean).at(-1))||'this folder';
  return args.prompt?words('Sent work to the owner of','Sending work to the owner of','Send work to the owner of',` ${folder}`):words('Found the owner of','Finding the owner of','Find the owner of',` ${folder}`);
}
type SentenceTemplate = ((input: SentenceInput) => Words) & {quietTextResult?: true | ((args: Record<string, unknown>) => boolean)};
function quiet(template: (input: SentenceInput) => Words, when: true | ((args: Record<string, unknown>) => boolean) = true): SentenceTemplate {
  return Object.assign((input: SentenceInput) => template(input), {quietTextResult: when});
}
const templates:Record<string,SentenceTemplate>={
  agent_send:quiet(sendWords, args=>args.mode==='report'),agent_steer:quiet(sendWords),agent_inspect:inspectWords,agent_await:awaitWords,agent_collaborate:collaborateWords,
  agent_spawn:({args})=>words('Started','Starting','Start',` ${first(args.name)||'a new agent'}${quote(args.prompt)}`),
  agent_abort:({args,identity,name})=>typeof args.timerId==='number'?words('Canceled a timer','Canceling a timer','Cancel a timer',identity?` for ${name}`:''):words('Stopped work','Stopping work','Stop work',identity?` in ${name}`:''),
  agent_status:()=>words('Checked agent status','Checking agent status','Check agent status'),
  agent_list:()=>words('Listed agents','Listing agents','List agents'),
  agent_place:quiet(placeWords),
  agent_profile:quiet(({args,identity,name})=>args.action==='update'?words('Updated the profile of','Updating the profile of','Update the profile of',` ${identity?name:'this agent'}`):words('Read the profile of','Reading the profile of','Read the profile of',` ${identity?name:'this agent'}`), args=>args.action==='update'),
  agent_reset:quiet(({name})=>words('Reset','Resetting','Reset',` ${name}`)),
  agent_configure:quiet(({name})=>words('Changed settings of','Changing settings of','Change settings of',` ${name}`)),
  agent_fork:quiet(({name})=>words('Forked','Forking','Fork',` ${name}`)),
  agent_rewind:quiet(({name})=>words('Rewound','Rewinding','Rewind',` ${name}`)),
  agent_compact:quiet(({name})=>words('Compacted','Compacting','Compact',` ${name}`)),
  registry:quiet(registryWords),history_search:historySearchWords,
  history_read:({args})=>words('Read conversation entry','Reading conversation entry','Read conversation entry',typeof args.entryId==='number'||typeof args.entryId==='string'?` ${first(String(args.entryId))}`:''),
  stash_write:quiet(({args})=>args.checkpoint===true?words('Saved a checkpoint','Saving a checkpoint','Save a checkpoint',quote(args.title)):words('Saved a handover','Saving a handover','Save a handover',quote(args.title))),
  stash_list:({args})=>{if(!Object.hasOwn(args,'query'))return words('Listed handovers','Listing handovers','List handovers');const quoted=quote(args.query);return words('Searched handovers','Searching handovers','Search handovers',quoted?` for ${quoted.slice(2)}`:'');},
  stash_read:()=>words('Read a handover','Reading a handover','Read a handover'),
  stash_edit:quiet(()=>words('Edited a handover','Editing a handover','Edit a handover')),
  stash_complete:quiet(()=>words('Closed a handover','Closing a handover','Close a handover')),
  stash_rotate:quiet(()=>words('Archived a handover','Archiving a handover','Archive a handover')),
  bash:({args,context})=>words('Ran','Running','Run',commandSentence(args.command,context.cwd)),
  read:readWords,edit:editWords,write:writeWords,pillars:pillarWords,
  memory_search:({args})=>words('Searched memory','Searching memory','Search memory',quote(Array.isArray(args.query)?args.query[0]:args.query)),
  memory_read:({args})=>words('Read memory note','Reading memory note','Read memory note',args.slug?` ${first(args.slug)}`:''),
  memory_write:({args})=>words('Saved a memory note','Saving a memory note','Save a memory note',quote(args.title)),
  memory_edit:({args})=>words('Edited memory note','Editing memory note','Edit memory note',args.slug?` ${first(args.slug)}`:''),
  memory_review:({args})=>words('Reviewed memory note','Reviewing memory note','Review memory note',args.slug?` ${first(args.slug)}`:''),
  memory_history:({args})=>words('Listed versions of memory note','Listing versions of memory note','List versions of memory note',args.slug?` ${first(args.slug)}`:''),
  memory_retire:quiet(({args})=>words('Retired memory note','Retiring memory note','Retire memory note',args.slug?` ${first(args.slug)}`:'')),
  pillars_usage:()=>words('Checked pillar usage','Checking pillar usage','Check pillar usage'),
  clipboard_copy:quiet(({args})=>words('Copied to the clipboard','Copying to the clipboard','Copy to the clipboard',quote(args.label))),
  twitter_search:({args})=>{const quoted=quote(args.query);return words('Searched X','Searching X','Search X',quoted?` for ${quoted.slice(2)}`:'');},
  twitter_feed:()=>words('Read the X feed','Reading the X feed','Read the X feed'),
  web_search:({args})=>words('Searched the web','Searching the web','Search the web',quote(args.query)),web_read:webWords,
  codemode:({context})=>words('Ran a script','Running a script','Run a script',context.nestedCount===undefined?'':` (${context.nestedCount} recorded tool calls)`),
};
/** Public call facts select quiet plain-text results; supplied previews keep their own presentation. */
export function quietTextResult(tool: JoinedTool): boolean {
  const flag = Object.hasOwn(templates, tool.name) ? templates[tool.name]?.quietTextResult : undefined;
  return typeof flag === 'function' ? flag(argsOf(tool)) : flag === true;
}
function sentenceWords(tool: JoinedTool, context: SentenceContext): Words {
  const args = argsOf(tool), identity = text(args.sessionId), caption = identity ? context.subject?.(identity) : undefined;
  const name=destinationName(caption);
  const path = pathName(args.path ?? args.file_path, text(args.cwd) || context.cwd);
  const target = path ? ` ${path}` : '';
  const template=Object.hasOwn(templates,tool.name)?templates[tool.name]:undefined;
  return template?template({tool,context,args,identity,name,target}):words('Used','Using','Use',` ${first(tool.name.replace(/[_-]+/g,' '))}`);
}
/** A call title describes the action; its separate state stays with the original invocation. */
export function toolLabel(tool:JoinedTool,context:SentenceContext={}):string{
  const value=sentenceWords(tool,context);
  if(tool.status==='success')return value.done;
  if(tool.status==='working')return tool.argumentText!==undefined&&!tool.args?'Preparing…':value.active;
  return value.action;
}
/** Public call arguments describe the action; completion never describes a recipient's task outcome. */
export function toolSentence(tool: JoinedTool, context: SentenceContext = {}): string {
  const value = sentenceWords(tool, context);
  if (tool.status === 'success') return value.done;
  if (tool.status === 'preparing') return `Preparing call: ${value.action}`;
  if (tool.status === 'working') return tool.argumentText !== undefined && !tool.args ? 'Preparing…' : value.active;
  if (tool.status === 'error') return `Failed: ${value.action}`;
  if (tool.status === 'pending') return `Queued: ${value.action}`;
  if (tool.status === 'ended') return `Ended without a result: ${value.action}`;
  if (tool.status === 'available') return `Result available: ${value.action}`;
  return `No result recorded: ${value.action}`;
}
