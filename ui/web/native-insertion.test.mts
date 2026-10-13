import assert from 'node:assert/strict';
import test from 'node:test';
import { insertNativeText } from './native-insertion.ts';
test('native insertion trusts the exact edit rather than the return value or event delivery', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {if (original) Object.defineProperty(globalThis, 'document', original); else Reflect.deleteProperty(globalThis, 'document');});
  for (const behavior of ['expected', 'refused', 'unexpected', 'throws-after-edit']) {
    const editor = {value: 'a😀z', selectionStart: 1, selectionEnd: 3, focus() {}, setSelectionRange(start: number, end: number) {this.selectionStart = start; this.selectionEnd = end;}};
    Object.defineProperty(globalThis, 'document', {configurable: true, value: {execCommand(command: string, _ui: boolean, text: string) {
      assert.equal(command, 'insertText');
      if (behavior === 'expected' || behavior === 'throws-after-edit') editor.value = `a${text}z`;
      if (behavior === 'unexpected') editor.value = 'native result';
      if (behavior === 'throws-after-edit') throw new Error('after edit');
      return false;
    }}});
    const result = insertNativeText(editor as HTMLTextAreaElement, 'new');
    assert.equal(result.status, behavior === 'refused' ? 'refused' : behavior === 'unexpected' ? 'unexpected' : 'inserted');
    assert.equal(result.text, editor.value); assert.equal(result.prepared, 'new');
  }
});
