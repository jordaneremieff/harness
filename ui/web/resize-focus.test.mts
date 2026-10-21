import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');

test('palette search retains the shared visible input focus indicator', () => {
  assert.match(css, /input:focus-visible, select:focus-visible\s*\{\s*border-color: var\(--edge\); outline: 2px solid var\(--accent\); outline-offset: 2px;/);
  assert.doesNotMatch(css, /\.palette-input:focus-visible\s*\{[^}]*outline:\s*(?:none|0(?:px)?)(?:;|\s*\})/);
});
