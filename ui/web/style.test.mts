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
  if (color.length === 4) color = `#${color.slice(1).split('').map(char => char + char).join('')}`;
  const channels = [1, 3, 5].map(index => Number.parseInt(color.slice(index, index + 2), 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a: string, b: string): number { const values = [luminance(a), luminance(b)].sort((a, b) => b - a); return (values[0] + 0.05) / (values[1] + 0.05); }
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  assert.ok(match, `Missing ${selector}`); return match[1];
}
const inks = ['text', 'secondary', 'muted', 'info', 'success', 'warning', 'danger'];
const surfaces = ['canvas', 'surface', 'tint', 'tint-strong', 'code'];
for (const [theme, selector] of [['dark', ':root'], ['light', ':root[data-appearance=light]'], ['system light', ':root[data-appearance=system]']]) {
  test(`${theme} inks pass AA on every surface and the inverted action stays legible`, () => {
    const colors = palette(selector);
    for (const ink of inks) for (const surface of surfaces) {
      const ratio = contrast(colors.get(ink) ?? '', colors.get(surface) ?? '');
      assert.ok(ratio >= 4.5, `${ink} on ${surface}: ${ratio}`);
    }
    for (const fill of ['text', 'secondary']) assert.ok(contrast(colors.get('canvas') ?? '', colors.get(fill) ?? '') >= 4.5, `canvas on ${fill}`);
  });
}
test('the palette has no brand accent and state colors never fill surfaces', () => {
  assert.doesNotMatch(css, /--accent|--user|--selected|--raised/);
  for (const state of ['info', 'success', 'warning', 'danger']) assert.doesNotMatch(css, new RegExp(`background(?:-color)?: var\\(--${state}\\)`));
  assert.doesNotMatch(css, /border-radius: (?:50%|1[2-9]px|[2-9]\dpx)/);
  assert.doesNotMatch(css, /backdrop-filter|filter:|text-shadow|animation:|transition:|scroll-behavior:\s*smooth/);
  assert.deepEqual([...css.matchAll(/box-shadow: ([^;}]+)/g)].map(match => match[1]), ['0 1px 0 var(--text)', '0 0 0 100vmax #0000004d']);
});
test('the native shell keeps labeled composers, text controls and no kind labels', () => {
  assert.match(html, /id="primary-editor"/); assert.match(html, /id="agent-editor"/);
  assert.match(html, /for="primary-editor"/); assert.match(html, /for="agent-editor"/);
  assert.match(html, /<dialog id="modal" aria-labelledby="modal-title"/);
  assert.match(html, /src="\/web\/app.js"/); assert.doesNotMatch(html, /on(?:load|click|error)=|<script[^>]*>[^<]+<\/script>/);
  assert.match(html, /id="primary-send" type="submit" class="send" disabled title="Send \(Enter\)">Send<\/button>/);
  assert.match(html, /id="agent-send" type="submit" class="send" disabled title="Send \(Enter\)">Send<\/button>/);
  assert.match(html, /id="commands-button" class="nav-action" type="button" aria-haspopup="dialog">Commands<kbd>/);
  assert.match(html, /id="sessions-button" class="nav-action" type="button" aria-haspopup="dialog">Sessions<\/button>/);
  assert.doesNotMatch(html, /class="kind"|class="composer-card"|class="accent"/);
  assert.match(html, /id="primary-editor" rows="1"/); assert.match(html, /id="agent-editor" rows="1"/);
  assert.match(html, /<div class="head-sub"><button id="agent-copy"[^>]*><span id="agent-identity"><\/span><\/button><span id="agent-availability"/);
});
test('header, transcript, composer and controls share one reading column with a marker gutter', () => {
  assert.match(rule(':root'), /--column: 46rem;\s*--gutter: 28px/);
  assert.match(rule('.app'), /grid-template-columns: 248px minmax\(0,1fr\)/);
  assert.match(rule('.app:has(> .sidebar[hidden])'), /grid-template-columns: minmax\(0,1fr\)/);
  assert.match(rule('.conversation-head, .workspace-alert, .availability, .facts-panel, .transcript-actions, .widgets, .composer'), /width: min\(var\(--column\), calc\(100% - 2 \* var\(--edge\)\)\); margin-inline: auto/);
  assert.match(rule('.transcript > .entry'), /width: min\(var\(--column\), calc\(100% - 2 \* var\(--edge\) \+ 2 \* var\(--scrollbar, 0px\)\)\); margin-inline: auto; padding-left: var\(--gutter\)/);
  assert.match(rule('.transcript'), /scrollbar-gutter: stable both-edges/);
  for (const selector of ['.conversation-head', '.transcript-actions', '.composer-input', '.composer-line', '.receipt']) assert.match(rule(selector), /var\(--gutter\)/);
  assert.match(rule('.message.user::before'), /content: "›"; position: absolute; top: 0; left: calc\(-1 \* var\(--gutter\)\)/);
  assert.match(rule('.composer-input::before'), /content: "›"/);
  assert.match(css, /\.app\.drawer-open > \.sidebar/);
  assert.match(rule('.workspace:has(> .sidebar-show:not([hidden]))'), /--edge: 52px/);
});
test('transcript content has no boxes and turn actions reveal without moving text', () => {
  assert.doesNotMatch(rule('.message'), /background|border|padding/);
  assert.doesNotMatch(rule('.tool-card > summary'), /border|background/);
  assert.match(rule('.message-header'), /float: right;[^}]*opacity: 0; pointer-events: none/);
  assert.match(rule('.message:hover > .message-header, .message:focus-within > .message-header'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.message-header'), /^ position: relative; z-index: 2;/, 'turn actions stay above the transcript edge fade');
  assert.match(rule('.facts-panel summary::before'), /position: absolute; top: 0; left: calc\(-1 \* var\(--gutter\)\)/);
  assert.match(rule('.tool-expanded .tool-output-text'), /padding: 0; background: transparent/);
  assert.match(rule('.agent-message-panel .composer textarea'), /scroll-margin-bottom: 40px/);
  assert.match(css, /@container transcript \(min-width: 66rem\) \{\s*\.message-header \{ position: absolute; top: 0; left: calc\(100% \+ 16px\); flex-wrap: wrap; float: none; width: max-content; max-width: 140px; height: auto; margin: 0; \}\s*\.message-header \.timestamp \{ white-space: nowrap;/);
  assert.match(rule('.message-body pre, .message-body table, .message-body > .tool-shell:first-child'), /clear: right/);
  assert.match(rule('.tool-status'), /position: absolute; top: 0; left: calc\(-1 \* var\(--gutter\)\)/);
  assert.match(rule('.tool-preview'), /overflow: hidden;[^}]*-webkit-line-clamp: 6/);
  assert.match(rule('.tool-shell:hover > .tool-copy, .tool-shell:focus-within > .tool-copy'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.code-block pre'), /margin: 0/); assert.doesNotMatch(rule('pre'), /border:/);
});
test('Latest sits above the composer at the column edge without changing transcript geometry', () => {
  assert.match(rule('.latest'), /position: absolute; right: max\(var\(--edge\), calc\(\(100% - var\(--column\)\) \/ 2\)\); bottom: 2px/);
  assert.match(rule('.latest'), /border: 1px solid var\(--faint\); border-radius: 4px; background: var\(--canvas\)/);
  assert.match(rule('.latest'), /white-space: nowrap/);
  assert.match(rule('.transcript-region'), /position: relative/);
  assert.match(rule('.transcript-region > .transcript'), /height: calc\(100% - 24px\)/);
  assert.doesNotMatch(css, /:has\(\.latest/);
});
test('history and agent actions are small text controls aligned to the column', () => {
  assert.match(rule('.transcript-actions'), /display: flex; flex: none; gap: 16px; padding: 0 0 4px var\(--gutter\)/);
  assert.doesNotMatch(rule('.transcript-actions'), /justify-content|position: (?:absolute|fixed)/);
  assert.match(rule('.transcript-actions button, .head-actions > button:not(.icon-button), .latest'), /color: var\(--muted\); font-size: 12px/);
  assert.match(html, /<div class="head-actions"><button id="agent-inspect" type="button" hidden>Inspect activity<\/button><\/div>/);
});
test('the composer is one borderless line with a statusline and text delivery controls', () => {
  assert.match(rule('.composer'), /border-top: 1px solid var\(--faint\)/);
  assert.match(rule('.composer:has(textarea:focus)'), /border-top-color: var\(--muted\)/);
  assert.match(rule('.composer-input:has(textarea:focus)::before'), /color: var\(--text\)/);
  assert.match(rule('.composer textarea'), /min-height: 40px; padding: 8px 0; border: 0; background: transparent/);
  assert.match(rule('.composer textarea'), /resize: none/);
  assert.match(rule('.statusline'), /font-family: var\(--font-code\)/);
  assert.match(rule('.statusline'), /margin: -4px; padding: 4px; overflow: hidden/, 'focus outlines of statusline controls stay inside its clip');
  assert.match(rule('.statusline button, .statusline summary'), /margin: 0; padding: 0/);
  assert.match(rule('.statusline > button, .statusline > .fact'), /flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis/);
  assert.match(rule('.statusline > .draft-state, .statusline > .receipt-details'), /flex: none/);
  assert.match(rule('.send'), /color: var\(--text\); font-weight: 600/);
  assert.match(rule('.caption'), /position: absolute; width: 1px; height: 1px;[^}]*clip: rect\(0,0,0,0\)/); assert.doesNotMatch(css, /\.caption[^{]*\{[^}]*display: none/);
  assert.match(rule('.receipt:empty'), /display: none/);
  assert.match(rule('.receipt-details pre'), /position: absolute; right: 0; bottom: calc\(100% \+ 4px\); left: 0/);
});
test('completion is a hairline popover flush with the input and selection uses tint and weight', () => {
  const menu = rule('.command-menu');
  assert.match(menu, /position: absolute; right: 0; bottom: 100%; left: 0/);
  assert.match(menu, /max-height: min\(320px,40vh\)/); assert.match(menu, /border: 1px solid var\(--faint\)/);
  assert.match(rule('.command-option[aria-selected=true]'), /^ background: var\(--tint-strong\); $/);
  assert.match(rule('.command-name mark'), /background: transparent; color: inherit; font-weight: 700/);
  assert.match(rule('.command-hint'), /position: sticky; bottom: 0/);
  assert.match(rule('.command-hint'), /background: var\(--surface\)/);
});
test('sidebar rows are two lines with hover actions and Resume kept visible', () => {
  assert.match(rule('.sidebar'), /border-right: 1px solid var\(--faint\)/);
  assert.match(rule('.roster'), /overflow-y: auto/); assert.match(rule('.roster'), /scrollbar-width: thin/);
  assert.match(rule('.row-message'), /opacity: 0; pointer-events: none/);
  assert.match(rule('.agent-row:hover > .row-message, .agent-row:focus-within > .row-message'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.agent-row[data-action=resume] > .row-message'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.nav-row[aria-current=page], .agent-row:has(> .row-select[aria-current=page])'), /background: var\(--tint-strong\)/);
  assert.doesNotMatch(css, /inset 2px/);
});
test('focus, skip link, picker space and sticky modal heading remain available', () => {
  assert.match(rule(':focus-visible'), /outline: 1.5px solid var\(--text\); outline-offset: 2px/);
  assert.match(rule('input:focus-visible, dialog textarea:focus-visible, select:focus-visible'), /border-bottom-color: var\(--text\); box-shadow: 0 1px 0 var\(--text\)/);
  assert.match(rule('.skip-link:focus'), /translateY\(0\)/);
  assert.match(rule('.picker-projects'), /height: min\(192px,25dvh\)/);
  assert.match(rule('.modal-heading'), /position: sticky/);
  assert.match(rule('dialog'), /border: 1px solid var\(--faint\); border-radius: 10px/); assert.doesNotMatch(rule('dialog'), /box-shadow/);
  assert.match(rule('.transcript-region > .empty-state'), /width: min\(var\(--column\), calc\(100% - 2 \* var\(--edge\)\)\)/);
  assert.doesNotMatch(rule('.transcript-region > .empty-state'), /text-align: center|translate/);
});
test('responsive layout has the collapse breakpoints, coarse pointers and forced colors', () => {
  for (const width of [899, 599]) assert.ok(css.includes(`${width}px`));
  assert.match(css, /@media\s*\(max-height:599px\)/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/); assert.match(css, /@media\s*\(pointer:\s*coarse\)/);
  const coarse = css.slice(css.indexOf('@media (pointer:coarse)'), css.indexOf('@media (forced-colors:active)'));
  assert.match(coarse, /\.message-header, \.tool-copy, \.code-block > \.copy, \.statusline > \.receipt-details \{ opacity: 1; pointer-events: auto; \}\n {2}\.statusline > \.receipt-details \{ max-width: none; \}/);
  assert.match(coarse, /\.row-message \{ position: static;[^}]*opacity: 1; pointer-events: auto; \}/);
  assert.match(coarse, /\.message-header \{ position: static; float: right; width: auto; max-width: 50%; height: 44px; margin-left: 16px; \}/, 'always-visible coarse turn actions stay in flow so stacked headers cannot overlap');
  const targets = [...coarse.matchAll(/\n {2}([^{\n]+) \{ min-height: 44px; \}/g)].flatMap(match => match[1]?.split(', ') ?? []);
  for (const selector of ['.row-age', '.message-header button', '.row-message', '.statusline button', '.statusline summary', '.transcript-actions button', '.head-actions > button:not(.icon-button)', '.latest', '.code-block > .copy']) assert.ok(targets.includes(selector), `coarse target ${selector}`);
});
test('one disclosure marker, a quiet scroll edge, a clear dark backdrop and an anchored session menu', () => {
  assert.match(rule('summary'), /list-style: none/); assert.match(rule('summary::-webkit-details-marker'), /display: none/);
  assert.match(rule('summary::before'), /content: "▸"; display: inline-block; width: 14px; color: var\(--muted\); font: 12px\/1 var\(--font-code\)/);
  assert.match(rule('details[open] > summary::before'), /content: "▾"/);
  assert.match(rule('.tool-card > summary::before, .tool-card[open] > summary::before, .receipt-details summary::before, .receipt-details details[open] > summary::before'), /content: none/, 'tool lines keep their status glyph as the only marker, open or closed');
  assert.doesNotMatch(css, /summary::before \{ content: "[^▸▾]/);
  assert.match(rule('.transcript-region::before'), /height: 24px; background: linear-gradient\(var\(--canvas\) 6px, transparent\); pointer-events: none/);
  assert.match(rule(':root'), /--backdrop: #00000099/); assert.match(rule(':root[data-appearance=light]'), /--backdrop: #00000033/);
  assert.match(rule('dialog::backdrop'), /background: var\(--backdrop\)/);
  assert.match(rule('dialog[data-variant=menu]'), /inset: var\(--menu-top\) var\(--menu-right\) auto auto; width: 232px;[^}]*margin: 0/);
  assert.match(rule('dialog[data-variant=menu] .options'), /border-top: 0/);
  assert.match(rule('dialog[data-variant=menu] .options > button, dialog[data-variant=menu] #modal-body > button'), /border-bottom: 0/);
  assert.match(html, /id="session-actions" class="icon-button" type="button" aria-label="Session actions" aria-haspopup="dialog" title="Session actions"><span class="more-glyph" aria-hidden="true">⋯<\/span>/);
  assert.match(rule('.statusline > .receipt-details'), /display: flex; align-items: center; max-width: 0; overflow: hidden; opacity: 0/);
  assert.match(rule('.statusline:hover > .receipt-details, .statusline:focus-within > .receipt-details, .statusline > .receipt-details:has(details[open])'), /max-width: none; opacity: 1/);
  assert.match(rule('.diff-del'), /color: var\(--danger\)/); assert.match(css, /\.diff-add \{ color: var\(--success\); \}/);
});
test('sidebar message form has compact controls and bounded independent overflow', () => {
  assert.match(rule('.agent-message-panel'), /max-height: 50dvh;[^}]*overflow: auto/);
  assert.match(rule('.agent-message-panel .composer'), /--gutter: 20px; width: 100%/);
  assert.match(rule('.agent-message-panel .composer-line'), /flex-wrap: wrap/);
  assert.match(rule('.message-panel-head > div'), /min-width: 0/);
});
test('an open Message panel reserves two roster rows and lets short sidebars scroll without overlap', () => {
  const open = '.sidebar:has(> .agent-message-panel:not([hidden]))';
  assert.match(rule(open), /overflow-y: auto/);
  assert.match(rule(`${open} > *`), /flex-shrink: 0/);
  assert.match(rule(`${open} .roster-section`), /display: grid; grid-template-rows: auto auto minmax\(96px,1fr\) auto/);
  assert.match(rule(`${open} .roster-section`), /flex: 1 0 0; min-height: min-content/);
  assert.match(rule(`${open} .roster`), /min-height: 96px/);
  const short = css.slice(css.indexOf('@media (max-height:599px)'), css.indexOf('@media (pointer:coarse)'));
  assert.ok(short.includes(`${open} .roster-section { min-height: 0; }`), 'short sidebars shrink the roster before the panel');
  assert.ok(short.includes(`${open} .agent-message-panel { min-height: min-content; max-height: none; overflow: visible; }`), 'short sidebars keep the whole panel and its controls');
});
