import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
function palette(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]+)\\}`).exec(css); assert.ok(match);
  return new Map([...match[1].matchAll(/--([a-z-]+):\s*(#[a-f\d]{3,6})(?=[;}]|$)/gi)].map(value => [value[1], value[2]]));
}
function luminance(color: string): number {
  const channels = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string): number { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); }
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  assert.ok(match, `Missing ${selector}`); return match[1];
}
const declarations = (property: string): string[] => [...css.matchAll(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;}]+)`, 'g'))].map(match => match[1].trim());
for (const [theme, selector] of [['dark', ':root'], ['light', ':root[data-appearance=light]'], ['system light', ':root[data-appearance=system]']]) {
  test(`${theme} inks pass AA on the canvas`, () => {
    const colors = palette(selector);
    assert.deepEqual([...colors.keys()].filter(name => name !== 'backdrop').sort(), ['canvas', 'dim', 'fg', 'green', 'red', 'rule']);
    for (const ink of ['fg', 'dim', 'red', 'green']) {
      const ratio = contrast(colors.get(ink) ?? '', colors.get('canvas') ?? '');
      assert.ok(ratio >= 4.5, `${ink} on canvas: ${ratio}`);
    }
  });
}
test('one monospace family, one size, one line height and two weights', () => {
  assert.match(rule(':root'), /--font: ui-monospace, "SF Mono", Menlo, monospace;/);
  assert.match(css, /html, body, button, input, textarea, select, pre, code, kbd, table, h1, h2, h3, h4, h5, h6 \{ font: 400 13px\/20px var\(--font\); \}/);
  assert.deepEqual(declarations('font-family'), []);
  assert.deepEqual(declarations('font-size'), []);
  assert.deepEqual(declarations('line-height'), []);
  assert.deepEqual([...new Set(declarations('font-weight'))].sort(), ['400', '600']);
  assert.deepEqual(declarations('font').filter(value => value !== '400 13px/20px var(--font)'), []);
});
test('no radius, shadows, tints, motion or icons', () => {
  assert.deepEqual([...new Set(declarations('border-radius'))], ['0']);
  assert.deepEqual(declarations('box-shadow'), []);
  const backgrounds = new Set(declarations('background').concat(declarations('background-color')));
  assert.deepEqual([...backgrounds].sort(), ['transparent', 'var(--backdrop)', 'var(--canvas)']);
  assert.match(rule('dialog::backdrop'), /background: var\(--backdrop\)/);
  assert.doesNotMatch(css, /animation:|transition:|scroll-behavior:\s*smooth|backdrop-filter|filter:|text-shadow|gradient/);
  assert.doesNotMatch(html, /<svg|class="icon/);
});
test('the shell has no header band and keeps labeled composers', () => {
  assert.doesNotMatch(html, /conversation-head|head-title|head-actions|id="session-actions"|id="sidebar-hide"|id="sessions-button"|id="appearance-button"|id="agent-refresh"|id="agent-new"/);
  assert.match(html, /<h1 id="session-title" class="sr-only">/); assert.match(html, /<h1 id="agent-name" class="sr-only" tabindex="-1">/);
  assert.match(html, /for="primary-editor"/); assert.match(html, /for="agent-editor"/);
  assert.match(html, /<dialog id="modal" aria-labelledby="modal-title"/);
  assert.match(html, /src="\/web\/app.js"/); assert.doesNotMatch(html, /on(?:load|click|error)=|<script[^>]*>[^<]+<\/script>/);
  assert.match(html, /id="primary-send" type="submit" class="send" disabled aria-label="Send" title="Send \(Enter\)">↵<\/button>/);
  assert.match(html, /id="commands-button" class="palette-hint" type="button" aria-haspopup="dialog" aria-label="Commands" title="Commands \(⌘K\)">⌘K<\/button>/);
  assert.match(html, /<input id="agent-search" class="nav-filter"[^>]*hidden>/);
});
test('sidebar and transcript sit on a ch grid without centering', () => {
  assert.match(rule(':root'), /--line: 20px;\s*--half: 10px;\s*--sidebar: 34ch;\s*--measure: 100ch;/);
  assert.match(rule('.app'), /grid-template-columns: var\(--sidebar\) minmax\(0,1fr\)/);
  assert.match(rule('.sidebar'), /border-right: 1px solid var\(--rule\)/);
  assert.match(rule('.transcript > .entry'), /max-width: calc\(var\(--measure\) \+ 2ch\); padding-left: 2ch/);
  assert.doesNotMatch(css, /margin-inline: auto|margin: 0 auto|text-align: center;[^}]*empty/);
  assert.match(rule('.message.user::before'), /content: "›"; position: absolute; top: 0; left: -2ch; width: 2ch; color: var\(--dim\)/);
  assert.match(rule('.message.user > .message-body'), /font-weight: 600/);
  for (const value of declarations('margin').concat(declarations('padding'), declarations('margin-top'), declarations('padding-top'), declarations('padding-bottom'), declarations('margin-bottom'))) {
    for (const length of value.match(/-?[\d.]+px/g) ?? []) assert.ok(['0px', '1px', '-1px', '2px', '-2px', '20px', '10px'].includes(length) || length === '0', `off-grid length ${length} in ${value}`);
  }
});
test('roster rows are one line and Message takes the age slot without changing height', () => {
  assert.match(rule('.nav-row, .row-select'), /display: flex; align-items: baseline;[^}]*white-space: nowrap/);
  assert.match(rule('.nav-row[aria-current=page]::before, .row-select[aria-current=page]::before'), /content: "›"/);
  assert.match(rule('.row-age, .row-message'), /position: absolute; top: 0; right: 0/);
  assert.match(rule('.row-message'), /opacity: 0; pointer-events: none/);
  assert.match(rule('.agent-row:hover > .row-message, .agent-row:focus-within > .row-message, .agent-row[data-action=resume] > .row-message'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.agent-row:hover > .row-age, .agent-row:focus-within > .row-age, .agent-row[data-action=resume] > .row-age'), /visibility: hidden/);
  assert.match(rule('.roster-older, .roster-more'), /color: var\(--dim\)/);
  assert.match(rule('.agent-row[data-live=false] .row-name'), /color: var\(--dim\)/);
  assert.match(rule('.nav-row[aria-current=page]::before, .row-select[aria-current=page]::before'), /left: 0; width: 1ch/);
  assert.match(rule('.sidebar'), /padding: var\(--line\) 1ch var\(--half\) 1ch/, 'a 1ch pointer gutter keeps › off the window edge');
});
test('code, tables, tools and disclosures stay text on the canvas', () => {
  assert.match(rule('pre'), /padding-left: calc\(2ch - 1px\); border-left: 1px solid var\(--dim\); white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; overflow-y: auto/, 'bounded output scrolls inside its block instead of spilling over later lines');
  assert.match(rule('.transcript > button'), /display: block; margin: 0 0 var\(--line\) 2ch; color: var\(--dim\)/);
  assert.doesNotMatch(css, /\.transcript-region::before/);
  assert.match(rule('.message-body code'), /color: var\(--dim\)/);
  assert.match(rule('.message-body thead th'), /border-bottom: 1px solid var\(--rule\)/);
  assert.match(rule('.message-body ul > li::before'), /content: "-"; position: absolute; left: -2ch; color: var\(--dim\)/);
  assert.match(rule('.tool-preview'), /-webkit-line-clamp: 3/);
  assert.match(rule('.tool-status'), /position: absolute; top: 0; left: -2ch/);
  assert.match(rule('.tool-expanded'), /padding-left: 2ch/);
  assert.match(rule('summary::before'), /content: "▸"/); assert.match(rule('details[open] > summary::before'), /content: "▾"/);
  assert.match(rule('.message-header'), /opacity: 0; pointer-events: none/);
  assert.match(rule('.message:hover > .message-header, .message:focus-within > .message-header'), /opacity: 1; pointer-events: auto/);
});
test('the composer is a prompt line with one statusline', () => {
  assert.match(rule('.composer'), /border-top: 1px solid var\(--rule\)/);
  assert.match(rule('.composer-input::before'), /content: "›"/);
  assert.match(rule('.composer-input:has(textarea:focus)::before'), /color: var\(--fg\)/);
  assert.match(rule('.composer textarea'), /min-height: var\(--line\); padding: 0; border: 0; background: transparent/);
  assert.match(rule('.statusline'), /margin: -2px; padding: 2px; overflow: hidden/, 'focus outlines stay inside the statusline clip');
  assert.match(rule('.statusline > * + *::before'), /content: "· "/);
  assert.match(rule('.send'), /color: var\(--fg\); font-weight: 600/); assert.match(rule('.send:disabled'), /color: var\(--dim\)/);
  assert.match(rule('.modes button + button::before'), /content: "\|"/);
  assert.match(rule('.latest'), /position: absolute; right: max\(0px, calc\(100% - var\(--measure\) - 2ch\)\); bottom: 0/);
  assert.match(rule('.transcript-region > .transcript'), /height: calc\(100% - var\(--line\)\)/);
  assert.match(rule('.statusline > .receipt-details'), /max-width: 0; overflow: hidden; opacity: 0/);
});
test('palette and menus are canvas panels with a dim edge and a › active row', () => {
  assert.match(rule('dialog'), /border: 1px solid var\(--dim\); border-radius: 0; background: var\(--canvas\)/);
  assert.match(rule('dialog[data-variant=palette], dialog[data-variant=picker]'), /inset: 0 auto auto calc\(var\(--sidebar\) \+ 2ch\)/);
  assert.match(rule('#app:has(> .sidebar[hidden]) ~ dialog[data-variant=palette], #app:has(> .sidebar[hidden]) ~ dialog[data-variant=picker]'), /left: 2ch/);
  assert.match(rule('.command-option[aria-selected=true]::before, .palette-row[aria-selected=true]::before'), /content: "›"/);
  assert.match(rule('.command-name mark, .palette-name mark'), /background: transparent; color: inherit; font-weight: 600/);
  assert.match(rule('.command-menu'), /border: 1px solid var\(--dim\); background: var\(--canvas\)/);
});
test('focus is a square 1 px fg outline', () => {
  assert.match(rule(':focus-visible'), /outline: 1px solid var\(--fg\); outline-offset: 1px/);
  assert.match(rule('.skip-link:focus'), /translateY\(0\)/);
});
test('responsive, short, coarse and forced-color paths remain', () => {
  for (const width of [899, 599]) assert.ok(css.includes(`${width}px`));
  assert.match(css, /@media\s*\(max-height:599px\)/); assert.match(css, /@media\s*\(forced-colors:\s*active\)/); assert.match(css, /@media\s*\(pointer:\s*coarse\)/);
  const coarse = css.slice(css.indexOf('@media (pointer:coarse)'), css.indexOf('@media (forced-colors:active)'));
  assert.match(coarse, /button, summary, \.row-age, \.row-message, \.message-header button, \.statusline button, \.transcript-actions button, \.latest, \.code-block > \.copy, \.tool-copy \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(coarse, /\.message-header, \.tool-copy, \.code-block > \.copy, \.statusline > \.receipt-details, \.row-message \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(coarse, /\.message-header \{ position: static; float: right;/);
  const short = css.slice(css.indexOf('@media (max-height:599px)'), css.indexOf('@media (pointer:coarse)'));
  assert.ok(short.includes('.sidebar > .roster-section { min-height: 2lh; }'));
  assert.match(css, /\.app\.drawer-open > \.sidebar/);
});
test('the Message panel is pinned to the sidebar bottom and only the roster scrolls', () => {
  assert.match(rule('.sidebar'), /overflow: hidden/);
  assert.match(rule('.sidebar > *'), /flex-shrink: 0/);
  assert.match(rule('.sidebar > .roster-section'), /flex: 1 1 auto; min-height: 3lh/);
  assert.match(rule('.roster'), /flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto/);
  assert.match(rule('.agent-message-panel'), /flex: none; max-height: calc\(100dvh - 12lh\);[^}]*overflow: auto/);
  assert.doesNotMatch(css, /\.sidebar:has/);
});
test('round-two corrections: diff ink, palette columns, heading rhythm, coarse rows and native search chrome', () => {
  assert.match(css, /\.diff-del \{ color: var\(--dim\); \} \.diff-add \{ color: var\(--fg\); \}/);
  assert.match(rule('.command-option, .palette-row'), /grid-template-columns: 28ch minmax\(0,1fr\) 10ch/);
  assert.match(rule('.message-body :is(h1, h2, h3, h4, h5, h6) + :not(h1, h2, h3, h4, h5, h6)'), /margin-top: 0/, 'consecutive headings keep their blank line');
  assert.match(rule('input[type=search]::-webkit-search-cancel-button'), /display: none/);
  assert.doesNotMatch(css, /@container/);
  const coarse = css.slice(css.indexOf('@media (pointer:coarse)'), css.indexOf('@media (forced-colors:active)'));
  assert.doesNotMatch(coarse, /\.row-message \{ position: static/, 'coarse actions stay in the age slot on one line');
  assert.match(coarse, /\.agent-row:is\(\[data-action=message\],\[data-action=resume\]\) > \.row-age \{ visibility: hidden; \}/);
  assert.match(rule('.picker-select'), /display: flex;[^}]*white-space: nowrap/);
  assert.match(rule('dialog[data-variant=picker]'), /padding: 0 2ch var\(--line\)/);
});
