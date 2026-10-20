import type { EntryView, JsonDisplay, MessageView, PartView } from '../shared/api.ts';
import { element } from './dom.ts';
import { previewText } from './format.ts';
import { identifierField } from './generic-content.ts';
import type { PresentationContext } from './transcript-presentation.ts';

function meaningfulPart(part: PartView): boolean {
  if (part.type === 'text' || part.type === 'thinking') return !!part.text.trim() || part.redacted === true || !!part.more;
  return true;
}
/** Assistant output and incoming user-role text carry no role label; user-role text reads "You" only where the viewer is the operator's own session. */
export function presentMessage(message: MessageView, operatorInput = false): {label: string; visible: boolean} {
  const label = message.role === 'user' ? operatorInput ? 'You' : '' : message.role === 'assistant' ? '' : message.role === 'toolResult' ? 'Tool output' : ['custom', 'system'].includes(message.role) ? 'Notice' : message.role;
  const omitted = message.coverage.truncated || message.coverage.omitted > 0 || message.coverage.complete === false;
  return {label, visible: !!message.communication || !!message.error || omitted || message.parts.some(meaningfulPart) || message.stopReason === 'error' || message.stopReason === 'aborted'};
}
/** The accessible name of a message article, which stays meaningful where the visible role label is empty. */
export function messageAriaLabel(message: MessageView, operatorInput = false): string {
  if (message.role === 'user') return operatorInput ? 'Your message' : 'Incoming message';
  return message.role === 'assistant' ? 'Agent response' : `${presentMessage(message).label} message`;
}
export function entryVisible(entry: EntryView): boolean {
  if (entry.data) return true;
  if (entry.messages) return entry.messages.some(message => presentMessage(message).visible);
  return true;
}
/** A browser-owned input copy states its delivery beside the role label; a failure shows once, in the error line. */
export function inputDelivery(entry: EntryView): string | undefined {
  if (entry.kind !== 'ui.input' || !entry.data) return undefined;
  const label = record(entry.data).delivery;
  return label === 'Sending…' || label === 'Sent' ? label : undefined;
}
function record(display: JsonDisplay): Record<string, unknown> {
  const value = display.value;
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const dottedType = /^[\w-]+(\.[\w-]+)+$/;
/** A dotted type name is an internal identifier; the row shows a plain label and raw inspection keeps the type. */
function dottedHeading(entry: EntryView): boolean { return dottedType.test(entry.head ?? entry.kind); }
function entryHeading(entry: EntryView): string {
  if (dottedHeading(entry)) return 'Record';
  const label = entry.head ?? entry.kind;
  if (label === 'custom') return 'custom';
  if (label === 'message') return 'message';
  if (entry.head) return entry.head;
  return label.replace(/[_-]/g, ' ').replace(/^./, char => char.toUpperCase());
}
/** One collapsed line of context: a leading text field, a string value, or the field names. */
function dataPreview(display: JsonDisplay, anyString = false): string {
  const value = display.value; const fields = record(display);
  const text = typeof value === 'string' ? value : ['text', 'message', 'summary', 'content', 'label', 'title'].map(key => fields[key]).find(item => typeof item === 'string') ?? (anyString ? Object.entries(fields).find(([key, item]) => typeof item === 'string' && item.trim() && !identifierField(key, item))?.[1] : undefined);
  if (typeof text === 'string') return previewText(text.replace(/\s+/g, ' ').trim(), 1, 160).text;
  if (anyString) return '';
  const keys = Object.keys(fields).slice(0, 4);
  return keys.length ? `${keys.join(', ')}${Object.keys(fields).length > 4 ? ', …' : ''}` : '';
}
function sessionNote(entry: EntryView, data: JsonDisplay): string | undefined {
  const value = record(data);
  if (entry.kind === 'model_change' && typeof value.provider === 'string' && typeof value.modelId === 'string') return `model changed to ${value.provider}/${value.modelId}`;
  if (entry.kind === 'thinking_level_change' && typeof value.thinkingLevel === 'string') return `thinking changed to ${value.thinkingLevel}`;
  return undefined;
}
export function presentEntry(entry: EntryView, context: PresentationContext): HTMLElement {
  const data = entry.data ?? {value: 'No display data is available.', truncated: false};
  const note = sessionNote(entry, data);
  const node = element('section', note ? 'system-note transcript-event' : 'custom-entry transcript-event');
  if (note) node.append(context.inspection(context.bounded(note, 4096), () => context.rawText(data.value)));
  else {
    const preview = entry.data ? dataPreview(entry.data, dottedHeading(entry)) : '';
    node.append(context.inspection(context.bounded(`${entryHeading(entry)}${preview ? ` · ${preview}` : ''}`, 4096), () => dottedHeading(entry) ? `${entry.head ?? entry.kind}\n${context.rawText(data.value)}` : context.rawText(data.value)));
    if (data.truncated) node.append(element('p', 'warning', `Some output is not available.${data.omittedBytes !== undefined ? ` · ${data.omittedBytes} bytes` : ''}`));
  }
  return node;
}
const eventKinds: Record<string, [string, string]> = {
  model_change: ['settings change', 'settings changes'], thinking_level_change: ['settings change', 'settings changes'],
  session_info: ['session info update', 'session info updates'], compaction: ['compaction', 'compactions'],
  branch_summary: ['branch summary', 'branch summaries'], label: ['label', 'labels'], custom: ['extension record', 'extension records'],
};
function settingText(entry: EntryView): string | undefined {
  const value = entry.data ? record(entry.data) : {};
  if (entry.kind === 'model_change' && typeof value.modelId === 'string' && value.modelId.trim()) return `Model ${previewText(value.modelId.replace(/\s+/g, ' ').trim(), 1, 60).text}`;
  if (entry.kind === 'thinking_level_change' && typeof value.thinkingLevel === 'string' && value.thinkingLevel.trim()) return `Thinking ${previewText(value.thinkingLevel.replace(/\s+/g, ' ').trim(), 1, 30).text}`;
  return undefined;
}
/** The collapsed session-events line names what the group holds: the settings themselves for a few changes, otherwise a count per kind. */
export function sessionEventsSummary(entries: readonly EntryView[]): string {
  const settings = entries.map(settingText);
  if (entries.length <= 4 && settings.every((text): text is string => text !== undefined)) return settings.join(' · ');
  const counts = new Map<string, number>(); const names = new Map<string, [string, string]>();
  for (const entry of entries) {
    const name = eventKinds[entry.kind] ?? ['record', 'records'];
    counts.set(name[0], (counts.get(name[0]) ?? 0) + 1); names.set(name[0], name);
  }
  return [...counts].map(([key, count]) => `${count} ${count === 1 ? names.get(key)?.[0] : names.get(key)?.[1]}`).join(', ');
}
