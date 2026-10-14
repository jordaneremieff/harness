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
  assert.match(rule('pre, code, kbd, samp'), /font-family: var\(--mono\); font-size: 13px/);
  assert.deepEqual([...new Set(declarations('font-family'))].sort(), ['var(--mono)', 'var(--sans)']);
  for (const selector of ['.statusline', '.tool-shell', '.row-identity', '.identity, code.identity']) assert.match(rule(selector), /font-family: var\(--mono\)/, selector);
});
test('one fixed type scale: meta 12, controls 13, interface 14, prose 15, headings 18', () => {
  const glyphs = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{[^{}]*font-size: (11px|16px);/g)].map(match => [match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), match[2]]);
  assert.deepEqual(glyphs, [['.pane-actions', '16px'], ['.message-menu', '16px'], ['.message-source-close', '16px']]);
  assert.deepEqual([...new Set(declarations('font-size'))].filter(value => value !== '11px' && value !== '16px').sort(), ['12px', '13px', '14px', '15px', '18px', 'inherit']);
  assert.match(rule('.message-role'), /font-size: 13px; line-height: 18px; font-weight: 600/);
  assert.match(rule('.communication-card > .communication-body'), /font-size: 15px; line-height: 1\.6; font-weight: 400; font-style: normal/);
  assert.match(rule('.message-body'), /font-size: 15px; line-height: 1\.6/);
  assert.match(rule('.message-body h1'), /font-size: 18px/);
  assert.match(rule('.composer textarea'), /font-size: 15px/);
  assert.deepEqual([...new Set(declarations('font-weight'))].sort(), ['400', '600']);
  assert.deepEqual(declarations('font').filter(value => value !== '400 14px/1.5 var(--sans)' && value !== 'inherit'), []);
});
test('attachment metadata uses the fixed scale and preview inherits the dialog hairline', () => {
  assert.match(rule('.attachment-digest'), /font-size: 12px; color: var\(--muted\)/);
  assert.match(rule('dialog'), /border: 1px solid var\(--rule\)/);
  assert.doesNotMatch(rule('.attachment-dialog'), /\bborder(?:-[\w-]+)?:/);
});
test('off-pane Message roots pass header pointers through while the original composer stays interactive', () => {
  assert.match(rule('.stable-views > *'), /pointer-events: auto/);
  assert.match(rule('.conversation[data-message-only=true]'), /pointer-events: none/);
  assert.match(rule('.conversation[data-message-only=true] > .composer'), /pointer-events: auto/);
  assert.match(rule('.conversation[data-message-only=true] > :not(.composer)'), /display: none/);
});
test('saved drafts and message choices retain full-width readable rows with separated values', () => {
  assert.match(rule('.recovery-target'), /display: grid; grid-template-columns: minmax\(0,1fr\) minmax\(12ch,20ch\);[^}]*gap: 12px/);
  assert.match(rule('.recovery-name, .recovery-count'), /min-width: 0; overflow-wrap: anywhere/);
  assert.match(rule('.message-choice'), /white-space: pre-wrap; overflow-wrap: anywhere/);
});
test('blue marks focus while selected rows and tabs use neutral rules and surfaces', () => {
  const values = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{([^{}]+)\}/g)].flatMap(match =>
    ['background', 'background-color', 'color', 'fill'].flatMap(property =>
      [...match[2].matchAll(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;}]+)`, 'g'))].map(value => ({selector: match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), property, value: value[1].trim()}))));
  assert.deepEqual(values.filter(item => item.value.includes('--accent')), [{selector: '.pane-split > .pane-divider:focus-visible::after', property: 'background', value: 'var(--accent)'}]);
  const fills = values.filter(item => item.property === 'background' || item.property === 'background-color');
  assert.deepEqual(fills.filter(item => item.value.includes('--edge')), [
    {selector: '.pane-split > .pane-divider::after', property: 'background', value: 'var(--edge)'},
    {selector: '.pane-split > .pane-divider:hover::after', property: 'background', value: 'var(--edge)'},
  ]);
  const graphicTokens = new Map([['.tab-dot', 'var(--muted)'], ['.tab-dot[data-state=working]', 'var(--link)'], ['.tab-dot[data-state=failed]', 'var(--error)']]);
  for (const item of fills.filter(item => !item.value.includes('--edge'))) {
    const graphic = graphicTokens.get(item.selector);
    if (graphic) assert.equal(item.value, graphic); else assert.doesNotMatch(item.value, /--(?:fg|muted|dim|link)\b/, `ink used as a fill: ${item.value}`);
  }
  assert.match(rule('.context-menu-item > .choice-check'), /color: var\(--muted\)/);
  assert.match(rule('.context-menu-item[aria-checked=false] > .choice-check'), /visibility: hidden/);
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule('.nav-row[aria-current=page], .row-select[aria-current=page]'), /border-left-color: var\(--edge\)/);
  assert.match(rule('.command-option[aria-selected=true], .palette-row[aria-selected=true]'), /border-left-color: var\(--edge\)/);
  assert.match(rule('.conversation-tab[aria-selected=true]'), /border-top-color: var\(--edge\); background: var\(--canvas\)/);
  assert.match(rule('.pane-leaf[data-focused=true] > .tab-bar .conversation-tab[aria-selected=true]'), /border-top-color: var\(--accent\)/);
  assert.match(rule('.pane-split > .pane-divider:focus-visible'), /outline: 2px solid var\(--accent\); outline-offset: -2px/);
});
test('pane statusline focus retains a full indicator inside compact controls', () => {
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule('.navigation-access :focus-visible'), /outline-offset: -2px/);
  assert.doesNotMatch(rule('.navigation-access :focus-visible'), /outline:\s*(?:none|0)|outline-width:\s*0/);
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
  assert.deepEqual([...new Set(declarations('box-shadow'))], ['var(--shadow)', 'none']);
  assert.match(rule('dialog[open][data-variant=find]'), /box-shadow: none/);
  const shadowed = [...css.matchAll(/(?:^|\n)\s*([^{}\n]+)\{[^}]*box-shadow: var\(--shadow\)/g)].map(match => match[1].trim()).sort();
  assert.deepEqual(shadowed, ['.app.drawer-open .workbench > .sidebar', '.command-menu', '.context-menu', '.receipt-details pre', '.workbench-status .composer-detail-body', 'dialog']);
  assert.doesNotMatch(css, /animation:|transition:|scroll-behavior:\s*smooth|backdrop-filter|filter:|text-shadow|gradient/);
});
test('neutral tools keep lifecycle accents in marks and errors while source diffs retain colors', () => {
  assert.match(rule('.tool-shell'), /border-left: 2px solid var\(--rule\);[^}]*background: var\(--canvas\)/);
  assert.doesNotMatch(css, /\.tool-shell\[data-status=success\]/);
  assert.match(rule('.tool-status.success'), /color: var\(--success\)/);
  assert.match(rule('.tool-shell[data-status=error]'), /border-left-color: var\(--error\)/);
  assert.match(rule('.state-glyph[data-state=running], .row-state[data-state=working]'), /color: var\(--link\)/, 'work in progress reads as activity, not as a warning');
  assert.match(rule('.diff-del'), /background: var\(--del-bg\); color: var\(--error\)/);
  assert.match(rule('.diff-add'), /background: var\(--add-bg\); color: var\(--success\)/);
  assert.match(rule('.row-state[data-state=done]'), /color: var\(--success\)/);
  assert.match(rule('.state-glyph[data-state=failed], .row-state[data-state=failed]'), /color: var\(--error\)/);
  assert.match(rule('a'), /color: var\(--link\)/);
  assert.match(rule('.stop'), /color: var\(--error\)/);
});
test('tool status labels have natural width and disclosure chevrons stay separate from status', () => {
  assert.match(rule('.tool-status'), /flex: none; min-width: 16px; width: auto/);
  assert.doesNotMatch(rule('.tool-status'), /(?:^|;\s*)width: 12px/);
  assert.match(rule('.tool-card > summary'), /display: grid; grid-template-columns: 16px minmax\(0,1fr\)/);
  assert.match(rule('.card-disclosure::before'), /content: none/);
  assert.match(rule('.card-disclosure > .card-icon-chevron'), /transform: rotate\(0deg\)/);
  assert.match(rule('details[open] > .card-disclosure > .card-icon-chevron'), /transform: rotate\(90deg\)/);
  assert.match(rule('.tool-card > summary > .tool-tier, .tool-card > summary > .tool-preview, .tool-card > summary > .tool-preview-qualification'), /grid-column: 2/);
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
  assert.match(rule('summary::before'), /content: none/);
  assert.match(rule('.card-disclosure > .card-icon-chevron'), /transform: rotate\(0deg\)/);
  assert.match(rule('details[open] > .card-disclosure > .card-icon-chevron'), /transform: rotate\(90deg\)/);
  assert.match(media('@media (pointer:coarse)'), /button, summary,[^{}]+\{ min-height: 44px; min-width: 44px/);
  assert.match(rule('.tool-source > pre'), /white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(rule('.tool-shell .kv'), /grid-template-columns: minmax\(0,32%\) minmax\(0,1fr\)/);
  assert.match(rule('.tool-shell .kv > dt, .tool-shell .kv > dd'), /min-width: 0; white-space: pre-wrap/);
  assert.match(rule('.tool-shell .kv > dd'), /overflow-wrap: anywhere/);
  assert.match(rule('.tool-rows'), /max-width: 100%; overflow-x: auto/);
  assert.doesNotMatch(rule('.tool-rows'), /max-height:|overflow-y:|background:/);
  assert.match(rule('.tool-rows th'), /color: var\(--muted\); font-size: 12px; font-weight: 600/);
  assert.match(rule('.tool-rows th, .tool-rows td'), /vertical-align: top; white-space: normal; overflow-wrap: anywhere/);
  assert.match(rule('.tool-record'), /min-width: 0; padding-left: 12px/);
  assert.match(rule('.tool-record > * + *'), /margin-top: 8px/);
  assert.match(rule('.tool-result-parts > .tool-result-part + .tool-result-part'), /margin-top: 8px/);
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
test('compact message headers retain keyboard actions above content without target reservations', () => {
  assert.match(rule('.message.tool-only'), /margin: 0/); assert.match(rule('.tool-shell'), /margin: 0;/);
  const header = rule('.message:is(.thinking-only, .tool-only) > .message-header');
  assert.match(header, /position: absolute; top: 0; right: 0/); assert.match(header, /transform: translateY\(-100%\)/);
  assert.doesNotMatch(header, /display: none|overflow: hidden|bottom:/);
  assert.match(rule('.message:is(.thinking-only, .tool-only) > .message-body'), /margin-top: 0/);
  assert.match(rule('.tool-copy'), /top: 8px; right: 8px/);
  assert.doesNotMatch(css, /padding-right: 184px|padding-top: 34px|padding-top: 54px/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /\.message:is\(\.thinking-only, \.tool-only\) > \.message-header \{ position: static; transform: none; min-height: 44px/);
});

test('ordinary role and actions share a stable header and compact actions retain focus access', async () => {
  const communication = await readFile(new URL('./communication.ts', import.meta.url), 'utf8');
  assert.match(rule('.message-header'), /display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 24px/);
  assert.doesNotMatch(rule('.message-header'), /grid-template-columns:|background:|border:/);
  assert.match(rule('.message-role'), /flex: 0 1 auto; min-width: 0/);
  assert.match(rule('.communication-card'), /padding: 0; border: 0; background: transparent; font-family: var\(--sans\)/);
  assert.match(rule('.communication-header > .communication-sender'), /min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap/);
  assert.match(rule('.communication-card > .communication-body'), /font-size: 15px; line-height: 1\.6; font-weight: 400; font-style: normal/);
  assert.doesNotMatch(css, /\.communication-(?:kind|time|trust|copy)\b[^{}]*\{/);
  assert.match(rule('.message-header + .message-body'), /margin-top: 4px/);
  assert.match(rule('.message-actions'), /display: flex; flex: none;[^}]*min-height: 24px; margin-top: 0/);
  assert.doesNotMatch(rule('.message-actions'), /display: none|visibility: hidden/);
  assert.match(rule('.message-menu'), /min-width: 24px; min-height: 24px; font-size: 16px/);
  assert.match(rule('.message:hover > .message-header > .message-actions, .message:focus-within > .message-header > .message-actions'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('[hidden]'), /display: none !important/);
  assert.match(rule('.message-source'), /min-width: 0; max-width: 100%;[^}]*background: var\(--side\)/);
  assert.match(rule('.message-source .kv > :is(dt, dd)'), /min-width: 0; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(communication, /configureSource\(open: boolean\): void \{ this\.inspection\.hidden = !open; this\.inspection\.inert = !open; \}/);
  assert.match(communication, /this\.configureSource\(hooks\.expanded\(this\.key\)\)/);
  assert.match(media('@media (pointer:coarse)'), /\.message-actions \{ min-height: 44px; \}/);
  assert.match(media('@media (pointer:coarse)'), /\.message-menu, \.communication-unverified, \.message-source-close, \.pane-actions, \.context-menu > \.context-menu-item \{ min-height: 44px; min-width: 44px; \}/);
});

test('collapsed session event groups add no surrounding margins while turns and notices retain their spacing', () => {
  assert.match(rule('.entry.session-event-group'), /margin-block: 0/);
  assert.match(rule('.entry.session-event-group .session-events'), /margin: 0/);
  assert.match(rule('.message'), /margin: 0/);
  assert.match(rule('.thinking'), /margin: 0/); assert.match(rule('.system-note, .custom-entry'), /margin: 0 0 14px/);
  assert.match(rule('.session-events > :not(summary)'), /margin-top: 6px/);
  assert.doesNotMatch(rule('.entry.session-event-group'), /display: none|max-height:|overflow: hidden/);
});
test('the sidebar resizes through a persisted width and the column sits beside it at a fixed gutter', () => {
  assert.match(rule('.workbench'), /grid-template-columns: var\(--sidebar-width,248px\) minmax\(0,1fr\)/);
  assert.match(rule('.resizer[data-axis=x]'), /cursor: col-resize/);
  assert.match(rule('.resizer[data-axis=y]'), /cursor: row-resize/);
  assert.match(rule('.resizer:hover::after, .resizer[data-dragging=true]::after'), /opacity: 1/);
  assert.match(rule('.resizer:focus-visible::after'), /border-color: var\(--accent\)/);
  assert.match(rule('.agent-message-panel'), /height: var\(--panel-height, auto\)/);
  assert.doesNotMatch(rule('.composer textarea'), /max-height|--composer-height/);
  assert.match(rule('.conversation'), /padding: 0 var\(--gutter\)/);
  assert.doesNotMatch(rule('.workspace'), /padding-left|margin-left/);
  assert.match(rule('.conversation > :not(.transcript-region), .transcript > .entry, .transcript > button'), /width: 100%/); assert.doesNotMatch(css, /--column/);
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
  const circles = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{[^{}]*border-radius: 50%;/g)].map(match => match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim());
  assert.deepEqual(circles, []);
  for (const value of declarations('border-radius')) if (value !== '50%') assert.doesNotMatch(value, /999|50%|9999/);
  assert.match(rule('.communication-unverified'), /display: inline-flex;[^}]*align-items: center;[^}]*width: auto/);
  assert.match(rule('.communication-unverified > .card-action-label'), /white-space: nowrap/);
  assert.match(rule('.context-menu-item > .choice-check'), /top: 50%; left: 10px; margin-top: -8px/);
  assert.match(rule('.nav-row, .row-select'), /height: 26px;[^}]*white-space: nowrap/);
  assert.match(rule('.row-age, .row-message'), /position: absolute; top: 1px; right: 8px/);
  assert.match(rule('.row-message'), /opacity: 1; pointer-events: auto; color: var\(--muted\)/);
  assert.doesNotMatch(css, /\.agent-row(?:\:hover|\:focus-within)[^{]+> \.row-message/);
  assert.match(rule('.agent-row:is([data-action=message],[data-action=resume]) > .row-age'), /right: 40px; max-width: 64px/);
  assert.match(rule('.agent-row:is([data-action=message],[data-action=resume]) > .row-select'), /padding-right: 104px/);
  assert.doesNotMatch(css, /\.conversation-title-line|\.conversation-title\s*\{/);
  assert.doesNotMatch(html, /conversation-title-line|conversation-head|head-actions|header-band/);
  assert.match(rule('.pane-actions'), /display: inline-flex; flex: none;[^}]*min-width: 28px; min-height: 28px/);
  assert.doesNotMatch(html, /id="session-actions"|id="tabs-list"|id="tabs-split"/);
  assert.doesNotMatch(css, /\.tab-actions\s*\{|\.tab-overflow\s*\{/);
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
  assert.match(rule('.tool-rows th, .tool-rows td'), /white-space: normal; overflow-wrap: anywhere/);
  assert.match(rule('.tool-rows'), /max-width: 100%; overflow-x: auto/);
});
test('narrow composer controls wrap only as needed and retain right alignment with unbroken control labels', () => {
  const narrow = [...css.matchAll(/@container conversation \(max-width: 480px\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.match(rule('.composer-bar'), /flex-wrap: wrap;[^}]*justify-content: flex-end/);
  assert.match(narrow, /\.composer-bar \{ justify-content: flex-end; \}/);
  assert.doesNotMatch(narrow, /\.composer-bar[^}]*flex-basis: 100%/);
  assert.doesNotMatch(css, /\.composer-bar[^{}]*\{[^}]*justify-content: (?:center|flex-start)/);
  assert.match(rule('.modes'), /flex: none; white-space: nowrap/);
  assert.doesNotMatch(css, /\.modes[^{}]*\{[^}]*flex-wrap: wrap/);
  assert.match(rule('.send, .stop'), /flex: none;[^}]*white-space: nowrap/);
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(media('@media (pointer:coarse)'), /button, summary,[^{}]*\{ min-height: 44px; min-width: 44px; \}/);
  assert.doesNotMatch(narrow, /\.send[^{}]*\{[^}]*(?:display: none|overflow: hidden|min-width: 0)/);
});
test('three direct utility controls retain named SVG slots and a separate unread badge', () => {
  const footer = html.match(/<footer class="sidebar-footer"[\s\S]*?<\/footer>/)?.[0]; assert.ok(footer);
  assert.equal([...footer.matchAll(/<button /g)].length, 3); assert.doesNotMatch(html, /id="app-menu"/);
  for (const [id, name, icon] of [['commands-button', 'Commands', 'commands'], ['notifications-button', 'Notifications', 'notifications'], ['appearance-button', 'Appearance', 'appearance']]) {
    const trigger = footer.match(new RegExp(`<button id="${id}"[\\s\\S]*?<\\/button>`))?.[0]; assert.ok(trigger);
    assert.match(trigger, new RegExp(`aria-label="${name}"`)); assert.match(trigger, new RegExp(`title="${name}"`));
    assert.match(trigger, /type="button"/); assert.match(trigger, /aria-haspopup="dialog"/); assert.match(trigger, new RegExp(`data-control-icon="${icon}"`));
  }
  assert.match(footer, /id="notices-count"[^>]*\shidden/);
  assert.match(rule('.sidebar-footer > .icon-button > .card-icon'), /margin-inline: 2px/);
  assert.match(media('@media (pointer:coarse)'), /\.sidebar-footer > \.icon-button > \.card-icon \{ margin-inline: 10px/);
  assert.match(rule('.ui-icon'), /display: block;[^}]*width: 16px; height: 16px/);
  assert.match(rule('.icon-button'), /display: inline-flex;[^}]*min-width: 28px; height: 28px/);
  assert.doesNotMatch(css, /\.sidebar-footer \.ui-icon\s*\{/);
});
test('card actions and expanded content share fixed geometry without label-width drift', () => {
  assert.match(rule('.card-action'), /width: 28px; height: 28px; min-width: 28px; min-height: 28px/);
  assert.match(rule('.card-icon'), /width: 16px; height: 16px/);
  assert.match(rule('.tool-tier'), /padding-right: 32px/);
  assert.match(rule('.tool-expanded'), /margin-left: 24px/);
  assert.match(rule('.tool-expanded .card-disclosure > .card-icon-chevron'), /left: -24px; margin: -8px 0 0/);
  assert.match(rule('.tool-expanded .source-disclosure > summary.source-header'), /padding: 2px 32px 2px 0/);
  assert.match(rule('.tool-copy'), /border: 0; background: transparent/);
});
test('multiline tool targets retain a first-line header and centered one-line controls', () => {
  const tier = rule('.tool-tier');
  assert.match(tier, /align-items: flex-start/);
  assert.doesNotMatch(tier, /align-items: center/);
  assert.match(rule('.tool-name, .tool-target'), /padding-top: 4px/);
  assert.match(rule('.tool-secondary'), /padding-top: 5px/);
  assert.match(rule('.tool-status'), /align-items: center; min-height: 28px/);
  assert.match(rule('.tool-card > summary > .card-icon-chevron'), /margin: 6px 0 0/);
  assert.match(rule('.tool-target'), /white-space: normal; overflow-wrap: anywhere/);
  assert.doesNotMatch(rule('.tool-target'), /line-clamp|text-overflow: ellipsis|overflow: hidden/);
});
test('partial output qualification shares the tool summary content column rather than its marker column', () => {
  assert.match(rule('.tool-card > summary'), /grid-template-columns: 16px minmax\(0,1fr\)/);
  const content = rule('.tool-card > summary > .tool-tier, .tool-card > summary > .tool-preview, .tool-card > summary > .tool-preview-qualification');
  assert.match(content, /grid-column: 2; min-width: 0/);
  assert.match(rule('.tool-card > summary > .card-icon-chevron'), /grid-column: 1/);
  assert.match(rule('.tool-preview-qualification'), /color: var\(--muted\);[^}]*font-size: 12px/);
  assert.doesNotMatch(rule('.tool-preview-qualification'), /display: none|visibility: hidden/);
});
test('visible controls carry labels and one icon stroke style', async () => {
  const icons = [...html.matchAll(/data-control-icon="([^"]+)"/g)].map(match => match[1]);
  assert.ok(icons.includes('close') && icons.includes('commands') && icons.includes('notifications') && icons.includes('appearance') && icons.includes('restart'));
  const vocabulary = await readFile(new URL('./card-icons.ts', import.meta.url), 'utf8');
  assert.match(vocabulary, /setAttribute\('stroke', 'currentColor'\)/); assert.match(vocabulary, /setAttribute\('stroke-width', '1.5'\)/);
  assert.match(vocabulary, /setAttribute\('aria-hidden', 'true'\)/); assert.match(vocabulary, /setAttribute\('viewBox', '0 0 16 16'\)/);
  for (const button of html.match(/<button [^>]*class="icon-button[^"]*"[^>]*>/g) ?? []) assert.match(button, /aria-label="[^"]+"/, button);
  for (const id of ['project-button', 'session-new', 'agent-refresh', 'agent-new', 'commands-button', 'notifications-button', 'appearance-button', 'conversation-panes', 'agent-search']) assert.match(html, new RegExp(`id="${id}"`), id);
  const composer = await readFile(new URL('./composer.ts', import.meta.url), 'utf8');
  const factory = composer.slice(composer.indexOf('export function createComposerElements('), composer.indexOf('\ntype Edit ='));
  assert.match(factory, /const id = `composer-\$\{encodeURIComponent\(instanceId\)\}`/);
  assert.match(factory, /const stop = element\('button', 'stop', 'Stop'\); stop\.id = `\$\{id\}-stop`; stop\.type = 'button'/);
  assert.match(factory, /const send = element\('button', 'send'\); send\.id = `\$\{id\}-send`; send\.type = 'submit'/);
  assert.match(factory, /controlIcon\(send, 'send', 'Send'\)/); assert.match(factory, /controlIcon\(stop, 'stop', 'Stop'\)/);
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /cardAction\('plus', 'New tab'/); assert.match(app, /plus\.setAttribute\('aria-haspopup', 'dialog'\)/);
  assert.doesNotMatch(html, /id="session-actions"|id="primary-send"|id="primary-stop"|id="notices-button"|window-actions/);
  assert.match(html, /id="notifications-button"[^>]*aria-haspopup="dialog"/);
  assert.doesNotMatch(html.match(/<input id="agent-search"[^>]*>/)?.[0] ?? '', /\shidden/);
});
test('code wraps, output scrolls inside its block, and disclosures stay reachable', () => {
  assert.match(rule('pre'), /white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; overflow-y: auto/);
  assert.match(rule('.tool-expanded pre'), /max-height: 480px/);
  assert.match(rule('.tool-preview'), /-webkit-line-clamp: 6/);
  assert.match(rule('.tool-tier'), /display: flex; flex-wrap: wrap;[^}]*min-width: 0/);
  assert.match(rule('.tool-target'), /min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere/);
  assert.match(rule('.tool-preview.tool-error'), /color: var\(--error\)/);
  assert.match(rule('.message-actions'), /opacity: 0; pointer-events: none/);
  assert.doesNotMatch(rule('.message-actions'), /position: absolute|border:|background:/);
  assert.match(rule('.message-actions'), /min-height: 24px/);
  assert.match(rule('.message:hover > .message-header > .message-actions, .message:focus-within > .message-header > .message-actions'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.thinking > .stream-text'), /font-style: normal/);
});
test('expanded output retains bounded native scrollports with fixed gutters', () => {
  const output = rule('.tool-expanded pre');
  assert.match(output, /box-sizing: border-box; max-height: 480px/);
  assert.match(output, /padding: 0; border-block: 6px solid transparent/);
  assert.match(output, /border-radius: 0; background: var\(--code\)/);
  assert.match(rule('.tool-expanded'), /margin-left: 24px/);
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
  assert.match(css, /\.app\.drawer-open \.workbench > \.sidebar/);
  assert.match(media('@media (max-width:899px)'), /\.sidebar > \.resizer \{ display: none; \}/);
  assert.ok(media('@media (max-height:599px)').includes('.sidebar > .roster-section { min-height: 0; }'));
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /\.icon-button \{ min-height: 44px; min-width: 44px; \}/);
  assert.match(coarse, /\.resizer\[data-axis=x\] \{ right: 0; width: 44px; \}/);
  assert.match(coarse, /\.resizer\[data-axis=y\] \{ position: relative; top: auto; height: 44px; \}/);
  assert.match(coarse, /\.sidebar > \.resizer\[data-axis=x\] \{ position: relative;[^}]*height: 44px/);
  assert.match(coarse, /\.pane-split > \.pane-divider\[data-axis=x\]::before \{ width: 44px; \}/);
  assert.match(coarse, /\.pane-split > \.pane-divider\[data-axis=y\]::before \{ height: 44px; \}/);
  assert.match(coarse, /\.tab-close \{ opacity: 1; \}/);
  assert.match(coarse, /\.message-actions, \.tool-copy, \.row-message \{ opacity: 1; pointer-events: auto; \}/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(media('@media (forced-colors:active)'), /:focus-visible \{ outline: 2px solid Highlight; \}/);
});
test('Latest occupies a flow lane outside the transcript scrollport', async () => {
  assert.match(rule('.transcript-region'), /display: grid; grid-template-rows: minmax\(0,1fr\) auto; flex: 1/);
  assert.match(rule('.transcript-region > .transcript'), /grid-area: 1 \/ 1; min-height: 0/);
  assert.match(rule('.transcript-region > .latest'), /grid-area: 2 \/ 1; justify-self: start/);
  const latest = rule('.latest');
  assert.match(latest, /position: static; flex: none/);
  assert.doesNotMatch(latest, /position: absolute|bottom:|transform:|z-index:/);
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /const scroller = add\('transcript', 'div', 'transcript'\)/);
  assert.match(app, /const latest = add\('latest', 'button', 'latest'\)/);
  assert.match(app, /region\.append\(absent, scroller, latest\)/);
  assert.doesNotMatch(html, /id="(?:primary|agent)-(?:transcript|latest)"/);
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
test('exceptional tab state remains readable and a sole tab fills its available width', () => {
  assert.match(rule('.tab-dot'), /flex: none; width: 14px; height: 14px/);
  assert.doesNotMatch(css, /\.tab-state\s*\{/);
  assert.match(rule('.conversation-tabs[data-sole=true] > .conversation-tab'), /flex: 1 0 auto; max-width: none/);
  assert.match(rule('.conversation-tabs'), /min-width: 0; overflow-x: auto/);
  assert.match(rule('.tab-label'), /flex: 1 0 auto/);
  assert.match(rule('.conversation-tab'), /overflow: hidden/);
  assert.match(rule('.tab-label'), /min-width: 8ch; white-space: nowrap/);
  assert.doesNotMatch(rule('.tab-label'), /text-overflow:|overflow:/);
  assert.match(rule('.tab-close'), /flex: none; width: 28px/);
});
test('neutral tabs and split panes retain 320px tracks with divider-aware equal-width defaults', async () => {
  const layout = await readFile(new URL('./pane-layout.ts', import.meta.url), 'utf8');
  assert.match(layout, /export const MIN_PANE_WIDTH = 320;/); assert.match(layout, /export const MIN_PANE_HEIGHT = 240;/); assert.match(layout, /export const PANE_DIVIDER = 4;/);
  assert.match(layout, /if \(node\.kind === 'pane'\) return \{width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT\}/);
  assert.match(rule('.conversation-tabs'), /min-width: 0; overflow-x: auto/);
  assert.match(rule('.tab-label'), /min-width: 8ch; white-space: nowrap/);
  assert.match(rule('.tab-dot'), /color: var\(--muted\)/);
  assert.doesNotMatch(rule('.tab-dot'), /background:|border:|border-radius:/);
  assert.match(rule('.conversation-tab[aria-selected=true]'), /border-top-color: var\(--edge\); background: var\(--canvas\)/);
  assert.match(rule('.conversation-tab:hover .tab-close, .conversation-tab:focus-within .tab-close'), /opacity: 1/);
  assert.match(rule('.pane-tree'), /display: flex; flex: 1; min-width: 0; min-height: 0/);
  assert.match(rule('.pane-tree > :is(.pane-split, .pane-leaf)'), /flex: 1/);
  assert.match(rule('.pane-split'), /display: grid; min-width: 0; min-height: 0/);
  assert.ok(rule('.pane-split[data-axis=x]').includes('grid-template-columns: minmax(0,var(--pane-first,calc((100% - 4px)/2))) 4px minmax(0,1fr)'));
  assert.ok(rule('.pane-split[data-axis=y]').includes('grid-template-rows: minmax(0,var(--pane-first,calc((100% - 4px)/2))) 4px minmax(0,1fr)'));
  assert.match(rule('.pane-leaf, .pane-content'), /display: flex; min-width: 0; min-height: 0/);
  assert.match(rule('.pane-split > .pane-divider'), /position: relative; inset: auto;[^}]*min-width: 0; min-height: 0; width: auto; height: auto/);
  assert.match(rule('.pane-split > .pane-divider[data-axis=x]::before'), /width: 20px; transform: translateX\(-50%\)/);
  assert.match(rule('.pane-split > .pane-divider[data-axis=y]::before'), /height: 20px; transform: translateY\(-50%\)/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /\.pane-split > \.pane-divider\[data-axis=x\]::before \{ width: 44px; \}/);
  assert.match(coarse, /\.pane-split > \.pane-divider\[data-axis=y\]::before \{ height: 44px; \}/);
  assert.doesNotMatch(coarse, /\.pane-split[^{}]*\{[^}]*grid-template-(?:columns|rows):/);
  assert.match(rule('.pane-tree[data-focus-only=true] .pane-split'), /display: contents/);
  assert.match(rule('.pane-tree[data-focus-only=true] .pane-divider'), /display: none/);
  assert.doesNotMatch(css, /\.conversation-panes\.is-split|#conversation-splitter/);
  assert.match(html, /id="conversation-panes" class="conversation-panes pane-tree" data-focus-only="false"/);
  assert.match(rule('.conversation'), /min-width: 0; min-height: 0/);
  assert.match(rule('.composer-bar'), /flex-wrap: wrap/);
  assert.match(media('@media (forced-colors:active)'), /\.conversation-tab\[aria-selected=true\][^{]*\{ outline: 2px solid Highlight/);
});
test('full tab names remain intrinsic and every name keeps an eight-ch minimum', () => {
  const tab = rule('.conversation-tab');
  assert.match(tab, /flex: 0 0 auto/);
  assert.match(tab, /min-width: calc\(8ch \+ var\(--tab-chrome,74px\) \+ var\(--tab-identity-width,0px\)\)/);
  assert.match(tab, /max-width: none/);
  assert.match(rule('.tab-label'), /flex: 1 0 auto; min-width: 8ch; white-space: nowrap/);
  assert.doesNotMatch(rule('.tab-label'), /text-overflow:|overflow:/);
  assert.match(rule('.tab-dot'), /width: 14px; height: 14px/);
  assert.match(media('@media (pointer:coarse)'), /\.conversation-tab \{ --tab-chrome: 90px; \}/);
  assert.match(rule('.conversation-tabs'), /scrollbar-color: transparent transparent/);
  assert.match(rule('.tab-close'), /flex: none/);
  assert.match(rule('.conversation-tabs'), /overflow-x: auto/);
  assert.match(rule('.conversation-tab:hover .tab-close, .conversation-tab:focus-within .tab-close'), /opacity: 1/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /button, summary,[^{}]*\{ min-height: 44px; min-width: 44px; \}/);
  assert.match(coarse, /\.tab-close \{ opacity: 1; \}/);
});
test('one workbench footer owns wrapped facts without composer-local settings', async () => {
  const settings = rule('.agent-settings'); assert.match(settings, /min-width: 0/); assert.match(settings, /max-width: 100%/); assert.match(settings, /white-space: normal/); assert.match(settings, /overflow-wrap: anywhere/);
  assert.doesNotMatch(settings, /overflow: hidden|text-overflow: ellipsis|line-clamp/);
  assert.match(rule('.workbench-status'), /display: flex;[^}]*flex-wrap: wrap/);
  assert.match(rule('.workbench-status-facts'), /flex-wrap: wrap/);
  assert.equal([...html.matchAll(/<footer id="workbench-status"/g)].length, 1);
  assert.equal([...html.matchAll(/id="focused-composer-status" class="workbench-draft-state"/g)].length, 1);
  assert.ok(html.indexOf('<footer id="workbench-status"') > html.indexOf('</main>'));
  const composer = await readFile(new URL('./composer.ts', import.meta.url), 'utf8');
  const factory = composer.slice(composer.indexOf('export function createComposerElements('), composer.indexOf('\ntype Edit ='));
  assert.match(factory, /const root = element\('form', 'composer'\); root\.id = id/);
  assert.match(factory, /const id = `composer-\$\{encodeURIComponent\(instanceId\)\}`/);
  assert.match(factory, /root\.append\(resize, receipt, input, line\)/);
  assert.match(factory, /bar\.append\(attach, picker, modes, stop, send\)/);
  assert.doesNotMatch(factory, /composer-settings|usage-details|workbench-status-facts|root\.append\([^)]*\b(?:save|receiptDetails)\b/);
  assert.doesNotMatch(html, /<form id="(?:primary|agent)-composer"/);
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /const slot = byId\('focused-composer-status'\), nodes = controller \? \[controller\.elements\.save, controller\.elements\.receiptDetails\] : \[\]/);
  assert.match(app, /slot\.replaceChildren\(\.\.\.nodes\)/);
  assert.doesNotMatch(css, /\.composer-settings\s*\{/);
});

test('receipt details are quiet at rest and available on footer hover, focus, expansion and coarse pointers', () => {
  const receipt = rule('.workbench-status .receipt-details');
  assert.match(receipt, /opacity: 0; pointer-events: none/);
  assert.doesNotMatch(receipt, /display: none|visibility: hidden/);
  assert.match(rule('.workbench-status:hover .receipt-details, .workbench-status:focus-within .receipt-details, .workbench-status .receipt-details:has(details[open])'), /opacity: 1; pointer-events: auto/);
  assert.match(media('@media (pointer:coarse)'), /\.workbench-status \.receipt-details \{ opacity: 1; pointer-events: auto; \}/);
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
test('project and pane controls have unique identities without a global toolbar or duplicate headers', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); assert.equal(ids.length, new Set(ids).size);
  assert.doesNotMatch(html, /project-bar|pane-heading|id="tab-bar"|id="statusbar"/);
  assert.match(html, /class="sidebar-footer"/); assert.match(rule('.connection-banner'), /flex-wrap: wrap/);
  for (const id of ['project-button','compact-project-button','commands-button','notifications-button','appearance-button','connection','model-button','thinking-button','primary-usage']) assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id);
});

test('supplied roles stay inline metadata and expanded thinking separates from prose only', () => {
  const role = rule('.message-role'); assert.match(role, /font-size: 13px; line-height: 18px; font-weight: 600/);
  assert.match(role, /min-width: 0; overflow: hidden; color: var\(--fg\)/);
  assert.doesNotMatch(role, /display:|grid|border|background|padding|margin/);
  assert.equal(rule('.message-body > .thinking[open] + :not(.tool-shell):not(.message-coverage)').trim(), 'margin-top: 16px;');
  assert.match(rule('.message-body > .thinking + *'), /margin-top: 8px/);
  assert.match(rule('.message.tool-only > .message-body > .thinking + .tool-shell'), /margin-top: 8px/);
});

test('focus marks the actual editor and its local split identity without changing placement', () => {
  assert.match(rule('.composer textarea:focus-visible'), /outline: 1px solid var\(--accent\); outline-offset: 3px/);
  assert.doesNotMatch(css, /\.composer:has\(textarea:focus-visible\).*border-color: var\(--accent\)/);
  assert.match(rule('.composer-input'), /border-top: 1px solid var\(--edge\)/);
  assert.match(rule('.pane-leaf[data-focused=true] > .tab-bar .conversation-tab[aria-selected=true]'), /border-top-color: var\(--accent\)/);
  assert.doesNotMatch(css, /\.pane-heading/);
});

test('recovery controls are bounded buttons and a ready Message panel reserves no status row', () => {
  assert.match(rule('.connection-banner button'), /border: 1px solid var\(--edge\)/);
  assert.match(rule('.message-panel-status > button'), /border: 1px solid var\(--edge\)/);
  assert.match(rule('.message-panel-status:has(> span:empty):has(> button[hidden])'), /display: none/);
});

test('the access check names its actual action without project jargon', () => {
  assert.match(html, /id="access-title">This browser is not signed in\.<\/h1>/);
  assert.match(html, /id="access-retry" type="button">Check access<\/button>/);
});

test('footer metadata keeps scoped groups and native details outside the composers', async () => {
  assert.match(rule('.usage-group'), /display: inline-flex;[^}]*gap: 4px; white-space: nowrap/);
  assert.match(rule('.workbench-status .composer-details'), /width: auto/);
  assert.match(rule('.workbench-status .composer-details > summary'), /flex-wrap: wrap/);
  assert.match(rule('.workbench-status .composer-detail-body'), /position: absolute;[^}]*bottom: calc\(100% \+ 6px\)/);
  assert.match(rule('.composer-detail-body'), /width: 100%; max-height: 30dvh/);
  assert.match(rule('.composer-details > summary > span:not(.composer-details-label)'), /display: inline-flex/);
  assert.doesNotMatch(css, /cacheTurnHit|cacheTurnWrite|context-bar/);
  const footer = html.match(/<footer id="workbench-status"[\s\S]*?<\/footer>/)?.[0]; assert.ok(footer);
  for (const prefix of ['primary', 'agent']) {
    assert.match(footer, new RegExp(`id="workbench-status-${prefix}"`));
    assert.match(footer, new RegExp(`<details id="${prefix}-usage-details"`));
    assert.match(footer, new RegExp(`id="${prefix}-folder"`));
  }
  const composer = await readFile(new URL('./composer.ts', import.meta.url), 'utf8');
  const factory = composer.slice(composer.indexOf('export function createComposerElements('), composer.indexOf('\ntype Edit ='));
  assert.match(factory, /const root = element\('form', 'composer'\); root\.id = id/);
  assert.doesNotMatch(factory, /composer-detail-body|usage-details|workbench-status-facts/);
  assert.match(html, /id="focused-composer-status" class="workbench-draft-state"/);
  assert.match(rule('.extension-status-list'), /overflow: auto/);
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
  assert.match(rule('.message-body > .thinking + *'), /margin-top: 8px/);
  assert.match(rule('.message.tool-only > .message-body > .thinking'), /margin: 0/);
  assert.match(rule('.message.tool-only > .message-body > .thinking + .tool-shell'), /margin-top: 8px/);
  assert.match(rule('.tool-inspection > pre'), /max-height: 320px/);
  assert.doesNotMatch(css, /\.tool-inspection\s*\{[^}]*overflow|max-height:[^}]*\.tool-inspection/);
});

test('navigation identities stay separate from ellipsis and overflow controls remain quiet', () => {
  assert.match(rule('.tab-identity'), /flex: none;.*font-size: 12px/);
  assert.match(rule('.pane-actions'), /display: inline-flex; flex: none;[^}]*min-width: 28px; min-height: 28px;[^}]*color: var\(--muted\)/);
  assert.match(rule('.pane-actions:hover, .pane-actions[aria-expanded=true]'), /background: var\(--raised\); color: var\(--fg\)/);
  assert.doesNotMatch(rule('.pane-actions'), /overflow: hidden|text-overflow:|display: none/);
  assert.doesNotMatch(css, /\.tab-overflow\s*\{/);
  assert.match(rule('.conversation-tab.tab-dragging'), /background: var\(--raised\); border-top-color: var\(--edge\)/);
  assert.match(rule('.palette-title'), /overflow: hidden; text-overflow: ellipsis/);
  assert.match(rule('.palette-identity'), /flex: none/);
  assert.match(rule('.palette-row[data-kind=conversation]'), /grid-template-columns: minmax\(0,1fr\) auto/);
  assert.match(rule('.picker-select'), /flex-direction: column/);
  assert.match(rule('.picker-session-tail'), /flex: none/);
  assert.match(rule('.picker-select .identity'), /overflow-wrap: anywhere/);
  assert.match(rule('.command-option:hover, .palette-row:hover'), /background: var\(--canvas\)/);
});
test('the document selects the same-origin SVG favicon', () => {
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
});

test('drawer and overflow controls share accessible inline stroke icons', async () => {
  const button = html.match(/<button id="sidebar-close"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(button, /data-control-icon="close"/); assert.match(button, /aria-label="Hide navigation"/);
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.equal([...app.matchAll(/const plus = cardAction\('plus'/g)].length, 1);
  assert.match(app, /cardAction\('plus', 'New tab', \(\) => choosePaneTarget\(leaf\.id\)/);
  assert.match(app, /plus\.setAttribute\('aria-haspopup', 'dialog'\)/);
  assert.match(app, /cardAction\('chevron', 'Tabs in this pane'/);
  assert.match(app, /bar\.append\(previous, next, tabs, plus, menu\); node\.append\(bar, content\)/);
  assert.match(rule('.pane-menu > .card-icon'), /transform: rotate\(90deg\)/);
  assert.match(app, /cardAction\('previous', 'Previous tab'/); assert.match(app, /cardAction\('next', 'Next tab'/);
  assert.match(rule('.pane-actions'), /align-items: center; justify-content: center; min-width: 28px; min-height: 28px/);
  assert.match(media('@media (pointer:coarse)'), /\.message-menu, \.communication-unverified, \.message-source-close, \.pane-actions, \.context-menu > \.context-menu-item \{ min-height: 44px; min-width: 44px; \}/);
  assert.doesNotMatch(html, /id="tabs-list"|id="tabs-split"/);
  assert.doesNotMatch(css, /\.tab-overflow\s*\{|\.tab-actions\s*\{/);
});

test('agent status uses one plain line and a flat action row in normal flow', () => {
  assert.match(rule('.agent-state'), /flex: none/); assert.match(rule('.agent-state > p'), /font-weight: 400/);
  assert.match(rule('.agent-state-actions'), /display: flex; flex-wrap: wrap; align-items: center; gap: 16px/);
  assert.match(rule('.agent-state-actions > button, #agent-message-retry'), /border: 0; border-radius: 0/);
  assert.doesNotMatch(rule('.agent-state-actions > button, #agent-message-retry'), /box-shadow|background/); assert.doesNotMatch(css, /agent-start-help|agent-absent/);
  assert.match(rule('.conversation'), /display: flex; flex-direction: column;[^}]*min-height: 0/);
  assert.match(rule('.transcript-region'), /display: grid; grid-template-rows: minmax\(0,1fr\) auto; flex: 1;[^}]*min-height: 0/);
  assert.doesNotMatch(css, /\.conversation\.agent-empty > \.transcript-region\s*\{/);
  assert.match(rule('.composer'), /flex: none/);
  assert.match(rule('.conversation.agent-empty .transcript'), /padding-block: 0/);
  assert.match(rule('.transcript-region > .empty-state'), /position: absolute/);
});

test('Message connection recovery shares flat state actions and retains native focus', () => {
  const action = rule('.agent-state-actions > button, #agent-message-retry');
  assert.match(action, /padding: 4px 0; border: 0; border-radius: 0/);
  assert.doesNotMatch(action, /outline|box-shadow|background/);
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(html, /id="agent-message-retry" type="button"/);
});

test('the sidebar footer uses one separated action row and a visible edge', () => {
  assert.equal([...css.matchAll(/\.sidebar-footer \{/g)].length, 1);
  assert.match(rule('.sidebar-footer'), /align-items: center; gap: 4px; padding: 8px 8px 0/); assert.match(rule('.sidebar-footer'), /border-top: 1px solid var\(--edge\)/);
});

test('the visible sidebar owns its close control and inherits coarse pointer targets', () => {
  assert.match(rule('.sidebar-close'), /display: inline-flex/);
  assert.match(html, /id="sidebar-close" class="icon-button sidebar-close"[^>]+aria-label="Hide navigation"/);
  assert.match(media('@media (max-width:899px)'), /\.sidebar-close \{ display: inline-flex/);
  assert.match(rule('.icon-button'), /width: 28px; height: 28px/);
  assert.match(media('@media (pointer:coarse)'), /min-height: 44px; min-width: 44px/);
});

test('source headers reserve controls outside local wrap scrollports and preserve diff line flow', () => {
  assert.match(rule('.source-header'), /display: flex/);
  assert.doesNotMatch(rule('.source-header button, .source-disclosure > .source-wrap'), /position: absolute|opacity:/);
  assert.match(rule('pre[data-wrap=false], .tool-source > pre[data-wrap=false]'), /white-space: pre; overflow-wrap: normal; overflow-x: auto/);
  assert.match(rule('pre'), /white-space: pre-wrap/);
  assert.doesNotMatch(rule('.diff-del, .diff-add'), /display: block/);
});
test('dialog word-button chrome never changes shared SVG action geometry', () => {
  const words = rule('#modal-body > button:not(.card-action, .icon-button), .dialog-actions > button:not(.card-action, .icon-button), .picker-project-actions > button:not(.card-action, .icon-button)');
  assert.match(words, /padding: 4px 10px; border: 1px solid var\(--edge\)/);
  assert.doesNotMatch(css, /(?:#modal-body|\.dialog-actions|\.picker-project-actions) > button(?:\s*,[^{}]+)?\s*\{[^}]*border:/);
  assert.match(rule('.card-action'), /padding: 0; border: 0/);
  assert.match(rule('.icon-button'), /min-width: 28px; height: 28px; padding: 0 4px/);
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--accent\)/);
});
test('primary history details and retry share a flat wrapping action row', () => {
  assert.match(rule('.history-actions'), /display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 12px/);
  assert.match(rule('.history-actions > .history-details'), /min-width: 0; max-width: calc\(100% - 40px\)/);
  assert.match(rule('.history-actions > .card-action'), /flex: none/);
});
test('coarse working tool slots require roster width and preserve names and action reservations', () => {
  assert.match(rule('.roster'), /container-type: inline-size; container-name: roster/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /@container roster \(min-width: 392px\)/);
  assert.match(coarse, /min-width: 184px; padding-right: 8px/);
  assert.match(coarse, /\.row-name \{ min-width: 64px/);
  assert.match(coarse, /max-width: calc\(100% - 184px\); visibility: visible/);
  assert.match(coarse, /padding-left: 12px; padding-right: 72px/);
  assert.match(coarse, /\.row-heading \{ gap: 6px/);
  assert.match(coarse, /\.agent-row:is\(\[data-action=message\],\[data-action=resume\]\) > \.row-age \{ visibility: hidden/);
});
test('source disclosure controls occupy the caption row without entering its click target', () => {
  assert.match(rule('.source-disclosure'), /position: relative/);
  assert.match(rule('.source-disclosure > summary.source-header'), /width: 100%; min-height: 29px; padding: 2px 56px 2px 6px/);
  assert.match(rule('.source-disclosure > .source-wrap'), /position: absolute; top: 2px; right: 6px/);
  assert.match(media('@media (pointer:coarse)'), /\.source-disclosure > summary\.source-header \{ min-height: 49px/);
  assert.doesNotMatch(rule('.source-disclosure'), /overflow|max-height/);
});
test('empty-session guidance has a distinct heading and caption inside the transcript region', async () => {
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /const region = element\('div', 'transcript-region'\); const absent = add\('empty', 'div', 'empty-state'\)/);
  assert.match(app, /absent\.append\(add\('empty-heading', 'h2'\), add\('empty-caption', 'p'\)\)/);
  assert.match(app, /region\.append\(absent, scroller, latest\)/);
  assert.doesNotMatch(html, /id="primary-empty"|id="primary-empty-heading"|id="primary-empty-caption"/);
  assert.match(rule('.transcript-region'), /position: relative/);
  assert.match(rule('.transcript-region > .empty-state'), /position: absolute; top: 0; left: 0/);
  assert.match(rule('.conversation > .transcript-region > .empty-state'), /grid-area: 1 \/ 1; align-self: start; padding-top: 24px/);
  assert.match(rule('.conversation > .transcript-region > .empty-state > h2'), /color: var\(--fg\); font-size: 18px; font-weight: 600/);
  assert.match(rule('.conversation > .transcript-region > .empty-state > p:not(:empty)'), /margin-top: 8px; font-size: 15px/);
  assert.doesNotMatch(css, /#primary-empty\b/);
});

test('message coverage stays subordinate without restoring turn-sized margins', () => {
  assert.match(rule('.message-body > .secondary.message-coverage'), /margin: 4px 0 0; font-size: 12px; line-height: 18px; color: var\(--muted\)/);
});

test('prose keeps a measured narrow allowance without shrinking technical blocks', () => {
  assert.match(rule('.message-body :is(p, ul, ol, blockquote):not(.tool-caption)'), /max-width: 72ch/);
  assert.doesNotMatch(rule('.code-block'), /600px/);
  assert.doesNotMatch(rule('.message-body table'), /600px/);
  assert.match(rule('.message-body'), /font-size: 15px; line-height: 1.6/);
});
test('slash rows use the conversation container and full-width descriptions at narrow pane widths', () => {
  const start = css.indexOf('@container conversation (max-width: 540px)'); assert.ok(start >= 0);
  const rows = css.slice(start, css.indexOf('.command-empty', start));
  assert.match(rows, /\.command-source \{ grid-column: 2; grid-row: 1/);
  assert.match(rows, /\.command-desc \{ grid-column: 1 \/ -1; grid-row: 2; white-space: normal; overflow: visible/);
});
