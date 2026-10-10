import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  assert.ok(match, `Missing ${selector}`); return match[1];
}
const declarations = (property: string): string[] => [...css.matchAll(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;}]+)`, 'g'))].map(match => match[1].trim());
const media = (query: string): string => { const start = css.indexOf(query); assert.ok(start >= 0, `Missing ${query}`); const next = css.indexOf('\n@media', start + 1); return css.slice(start, next < 0 ? undefined : next); };

test('two families: system sans for interface and prose, system monospace for code and status', () => {
  assert.match(rule(':root'), /--sans: system-ui, -apple-system, "Segoe UI", sans-serif;/);
  assert.match(rule(':root'), /--mono: ui-monospace, "SF Mono", Menlo, monospace;/);
  assert.match(rule('html, body'), /font: 400 14px\/1\.5 var\(--sans\)/);
  assert.match(rule('pre, code, kbd, samp, .mono'), /font-family: var\(--mono\); font-size: 13px/);
  assert.deepEqual([...new Set(declarations('font-family'))].sort(), ['var(--mono)', 'var(--sans)']);
  for (const selector of ['.statusbar', '.statusline', '.tool-shell', '.row-identity', '.identity, code.identity']) assert.match(rule(selector), /font-family: var\(--mono\)/, selector);
});
test('one fixed type scale: meta 12, controls 13, interface 14, prose 15, headings 18', () => {
  assert.deepEqual([...new Set(declarations('font-size'))].sort(), ['12px', '13px', '14px', '15px', '18px', 'inherit']);
  assert.match(rule('.message-body'), /font-size: 15px; line-height: 1\.6/);
  assert.match(rule('.message-body h1'), /font-size: 18px/);
  assert.match(rule('.composer textarea'), /font-size: 15px/);
  assert.deepEqual([...new Set(declarations('font-weight'))].sort(), ['400', '600']);
  assert.deepEqual(declarations('font').filter(value => value !== '400 14px/1.5 var(--sans)' && value !== 'inherit'), []);
});
test('blue marks focus while selected rows and tabs use neutral rules and surfaces', () => {
  for (const property of ['background', 'background-color', 'color', 'fill']) assert.ok(!declarations(property).some(value => value.includes('--accent')), property);
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule('.nav-row[aria-current=page], .row-select[aria-current=page]'), /border-left-color: var\(--edge\)/);
  assert.match(rule('.command-option[aria-selected=true], .palette-row[aria-selected=true]'), /border-left-color: var\(--edge\)/);
  for (const value of declarations('background').concat(declarations('background-color'))) assert.doesNotMatch(value, /--(?:fg|muted|dim|link|edge)\b/, `ink used as a fill: ${value}`);
});
test('statusbar focus retains a full indicator inside compact controls at the viewport edge', () => {
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule('.statusbar :focus-visible'), /outline-offset: -2px/);
  assert.doesNotMatch(rule('.statusbar :focus-visible'), /outline:\s*(?:none|0)|outline-width:\s*0/);
  assert.match(media('@media (forced-colors:active)'), /:focus-visible \{ outline: 2px solid Highlight; \}/);
});
test('stored and live conversation names use primary text while metadata stays quiet', () => {
  assert.match(rule('.row-title, .row-name'), /color: var\(--fg\)/);
  assert.doesNotMatch(css, /\.agent-row\[data-live=false\] \.row-name/);
  assert.match(rule('.row-identity'), /color: var\(--muted\)/);
  assert.match(rule('.row-age, .row-message'), /color: var\(--muted\)/);
  assert.match(rule('.state-glyph, .row-state'), /color: var\(--dim\)/);
});
test('small radius, one floating shadow and no gradients or motion', () => {
  for (const value of declarations('border-radius')) for (const length of value.match(/[\d.]+px/g) ?? []) assert.ok(Number.parseFloat(length) <= 4, `radius ${value}`);
  assert.deepEqual([...new Set(declarations('box-shadow'))], ['var(--shadow)']);
  const shadowed = [...css.matchAll(/(?:^|\n)\s*([^{}\n]+)\{[^}]*box-shadow: var\(--shadow\)/g)].map(match => match[1].trim()).sort();
  assert.deepEqual(shadowed, ['.app.drawer-open > .sidebar', '.command-menu', '.context-menu', '.extension-status-list', '.receipt-details pre', 'dialog']);
  assert.doesNotMatch(css, /animation:|transition:|scroll-behavior:\s*smooth|backdrop-filter|filter:|text-shadow|gradient/);
});
test('Pi theme semantics color tool runs, diffs and states', () => {
  assert.match(rule('.tool-shell'), /border-left: 2px solid var\(--dim\);[^}]*background: var\(--run-bg\)/);
  assert.match(rule('.tool-shell[data-status=success]'), /border-left-color: var\(--success\); background: var\(--ok-bg\)/);
  assert.match(rule('.tool-shell[data-status=error]'), /border-left-color: var\(--error\); background: var\(--err-bg\)/);
  assert.match(rule('.state-glyph[data-state=running], .row-state[data-state=working]'), /color: var\(--link\)/, 'work in progress reads as activity, not as a warning');
  assert.match(rule('.diff-del'), /background: var\(--del-bg\); color: var\(--error\)/);
  assert.match(rule('.diff-add'), /background: var\(--add-bg\); color: var\(--success\)/);
  assert.match(rule('.row-state[data-state=done]'), /color: var\(--success\)/);
  assert.match(rule('.state-glyph[data-state=failed], .row-state[data-state=failed]'), /color: var\(--error\)/);
  assert.match(rule('a'), /color: var\(--link\)/);
  assert.match(rule('.stop'), /color: var\(--error\)/);
});
test('tool status labels have natural width and disclosure chevrons stay separate from status', () => {
  assert.match(rule('.tool-status'), /flex: none; min-width: 12px; width: auto/);
  assert.doesNotMatch(rule('.tool-status'), /(?:^|;\s*)width: 12px/);
  assert.match(rule('.tool-card > summary'), /display: grid; grid-template-columns: 8px minmax\(0,1fr\)/);
  assert.match(rule('.tool-card > summary::before'), /content: "";[^}]*transform: rotate\(-45deg\)/);
  assert.match(rule('.tool-card[open] > summary::before'), /transform: rotate\(45deg\)/);
  assert.match(rule('.tool-card > summary > .tool-tier, .tool-card > summary > .tool-preview'), /grid-column: 2/);
  assert.match(rule('.tool-preview'), /color: var\(--fg\)/);
  assert.match(rule('.tool-secondary'), /color: var\(--muted\)/);
  assert.match(rule('.tool-output-info'), /max-width: 100%; color: var\(--muted\); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.doesNotMatch(rule('.tool-output-info'), /cursor: pointer|text-overflow: ellipsis|line-clamp/);
});
test('structured content uses readable prose, wrapped fields, compact tables and plain event disclosures', () => {
  assert.match(rule('.tool-document'), /min-width: 0; color: var\(--fg\); font-family: var\(--sans\)/);
  assert.match(rule('pre.tool-document'), /font-family: var\(--mono\)/, 'supplied argument text and plain-result fallbacks stay monospaced while document prose stays sans');
  const summary = rule('.tool-source > summary, .tool-metadata > summary, .tool-fact > summary, .tool-row-content > summary, .session-events > summary');
  assert.match(summary, /font-size: 12px; overflow-wrap: anywhere/);
  assert.doesNotMatch(summary, /background:|border:|min-height:|max-height:|overflow: hidden/);
  assert.match(rule('summary::before'), /content: ""; display: inline-block/);
  assert.match(rule('details[open] > summary::before'), /transform: rotate\(45deg\)/);
  assert.match(media('@media (pointer:coarse)'), /button, summary,[^{}]+\{ min-height: 44px; min-width: 44px/);
  assert.match(rule('.tool-source > pre'), /white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(rule('.tool-shell .kv'), /grid-template-columns: minmax\(0,32%\) minmax\(0,1fr\)/);
  assert.match(rule('.tool-shell .kv > dt, .tool-shell .kv > dd'), /min-width: 0; white-space: pre-wrap/);
  assert.match(rule('.tool-shell .kv > dd'), /overflow-wrap: anywhere/);
  assert.match(rule('.tool-rows'), /max-width: 100%; overflow-x: auto/);
  assert.doesNotMatch(rule('.tool-rows'), /max-height:|overflow-y:|background:/);
  assert.match(rule('.tool-rows th'), /color: var\(--muted\); font-size: 12px; font-weight: 600/);
  assert.match(rule('.tool-rows th, .tool-rows td'), /vertical-align: top; white-space: nowrap; overflow-wrap: normal/);
  assert.match(rule('.tool-record'), /min-width: 0; padding-left: 12px/);
  assert.match(rule('.tool-record > * + *'), /margin-top: 6px/);
  assert.match(rule('.tool-result-parts > .tool-result-part + .tool-result-part'), /margin-top: 6px/);
  assert.doesNotMatch(rule('.tool-record'), /max-height:|overflow: hidden|text-overflow:|background:|border:/);
  assert.match(rule('.session-events > :not(summary)'), /margin-top: 6px; overflow-wrap: anywhere/);
});
test('structured key labels wrap at semantic breaks and long keys retain the full grid width', () => {
  const keys = rule('.tool-shell .kv > dt, .field-key, .tool-shell .field-key');
  assert.match(keys, /overflow-wrap: normal; word-break: normal/);
  assert.doesNotMatch(keys, /anywhere|break-all|break-word|overflow: hidden|text-overflow:|line-clamp/);
  assert.doesNotMatch(rule('.tool-shell .kv > dt, .tool-shell .kv > dd'), /overflow-wrap:|word-break:/);
  assert.match(rule('.tool-shell .kv > dt.field-key-wide, .tool-shell .kv > dt.field-key-wide + dd'), /grid-column: 1 \/ -1/);
  const narrow = [...css.matchAll(/@container conversation \(max-width: 480px\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.match(narrow, /\.tool-shell \.kv \{ grid-template-columns: minmax\(0,1fr\); \}/);
  assert.match(rule('.tool-shell .kv > dd'), /overflow-wrap: anywhere/);
});
test('tool-only messages retain header actions without a bottom gap or overlap with per-tool Copy', () => {
  assert.match(rule('.message.tool-only'), /margin: 0/);
  assert.match(rule('.tool-shell'), /margin: 0 0 8px/);
  assert.match(rule('.message'), /margin: 0 0 18px/);
  assert.doesNotMatch(rule('.message.tool-only'), /display: none|overflow: hidden/);
  const actions = rule('.message.tool-only > .message-actions');
  assert.match(actions, /position: absolute; top: 4px; right: 64px; flex-wrap: nowrap/);
  assert.match(actions, /max-width: 184px; margin-top: 0; white-space: nowrap/);
  assert.doesNotMatch(actions, /display: none|overflow: hidden|bottom:|text-overflow:/);
  assert.match(rule('.tool-copy'), /top: 4px; right: 4px/);
  const tier = '.message.tool-only > .message-body > .tool-shell:first-child > .tool-card > summary > .tool-tier';
  assert.match(rule(tier), /padding-right: 184px/);
  const narrow = [...css.matchAll(/@container conversation \(max-width: 480px\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.ok(narrow.includes('.message.tool-only > .message-body > .tool-shell:first-child { padding-top: 34px; }'));
  assert.ok(narrow.includes(`${tier} { padding-right: 0; }`));
  const coarse = media('@media (pointer:coarse)');
  assert.ok(coarse.includes('.message.tool-only > .message-body > .tool-shell:first-child { padding-top: 54px; }'));
  assert.ok(coarse.includes(`${tier} { padding-right: 0; }`));
  assert.match(coarse, /\.message-actions \{ min-height: 44px; \}/);
});
test('thinking-only messages keep actions beside the disclosure without a reserved bottom row', () => {
  assert.match(rule('.message.thinking-only'), /min-height: 24px; margin: 0 0 6px/);
  assert.match(rule('.message.thinking-only .thinking'), /margin: 0/);
  const actions = rule('.message.thinking-only > .message-actions');
  assert.match(actions, /position: absolute; top: 0; right: 0; flex-wrap: nowrap/);
  assert.match(actions, /max-width: calc\(100% - 88px\); margin-top: 0; white-space: nowrap/);
  assert.doesNotMatch(actions, /display: none|overflow: hidden|text-overflow:|bottom:/);
  assert.match(rule('.message:hover > .message-actions, .message:focus-within > .message-actions'), /opacity: 1; pointer-events: auto/);
  assert.match(media('@media (pointer:coarse)'), /\.message-actions \{ min-height: 44px; \}/);
});
test('collapsed session event groups add no surrounding margins while turns and notices retain their spacing', () => {
  assert.match(rule('.entry.session-event-group'), /margin-block: 0/);
  assert.match(rule('.entry.session-event-group .session-events'), /margin: 0/);
  assert.match(rule('.message'), /margin: 0 0 18px/);
  assert.match(rule('.thinking, .system-note, .custom-entry'), /margin: 0 0 14px/);
  assert.match(rule('.session-events > :not(summary)'), /margin-top: 6px/);
  assert.doesNotMatch(rule('.entry.session-event-group'), /display: none|max-height:|overflow: hidden/);
});
test('the sidebar resizes through a persisted width and the column sits beside it at a fixed gutter', () => {
  assert.match(rule('.app'), /grid-template-columns: var\(--sidebar-width, 272px\) minmax\(0,1fr\)/);
  assert.match(rule('.resizer[data-axis=x]'), /cursor: col-resize/);
  assert.match(rule('.resizer[data-axis=y]'), /cursor: row-resize/);
  assert.match(rule('.resizer:hover::after, .resizer[data-dragging=true]::after'), /opacity: 1/);
  assert.match(rule('.resizer:focus-visible::after'), /border-color: var\(--accent\)/);
  assert.match(rule('.agent-message-panel'), /height: var\(--panel-height, auto\)/);
  assert.match(rule('.composer textarea'), /max-height: var\(--composer-height, none\)/);
  assert.match(rule('.conversation'), /padding: 0 var\(--gutter\)/);
  assert.doesNotMatch(rule('.workspace'), /padding-left|margin-left/);
  assert.match(rule('.conversation > :not(.transcript-region), .transcript > .entry, .transcript > button'), /max-width: var\(--column\)/);
  assert.doesNotMatch(css, /margin-inline: auto|margin: 0 auto|margin-left: auto; margin-right: auto/);
});
test('lean chrome: gutter-marked user turns, no pills, one-line roster rows and no duplicate title band', () => {
  const user = rule('.message.user > .message-body');
  assert.doesNotMatch(user, /max-width|margin-left|float/);
  assert.match(user, /background: transparent/);
  assert.match(user, /border-radius: 0/);
  assert.match(user, /padding: 0 0 0 12px/);
  assert.match(user, /font-weight: 400/);
  assert.match(rule('.message.user > .message-body::before'), /content: "";[^}]*left: 0; border-left: 2px solid var\(--edge\)/);
  assert.doesNotMatch(css, /content: "You"/);
  for (const value of declarations('border-radius')) assert.doesNotMatch(value, /999|50%|9999/);
  assert.match(rule('.nav-row, .row-select'), /height: 26px;[^}]*white-space: nowrap/);
  assert.match(rule('.row-age, .row-message'), /position: absolute; top: 1px; right: 8px/);
  assert.match(rule('.row-message'), /opacity: 0; pointer-events: none/);
  assert.match(rule('.agent-row:hover > .row-message, .agent-row:focus-within > .row-message, .agent-row[data-action=resume] > .row-message'), /opacity: 1; pointer-events: auto/);
  assert.doesNotMatch(css, /\.conversation-title-line|\.conversation-title\s*\{/);
  assert.doesNotMatch(html, /conversation-title-line|conversation-head|head-actions|header-band/);
  assert.match(html, /id="session-actions" class="icon-button tab-actions"/);
});
test('user paragraphs and lists use regular body weight while semantic headings retain emphasis', () => {
  assert.match(rule('.message.user > .message-body'), /font-weight: 400/);
  assert.match(rule('h1, h2, h3, h4, h5, h6, strong, th, b'), /font-weight: 600/);
  assert.match(rule('.message-body h1'), /font-size: 18px/);
  assert.doesNotMatch(css, /\.message\.user[^{}]*\s(?:p|li|ul|ol|h[1-6]|\*)[^{}]*\{[^}]*font-weight:/);
});
test('prose table cells wrap at words while wide data keeps horizontal scroll and intact cell values', () => {
  const prose = rule('.message-body th, .message-body td');
  assert.match(prose, /white-space: normal; overflow-wrap: normal/);
  assert.doesNotMatch(prose, /white-space: nowrap|overflow: hidden|text-overflow:|line-clamp/);
  assert.match(rule('.message-body table'), /display: block; max-width: 100%; overflow-x: auto/);
  assert.doesNotMatch(rule('.message-body table'), /table-layout: fixed|overflow-x: hidden/);
  assert.match(rule('.tool-rows th, .tool-rows td'), /white-space: nowrap; overflow-wrap: normal/);
  assert.match(rule('.tool-rows'), /max-width: 100%; overflow-x: auto/);
});
test('narrow composer actions occupy a full row and retain right alignment with unbroken control labels', () => {
  const narrow = [...css.matchAll(/@container conversation \(max-width: 480px\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.match(rule('.composer-bar'), /flex-wrap: wrap;[^}]*justify-content: flex-end/);
  assert.match(narrow, /\.composer-bar \{ flex-basis: 100%; justify-content: flex-end; \}/);
  assert.doesNotMatch(css, /\.composer-bar[^{}]*\{[^}]*justify-content: (?:center|flex-start)/);
  assert.match(rule('.modes'), /flex: none; white-space: nowrap/);
  assert.doesNotMatch(css, /\.modes[^{}]*\{[^}]*flex-wrap: wrap/);
  assert.match(rule('.send, .stop'), /flex: none;[^}]*white-space: nowrap/);
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(media('@media (pointer:coarse)'), /button, summary,[^{}]*\{ min-height: 44px; min-width: 44px; \}/);
  assert.doesNotMatch(narrow, /\.send[^{}]*\{[^}]*(?:display: none|overflow: hidden|min-width: 0)/);
});
test('visible controls carry labels and one icon stroke style', () => {
  const icons = [...html.matchAll(/<svg [^>]*>/g)].map(match => match[0]);
  assert.ok(icons.length > 0);
  for (const icon of icons) {
    assert.match(icon, /width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"/);
    assert.match(icon, /aria-hidden="true"/);
  }
  for (const button of html.match(/<button [^>]*class="icon-button[^"]*"[^>]*>/g) ?? []) assert.match(button, /aria-label="[^"]+"/, button);
  for (const id of ['project-button', 'session-new', 'agent-refresh', 'agent-new', 'notices-button', 'appearance-button', 'session-actions', 'primary-send', 'primary-stop', 'agent-search']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html.match(/<input id="agent-search"[^>]*>/)?.[0] ?? '', /\shidden/);
});
test('code wraps, output scrolls inside its block, and disclosures stay reachable', () => {
  assert.match(rule('pre'), /white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; overflow-y: auto/);
  assert.match(rule('.tool-expanded pre'), /max-height: 480px/);
  assert.match(rule('.tool-preview'), /-webkit-line-clamp: 3/);
  assert.match(rule('.message-actions'), /opacity: 0; pointer-events: none/);
  assert.doesNotMatch(rule('.message-actions'), /position: absolute|border:|background:/);
  assert.match(rule('.message-actions'), /min-height: 24px/);
  assert.match(rule('.message:hover > .message-actions, .message:focus-within > .message-actions'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.thinking > .stream-text'), /font-style: italic/);
});
test('expanded output retains bounded native scrollports with fixed gutters', () => {
  const output = rule('.tool-expanded pre');
  assert.match(output, /box-sizing: border-box; max-height: 480px/);
  assert.match(output, /padding: 0 10px; border-block: 6px solid transparent/);
  assert.match(output, /border-radius: 4px; background: var\(--code\)/);
  assert.match(rule('pre'), /line-height: 1\.5; white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; overflow-y: auto/);
  assert.doesNotMatch(output, /(?:^|;\s*)(?:height|line-height):|padding-(?:top|bottom|block):|overflow(?:-y)?:|clip-path:|transform:|margin:/);
  assert.doesNotMatch(css, /\.tool-output-frame/);
});
test('the Message panel is pinned to the sidebar bottom and only the roster scrolls', () => {
  assert.match(rule('.sidebar > *'), /flex-shrink: 0/);
  assert.match(rule('.sidebar > .roster-section'), /flex: 1 1 auto/);
  assert.match(rule('.roster'), /flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto/);
  assert.match(rule('.roster-body'), /display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0/);
  assert.match(rule('.roster-body > :not(.roster)'), /flex: none/);
  assert.match(rule('.sidebar > .roster-section'), /min-height: 0/);
  assert.match(rule('.agent-message-panel'), /flex: none;/);
});
test('responsive, short, coarse, reduced-motion and forced-color paths remain', () => {
  for (const width of [899, 599]) assert.ok(css.includes(`${width}px`));
  assert.match(css, /\.app\.drawer-open > \.sidebar/);
  assert.match(media('@media (max-width:899px)'), /\.sidebar > \.resizer \{ display: none; \}/);
  assert.ok(media('@media (max-height:599px)').includes('.sidebar > .roster-section { min-height: 0; }'));
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /\.icon-button \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(coarse, /\.resizer\[data-axis=x\] \{ right: 0; width: 44px; \}/);
  assert.match(coarse, /\.resizer\[data-axis=y\] \{ position: relative; top: auto; height: 44px; \}/);
  assert.match(coarse, /\.sidebar > \.resizer\[data-axis=x\] \{ position: relative;[^}]*height: 44px/);
  assert.match(coarse, /#conversation-splitter \{ width: 44px; \}/);
  assert.match(coarse, /\.tab-close \{ opacity: 1; \}/);
  assert.match(coarse, /\.message-actions, \.tool-copy, \.code-block > \.copy, \.row-message \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(media('@media (forced-colors:active)'), /:focus-visible \{ outline: 2px solid Highlight; \}/);
});
test('Latest occupies a flow lane outside the transcript scrollport', () => {
  assert.match(rule('.transcript-region'), /display: grid; grid-template-rows: minmax\(0,1fr\) auto; flex: 1/);
  assert.match(rule('.transcript-region > .transcript'), /grid-area: 1 \/ 1; min-height: 0/);
  assert.match(rule('.transcript-region > .latest'), /grid-area: 2 \/ 1; justify-self: start/);
  const latest = rule('.latest');
  assert.match(latest, /position: static; flex: none/);
  assert.doesNotMatch(latest, /position: absolute|bottom:|transform:|z-index:/);
  for (const name of ['primary', 'agent']) {
    assert.match(html, new RegExp(`id="${name}-transcript"[^>]*><\\/div>\\s*<button id="${name}-latest"`));
  }
});
test('native text flow preserves scroll boundaries without line paint clipping', () => {
  assert.doesNotMatch(css, /data-rest-lines|rest-line-|clip-path:/);
  assert.match(rule('.pre-text-frame'), /display: block; min-width: 0/);
  assert.match(rule('.transcript > .entry'), /min-width: 0; overflow-wrap: anywhere/);
  assert.match(rule('.transcript :is(pre, table)'), /overscroll-behavior: contain/);
  assert.match(rule('.transcript :is(.message-body, .tool-content, .tool-expanded, .tool-result-part, .tool-record, .structured, details)'), /min-width: 0; max-width: 100%/);
});
test('editor text and prose share the pane gutter without horizontal correction offsets', () => {
  assert.match(rule('.conversation'), /padding: 0 var\(--gutter\)/);
  assert.match(rule('.transcript'), /padding: 16px 0/);
  assert.match(rule('.composer-input'), /padding: 10px 0 4px; border: 0; border-top: 1px solid var\(--edge\)/);
  assert.match(rule('.composer textarea'), /padding: 0; border: 0/);
  for (const selector of ['.transcript', '.composer-input', '.composer textarea']) {
    assert.doesNotMatch(rule(selector), /margin-left: -|translateX|left: -/);
  }
});
test('neutral tabs and split panes retain 320px tracks with divider-aware equal-width defaults', () => {
  assert.match(rule('.conversation-tabs'), /min-width: 0; overflow-x: auto/);
  assert.match(rule('.tab-label'), /min-width: 8ch; overflow: hidden; text-overflow: ellipsis/);
  assert.match(rule('.tab-state'), /color: var\(--muted\); font-size: 12px; font-weight: 400/);
  assert.doesNotMatch(rule('.tab-state'), /background:|border:|border-radius:/);
  assert.match(rule('.conversation-tab[aria-selected=true]'), /border-top-color: var\(--edge\); background: var\(--canvas\)/);
  assert.match(rule('.conversation-tab:hover .tab-close, .conversation-tab:focus-within .tab-close'), /opacity: 1/);
  assert.match(rule('.conversation-panes'), /flex: 1; min-width: 0; min-height: 0/);
  assert.ok(rule('.conversation-panes.is-split').includes('grid-template-columns: minmax(320px,var(--split-primary,calc((100% - 5px)/2))) 5px minmax(320px,1fr)'));
  assert.ok(media('@media (pointer:coarse)').includes('grid-template-columns: minmax(320px,var(--split-primary,calc((100% - 44px)/2))) 44px minmax(320px,1fr)'));
  assert.match(rule('#conversation-splitter'), /position: relative; inset: auto; width: 5px/);
  assert.match(rule('.conversation'), /min-width: 0; min-height: 0/);
  assert.match(rule('.composer-bar'), /flex-wrap: wrap/);
  assert.match(media('@media (forced-colors:active)'), /\.conversation-tab\[aria-selected=true\][^{]*\{ outline: 2px solid Highlight/);
});
test('short tab names remain intrinsic while long tabs respect fair shares and every name keeps an eight-ch minimum', () => {
  const tab = rule('.conversation-tab');
  assert.match(tab, /flex: 0 1 auto/);
  assert.match(tab, /min-width: calc\(8ch \+ var\(--tab-chrome,66px\)\)/);
  assert.match(tab, /max-width: min\(40ch,max\(calc\(8ch \+ var\(--tab-chrome,66px\)\),var\(--tab-share,100%\)\)\)/);
  assert.match(rule('.tab-label'), /flex: 1 1 auto; min-width: 8ch; overflow: hidden; text-overflow: ellipsis/);
  assert.match(media('@media (pointer:coarse)'), /\.conversation-tab \{ --tab-chrome: 88px; \}/);
  for (const selector of ['.tab-state', '.tab-close']) assert.match(rule(selector), /flex: none/);
  assert.match(rule('.conversation-tabs'), /overflow-x: auto/);
  assert.match(rule('.conversation-tab:hover .tab-close, .conversation-tab:focus-within .tab-close'), /opacity: 1/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /button, summary,[^{}]*\{ min-height: 44px; min-width: 44px; \}/);
  assert.match(coarse, /\.tab-close \{ opacity: 1; \}/);
});
test('a 320px agent pane gives model and thinking facts a separate wrapped footer row without changing Primary facts', () => {
  const settings = rule('.agent-settings');
  assert.match(settings, /min-width: 0; max-width: 100%/);
  assert.match(settings, /font-family: var\(--mono\); font-size: 12px; white-space: normal; overflow-wrap: anywhere/);
  assert.doesNotMatch(settings, /overflow: hidden|text-overflow:|line-clamp/);
  assert.match(media('@container conversation (max-width: 480px)'), /\.agent-settings \{ flex-basis: 100%; order: 3; \}/);
  assert.match(html, /<span id="agent-status" class="agent-settings"><\/span>\s*<div class="statusline"><span id="agent-save"/);
  const global = html.match(/<footer id="statusbar"[\s\S]*?<\/footer>/)?.[0] ?? '';
  assert.doesNotMatch(global, /agent-status|agent-settings/);
  assert.match(global, /id="model-button"/);
  assert.match(global, /id="thinking-button"/);
});
test('receipt details are quiet at rest and available on footer hover, focus, expansion and coarse pointers', () => {
  const receipt = rule('.statusline > .receipt-details');
  assert.match(receipt, /opacity: 0; pointer-events: none/);
  assert.doesNotMatch(receipt, /display: none|visibility: hidden/);
  assert.match(rule('.composer-line:hover .receipt-details, .composer-line:focus-within .receipt-details, .receipt-details:has(details[open])'), /opacity: 1; pointer-events: auto/);
  assert.match(media('@media (pointer:coarse)'), /\.statusline > \.receipt-details \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(rule('.receipt-details summary'), /display: block/);
  assert.match(rule('.receipt-details pre'), /max-height: 30dvh;[^}]*overflow: auto/);
});
test('palette viewports fit whole rows with fixed gutters and native row snapping at every target size', () => {
  const list = rule('.palette-list');
  assert.match(list, /--palette-row-size: 32px/);
  assert.ok(list.includes('max-height: calc(round(down,max(0px,var(--palette-available-height,calc(70dvh - 64px)) - 8px),var(--palette-row-size)) + 8px)'));
  assert.match(list, /box-sizing: border-box/);
  assert.match(list, /padding: 0; border-block: 4px solid transparent; overflow-y: auto/);
  assert.match(list, /scroll-snap-type: y mandatory/);
  assert.doesNotMatch(list, /overflow-y: hidden|flex:|clip-path:/);
  const row = rule('.palette-list > .palette-row');
  assert.match(row, /box-sizing: border-box; height: var\(--palette-row-size\); min-height: var\(--palette-row-size\); scroll-snap-align: start/);
  assert.match(media('@media (max-width:599px)'), /\.palette-list \{ --palette-row-size: 56px; \}/);
  assert.match(media('@media (pointer:coarse) and (min-width:600px)'), /\.palette-list \{ --palette-row-size: 44px; \}/);
  assert.doesNotMatch(media('@media (pointer:coarse)'), /--palette-row-size:/);
  assert.match(rule('.command-name, .palette-name'), /white-space: nowrap/);
  assert.match(rule('.command-desc, .palette-desc, .command-source, .palette-source, .palette-tail'), /white-space: nowrap/);
});
test('the full-width statusbar and sidebar footer have distinct controls with unique identities', () => {
  assert.match(rule('.statusbar'), /grid-column: 1 \/ -1/);
  assert.match(rule('.statusbar'), /font-family: var\(--mono\); font-size: 12px/);
  assert.match(rule('.statusbar-facts'), /overflow: visible/);
  assert.match(rule('.statusbar #primary-usage'), /overflow-x: auto/);
  assert.match(rule('.statusbar #primary-usage'), /flex-wrap: nowrap/);
  assert.match(rule('.usage-group'), /display: inline-flex; flex: none; align-items: center; gap: 4px/);
  assert.match(rule('.usage-separator'), /padding: 0 6px; color: var\(--muted\)/);
  assert.doesNotMatch(css, /#primary-usage[^{}]*::(?:before|after)|\.statusbar-settings[^{}]*::after/);
  assert.doesNotMatch(media('@media (max-width:899px)'), /\.statusbar-facts[^}]*order:/);
  assert.match(html, /class="statusbar-settings"><button id="model-button"[\s\S]*?<button id="thinking-button"/);
  const sidebar = html.match(/<nav id="sidebar"[\s\S]*?<\/nav>/)?.[0] ?? '';
  const footer = sidebar.slice(sidebar.indexOf('class="sidebar-footer"'));
  assert.match(footer, /id="notices-button"/);
  assert.match(footer, /id="appearance-button"/);
  const statusbar = html.match(/<footer id="statusbar"[\s\S]*?<\/footer>/)?.[0] ?? '';
  for (const id of ['primary-usage', 'model-button', 'thinking-button', 'commands-button']) {
    assert.match(statusbar, new RegExp(`id="${id}"`));
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'each control has exactly one DOM identity');
  assert.doesNotMatch(statusbar, /id="(?:notices|appearance)-button"/);
});
test('cache turn colors match their semantics and the extension disclosure escapes only the facts scrollport', () => {
  assert.match(rule('.usage-fact[data-key=cacheTurnHit]'), /color: var\(--success\)/);
  assert.match(rule('.usage-fact[data-key=cacheTurnWrite]'), /color: var\(--error\)/);
  assert.match(rule('.statusbar'), /position: relative/);
  assert.match(rule('.extension-status-details'), /position: static/);
  assert.match(rule('.statusbar #primary-usage'), /overflow-x: auto/);
  for (const selector of ['.statusbar', '.statusbar-facts', '.extension-status-details']) {
    assert.doesNotMatch(rule(selector), /overflow(?:-x|-y)?: (?:auto|hidden|clip|scroll)/);
  }
  const list = rule('.extension-status-list');
  assert.match(list, /position: absolute/);
  assert.match(list, /bottom: calc\(100% \+ 4px\)/);
  assert.match(list, /max-height: min\(360px,50dvh\)/);
  assert.match(list, /white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(list, /box-shadow: var\(--shadow\)/);
  assert.match(rule('.extension-status-list > dd'), /margin: 0/);
  assert.match(rule('.extension-status-list > dt'), /color: var\(--muted\); font-weight: 600/);
  assert.match(rule('.extension-status-details > summary'), /max-width: 28ch/);
  assert.match(rule('.extension-status-preview'), /min-width: 0; overflow: hidden; text-overflow: ellipsis/);
  assert.match(rule('.extension-status-count'), /flex: none/);
});
test('transcript images retain aspect ratio within the pane and expose readable metadata and load controls', () => {
  assert.match(rule('.transcript-image'), /min-width: 0; max-width: 100%/);
  const image = rule('.transcript-image-content');
  assert.match(image, /width: auto; height: auto; max-width: 100%; max-height: 480px/);
  assert.match(image, /object-fit: contain; object-position: left top/);
  assert.doesNotMatch(image, /position: absolute|overflow: hidden/);
  assert.match(rule('.transcript-image-caption'), /color: var\(--muted\); font-family: var\(--sans\); font-size: 12px/);
  assert.match(rule('.transcript-image-status'), /color: var\(--fg\)/);
  assert.match(rule('.transcript-image button'), /border: 1px solid var\(--edge\)/);
  assert.doesNotMatch(rule('.transcript-image button'), /min-height:|opacity:|display: none/);
});
test('every theme uses blue focus, never lavender or mauve', () => {
  const focus: Record<string, string> = {':root': '#74b6d8', ':root[data-appearance=light]': '#22698a', ':root[data-appearance=system]': '#22698a', ':root[data-appearance=latte]': '#1a59d5', ':root[data-appearance=frappe]': '#a3bbf1', ':root[data-appearance=macchiato]': '#8baef4', ':root[data-appearance=mocha]': '#89b4fa'};
  for (const [selector, color] of Object.entries(focus)) assert.match(rule(selector), new RegExp(`--accent: ${color};`));
  assert.doesNotMatch(css, /#b0a2e0|#6a4fae|#8839ef|#ca9ee6|#c6a0f6|#cba6f7/i);
});
test('Catppuccin flavors map text and subtext onto the text tokens and keep the shared token set', () => {
  const text: Record<string, [string, string]> = {latte: ['#4c4f69', '#5c5f77'], frappe: ['#c6d0f5', '#b5bfe2'], macchiato: ['#cad3f5', '#b8c0e0'], mocha: ['#cdd6f4', '#bac2de']};
  for (const [flavor, [fg, muted]] of Object.entries(text)) {
    const body = rule(`:root[data-appearance=${flavor}]`);
    assert.match(body, new RegExp(`--fg: ${fg};`), flavor);
    assert.match(body, new RegExp(`--muted: ${muted};`), flavor);
    assert.match(body, new RegExp(`color-scheme: ${flavor === 'latte' ? 'light' : 'dark'};`));
  }
});

test('mixed thinking and tool turns use compact spacing and raw inspections have one scroll owner', () => {
  assert.match(rule('.message.tool-only > .message-body > .thinking'), /margin: 0/);
  assert.match(rule('.message.tool-only > .message-body > .thinking + .tool-shell'), /margin-top: 6px/);
  assert.match(rule('.tool-inspection > pre'), /max-height: 320px/);
  assert.doesNotMatch(css, /\.tool-inspection\s*\{[^}]*overflow|max-height:[^}]*\.tool-inspection/);
});
