import { LIMITS, type MessageView, type PartView } from '../shared/api.ts';

function boundary(text: string, offset: number): boolean {
  return offset === 0 || offset === text.length || !(text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff && text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff);
}
/** Display ranges come from verified admission records; original parts remain available to Source and Copy. */
export function attachmentParts(message: MessageView, index: number): readonly PartView[] {
  const part = message.parts[index]; if (!part) return [];
  if (part.type !== 'text' || part.redacted || part.more || part.structured || message.role !== 'user' || message.state !== 'final' || !message.coverage.complete || message.coverage.truncated || message.coverage.omitted || !message.attachments?.length || message.attachments.length > LIMITS.imagesPerDraft) return [part];
  const ranges = message.attachments.filter(range => range.part === index);
  if (!ranges.length) return [part];
  let end = 0;
  for (const range of ranges) {
    if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < end || range.end <= range.start || range.end > part.text.length || !boundary(part.text, range.start) || !boundary(part.text, range.end) || range.image.type !== 'image' || !range.image.attachment) return [part];
    end = range.end;
  }
  const displayed: PartView[] = []; let start = 0;
  for (const range of ranges) {
    if (range.start > start) displayed.push({type: 'text', text: part.text.slice(start, range.start)});
    displayed.push(range.image); start = range.end;
  }
  if (start < part.text.length) displayed.push({type: 'text', text: part.text.slice(start)});
  return displayed;
}
