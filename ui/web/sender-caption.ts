import type {AgentRow, SavedSession, TaskSender} from '../shared/api.ts';
import {conversationIdentityText} from './tabs.ts';

export type SenderCaptionRecord = {identity:string;name?:string;cwd?:string};
export type SenderCaptionRoster = Pick<AgentRow,'identity'|'handle'|'name'|'cwd'>;
export function sessionCaptionRecord(item:SavedSession):SenderCaptionRecord {
  const line=item.title.split(/\r?\n/,1)[0]?.trim();
  const name=item.titleState === 'ready' && (item.titleSource === 'name' || item.titleSource === 'prompt') ? line : undefined;
  return {identity:item.id,cwd:item.project,...(name?{name}:{})};
}
function usefulName(value:string|undefined,identity:string):string|undefined {
  const name=value?.trim();return name && name !== identity && !conversationIdentityText(name) ? name : undefined;
}
/** Caption evidence applies only to the exact supplied conversation identity. */
export function senderCaption(sender:TaskSender,roster?:SenderCaptionRoster,registered?:SenderCaptionRecord):string {
  const row=roster?.identity === sender.identity ? roster : undefined;
  const session=registered?.identity === sender.identity ? registered : undefined;
  const handle=row?.handle?.trim().replace(/^@/,'');if(handle)return `@${handle}`;
  for(const value of row || session ? [row?.name,session?.name,sender.name] : []){const name=usefulName(value,sender.identity);if(name)return name;}
  const cwd=session?.cwd ?? row?.cwd,folder=cwd?.split('/').filter(Boolean).at(-1)||cwd;
  return folder ? `${folder} · ${sender.identity.slice(-4)}` : `Unnamed conversation · ${sender.identity.slice(-8)}`;
}
