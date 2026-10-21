import type {AgentRow, Target} from '../shared/api.ts';
import type {Attention} from './attention.ts';
import type {ConversationPresentation} from './conversation-presentation.ts';
import {element, setText} from './dom.ts';
import {absoluteTime, compactAge, isValidTimestamp} from './format.ts';

function blockedFact(row: AgentRow | undefined, view: ConversationPresentation, attention?: Attention): string {
  if(attention?.label === 'Failed')return 'Turn failed';
  if(attention?.label !== 'Blocked')return '';
  if(view.activity === 'Provider blocked')return 'Provider blocked';
  const hint=row?.attention;
  if(hint?.kind === 'task-blocked')return hint.reason ? `Task blocked: ${hint.reason.replaceAll('_',' ')}` : 'Task blocked';
  return 'Provider blocked';
}
function stateWord(row: AgentRow | undefined, view: ConversationPresentation, hasFrame: boolean): string {
  if(!row && !hasFrame)return '';
  if(view.hideVisibleState && row) {
    const states:Record<string,string>={working:'Working',idle:'Idle',starting:'Starting',done:'Done',failed:'Failed',stopped:'Stopped',interrupted:'Interrupted',new:'New',unavailable:'Not reachable'};
    return states[row.state] ?? view.activity;
  }
  return view.activity === 'Ready' ? 'Idle' : view.activity;
}
function toolFact(row: AgentRow | undefined, view: ConversationPresentation, attention?: Attention): string {
  if(attention)return blockedFact(row,view,attention);
  const current=view.tool ?? (view.hideVisibleState && row?.state === 'working' ? row.currentTool : undefined);
  return current ? [current.name,current.argument].filter(Boolean).join(' ') : '';
}
export function createAgentLiveStrip(kind: Target['kind'], root: HTMLElement): AgentLiveStrip | undefined {
  if(kind !== 'agent')return;
  const strip=new AgentLiveStrip();root.prepend(strip.node);return strip;
}
/** Per-target display only. Catalog activity age is not elapsed run time. */
export class AgentLiveStrip {
  readonly node=element('div','agent-live-strip');
  private state=element('span','agent-live-state');
  private tool=element('span','agent-live-tool');
  private model=element('span','agent-live-model');
  constructor() {this.node.hidden=true;this.node.setAttribute('role','group');this.node.setAttribute('aria-label','Agent status');this.node.append(this.state,this.tool,this.model);}
  update(row: AgentRow | undefined, view: ConversationPresentation, attention: Attention | undefined, hasFrame: boolean): void {
    const state=attention?.label ?? stateWord(row,view,hasFrame);
    const idle=state === 'Idle' && !!row && row.modifiedAt > 0 && isValidTimestamp(row.modifiedAt);
    setText(this.state,idle ? compactAge(row.modifiedAt,Date.now()) : state);this.state.hidden=!state;
    this.state.dataset.tone=attention?.tone ?? (state === 'Working' ? 'info' : view.tone);
    this.state.title=idle ? `Idle · last catalog activity ${absoluteTime(row.modifiedAt)}` : state;
    this.state.setAttribute('aria-label',idle ? this.state.title : state);
    const tool=toolFact(row,view,attention);
    setText(this.tool,tool);this.tool.hidden=!tool;this.tool.title=tool;
    const model=row?.model;setText(this.model,model?.modelId ?? '');this.model.hidden=!model;
    this.model.title=model ? `Catalog model: ${model.provider}/${model.modelId}` : '';
    this.node.hidden=!state && !tool && !model;
  }
}
