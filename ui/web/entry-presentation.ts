import type { EntryView, JsonDisplay, MessageView, PartView } from '../shared/api.ts';
import { element } from './dom.ts';
import type { PresentationContext } from './transcript-presentation.ts';

function meaningfulPart(part: PartView): boolean {
  if (part.type === 'text' || part.type === 'thinking') return !!part.text.trim() || part.redacted === true || !!part.more;
  return true;
}
export function presentMessage(message: MessageView): {label: string; visible: boolean} {
  const label = message.role === 'user' ? 'You' : message.role === 'assistant' ? 'Assistant' : message.role;
  const omitted = message.coverage.truncated || message.coverage.omitted > 0 || message.coverage.complete === false;
  return {label, visible: !!message.error || omitted || message.parts.some(meaningfulPart) || message.stopReason === 'error' || message.stopReason === 'aborted'};
}
export function entryVisible(entry: EntryView): boolean {
  if (entry.data) return true;
  if (entry.messages) return entry.messages.some(message => presentMessage(message).visible);
  return true;
}
function record(display: JsonDisplay): Record<string, unknown> {
  const value = display.value;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function entryHeading(entry: EntryView): string {
  const label = entry.head ?? entry.kind;
  if (['custom', 'message'].includes(label)) return 'Session event';
  if (entry.head) return entry.head;
  return label.replace(/[_-]/g, ' ').replace(/^./, char => char.toUpperCase());
}
export function presentEntry(entry: EntryView, context: PresentationContext): HTMLElement {
  const data = entry.data ?? {value: 'No retained display data', truncated: false};
  const value = record(data);
  let note: string | undefined;
  if (entry.kind === 'model_change' && typeof value.provider === 'string' && typeof value.modelId === 'string') note = `Model changed to ${value.provider}/${value.modelId}`;
  if (entry.kind === 'thinking_level_change' && typeof value.thinkingLevel === 'string') note = `Thinking changed to ${value.thinkingLevel}`;
  const node = element('section', note ? 'system-note' : 'custom-entry');
  if (note) node.append(context.inspection(context.bounded(note, 4096), () => context.rawText(data.value)));
  else {
    node.append(context.inspection(context.bounded(entryHeading(entry), 4096), () => context.rawText(data.value)));
    if (data.truncated) node.append(element('p', 'warning', `Output omitted by host${data.omittedBytes !== undefined ? ` · ${data.omittedBytes} bytes` : ''}`));
  }
  return node;
}
