export type NativeInsertion = {status: 'inserted' | 'refused' | 'unexpected'; text: string; prepared: string};
/** The native transaction preserves browser undo; refusal never falls back to a value assignment. */
export function insertNativeText(editor: HTMLTextAreaElement, prepared: string, start = editor.selectionStart, end = editor.selectionEnd): NativeInsertion {
  const before = editor.value;
  const expected = before.slice(0, start) + prepared + before.slice(end);
  editor.focus({preventScroll: true}); editor.setSelectionRange(start, end);
  try { document.execCommand('insertText', false, prepared); } catch { /* Inspect the actual edit even if the browser refuses or throws. */ }
  const text = editor.value;
  return {status: text === expected ? 'inserted' : text === before ? 'refused' : 'unexpected', text, prepared};
}
