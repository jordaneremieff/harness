import type { EntryView, JsonDisplay, MessageView, PartView } from '../shared/api.ts';
import { element } from './dom.ts';
import { previewText } from './format.ts';
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
  if (label === 'custom') return 'Custom entry';
  if (label === 'message') return 'Message entry';
  if (entry.head) return entry.head;
  return label.replace(/[_-]/g, ' ').replace(/^./, char => char.toUpperCase());
}
/** One collapsed line of context: a leading text field, a string value, or the field names. */
function dataPreview(display: JsonDisplay): string {
  const value = display.value; const fields = record(display);
  const text = typeof value === 'string' ? value : ['text', 'message', 'summary', 'content', 'label', 'title'].map(key => fields[key]).find(item => typeof item === 'string');
  if (typeof text === 'string') return previewText(text.replace(/\s+/g, ' ').trim(), 1, 160).text;
  const keys = Object.keys(fields).slice(0, 4);
  return keys.length ? `${keys.join(', ')}${Object.keys(fields).length > 4 ? ', …' : ''}` : '';
}
function sessionNote(entry: EntryView, data: JsonDisplay): string | undefined {
  const value = record(data);
  if (entry.kind === 'model_change' && typeof value.provider === 'string' && typeof value.modelId === 'string') return `Model changed to ${value.provider}/${value.modelId}`;
  if (entry.kind === 'thinking_level_change' && typeof value.thinkingLevel === 'string') return `Thinking changed to ${value.thinkingLevel}`;
  return undefined;
}
export function presentEntry(entry: EntryView, context: PresentationContext): HTMLElement {
  const data = entry.data ?? {value: 'No retained display data', truncated: false};
  const note = sessionNote(entry, data);
  const node = element('section', note ? 'system-note' : 'custom-entry');
  if (note) node.append(context.inspection(context.bounded(note, 4096), () => context.rawText(data.value)));
  else {
    const preview = entry.data ? dataPreview(entry.data) : '';
    node.append(context.inspection(context.bounded(`${entryHeading(entry)}${preview ? ` · ${preview}` : ''}`, 4096), () => context.rawText(data.value)));
    if (data.truncated) node.append(element('p', 'warning', `Output omitted by host${data.omittedBytes !== undefined ? ` · ${data.omittedBytes} bytes` : ''}`));
  }
  return node;
}
