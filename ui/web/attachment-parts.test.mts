import assert from 'node:assert/strict';
import test from 'node:test';
import type {ImageView, MessageView, PartView} from '../shared/api.ts';
import {attachmentParts} from './attachment-parts.ts';

const image: ImageView = {type: 'image', mimeType: 'image/png', digest: 'a'.repeat(64), bytes: 388, width: 96, height: 64,
  alt: 'Blue sample.png', attachment: {workspaceId: '11111111-1111-1111-1111-111111111111', targetKey: '22222222-2222-2222-2222-222222222222'}};
function message(text: string, start: number, end = text.length): MessageView {
  return {id: 'message', role: 'user', state: 'final', parts: [{type: 'text', text}], coverage: {complete: true, truncated: false, omitted: 0},
    attachments: [{part: 0, start, end, image}]};
}
test('verified attachment ranges replace only display text and preserve original source and copy parts', () => {
  const text = 'Describe this picture.\n\nAttached image "Blue sample.png" (image/png): /server/owned.bin';
  const source = message(text, text.indexOf('Attached image'));
  const original = structuredClone(source.parts);
  assert.deepEqual(attachmentParts(source, 0), [{type: 'text', text: 'Describe this picture.\n\n'}, image]);
  assert.deepEqual(source.parts, original);
  assert.equal(source.parts[0]?.type === 'text' && source.parts[0].text, text);
});
test('multiple images keep their order and surrounding text', () => {
  const source = message('before first between second after', 7, 12);
  source.attachments?.push({part: 0, start: 21, end: 27, image: {...image, alt: 'Second.png'}});
  assert.deepEqual(attachmentParts(source, 0).map(part => part.type === 'text' ? part.text : part.type === 'image' ? part.alt : ''),
    ['before ', 'Blue sample.png', ' between ', 'Second.png', ' after']);
});
test('an image-only input stays visible without an empty text part', () => {
  const source = message('exact reference', 0);
  assert.deepEqual(attachmentParts(source, 0), [image]);
});
test('unverified prose, assistant text, partial and protected messages retain their supplied text', () => {
  const source = message('Attached image "Blue sample.png" (image/png): /server/owned.bin', 0);
  const variants: MessageView[] = [
    {...source, attachments: undefined}, {...source, role: 'assistant'}, {...source, state: 'partial'},
    {...source, coverage: {...source.coverage, complete: false}}, {...source, coverage: {...source.coverage, truncated: true}},
    {...source, parts: [{type: 'text', text: 'Protected source', redacted: true}]},
    {...source, parts: [{type: 'text', text: 'Paged source', more: {entryId: 'entry', part: 0, offset: 0}}]},
  ];
  for (const variant of variants) assert.deepEqual(attachmentParts(variant, 0), variant.parts);
});
test('invalid or overlapping ranges do not hide source text', () => {
  const source = message('first second', 0, 5);
  const range = source.attachments?.[0]; assert.ok(range);
  for (const invalid of [{...range, start: -1}, {...range, start: 0.5}, {...range, end: 99}, {...range, end: 0},
    {...range, image: {...image, attachment: undefined}}]) {
    const variant = {...source, attachments: [invalid]}; assert.deepEqual(attachmentParts(variant, 0), source.parts);
  }
  assert.deepEqual(attachmentParts({...source, attachments: [range, {...range, start: 4, end: 8}]}, 0), source.parts);
  const unicode = message('😀 picture', 1, 2); assert.deepEqual(attachmentParts(unicode, 0), unicode.parts);
});
test('attachments retain original part indexes and never replace thinking or other content', () => {
  const source = message('exact reference', 0);
  const thinking: PartView = {type: 'thinking', text: 'Supplied thinking'};
  source.parts.unshift(thinking); if (source.attachments?.[0]) source.attachments[0].part = 1;
  assert.deepEqual(attachmentParts(source, 0), [thinking]); assert.deepEqual(attachmentParts(source, 1), [image]);
  assert.deepEqual(attachmentParts(source, 2), []);
});
