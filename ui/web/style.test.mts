import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PERSISTENT_SIDEBAR_MIN_WIDTH } from './layout-breakpoints.ts';
const css = await readFile(new URL('./style.css', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  assert.ok(match, `Missing ${selector}`); return match[1];
}
const declarations = (property: string): string[] => [...css.matchAll(new RegExp(`(?:^|[;{\\s])${property}:\\s*([^;}]+)`, 'g'))].map(match => match[1].trim());
const media = (query: string): string => { const start = css.indexOf(query); assert.ok(start >= 0, `Missing ${query}`); const next = css.indexOf('\n@media', start + 1); return css.slice(start, next < 0 ? undefined : next); };

test('loaded-message choices keep separate excerpt and date rows at phone and desktop widths',()=>{
  assert.match(rule('dialog[data-variant=palette][data-mode=messages] .palette-list'),/--palette-row-size: 56px/);
  assert.match(rule('dialog[data-variant=palette][data-mode=messages] .palette-row'),/grid-template-columns: minmax\(0,1fr\); grid-template-rows: auto auto/);
  assert.match(rule('dialog[data-variant=palette][data-mode=messages] .palette-desc'),/grid-column: 1; grid-row: 2/);
  assert.match(rule('dialog[data-variant=palette], dialog[data-variant=picker]'),/width: min\(680px, calc\(100vw - 32px\)\)/);
});
test('quiet file rows use the existing muted ink without other presentation overrides', () => {
  assert.equal(rule('.file-row-quiet').trim(), 'color: var(--muted);');
});
test('raised-menu hover and keyboard selection use visible mode-aware surfaces', () => {
  assert.match(rule(':where(:root)'), /--menu-hover: var\(--canvas\);/);
  for (const mode of ['light', 'system']) assert.match(rule(`:where(:root[data-appearance=${mode}])`), /--menu-hover: var\(--side\);/);
  for (const selector of ['.composer-intake-menu > .context-menu-item:hover, .composer-intake-menu > .context-menu-item:focus-visible', '.command-option:hover, .command-option[aria-selected=true]']) {
    assert.equal(rule(selector).trim(), 'background: var(--menu-hover);');
  }
  assert.equal(declarations('background').filter(value => value === 'var(--menu-hover)').length, 4);
});
test('roster rows place a wrapping model line between the heading and optional summary', () => {
  assert.match(rule('.agent-row'), /grid-template-columns: minmax\(0,1fr\) max-content/);
  assert.match(rule('.agent-row:is([data-action=message],[data-action=resume])'), /max-content 24px/);
  const select = rule('.agent-row .row-select');
  assert.match(select, /grid-column: 1 \/ -1; grid-row: 1;/);
  assert.match(select, /grid-template-columns: subgrid; grid-template-rows: 30px auto auto; row-gap: 0/);
  assert.match(select, /height: auto; min-height: 30px; padding: 0 var\(--s2\) 0 var\(--s3\)/);
  assert.match(media('@media (pointer:coarse)'), /\.agent-row \.row-select \{ grid-template-rows: 44px auto auto; min-height: 44px; \}/);
  assert.match(media('@media (pointer:coarse)'), /\.agent-row \.row-heading \{ height: 44px; \}/);
  assert.match(rule('.agent-row .row-heading'), /grid-column: 1; grid-row: 1; display: flex/);
  assert.match(rule('.agent-row .row-heading'), /height: 30px; min-width: 0; overflow: hidden/);
  assert.match(rule('.agent-row .row-name'), /flex: 1; font-size: var\(--fs-ui\); line-height: 30px; white-space: nowrap/);
  assert.match(rule('.row-title, .row-name'), /overflow: hidden; color: var\(--fg\); font-weight: 500; text-overflow: clip/);
  const model = rule('.agent-row .row-model');
  assert.match(model, /grid-column: 1 \/ -1; grid-row: 2; min-width: 0/);
  assert.match(model, /color: var\(--muted\); font-size: var\(--fs-meta\); line-height: 18px/);
  assert.match(model, /white-space: normal; overflow-wrap: anywhere/);
  assert.doesNotMatch(model, /(?:^|;)\s*(?:height|max-height|overflow|text-overflow):/);
  assert.match(rule('.sidebar .agent-row'), /height: auto/);
  assert.match(rule('.sidebar .agent-row .row-select'), /grid-template-rows: 30px auto auto; min-height: 30px; height: auto/);
  assert.match(rule('.sidebar .agent-row .row-preview'), /grid-row: 3/);
  assert.match(css.slice(css.lastIndexOf('@media (pointer:coarse)')), /\.sidebar \.agent-row \.row-select \{ grid-template-rows: 44px auto auto;/);
  const summary = rule('.agent-row .row-summary');
  assert.match(summary, /grid-column: 1 \/ -1; grid-row: 3/);
  assert.match(summary, /height: 20px; color: var\(--muted\); font-size: var\(--fs-meta\); line-height: 20px/);
  assert.match(summary, /white-space: nowrap; overflow: hidden; text-overflow: clip/);
  assert.doesNotMatch(rule('.agent-row .row-state'), /grid-row|grid-column/);
  assert.match(rule('.row-age, .row-message'), /position: static; grid-row: 1; z-index: 1; margin-top: 0/);
  assert.match(rule('.agent-row > .row-age'), /grid-column: 2; width: auto; height: 30px/);
  assert.match(rule('.row-message.card-action'), /width: 24px; height: 24px/);
  assert.match(rule('[hidden]'), /display: none !important/);
});
test('roster activity owns a 10px inline spinner and filters stay quiet until focus', () => {
  const spinner = rule('.row-state[data-busy=true]::before');
  assert.match(spinner, /width: 10px; height: 10px/); assert.match(spinner, /border: 1.5px solid currentColor/);
  assert.match(spinner, /animation: work-pulse 900ms linear infinite/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \.row-state\[data-busy=true\]::before \{ animation: none; \} \}/);
  assert.match(rule('.nav-filter'), /border: 0; border-radius: 0; background: transparent; font-size: var\(--fs-ui\)/);
  assert.match(rule('.nav-filter::placeholder'), /color: var\(--muted\)/);
  assert.match(rule('.nav-search'), /height: 30px; margin: 0 var\(--s3\); border-bottom: 1px solid transparent/);
  assert.match(rule('.nav-search:focus-within'), /border-bottom-color: var\(--rule\)/);
  assert.match(media('@media (pointer:coarse)'), /\.nav-search \{ height: 44px; \}/);
  assert.match(rule('input:focus-visible, select:focus-visible'), /outline: 2px solid var\(--accent\)/);
});
test('result references are plain inline text with zero horizontal inset and vertical hit areas', () => {
  const row = rule('.communication-results'), action = rule('.communication-results > .communication-result-link');
  assert.match(row, /display: block; padding: 0; color: var\(--muted\); font-size: var\(--fs-meta\)/);
  assert.match(action, /display: inline-block; vertical-align: baseline; min-width: 0; min-height: 24px/);
  assert.match(action, /margin: 0; padding: var\(--s1\) 0; border: 0; border-radius: 0; background: transparent/);
  assert.match(action, /color: var\(--link\); font: inherit; line-height: 16px/);
  assert.match(action, /white-space: normal; overflow-wrap: normal; word-break: normal/);
  assert.doesNotMatch(action, /(?:^|;)\s*(?:gap|position|overflow|text-overflow):|line-clamp/);
  assert.equal(rule('.communication-results > .communication-result-link:is(:hover, :focus-visible)').trim(), 'text-decoration: underline;');
  assert.match(rule(':focus-visible, .entry.own-message-focus, .thread-message.own-message-focus'), /outline: 2px solid var\(--accent\); outline-offset: 2px/);
  assert.match(media('@media (pointer:coarse)'), /\.communication-results > \.communication-result-link \{ min-height: 44px; padding-block: calc\(var\(--s3\) \+ var\(--s1\) \/ 2\); \}/);
  assert.doesNotMatch(css, /\.communication-results > \.card-action/);
});
test('task inspection hides its composer independently of draft visibility and preserves projected editors', () => {
  assert.equal(rule('.conversation.inspection-active > .composer:not([data-message-panel]):not([data-desk-panel])').trim(), 'display: none;');
});
test('conversation actions live in the pane tab row and keep shared desktop and coarse targets', () => {
  assert.doesNotMatch(css, /inspection-navigation/);
  assert.match(rule('.pane-actions'), /display: inline-flex; flex: none/); assert.doesNotMatch(rule('.pane-actions'), /opacity|visibility|display: none/);
  assert.match(rule('.inspection-header'), /display: flex; flex: none/);
  assert.match(rule('.card-action'), /width: 24px; height: 24px; min-width: 24px; min-height: 24px/);
  assert.match(media('@media (pointer:coarse)'), /\.card-action, \.section-toggle[^{}]+\{ min-height: 44px; min-width: 44px/);
});
test('sidebar headings are text controls with counts and the finder is the first row of SESSIONS', () => {
  const chevron = rule('.section-toggle > .card-icon-chevron');
  assert.match(chevron, /display: block; flex: none; width: 12px; height: 12px; color: var\(--dim\)/);
  assert.match(chevron, /transform: rotate\(0deg\); transition: transform 120ms/);
  assert.match(rule('.section-toggle[aria-expanded=true] > .card-icon-chevron'), /transform: rotate\(90deg\)/);
  assert.doesNotMatch(css, /\.section-toggle\[aria-expanded=false\] > \.card-icon-chevron/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \.section-toggle > \.card-icon-chevron \{ transition: none; \} \}/);
  assert.match(rule('.nav-heading'), /display: flex; flex: 1; min-width: 0/);
  assert.match(rule('.section-toggle'), /display: flex; flex: 1; align-items: center; gap: var\(--s1\); width: 100%/);
  assert.match(rule('#sessions-heading'), /padding-left: calc\(var\(--s3\) \+ var\(--s1\)\)/);
  assert.match(rule('.nav-heading-row'), /padding: 0 var\(--s2\) 0 var\(--s3\)/);
  assert.doesNotMatch(css, /\.section-toggle::before/);
  assert.match(rule('.section-toggle:hover'), /color: var\(--fg\)/); assert.match(rule('.section-toggle .count'), /margin-left: var\(--s2\)/);
  assert.match(rule('.threads-footer'), /padding-right: var\(--s3\); padding-left: var\(--s3\)/);
  assert.match(html, /id="files-count"/); assert.match(html, /id="agents-count"/);
  assert.match(html, /<h2 id="sessions-heading" class="nav-heading">SESSIONS<\/h2>/);
  assert.match(rule('.session-catalog'), /color: var\(--muted\)/);
  assert.match(html, /id="session-open" class="icon-button"[^>]*data-control-icon="search"[^>]*aria-label="Find session"/);
  assert.match(html, /id="session-new"[^>]*data-control-icon="plus"[^>]*aria-label="New session"/);
});

test('content hues share scoped Markdown rules and leave metadata and identity tails intact',()=> {
  assert.match(rule('.secondary, .info'),/color: var\(--muted\)/);
  assert.match(rule('.message-role'),/color: var\(--muted\)/);assert.match(rule('.thinking > summary, .system-note > details > summary, .custom-entry > details > summary, .facts-panel summary'),/color: var\(--muted\)/);assert.match(rule('.thinking > summary'),/font-weight: 400; line-height: 20px/);assert.match(rule('.thinking-label'),/font-weight: 500/);assert.match(rule('.thinking[open] > summary > .thinking-preview'),/display: none/);assert.match(rule('.thinking-content'),/color: var\(--muted\)/);
  assert.match(rule('.tool-name'), /color: inherit/); assert.match(rule('.tool-shell'), /color: var\(--fg\)/);
  assert.match(rule('.tool-status.working'),/color: var\(--info\)/);assert.match(rule('.tool-status.missing'),/color: var\(--warning\)/);
  assert.match(rule('.markdown-content:is(h1, h2, h3, h4, h5, h6)'),/color: var\(--fg\)/);assert.match(rule('.markdown-content .markdown-inline-code'),/color: var\(--fg\)/);
  assert.doesNotMatch(css,/\.file-content th, \.file-content td|\.file-content blockquote/);
  assert.match(rule('.row-identity'),/max-width: 40%; overflow: hidden; text-overflow: clip/);
  assert.match(rule('.conversation-identity'),/white-space: nowrap/);
});
test('shared Markdown adjacency never overrides heading or post-heading margins', () => {
  const adjacency = css.split('\n').find(line => line.includes('.markdown-content') && line.includes(' + ') && line.includes('margin-top: var(--s3);'))?.split('{')[0].trim(); assert.ok(adjacency);
  const weight = (selector: string) => {
    const weighted = selector.replace(/:where\([^)]*\)/g, '');
    return (weighted.match(/\.[\w-]+/g)?.length ?? 0) * 100 + Number(/:is\(h[1-6]/.test(weighted));
  };
  for (const selector of ['.markdown-content:is(h1)', '.markdown-content:is(h2)', '.markdown-content:is(h3)', '.markdown-content:is(h4, h5, h6)', '.markdown-content:is(h1, h2, h3, h4, h5, h6) + :not(:where(h1, h2, h3, h4, h5, h6))']) {
    assert.ok(weight(selector) > weight(adjacency), `${selector} must beat ${adjacency}`);
  }
  assert.match(rule('.markdown-content:is(h1, h2, h3, h4, h5, h6) + :not(:where(h1, h2, h3, h4, h5, h6))'), /margin-top: var\(--s2\)/);
  assert.match(rule(adjacency), /margin-top: var\(--s3\)/);
});
test('post-heading spacing excludes every heading level and preserves adjacent heading margins', () => {
  const siblings = [...css.matchAll(/(?:^|\n)\s*(\.markdown-content:is\(h1, h2, h3, h4, h5, h6\)\s*\+\s*[^{}]+)\{([^{}]+)\}/g)];
  assert.ok(siblings.length > 0, 'post-heading spacing has a rule');
  for (const [, selector, body] of siblings) {
    assert.match(body, /margin-top: var\(--s2\);/);
    const excluded = /\+\s*:not\(:where\(([^)]+)\)\)\s*$/.exec(selector)?.[1].split(/,\s*/);
    assert.deepEqual(excluded, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'], `${selector} must not apply to a heading`);
  }
  for (const [selector, margin] of [['h1', 'calc(var(--s4) + var(--s3))'], ['h2', 'calc(var(--s4) + var(--s3))'], ['h3', 'calc(var(--s4) + var(--s1))'], ['h4, h5, h6', 'calc(var(--s4) + var(--s1))']]) {
    assert.ok(rule(`.markdown-content:is(${selector})`).includes(`margin-top: ${margin};`), `${selector} retains its own heading space`);
  }
});
test('the tool status from active execution receives the information tone', async () => {
  const tools = await readFile(new URL('./transcript-tools.ts', import.meta.url), 'utf8');
  const rendered = /if \(part.status === 'running'\) return '([^']+)'/.exec(tools)?.[1]; assert.ok(rendered);
  const renderer = await readFile(new URL('./render.ts', import.meta.url), 'utf8'); assert.match(renderer, /this\.toolState\(tool, source\)/);
  assert.match(renderer, /tool\.glyph\.className = `tool-status \$\{status\}`/);
  assert.match(rule(`.tool-status.${rendered}`), /color: var\(--info\)/);
  assert.doesNotMatch(css, /\.tool-status\.running\s*\{/);
});

test('two families: system sans for interface and prose, system monospace for code and status', () => {
  assert.match(rule(':where(:root)'), /--sans: system-ui, -apple-system, "Segoe UI", sans-serif;/);
  assert.match(rule(':where(:root)'), /--mono: ui-monospace, "SF Mono", Menlo, monospace;/);
  assert.match(rule('html, body'), /font: 400 var\(--fs-ui\)\/1\.5 var\(--sans\)/);
  assert.match(rule('pre, code, kbd, samp'), /font-family: var\(--mono\); font-size: var\(--fs-code\)/);
  assert.deepEqual([...new Set(declarations('font-family'))].sort(), ['inherit', 'var(--mono)', 'var(--sans)']);
  for (const selector of ['.statusline', '.row-identity', '.identity, code.identity']) assert.match(rule(selector), /font-family: var\(--mono\)/, selector);
  assert.match(rule('.tool-shell'), /font-family: var\(--sans\)/);
  assert.match(rule('.tool-preview'), /font-family: var\(--mono\)/);
});
test('type tokens define readable labels, metadata, controls, prose, code and headings', () => {
  const sizes = {label: 12, meta: 13, ui: 15, body: 16, code: 14, title: 18, h1: 24, h2: 20, h3: 17, h4: 16};
  for (const [name, size] of Object.entries(sizes)) {
    assert.match(rule(':where(:root)'), new RegExp(`--fs-${name}: ${size}px;`));
    assert.ok(size >= (name === 'label' ? 12 : 13), name);
  }
  const allowed = new Set(['inherit', ...Object.keys(sizes).map(name => `var(--fs-${name})`)]);
  for (const value of declarations('font-size')) assert.ok(allowed.has(value), `font-size outside the type scale: ${value}`);
  assert.match(rule('.message-role'), /font-size: var\(--fs-meta\); line-height: 18px; font-weight: 500/);
  assert.match(rule('.communication-card > .communication-body'), /font-size: var\(--fs-body\); line-height: 1\.65; font-weight: 400; font-style: normal/);
  assert.match(rule('.message-body'), /font-size: var\(--fs-body\); line-height: 1\.65;/);
  assert.match(rule('.composer textarea'), /font-size: var\(--fs-body\); line-height: 1\.65;/);
  assert.match(rule('pre'), /line-height: 1\.55;/);
  assert.match(rule('.file-text'), /font-size: var\(--fs-code\); line-height: 1\.55;/);
  assert.match(rule('.statusline'), /font-size: var\(--fs-meta\);/);
  assert.match(rule('.thread-prose'), /font-size: var\(--fs-body\); line-height: 1\.65;/);
  assert.deepEqual([...new Set(declarations('font-weight'))].sort(), ['400', '500', '600']);
  assert.deepEqual(declarations('font').filter(value => value !== '400 var(--fs-ui)/1.5 var(--sans)' && value !== 'var(--fs-code)/1.55 var(--mono)' && value !== 'inherit'), []);
});
test('spacing tokens define one rhythm across transcript, threads, tools, sidebar and dialogs', () => {
  for (const [index, size] of [4, 8, 12, 16, 24, 32, 48].entries()) assert.match(rule(':where(:root)'), new RegExp(`--s${index + 1}: ${size}px;`));
  const subject = /\.(?:transcript|entry|markdown-content|message|thinking|system-note|custom-entry|communication|tool|thread|sidebar|nav|row|agent-row|roster|file-row|file-naming|conversation-heading|conversation-group-title|picker|palette|context-menu)(?:[-\w]*)(?=[\s.#:[>+~,)]|$)|\bdialog\b|#modal(?:[-\w]*)/;
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  let checked = 0;
  for (const [, selectors, body] of blocks) {
    if (!subject.test(selectors)) continue;
    for (const [, property, value] of body.matchAll(/(?:^|;)\s*((?:margin|padding)(?:-[\w-]+)?|(?:row-|column-)?gap)\s*:\s*([^;]+)/g)) {
      checked++;
      let normalized = value.replace(/var\(--s[1-7]\)/g, '0').replace(/var\(--work-gutter\)/g, '0').replace(/\s*!important$/, '');
      normalized = normalized.replace(/(?<![\d.])-?(\d+)px\b/g, (match, size) => [2, 4, 6, 8, 12, 16, 24, 28, 32, 48].includes(Number(size)) ? '0' : match);
      if (/\.file-(?:row|naming)\b/.test(selectors)) normalized = normalized.replace(/var\(--file-depth,0\)|var\(--fs-code\)/g, '0');
      assert.match(normalized, /^(?:\s*(?:0|auto|calc\([\d\s.+*/(),%-]+\))\s*)+$/, `${selectors.trim()} ${property}: ${value}`);
      assert.doesNotMatch(normalized, /(?:\d|\.)\s*(?:px|rem|em|vh|dvh|vw|ch)\b/, `${selectors.trim()} ${property}: ${value}`);
    }
  }
  assert.ok(checked > 0, 'subject selectors contain spacing declarations');
});
test('shared Markdown uses readable heading levels, list rhythm and row-rule tables', () => {
  const headings = rule('.markdown-content:is(h1, h2, h3, h4, h5, h6)');
  assert.match(headings, /color: var\(--fg\)/);
  assert.match(headings, /font-weight: 600/);
  assert.match(headings, /margin-bottom: var\(--s2\)/);
  for (const [selector, token, above] of [['h1', 'h1', 'calc(var(--s4) + var(--s3))'], ['h2', 'h2', 'calc(var(--s4) + var(--s3))'], ['h3', 'h3', 'calc(var(--s4) + var(--s1))'], ['h4, h5, h6', 'h4', 'calc(var(--s4) + var(--s1))']]) {
    const body = rule(`.markdown-content:is(${selector})`);
    assert.ok(body.includes(`font-size: var(--fs-${token})`), selector);
    assert.ok(body.includes(`margin-top: ${above}`), selector);
  }
  assert.match(rule('.markdown-content:is(ul, ol)'), /padding-left: var\(--s5\)/);
  assert.match(rule('.markdown-content li + li'), /margin-top: var\(--s1\)/);
  assert.match(rule('.markdown-content li::marker'), /color: var\(--muted\)/);
  assert.match(rule('.markdown-content strong'), /color: var\(--fg\)/);
  const cells = rule('.markdown-content th, .markdown-content td');
  assert.match(cells, /padding: var\(--s2\) var\(--s3\)/);
  assert.match(cells, /border: 0; border-bottom: 1px solid var\(--rule\)/);
  assert.doesNotMatch(cells, /background:|border-(?:left|right|top):/);
  const header = rule('.markdown-content thead th');
  assert.match(header, /font-weight: 600/);
  assert.match(header, /border-bottom: 1px solid var\(--rule\)/);
  assert.match(header, /background: transparent/);
  assert.match(rule('.markdown-content tbody tr:last-child td'), /border-bottom: 0/);
  const table = rule('.markdown-content:is(table)');
  assert.match(table, /font-size: var\(--fs-ui\)/);
  assert.doesNotMatch(table, /background:|(?:^|;)\s*border:/);
  assert.match(rule('.markdown-content:is(blockquote)'), /border-left: 3px solid var\(--rule\)/);
  assert.match(rule('.markdown-content:is(blockquote)'), /padding-left: var\(--s3\)/);
  assert.match(rule('.markdown-content .markdown-inline-code'), /font-size: var\(--fs-code\)/);
});
test('turns, paragraphs and tool runs retain distinct spacing tiers', () => {
  assert.match(rule('.entry'), /padding-bottom: var\(--s5\);/);
  assert.match(rule('.entry.compact-entry'), /padding-block: var\(--s1\);/);
  assert.match(rule('.tool-shell'), /margin: 0;/);
  assert.match(rule('.message-body > * + *, .message-body > * > * + *'), /margin-top: var\(--s3\);/);
  assert.match(rule('.message-body > :not(.tool-shell) + .tool-shell'), /margin-top: var\(--s4\);/);
  assert.match(rule('.message-body > .tool-shell + .tool-shell'), /margin-top: var\(--s2\);/);
});
test('section labels use readable uppercase type and primary names retain their weight', () => {
  for (const selector of ['.nav-heading', '.section-toggle', '.conversation-group-title']) {
    const body = rule(selector);
    assert.match(body, /font-size: var\(--fs-label\)/, selector);
    assert.match(body, /font-weight: 600/, selector);
    assert.match(body, /letter-spacing: \.05em/, selector);
    assert.match(body, /text-transform: uppercase/, selector);
  }
  for (const selector of ['.row-title, .row-name', '.conversation-name', '.file-name', '.picker-project-row strong', '.picker-select strong', '.tool-name']) assert.match(rule(selector), /font-weight: 500/, selector);
  assert.match(rule('.nav-section'), /margin-top: var\(--s4\)/);
  assert.match(rule('.primary-section'), /margin-top: var\(--s4\)/);
  assert.match(rule('.nav-heading-row'), /margin-bottom: var\(--s1\)/);
});
test('Save and Version retain quiet desktop hit heights without weakening coarse targets', () => {
  assert.equal(rule(':where(.file-save, .file-view-switch, .file-quote-selection, .workbench-version)').trim(), 'min-height: 24px;');
  assert.match(media('@media (pointer:coarse)'), /button, summary,[^{}]+\{ min-height: 44px; min-width: 44px/);
  for (const selector of ['.file-save, .file-quote-selection', '.file-view-switch', '.workbench-version']) {
    assert.doesNotMatch(rule(selector), /(?:^|;)\s*(?:height|min-height|max-height):/);
  }
  assert.doesNotMatch(css, /\.workbench-health/);
});
test('the file action row wraps its separated text controls within narrow panes', () => {
  assert.match(rule('.file-view-actions'), /display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var\(--s3\);/);
  assert.match(rule('.file-save, .file-quote-selection'), /color: var\(--dim\); font-size: var\(--fs-meta\);/);
  assert.match(rule('.file-save:hover, .file-quote-selection:hover'), /color: var\(--fg\);/);
});
test('draft attachments keep a fixed contained preview and bounded wrapping details and actions', () => {
  assert.match(rule('.attachment-preview'), /width: 48px; height: 48px; min-width: 48px; min-height: 48px/);
  assert.match(rule('.attachment-preview img'), /width: 100%; height: 100%; object-fit: contain/);
  assert.match(rule('.attachment-row-image'), /grid-template-columns: 48px minmax\(0,1fr\) auto/);
  assert.match(rule('.attachment-row'), /min-width: 0; max-width: 100%/);
  assert.match(rule('.attachment-info'), /min-width: 0; overflow-wrap: anywhere/);
  assert.match(rule('.attachment-details > p'), /white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(rule('.attachment-actions'), /grid-column: 1 \/ -1; display: flex; flex-wrap: wrap/);
  assert.match(rule('.composer-attachments'), /flex-wrap: wrap/);
});
test('draft image previews bound their viewport while Fit and Actual size retain distinct image constraints', () => {
  assert.match(rule('.attachment-dialog'), /width: min\(90vw,900px\); height: min\(90dvh,800px\); max-height: 90dvh/);
  assert.equal(rule('.attachment-dialog[open]').trim(), 'display: flex;');
  assert.match(rule('.image-preview'), /flex-direction: column;.*min-height: 0/);
  assert.match(rule('.image-preview-controls'), /flex-wrap: wrap/);
  assert.match(rule('.image-preview-viewport'), /flex: 1; min-width: 0; min-height: 0; overflow: auto/);
  assert.match(rule('.attachment-dialog.image-preview-fit .image-preview-viewport'), /grid-template: minmax\(0,1fr\) \/ minmax\(0,1fr\); place-items: center/);
  assert.equal(rule('.attachment-dialog.image-preview-fit .image-preview-content').trim(), 'max-height: 100%;');
  assert.match(rule('.image-preview-fit .image-preview-content'), /max-width: 100%/);
  assert.match(rule('.image-preview-actual .image-preview-content'), /width: auto; height: auto; max-width: none; max-height: none; margin: 0/);
});
test('attachment metadata uses the fixed scale and preview inherits the dialog hairline', () => {
  assert.match(rule('.attachment-digest'), /font-size: var\(--fs-meta\); color: var\(--muted\)/);
  assert.match(rule('dialog'), /border: 0/);
  assert.doesNotMatch(rule('.attachment-dialog'), /\bborder(?:-[\w-]+)?:/);
});
test('off-pane Message roots pass header pointers through while the original composer stays interactive', () => {
  assert.match(rule('.stable-views > *'), /pointer-events: auto/);
  assert.match(rule('.conversation[data-message-only=true]'), /pointer-events: none/);
  assert.match(rule('.conversation[data-message-only=true] > .composer'), /pointer-events: auto/);
  assert.match(rule('.conversation[data-message-only=true] > :not(.composer)'), /display: none/);
});
test('the narrow drawer covers transcripts while only its projected Message writer crosses the drawer layer', () => {
  const narrow = media('@media (max-width:743px)');
  assert.match(narrow, /\.app\.drawer-open \.workbench > \.sidebar \{[^}]*z-index: 10;/);
  assert.match(narrow, /\.app\.drawer-open \.stable-views \{ z-index: auto; \}/);
  assert.doesNotMatch(narrow, /\.app\.drawer-open \.stable-views \{[^}]*z-index: \d/);
  const projected = '.app.drawer-open .stable-views > .conversation:has(> .composer[data-message-panel=true])';
  assert.equal(rule(projected).trim(), 'container: none;');
  assert.match(rule(`${projected} > .transcript-region`), /container: conversation \/ inline-size/);
  assert.match(rule('.app.drawer-open .composer[data-message-panel=true]'), /z-index: 11; container-name: composer conversation/);
  assert.match(rule('.conversation'), /container: conversation \/ inline-size/);
  assert.match(rule('.composer'), /container: composer \/ inline-size/);
});
test('saved drafts and message choices retain full-width readable rows with separated values', () => {
  assert.match(rule('.recovery-target'), /display: grid; grid-template-columns: minmax\(0,1fr\) minmax\(12ch,20ch\);[^}]*gap: var\(--s3\)/);
  assert.match(rule('.recovery-name, .recovery-count'), /min-width: 0; overflow-wrap: anywhere/);
  assert.match(rule('.message-choice'), /white-space: pre-wrap; overflow-wrap: anywhere/);
});
test('blue marks focus while selected rows and tabs use neutral rules and surfaces', () => {
  const values = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{([^{}]+)\}/g)].flatMap(match =>
    ['background', 'background-color', 'color', 'fill'].flatMap(property =>
      [...match[2].matchAll(new RegExp(`(?:^|[;\\s])${property}:\\s*([^;}]+)`, 'g'))].map(value => ({selector: match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(), property, value: value[1].trim()}))));
  assert.deepEqual(values.filter(item => item.value.includes('--accent') && !item.selector.endsWith('::selection')), [{selector: '.pane-split > .pane-divider:focus-visible::after', property: 'background', value: 'var(--accent)'}, {selector: '.sidebar-content-row[data-unread=true] > .row-title::before', property: 'background', value: 'var(--accent)'}, {selector: '.desk-row-title[aria-expanded=true]', property: 'color', value: 'var(--accent)'}]);
  const fills = values.filter(item => item.property === 'background' || item.property === 'background-color');
  assert.deepEqual(fills.filter(item => item.value.includes('--edge')), [
    {selector: '.pane-split > .pane-divider:hover::after', property: 'background', value: 'var(--edge)'},
  ]);
  const graphicTokens = new Map([['.tab-dot', 'var(--muted)'], ['.tab-dot[data-state=working]', 'var(--link)'], ['.tab-dot[data-state=failed]', 'var(--error)'], ['.send', 'var(--fg)'], ['.send:not(:disabled):hover', 'var(--muted)'], ['.stop', 'transparent'], ['.stop:hover', 'color-mix(in srgb, var(--fg) 2%, transparent)']]);
  for (const item of fills.filter(item => !item.value.includes('--edge'))) {
    const graphic = graphicTokens.get(item.selector);
    if (graphic) assert.equal(item.value, graphic);
    else if (['.composer-intake-menu > .context-menu-item:hover, .composer-intake-menu > .context-menu-item:focus-visible', '.command-option:hover, .command-option[aria-selected=true]'].includes(item.selector)) assert.equal(item.value, 'var(--menu-hover)');
    else if (/^\.composer(?:-input|\b)|^\.queue:not\(:disabled\):hover$|^\.send:disabled$/.test(item.selector)) assert.match(item.value, /color-mix|transparent|ButtonText|ButtonFace|var\(--composer-fill\)/);
    else if (item.selector === '.communication-group-row .communication-toggle:hover') assert.equal(item.value, 'color-mix(in srgb,var(--fg) 5%,var(--raised))');
    else assert.doesNotMatch(item.value, /--(?:fg|muted|dim|link)\b/, `ink used as a fill: ${item.value}`);
  }
  assert.match(rule('.context-menu-item > .choice-check'), /color: var\(--muted\)/);
  assert.match(rule('.context-menu-item[aria-checked=false] > .choice-check'), /visibility: hidden/);
  assert.match(rule(':focus-visible, .entry.own-message-focus, .thread-message.own-message-focus'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule('.nav-row[aria-current=page], .row-select[aria-current=page]'), /background: var\(--raised\)/);
  assert.match(rule('.palette-row[aria-selected=true]'), /background: var\(--canvas\)/);
  assert.match(rule('.command-option:hover, .command-option[aria-selected=true]'), /background: var\(--menu-hover\)/);
  assert.match(rule('.context-menu > button:hover'), /background: var\(--menu-hover\)/);
  assert.doesNotMatch(rule('.context-menu > button:hover'), /outline:/);
  assert.match(rule('.context-menu > button:focus-visible'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule('.conversation-tab[aria-selected=true]'), /background: transparent;[^}]*box-shadow: inset 0 -2px var\(--edge\)/);
  assert.match(rule('.pane-leaf[data-focused=true] > .tab-bar .conversation-tab[aria-selected=true]'), /box-shadow: inset 0 -2px var\(--accent\)/);
  assert.match(rule('.pane-split > .pane-divider:focus-visible'), /outline: 2px solid var\(--accent\); outline-offset: 2px/);
});
test('pane statusline focus uses the shared offset without removing its indicator', () => {
  assert.match(rule(':focus-visible, .entry.own-message-focus, .thread-message.own-message-focus'), /outline: 2px solid var\(--accent\)/);
  assert.match(rule('.navigation-access :focus-visible'), /outline-offset: 2px/);
  assert.doesNotMatch(rule('.navigation-access :focus-visible'), /outline:\s*(?:none|0)|outline-width:\s*0/);
  assert.match(media('@media (forced-colors:active)'), /:focus-visible \{ outline: 2px solid Highlight; \}/);
});
test('stored and live conversation names use primary text while metadata stays quiet', () => {
  assert.match(rule('.row-title, .row-name'), /color: var\(--fg\)/);
  assert.doesNotMatch(css, /\.agent-row\[data-live=false\] \.row-name/);
  assert.match(rule('.row-identity'), /color: var\(--muted\)/);
  assert.match(rule('.row-age, .row-message'), /color: var\(--muted\)/);
  assert.match(rule('.row-state'), /color: var\(--dim\)/);
});
test('small radii and quiet surfaces limit motion to the busy marker and section chevrons', () => {
  const radii = declarations('border-radius');
  assert.match(rule('.composer-input'), /border-radius: var\(--r-lg\)/); assert.match(rule('.context-menu-compact'), /border-radius: var\(--r-md\)/);
  assert.deepEqual([...new Set(radii)].sort(), ['0', '0 0 var(--r-md) var(--r-md)', '0 var(--r-sm) var(--r-sm) 0', '50%', '6px', '8px', 'var(--r-lg)', 'var(--r-md)', 'var(--r-sm)']);
  assert.deepEqual([...new Set(declarations('box-shadow'))].sort(), ['inset 0 -2px var(--accent)', 'inset 0 -2px var(--edge)', 'none', 'var(--shadow)']);
  assert.match(rule('dialog[open][data-variant=find]'), /box-shadow: none/);
  const shadowed = [...css.matchAll(/(?:^|\n)\s*([^{}\n]+)\{[^}]*box-shadow: var\(--shadow\)/g)].map(match => match[1].trim()).sort();
  assert.deepEqual(shadowed, ['.app.drawer-open .workbench > .sidebar', '.command-menu, .composer-intake-menu', '.context-menu', '.context-menu.composer-intake-menu', '.primary-draft-selection', '.receipt-details pre', '.workbench-status .composer-detail-body', 'dialog']);
  assert.doesNotMatch(css, /scroll-behavior:\s*smooth|backdrop-filter|text-shadow/);
  const fades = css.replace(/mask-image: linear-gradient\(to right,#000 calc\(100% - 24px\),transparent\)|background: linear-gradient\(to bottom,transparent,var\(--(?:side|canvas)\)\)/g, '');
  assert.doesNotMatch(fades, /gradient/);
  assert.deepEqual(declarations('filter'), []);
  assert.deepEqual(declarations('transition'), ['transform 120ms', 'none']);
  assert.deepEqual(declarations('animation'), ['work-pulse 900ms linear infinite', 'none', 'work-pulse 900ms linear infinite', 'none', 'work-pulse 900ms linear infinite', 'none']);
  assert.match(rule('.workbench-activity[data-busy=true]::before'), /animation: work-pulse 900ms linear infinite/);
  assert.match(css, /^@keyframes work-pulse \{ to \{ transform: rotate\(360deg\); \} \}$/m);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \.workbench-activity\[data-busy=true\]::before \{ animation: none; \} \}/);
});
test('neutral tools keep lifecycle accents in marks and errors while source diffs retain colors', () => {
  assert.match(rule('.tool-shell'), /padding: var\(--s3\) var\(--s4\); border: 0; border-radius: var\(--r-md\); background: var\(--run-bg\)/);
  assert.doesNotMatch(css, /\.tool-shell\[data-status=success\]/);
  assert.match(rule('.tool-status'), /color: var\(--muted\)/);
  assert.match(rule('.tool-shell[data-status=error] > .tool-card > summary'), /color: var\(--error\)/);
  assert.match(rule('.tool-status.error'), /color: var\(--error\)/);
  assert.match(rule(':is(.tab-dot, .conversation-state, .row-state)[data-tone=info]'), /color: var\(--info\)/, 'work in progress reads as activity, not as a warning');
  assert.match(rule('.diff-del'), /background: var\(--del-bg\); color: var\(--error\)/);
  assert.match(rule('.diff-add'), /background: var\(--add-bg\); color: var\(--success\)/);
  assert.match(rule(':is(.tab-dot, .conversation-state, .row-state)[data-tone=success]'), /color: var\(--success\)/);
  assert.match(rule(':is(.tab-dot, .conversation-state, .row-state)[data-tone=error]'), /color: var\(--error\)/);
  assert.match(rule('a'), /color: var\(--link\)/);
  assert.match(rule('.stop:hover'), /color: var\(--error\)/);
});
test('tool status labels have natural width and disclosure marks stay separate from status', () => {
  assert.match(rule('.tool-status'), /flex: none/);
  assert.doesNotMatch(rule('.tool-status'), /overflow: hidden|text-overflow:|line-clamp/);
  assert.doesNotMatch(rule('.tool-status'), /(?:^|;\s*)width: 12px/);
  assert.match(rule('.tool-card > summary'), /display: grid; grid-template-columns: minmax\(0,1fr\) auto/);
  assert.match(rule('.card-disclosure::before'), /content: none/);
  assert.doesNotMatch(css, /card-icon-disclosure/);
  assert.match(rule('.tool-card > summary > .tool-tier'), /grid-column: 1; grid-row: 1; min-width: 0/);
  assert.match(rule('.tool-card > summary > :is(.tool-preview, .tool-preview-qualification)'), /grid-column: 1 \/ -1/);
  assert.equal(rule('.tool-shell:hover').trim(), 'background: var(--run-hover);');
  assert.match(rule('.tool-preview'), /color: var\(--fg\)/);
  assert.match(rule('.tool-secondary'), /color: var\(--muted\)/);
  assert.match(rule('.tool-output-info'), /max-width: 100%; color: var\(--muted\); font-size: var\(--fs-meta\); white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.doesNotMatch(rule('.tool-output-info'), /cursor: pointer|text-overflow: ellipsis|line-clamp/);
});
test('image load details keep long request identities wrapped inside a bounded disclosure', () => {
  assert.match(rule('.transcript-image-details'), /min-width: 0; max-width: 100%/);
  assert.match(rule('.transcript-image-diagnostics'), /max-width: 100%; max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere/);
});
test('file message source and exact destination details wrap within the dialog', () => {
  assert.match(rule('.file-message-fact'), /min-width: 0; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(rule('.file-message-destination'), /width: 100%; min-width: 0; max-width: 100%/);
});
test('model and thinking use separate readable targets on the composer shelf', () => {
  assert.doesNotMatch(html, /id="(?:model-button|thinking-button|model-value|thinking-value|agent-status)"|workbench-model/);
  assert.match(rule('.composer-settings'), /display: flex; flex: 1 1 auto; justify-content: flex-end; align-items: center/); assert.match(rule('.composer-model, .composer-thinking'), /min-height: 32px;[^}]*font-size: var\(--fs-meta\); white-space: nowrap/);
  assert.match(rule('.composer-meta'), /display: grid/);
  assert.doesNotMatch(css, /\.composer-model[^{}]*\{[^}]*min-width: 10ch/);
  assert.match(media('@media (pointer:coarse)'), /\.composer-model, \.composer-thinking, \.icon-button/);
  assert.equal((html.match(/<footer id="workbench-status"/g) ?? []).length, 1);
  assert.match(rule('.workbench-status'), /flex-wrap: wrap/); assert.match(rule('.workbench-version'), /margin-left: auto/);
  assert.match(rule('.workbench-status-facts'), /gap: var\(--s1\) var\(--s4\)/);
  assert.match(rule('.palette-row[data-source=app]'), /grid-template-columns: minmax\(0,36%\) minmax\(0,1fr\)/);
});
test('agent settings details preserve line boundaries without changing other footer text', () => {
  assert.equal(rule('#agent-settings-detail').trim(),'white-space: pre-line;');
  assert.match(rule('.composer-detail-body'),/overflow-wrap: anywhere/);
});
test('desktop status reserves controls and identity while only long text slots shorten', () => {
  const desktop=media('@media (min-width:1000px)');
  // The row wraps instead of drawing items over each other; only the activity text shrinks, with an ellipsis.
  assert.match(desktop,/\.workbench-status \{ flex-wrap: wrap;/);assert.doesNotMatch(desktop,/\.workbench-status \{[^}]*overflow:/);
  assert.match(desktop,/\.workbench-status-facts \{ flex: 0 1 auto; flex-wrap: wrap; min-width: min-content;/);assert.doesNotMatch(desktop,/\.workbench-status-facts \{[^}]*(flex: 1 1 0|nowrap)/);
  assert.match(desktop,/\.workbench-activity:has\(> \.workbench-activity-text\) \{ flex: 1 1 0; min-width: 10ch;/);
  // The name fills free space up to its text width and shortens with an ellipsis only when the row is full; the version never wraps. Both rules apply at every width.
  assert.doesNotMatch(desktop,/#workbench-scope \{/);assert.doesNotMatch(desktop,/\.workbench-version \{/);
  assert.match(rule('#workbench-scope'),/flex: 1 1 0;[^}]*min-width: 8ch;[^}]*max-width: max-content;[^}]*overflow: hidden; text-overflow: clip;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(rule('#workbench-scope'),/18ch|flex: none/);
  assert.match(rule('.workbench-version'),/flex: none;[^}]*max-width: none;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(rule('.workbench-version'),/font-family/);
  // Setting labels keep their full text; the update notice wraps, and scope and details give way when space runs short.
  assert.match(desktop,/\.workbench-update \{ flex: 0 1 auto; flex-wrap: wrap; white-space: normal; \}/);assert.match(desktop,/\.workbench-status \.composer-details \{ flex: none; max-width: none; \}/);
  assert.match(rule('.workbench-update'),/display: inline-flex; align-items: center; gap: var\(--s2\)/);
  assert.match(rule('.inspection-content button, .agent-inspection > button'),/padding: var\(--s1\) 0/);
  assert.match(desktop,/\.workbench-activity-state \{ flex: none;/);assert.match(desktop,/\.workbench-activity-text \{[^}]*text-overflow: clip;/);
  assert.match(desktop,/\.workbench-status:has\([^}]*workbench-draft-state[^}]*file-retained-drafts[^}]*control-attribution[^}]*\{ flex-wrap: wrap;/);
  assert.match(desktop,/\.workbench-activity\[data-notice=true\] \{[^}]*white-space: normal;/);
  assert.match(desktop,/\.workbench-status\[data-pane=file\] \{ flex-wrap: wrap;/);assert.match(desktop,/\.workbench-status\[data-pane=file\] > \.workbench-activity \{[^}]*white-space: normal;/);
  for(const id of ['primary-status-summary','primary-settings-detail','agent-status-summary','agent-settings-detail'])assert.match(html,new RegExp(`<p id="${id}"></p>`));
});
test('Durable picker choices use full-width native rows with wrapping state and shared focus', () => {
  assert.match(rule('.picker-durable-list'), /display: grid; grid-template-columns: minmax\(0,1fr\)/);
  const row = rule('.picker-durable-select'); assert.match(row, /display: grid; grid-template-columns: minmax\(0,1fr\); gap: var\(--s1\); width: 100%; min-width: 0; min-height: 44px/);
  assert.match(row, /text-align: left; white-space: normal/); assert.doesNotMatch(row, /(?:^|;)\s*height:|overflow: hidden/);
  assert.match(rule('.picker-durable-select .picker-session-heading'), /flex-wrap: wrap/);
  const text = rule('.picker-durable-select :is(.picker-session-title, .picker-session-tail, .picker-durable-state)');
  assert.match(text, /max-width: none; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere/);
  assert.match(rule('.picker-durable-select .picker-session-tail'), /max-width: 100%; flex: 0 1 auto/);
  assert.match(rule('.picker-durable-select .picker-session-meta'), /display: block; min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere/);
  assert.match(rule('.picker-durable-select:focus-visible'), /outline: 2px solid var\(--accent\); outline-offset: 2px/);
  assert.doesNotMatch(rule('.picker-durable-list'), /max-height:|overflow/);
});
test('results-first tool regions keep output and technical details inside local bounds', () => {
  const result = rule('.tool-result');
  assert.match(result, /min-width: 0; max-width: 100%/);
  assert.match(result, /min-height: 0; max-height: min\(480px,50dvh\); overflow: auto/);
  assert.doesNotMatch(result, /(?:^|;)\s*height:|overflow: hidden|line-clamp/);
  assert.match(rule('.tool-result:focus-visible'), /outline-offset: 2px/);
  assert.match(rule('.tool-expanded .tool-result pre'), /max-height: none/);
  assert.match(rule('.tool-output-actions'), /display: flex; flex-wrap: wrap/);
  assert.match(rule('.tool-details'), /min-width: 0; max-width: 100%/);
  assert.match(rule('.tool-expanded pre'), /max-height: 480px/);
  assert.match(rule('.tool-inspection > pre'), /max-height: 320px/);
  assert.match(rule('.tool-shell'), /box-sizing: border-box; width: 100%;/);
});
test('structured content uses readable prose, wrapped fields, compact tables and plain event disclosures', () => {
  assert.match(rule('.tool-document'), /min-width: 0; color: var\(--fg\); font-family: var\(--sans\)/);
  assert.match(rule('pre.tool-document'), /font-family: var\(--mono\)/, 'supplied argument text and plain-result fallbacks stay monospaced while document prose stays sans');
  const summary = rule('.tool-source > summary, .tool-metadata > summary, .tool-fact > summary, .tool-row-content > summary, .session-events > summary');
  assert.match(summary, /font-size: var\(--fs-meta\); overflow-wrap: anywhere/);
  assert.doesNotMatch(summary, /background:|border:|min-height:|max-height:|overflow: hidden/);
  assert.match(rule('summary::before'), /content: none/);
  assert.match(media('@media (pointer:coarse)'), /button, summary,[^{}]+\{ min-height: 44px; min-width: 44px/);
  assert.match(rule('.tool-source > pre'), /white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(rule('.tool-shell .kv'), /grid-template-columns: minmax\(6ch,max-content\) minmax\(0,1fr\)/);
  assert.match(rule('.tool-shell .kv > dt, .tool-shell .kv > dd'), /min-width: 0; white-space: pre-wrap/);
  assert.match(rule('.tool-shell .kv > dd'), /overflow-wrap: anywhere/);
  assert.match(rule('.tool-rows'), /max-width: 100%; overflow-x: auto/);
  assert.doesNotMatch(rule('.tool-rows'), /max-height:|overflow-y:|background:/);
  assert.match(rule('.tool-rows th'), /color: var\(--muted\); font-size: var\(--fs-meta\); font-weight: 600/);
  assert.match(rule('.tool-rows th, .tool-rows td'), /vertical-align: top; white-space: normal; overflow-wrap: normal/);
  assert.match(rule('.tool-record'), /min-width: 0; padding-left: var\(--s3\)/);
  assert.match(rule('.tool-record > * + *'), /margin-top: var\(--s2\)/);
  assert.match(rule('.tool-result-parts > .tool-result-part + .tool-result-part'), /margin-top: var\(--s2\)/);
  assert.doesNotMatch(rule('.tool-record'), /max-height:|overflow: hidden|text-overflow:|background:|border:/);
  assert.match(rule('.session-events > :not(summary)'), /margin-top: var\(--s2\); overflow-wrap: anywhere/);
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
test('compact message headers retain focus access and Copy output follows the result', async () => {
  assert.match(rule('.message.tool-only'), /margin: 0/); assert.match(rule('.tool-shell'), /margin: 0;/);
  const header = rule('.message:is(.thinking-only, .tool-only) > .message-header');
  assert.match(header, /position: absolute; top: 2px; right: 2px/); assert.doesNotMatch(header, /transform:/);
  assert.match(rule('.tool-output-actions'), /display: flex; flex-wrap: wrap/);
  assert.match(rule('.tool-output-actions > button'), /min-height: 24px/);
  assert.doesNotMatch(header, /display: none|overflow: hidden|bottom:/);
  assert.match(rule('.message:is(.thinking-only, .tool-only) > .message-body'), /margin-top: 0/);
  const renderer = await readFile(new URL('./render.ts', import.meta.url), 'utf8');
  assert.match(renderer, /actions\.append\(action\); expanded\.append\(resultArea, actions, technical\)/);
  assert.match(renderer, /action\.setAttribute\('aria-label', 'Copy tool output'\)/);
  assert.doesNotMatch(css, /padding-right: 184px|padding-top: 34px|padding-top: 54px/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /\.message:is\(\.thinking-only, \.tool-only\) > \.message-header \{ position: static; transform: none; min-height: 44px/);
});

test('ordinary role and actions share a stable header and compact actions retain focus access', async () => {
  const communication = await readFile(new URL('./communication.ts', import.meta.url), 'utf8');
  assert.match(rule('.message-header'), /display: flex; align-items: center; gap: var\(--s2\); min-width: 0; max-width: 100%; min-height: 24px/);
  assert.doesNotMatch(rule('.message-header'), /grid-template-columns:|background:|border:/);
  assert.match(rule('.message-role'), /flex: 0 1 auto; min-width: 0/);
  assert.match(rule('.communication-card'), /padding: 0; border: 0; background: transparent; font-family: var\(--sans\)/);
  assert.match(rule('.communication-header > .communication-sender'), /min-width: 0; max-width: 100%; overflow: hidden; text-overflow: clip;[^}]*white-space: nowrap/);
  assert.match(rule('.communication-card > .communication-body'), /font-size: var\(--fs-body\); line-height: 1\.65; font-weight: 400; font-style: normal/);
  assert.match(rule('.communication-kind, .extension-notice > .message-header > .message-role'), /color: var\(--peer-label\)/);
  assert.doesNotMatch(css, /\.communication-(?:time|trust|copy)\b[^{}]*\{/);
  assert.match(rule('.message-header + .message-body'), /margin-top: var\(--s1\)/);
  assert.match(rule('.message-actions'), /display: flex; flex: none;[^}]*min-height: 24px; margin-top: 0/);
  assert.doesNotMatch(rule('.message-actions'), /display: none|visibility: hidden/);
  assert.match(rule('.message-menu'), /min-width: 24px; min-height: 24px; font-size: var\(--fs-body\)/);
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
  assert.match(rule('.thinking'), /margin: 0/); assert.match(rule('.system-note, .custom-entry'), /margin: 0 0 var\(--s4\)/);
  assert.match(rule('.session-events > :not(summary)'), /margin-top: var\(--s2\)/);
  assert.doesNotMatch(rule('.entry.session-event-group'), /display: none|max-height:|overflow: hidden/);
});
test('the sidebar resizes through a persisted width and the column sits beside it at a fixed gutter', () => {
  assert.match(rule(':where(:root)'), /--read-width: 760px;/);
  assert.match(rule('.workbench'), /grid-template-columns: var\(--sidebar-width,280px\) minmax\(0,1fr\)/);
  assert.match(rule('.resizer[data-axis=x]'), /cursor: col-resize/);
  assert.match(rule('.resizer[data-axis=y]'), /cursor: row-resize/);
  assert.match(rule('.resizer:hover::after, .resizer[data-dragging=true]::after'), /opacity: 1/);
  assert.match(rule('.resizer:focus-visible::after'), /border-color: var\(--accent\)/);
  assert.match(rule('.agent-message-panel'), /height: var\(--panel-height, auto\)/);
  assert.doesNotMatch(rule('.composer textarea'), /max-height|--composer-height/);
  assert.match(rule('.conversation'), /--work-gutter: 24px/);
  assert.match(rule('.session-reader'), /--work-gutter: 24px/);
  assert.doesNotMatch(rule('.workspace'), /padding-left|margin-left/);
  assert.match(rule('.conversation > :not(.transcript-region)'), /width: calc\(100% - 2 \* var\(--work-gutter\)\); max-width: var\(--read-width\)/);
  assert.match(rule('.transcript > .entry, .transcript > button'), /width: 100%; max-width: var\(--read-width\)/);
  assert.doesNotMatch(css, /\.spacer[^{}]*\{[^}]*max-width: var\(--read-width\)/);
  assert.doesNotMatch(rule('.conversation'), /margin-inline: auto|margin: 0 auto|margin-left: auto; margin-right: auto/);
});
test('lean chrome: gutter-marked user turns, no pills, compact roster rows and no duplicate title band', () => {
  const user = rule('.message.user > .message-body');
  assert.doesNotMatch(user, /max-width|margin-left|float/);
  assert.match(user, /background: var\(--side\)/);
  assert.match(user, /border: 0; border-radius: var\(--r-lg\)/);
  assert.match(user, /padding: var\(--s2\) var\(--s3\)/);
  assert.match(user, /font-weight: 400/);
  assert.match(rule('.message.user > .message-body::before'), /content: "";[^}]*left: 0; border-left: 2px solid var\(--accent\)/);
  assert.doesNotMatch(css, /content: "You"/);
  const circles = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{[^{}]*border-radius: 50%;/g)].map(match => match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim());
  assert.deepEqual(circles, ['.row-state[data-busy=true]::before', '.workbench-activity[data-busy=true]::before', '.sidebar-content-row[data-unread=true] > .row-title::before']);
  for (const value of declarations('border-radius')) if (value !== '50%') assert.doesNotMatch(value, /999|50%|9999/);
  assert.match(rule('.communication-unverified'), /display: inline-flex;[^}]*align-items: center;[^}]*width: auto/);
  assert.match(rule('.communication-unverified > .card-action-label'), /white-space: nowrap/);
  assert.match(rule('.context-menu-item > .choice-check'), /top: 50%; left: 10px; margin-top: calc\(var\(--s1\) \* -2\)/);
  assert.match(rule('.nav-row, .row-select'), /height: 30px;[^}]*white-space: nowrap/);
  assert.match(rule('.row-age, .row-message'), /position: static; grid-row: 1/);
  assert.match(rule('.row-message'), /opacity: 0; pointer-events: none; color: var\(--muted\)/); assert.match(rule('.agent-row:is(:hover, :focus-within) > .row-message'), /opacity: 1; pointer-events: auto/);
  assert.doesNotMatch(css, /\.agent-row(?::hover|:focus-within)[^{]+> \.row-message/);
  assert.match(rule('.agent-row > .row-age'), /grid-column: 2; width: auto/);
  assert.match(rule('.agent-row .row-select'), /grid-column: 1 \/ -1; grid-row: 1;/);
  assert.doesNotMatch(css, /\.conversation-title-line|\.conversation-title\s*\{/);
  assert.doesNotMatch(html, /conversation-title-line|conversation-head|head-actions|header-band/);
  assert.match(rule('.pane-actions'), /display: inline-flex; flex: none;[^}]*min-width: 24px; min-height: 24px/);
  assert.doesNotMatch(html, /id="session-actions"|id="tabs-list"|id="tabs-split"/);
  assert.doesNotMatch(css, /\.tab-actions\s*\{|\.tab-overflow\s*\{/);
});
test('user paragraphs and lists use regular body weight while semantic headings retain emphasis', () => {
  assert.match(rule('.message.user > .message-body'), /font-weight: 400/);
  assert.match(rule('h1, h2, h3, h4, h5, h6, strong, th, b'), /font-weight: 600/);
  assert.match(rule('.markdown-content:is(h1)'), /font-size: var\(--fs-h1\)/);
  assert.doesNotMatch(css, /\.message\.user[^{}]*\s(?:p|li|ul|ol|h[1-6]|\*)[^{}]*\{[^}]*font-weight:/);
});
test('prose table cells wrap at words while wide data keeps horizontal scroll and intact cell values', () => {
  const prose = rule('.markdown-content th, .markdown-content td');
  assert.match(prose, /white-space: normal; overflow-wrap: normal/);
  assert.doesNotMatch(prose, /white-space: nowrap|overflow: hidden|text-overflow:|line-clamp/);
  assert.match(rule('.markdown-content:is(table)'), /display: block; max-width: 100%; overflow-x: auto/);
  assert.doesNotMatch(rule('.markdown-content:is(table)'), /table-layout: fixed|overflow-x: hidden/);
  assert.match(rule('.tool-rows th, .tool-rows td'), /white-space: normal; overflow-wrap: normal/);
  assert.match(rule('.tool-rows'), /max-width: 100%; overflow-x: auto/);
});
test('the writing surface groups Add and the required action below native text', () => {
  assert.match(rule('.composer-intake'), /display: inline-flex; flex: none; align-items: center/);
  assert.match(rule('.composer .attachment-sources'), /width: 32px; height: 32px; min-width: 32px; min-height: 32px/);
  assert.match(rule('.working-file-list'), /max-height: 36dvh; overflow: auto/);
  assert.match(rule('.working-file-row .file-name'), /white-space: normal; overflow-wrap: anywhere/);
  assert.match(rule('.composer-bar'), /margin-left: auto/);
  assert.match(rule('.composer-submit'), /flex: none; flex-wrap: nowrap/);
  assert.match(rule('.send, .stop'), /width: 36px; height: 36px; min-width: 36px; min-height: 36px; padding: 0; border: 0; border-radius: var\(--r-md\)/);
  assert.match(rule('.send'), /background: var\(--fg\); color: var\(--canvas\)/);
  assert.match(rule('.send:disabled'), /opacity: 1; background: color-mix\(in srgb, var\(--fg\) 14%, var\(--composer-fill\)\); color: var\(--muted\)/);
  assert.doesNotMatch(css, /\.send\[data-kind=recovery\]/);
  assert.match(rule('.composer-input'), /padding: var\(--s5\); border: 1px solid var\(--rule\); border-radius: var\(--r-lg\); background: var\(--composer-fill\)/);
  assert.match(rule('.composer'), /--composer-fill: color-mix\(in srgb, var\(--canvas\) 96%, var\(--fg\)\)/);
  assert.match(rule(':root[data-appearance=light] .composer'), /--composer-fill: color-mix\(in srgb, var\(--canvas\) 96%, var\(--fg\)\)/);
  assert.match(rule('.composer-line'), /min-height: 36px; margin-top: var\(--s4\)/);
  assert.match(rule('.start'), /width: auto; min-width: 82px; gap: var\(--s2\); padding: 0 var\(--s3\); font-size: var\(--fs-ui\); font-weight: 500; white-space: nowrap/);
});
test('narrow composer controls wrap only as needed and retain right alignment with unbroken control labels', () => {
  const narrow = [...css.matchAll(/@container conversation \(max-width: 480px\) \{([\s\S]*?)\n\}/g)].map(match => match[1]).join('\n');
  assert.match(rule('.composer-bar'), /flex-wrap: nowrap;[^}]*justify-content: flex-end/);
  assert.match(narrow, /\.composer-bar \{ justify-content: flex-end; \}/);
  assert.doesNotMatch(narrow, /\.composer-bar[^}]*flex-basis: 100%/);
  assert.doesNotMatch(css, /\.composer-bar[^{}]*\{[^}]*justify-content: (?:center|flex-start)/);
  assert.match(rule('.queue'), /flex: none;[^}]*white-space: nowrap/);
  assert.doesNotMatch(css, /\.queue[^{}]*\{[^}]*flex-wrap: wrap/);
  assert.match(rule('.send, .stop'), /flex: none;[^}]*width: 36px/);
  assert.match(rule(':focus-visible, .entry.own-message-focus, .thread-message.own-message-focus'), /outline: 2px solid var\(--accent\)/);
  assert.match(media('@media (pointer:coarse)'), /button, summary,[^{}]*\{ min-height: 44px; min-width: 44px; \}/);
  assert.doesNotMatch(narrow, /\.send[^{}]*\{[^}]*(?:display: none|overflow: hidden|min-width: 0)/);
});
test('working controls keep a quiet named Stop and visible delivery choices with wrapping guidance', () => {
  assert.doesNotMatch(css, /\.composer\[data-working=empty\][^{]*\.composer-submit/);
  assert.match(rule('.stop'), /width: auto; height: 32px;[^}]*background: transparent; color: var\(--muted\)/);
  assert.match(rule('.stop'), /gap: var\(--s2\); padding: 0 var\(--s2\)/);
  assert.match(rule('.send-named'), /width: auto; gap: var\(--s2\); padding: 0 var\(--s3\); font-size: var\(--fs-ui\)/);
  assert.match(rule('.queue'), /color: var\(--muted\)/);
  assert.match(rule('.composer-delivery-guidance .composer-state-label'), /overflow: visible; text-overflow: clip; white-space: normal/);
  assert.match(css, /@container composer \(max-width: 760px\)/);
  assert.match(rule('.composer-meta:has(.composer-delivery-guidance) > .composer-state'), /grid-column: 1 \/ -1; grid-row: 1/);
  assert.match(rule('.composer-settings'), /justify-content: flex-end/);
  assert.doesNotMatch(css, /\.modes\b/);
});
test('three direct utility controls retain named SVG slots and a separate unread badge', () => {
  const footer = html.match(/<footer class="sidebar-footer"[\s\S]*?<\/footer>/)?.[0]; assert.ok(footer);
  assert.equal([...footer.matchAll(/<button /g)].length, 3); assert.doesNotMatch(html, /id="app-menu"/);
  for (const [id, name, icon, title] of [['commands-button', 'Commands', 'commands', 'Commands'], ['notifications-button', 'Notices', 'notifications', 'Notices'], ['appearance-button', 'Theme', 'appearance', 'Theme']]) {
    const trigger = footer.match(new RegExp(`<button id="${id}"[\\s\\S]*?<\\/button>`))?.[0]; assert.ok(trigger);
    assert.match(trigger, new RegExp(`aria-label="${name}"`)); assert.match(trigger, new RegExp(`title="${title}"`));
    assert.match(trigger, /type="button"/); assert.match(trigger, /aria-haspopup="dialog"/); assert.match(trigger, new RegExp(`data-control-icon="${icon}"`));
  }
  assert.match(footer, /id="notices-count"[^>]*\shidden/);
  assert.match(rule('.sidebar-footer > .icon-button > .card-icon'), /margin-inline: var\(--s1\)/);
  assert.doesNotMatch(media('@media (pointer:coarse)'), /\.sidebar-footer > \.icon-button > \.card-icon\s*\{[^}]*margin-inline:/);
  assert.match(rule('.ui-icon'), /display: block;[^}]*width: 16px; height: 16px/);
  assert.match(rule('.icon-button'), /display: inline-flex;[^}]*min-width: 24px; height: 24px/);
  assert.doesNotMatch(css, /\.sidebar-footer \.ui-icon\s*\{/);
});
test('the status line holds the three utility controls in a quiet group before the conversation name', () => {
  const status = html.match(/<footer id="workbench-status"[\s\S]*?<\/footer>/)?.[0]; assert.ok(status);
  const group = status.match(/<div id="status-controls"[^>]*>/)?.[0]; assert.ok(group);
  assert.match(group, /class="status-controls"/); assert.match(group, /\shidden/); assert.match(group, /aria-label="Workbench controls"/);
  assert.ok(status.indexOf(group) < status.indexOf('id="workbench-scope"'));
  for (const id of ['commands-button', 'notifications-button', 'appearance-button']) assert.equal(status.includes(`id="${id}"`), false);
  assert.match(rule('.status-controls'), /display: flex; flex: none; align-items: center; gap: var\(--s1\)/);
  assert.match(rule('.status-controls[hidden]'), /display: none/);
  assert.match(rule('.status-controls > .icon-button'), /justify-content: flex-start; padding: 0 var\(--s1\)/);
  assert.doesNotMatch(rule('.status-controls'), /border|background/);
  assert.match(media('@media (pointer:coarse)'), /\.status-controls > \.icon-button > \.card-icon \{ margin-inline: var\(--s3\)/);
});
test('card actions and expanded content share fixed geometry without label-width drift', () => {
  assert.match(rule('.card-action'), /width: 24px; height: 24px; min-width: 24px; min-height: 24px/);
  assert.match(rule('.card-icon'), /width: 16px; height: 16px/);
  assert.match(rule('.tool-output-actions > button'), /min-height: 24px; padding: var\(--s1\) var\(--s1\); color: var\(--muted\)/);
  assert.match(rule('.tool-expanded'), /margin: var\(--s1\) 0 var\(--s2\) 0/);
  assert.match(rule('.tool-expanded .source-disclosure > summary.source-header'), /padding: var\(--s1\) var\(--s6\) var\(--s1\) 0/);
  assert.match(rule('button'), /border: 0; border-radius: var\(--r-sm\); background: transparent/);
});
test('tool titles share one line with a centered state icon inside the whole-card control', () => {
  const tier = rule('.tool-tier');
  assert.match(tier, /align-items: center; gap: var\(--s2\)/);
  assert.doesNotMatch(css, /\.tool-tier\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.doesNotMatch(tier, /justify-content: space-between/);
  assert.match(rule('.tool-secondary'), /padding-top: var\(--s1\)/);
  assert.match(rule('.tool-status'), /flex: none; color: var\(--muted\); font-size: var\(--fs-meta\)/);
  assert.match(rule('.tool-target'), /white-space: normal; overflow-wrap: anywhere/);
  assert.doesNotMatch(rule('.tool-target'), /line-clamp|text-overflow: ellipsis|overflow: hidden/);
});
test('partial output qualification shares the full tool summary width', () => {
  assert.match(rule('.tool-card > summary'), /grid-template-columns: minmax\(0,1fr\) auto/);
  assert.match(rule('.tool-card > summary > :is(.tool-preview, .tool-preview-qualification)'), /grid-column: 1 \/ -1/);
  assert.match(rule('.tool-card > summary > .tool-tier'), /grid-column: 1; grid-row: 1; min-width: 0/);
  assert.match(rule('.tool-preview-qualification'), /color: var\(--muted\);[^}]*font-size: var\(--fs-meta\)/);
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
  assert.match(factory, /const stop = element\('button', 'stop'\); stop\.id = `\$\{id\}-stop`; stop\.type = 'button'; stop\.hidden = true; paintAction\(stop, 'stop', 'Stop', true\)/);
  assert.match(factory, /const send = element\('button', 'send'\); send\.id = `\$\{id\}-send`; send\.type = 'submit'; send\.disabled = true; paintAction\(send, 'send', 'Send'\)/);
  assert.match(factory, /send\.setAttribute\('aria-label', 'Send message'\)/);
  assert.match(factory, /stop\.setAttribute\('aria-label', 'Stop response'\)/);
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
  assert.match(rule('.tool-tier'), /display: flex; flex-wrap: nowrap;[^}]*min-width: 0/);
  assert.match(rule('.tool-target'), /min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere/);
  assert.match(rule('.tool-preview.tool-error'), /color: var\(--error\)/);
  assert.match(rule('.message-actions'), /opacity: 0; pointer-events: none/);
  assert.doesNotMatch(rule('.message-actions'), /position: absolute|border:|background:/);
  assert.match(rule('.message-actions'), /min-height: 24px/);
  assert.match(rule('.message:hover > .message-header > .message-actions, .message:focus-within > .message-header > .message-actions'), /opacity: 1; pointer-events: auto/);
  assert.match(rule('.thinking > .stream-text'), /font-style: normal/);
});
test('machine-output boxes span the column without content-sized widths', () => {
  for (const selector of ['.tool-shell', '.tool-inspection', '.tool-expanded pre']) {
    const body = rule(selector);
    assert.match(body, /box-sizing: border-box;/, selector);
    assert.match(body, /(?:^|;)\s*width: 100%;/, selector);
    assert.doesNotMatch(body, /(?:^|;)\s*min-width:/, selector);
  }
  for (const selector of ['.tool-shell', '.tool-inspection', '.tool-expanded pre', '.communication-card', 'pre']) {
    assert.doesNotMatch(rule(selector), /fit-content|min-content|max-content|(?:^|;)\s*min-width:[^;]*(?:ch|em|rem)/, selector);
  }
  assert.match(rule('.message.user'), /width: fit-content; max-width: 100%;/);
  for (const selector of ['.thinking > summary, .system-note > details > summary, .custom-entry > details > summary, .facts-panel summary', '.tool-source > summary, .tool-metadata > summary, .tool-fact > summary, .tool-row-content > summary, .session-events > summary']) assert.match(rule(selector), /width: fit-content;/, selector);
});
test('expanded output retains bounded native scrollports with fixed gutters', () => {
  const output = rule('.tool-expanded pre');
  assert.match(output, /box-sizing: border-box; width: 100%; max-width: 100%; max-height: 480px/);
  assert.match(output, /padding: var\(--s2\) var\(--s3\); border: 0/);
  assert.match(output, /border-radius: var\(--r-sm\); background: var\(--code\)/);
  assert.match(rule('.tool-expanded'), /margin: var\(--s1\) 0 var\(--s2\) 0/);
  assert.match(rule('pre'), /line-height: 1\.55; white-space: pre-wrap; overflow-wrap: anywhere; overflow-x: hidden; overflow-y: auto/);
  assert.doesNotMatch(output, /(?:^|;\s*)(?:height|line-height):|padding-(?:top|bottom|block):|overflow(?:-y)?:|clip-path:|transform:|margin:/);
  assert.doesNotMatch(css, /\.tool-output-frame/);
});
test('the desktop Message panel stays outside the sidebar section flow and the roster scrolls', () => {
  assert.match(rule('.sidebar > *, .sidebar-scroll > *'), /flex-shrink: 0/);
  assert.match(rule('.sidebar-scroll'), /display: contents/);
  assert.match(rule('.sidebar-scroll > :is(.roster-section, .files-section)'), /flex: 1 1 0; min-height: calc\(32px \+ 5 \* 30px\)/);
  assert.match(rule('.roster'), /flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto/);
  assert.match(rule('.roster-body'), /display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0/);
  assert.match(rule('.roster-body > :not(.roster)'), /flex: none/);
  assert.match(rule('.agent-message-panel'), /flex: none;/);
});
test('responsive, short, coarse, reduced-motion and forced-color paths remain', () => {
  for (const width of [743, 599]) assert.ok(css.includes(`${width}px`));
  assert.match(css, /\.app\.drawer-open \.workbench > \.sidebar/);
  assert.match(media('@media (max-width:743px)'), /\.sidebar > \.resizer \{ display: none; \}/);
  assert.ok(media('@media (max-height:599px)').includes('.sidebar-scroll > :is(.roster-section, .files-section) { min-height: 28px; }'));
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
test('Find occupies app flow above status with visible coverage and compact controls', () => {
  assert.match(html, /<dialog id="modal"[\s\S]*?<\/dialog>\s*<footer[^>]*class="workbench-status/);
  assert.match(rule('dialog[open][data-variant=find]'), /position: relative; display: flex; flex: none/);
  assert.match(rule('dialog[open][data-variant=find]'), /max-height: 30dvh/);
  assert.match(rule('dialog[data-variant=find] #modal-body'), /flex-wrap: wrap/);
  assert.match(rule('dialog[data-variant=find] #modal-body > input'), /height: 24px/);
  assert.doesNotMatch(rule('dialog[data-variant=find] :is(.find-status, .find-coverage)'), /display: none|visibility: hidden/);
  assert.match(rule('dialog[data-variant=find] #modal-title'), /width: 1px; height: 1px/);
  assert.match(media('@media (pointer:coarse)'), /dialog\[data-variant=find\] #modal-body > input \{ min-height: 44px/);
});
test('short tool output spans the column and wrap controls retain reserved space', () => {
  assert.match(rule('.tool-expanded pre'), /width: 100%;[^}]*max-width: 100%/);
  assert.match(rule('.tool-inspection > .source-header + pre'), /padding-right: var\(--s6\)/);
  assert.match(rule('.tool-inspection > .source-header'), /opacity: 0/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /\.tool-inspection > \.source-header \{ opacity: 1/);
  assert.match(coarse, /\.tool-expanded details > summary \{ min-height: 44px/);
  assert.match(coarse, /\.card-action, \.section-toggle, \.attachment-row > button, \.source-header button\.card-action, \.source-disclosure > \.source-wrap\.card-action \{ min-height: 44px; min-width: 44px/);
});
test('Latest occupies the existing composer control line outside the transcript scrollport', async () => {
  assert.match(rule('.transcript-region'), /display: grid; grid-template-rows: minmax\(0,1fr\); flex: 1/);
  assert.match(rule('.transcript-region > .transcript'), /grid-area: 1 \/ 1; min-height: 0/);
  assert.doesNotMatch(css, /\.transcript-region > \.latest/);
  const latest = rule('.latest');
  assert.match(latest, /position: static; flex: none/);
  assert.doesNotMatch(latest, /position: absolute|bottom:|transform:|z-index:/);
  assert.match(latest, /display: inline-flex; align-items: center/);
  assert.match(latest, /gap: var\(--s1\)/);
  assert.match(latest, /margin: 0 0 0 var\(--s2\)/, 'the jump control stands apart from what precedes it');
  assert.match(css, /\.latest\[hidden\] \{ display: none/);
  assert.match(rule('.composer-intake > .latest'), /min-height: 32px; max-width: 140px; margin-left: var\(--s2\)/);
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /const scroller = add\('transcript', 'div', 'transcript'\)/);
  assert.match(app, /const latest = add\('latest', 'button', 'latest'\)/);
  assert.match(app, /region\.append\(absent, scroller\)/);
  assert.match(app, /elements\.sources\?\.after\(latest\)/, 'the jump control follows the intake control on the composer line');
  assert.doesNotMatch(html, /id="(?:primary|agent)-(?:transcript|latest)"/);
});
test('narrow composers reserve a permanent touch-sized Latest icon beside Add', () => {
  const start = css.indexOf('@container composer (max-width: 420px)');
  const compact = css.slice(start, css.indexOf('\n}', start));
  assert.ok(start >= 0);
  assert.match(compact, /\.composer-intake:has\(> \.latest\) \{ flex-basis: calc\(88px \+ var\(--s2\)\); \}/);
  assert.match(compact, /\.composer-intake > \.latest \{ width: 44px; min-width: 44px; min-height: 44px; justify-content: center; \}/);
  assert.match(compact, /\.composer-intake > \.latest > \.latest-text \{ display: none; \}/);
  assert.match(compact, /\.composer-line \{ flex-wrap: wrap; \}/);
  assert.doesNotMatch(compact, /:not\(\[hidden\]\)|:has\([^}]*:not/);
});
test('native text flow preserves scroll boundaries without line paint clipping', () => {
  assert.doesNotMatch(css, /data-rest-lines|rest-line-|clip-path:/);
  assert.match(rule('.pre-text-frame'), /display: block; min-width: 0/);
  assert.match(rule('.transcript > .entry'), /min-width: 0; overflow-wrap: anywhere/);
  assert.match(rule('.transcript :is(pre, table)'), /overscroll-behavior: contain/);
  assert.match(rule('.transcript :is(.message-body, .tool-content, .tool-expanded, .tool-result-part, .tool-record, .structured, details)'), /min-width: 0; max-width: 100%/);
});
test('editor and transcript share a centered bounded column without moving the native editor', () => {
  assert.match(rule('.conversation > :not(.transcript-region)'), /max-width: var\(--read-width\); margin-inline: auto/);
  assert.match(rule('.transcript'), /padding: var\(--s3\) var\(--work-gutter\)/);
  assert.match(css, /@container conversation \(max-width: 700px\)[\s\S]*?--work-gutter: 16px/);
  assert.match(rule('.transcript-region > .empty-state'), /left: 0; right: 0; width: calc\(100% - 2 \* var\(--work-gutter\)\); max-width: var\(--read-width\); margin-inline: auto/);
  assert.match(rule('.composer-input'), /padding: var\(--s5\); border: 1px solid/);
  assert.match(rule('.transcript > .entry, .transcript > button'), /max-width: var\(--read-width\); margin-inline: auto/);
  assert.match(rule('.composer textarea'), /padding: 0; border: 0/);
  for (const selector of ['.transcript', '.composer-input', '.composer textarea']) {
    assert.doesNotMatch(rule(selector), /margin-left: -|translateX|left: -/);
  }
});
test('exceptional tab state remains readable while names use bounded tab widths', () => {
  assert.match(rule('.tab-dot'), /flex: none/);
  assert.doesNotMatch(rule('.tab-dot'), /max-width:|overflow: hidden/);
  assert.doesNotMatch(rule('.conversation-state'), /max-width:|overflow: hidden/);
  assert.doesNotMatch(css, /\.tab-state\s*\{/);
  assert.match(rule('.conversation-tabs[data-sole=true] > .conversation-tab'), /flex: 0 1 400px/);
  assert.match(rule('.conversation-tabs'), /min-width: 0; overflow-x: auto/);
  assert.match(rule('.tab-label'), /flex: 1 1 auto/);
  assert.match(rule('.conversation-tab'), /overflow: hidden/);
  assert.match(rule('.tab-label'), /text-overflow: clip;[^}]*white-space: nowrap/);
  assert.match(rule('.tab-close'), /flex: none; width: 28px/);
});
test('neutral tabs and split panes retain 320px tracks with divider-aware equal-width defaults', async () => {
  const layout = await readFile(new URL('./pane-layout.ts', import.meta.url), 'utf8');
  assert.match(layout, /export const MIN_PANE_WIDTH = 320;/); assert.match(layout, /export const MIN_PANE_HEIGHT = 240;/); assert.match(layout, /export const PANE_DIVIDER = 4;/);
  assert.match(layout, /if \(node\.kind === 'pane'\) return \{width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT\}/);
  assert.match(rule('.conversation-tabs'), /min-width: 0; overflow-x: auto/);
  assert.match(rule('.tab-label'), /min-width: 0; overflow: hidden; text-overflow: clip;[^}]*white-space: nowrap/);
  assert.match(rule('.tab-dot'), /color: var\(--muted\)/);
  assert.doesNotMatch(rule('.tab-dot'), /background:|border:|border-radius:/);
  assert.match(rule('.conversation-tab[aria-selected=true]'), /background: transparent;[^}]*box-shadow: inset 0 -2px var\(--edge\)/);
  assert.match(rule('.conversation-tab[aria-selected=true] .tab-close, .conversation-tab:hover .tab-close, .conversation-tab:focus-within .tab-close'), /opacity: 1/);
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
  assert.match(rule('.composer-bar'), /flex-wrap: nowrap/);
  assert.match(media('@media (forced-colors:active)'), /\.conversation-tab\[aria-selected=true\][^{]*\{ outline: 2px solid Highlight/);
});
test('long tab names ellipsize without crowding their status and close action', () => {
  const tab = rule('.conversation-tab');
  assert.match(tab, /flex: 0 1 auto/);
  assert.match(tab, /min-width: 120px; max-width: 400px/);
  assert.match(rule('.tab-label'), /flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: clip/);
  assert.match(rule('.tab-dot'), /flex: none;[^}]*white-space: nowrap/);
  assert.match(media('@media (pointer:coarse)'), /\.conversation-tab \{ --tab-chrome: 90px; \}/);
  assert.match(rule('.conversation-tabs'), /scrollbar-color: transparent transparent/);
  assert.match(rule('.tab-close'), /flex: none/);
  assert.match(rule('.conversation-tabs'), /overflow-x: auto/);
  assert.match(rule('.conversation-tab[aria-selected=true] .tab-close, .conversation-tab:hover .tab-close, .conversation-tab:focus-within .tab-close'), /opacity: 1/);
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /button, summary,[^{}]*\{ min-height: 44px; min-width: 44px; \}/);
  assert.match(coarse, /\.tab-close \{ opacity: 1; \}/);
});
test('one workbench footer owns wrapped facts while settings sit on the composer shelf', async () => {
  assert.match(rule('.workbench-status'), /display: flex;[^}]*flex-wrap: wrap/);
  assert.match(rule('.workbench-status'), /font-size: var\(--fs-meta\); line-height: 1\.5;/);
  assert.match(rule('.workbench-status-facts'), /flex-wrap: wrap/);
  assert.equal([...html.matchAll(/<footer id="workbench-status"/g)].length, 1);
  assert.equal([...html.matchAll(/id="focused-composer-status" class="workbench-draft-state"/g)].length, 1);
  assert.ok(html.indexOf('<footer id="workbench-status"') > html.indexOf('</main>'));
  const composer = await readFile(new URL('./composer.ts', import.meta.url), 'utf8');
  const factory = composer.slice(composer.indexOf('export function createComposerElements('), composer.indexOf('\ntype Edit ='));
  assert.match(factory, /const root = element\('form', 'composer'\); root\.id = id/);
  assert.match(factory, /const id = `composer-\$\{encodeURIComponent\(instanceId\)\}`/);
  assert.match(factory, /root\.append\(receipt, utilities, input, meta, queueGuidance\)/);
  assert.match(factory, /const queueGuidance = element\('span', 'sr-only', queueDescription\)/);
  assert.match(factory, /submit\.append\(queue, start, send\)/);
  assert.match(factory, /bar\.append\(submit\)/);
  assert.match(factory, /intake\.append\(attach,sources,picker\)/);
  assert.match(factory, /line\.append\(intake, stop, settings, bar\)/);
  assert.doesNotMatch(factory, /usage-details|workbench-status-facts|root\.append\([^)]*\b(?:save|receiptDetails)\b/);
  assert.doesNotMatch(html, /<form id="(?:primary|agent)-composer"/);
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /const slot = byId\('focused-composer-status'\), nodes = controller \? \[controller\.elements\.save, controller\.elements\.receiptDetails\] : \[\]/);
  assert.match(app, /slot\.replaceChildren\(\.\.\.nodes\)/);
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
  for (const id of ['project-button','compact-project-button','commands-button','notifications-button','appearance-button','connection','primary-usage']) assert.equal([...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length, 1, id);
});

test('supplied roles stay inline metadata and expanded thinking separates from prose only', () => {
  const role = rule('.message-role'); assert.match(role, /font-size: var\(--fs-meta\); line-height: 18px; font-weight: 500/);
  assert.match(role, /min-width: 0; overflow: hidden; color: var\(--muted\)/);
  assert.doesNotMatch(role, /display:|grid|border|background|padding|margin/);
  assert.equal(rule('.message-body > .thinking[open] + :not(.tool-shell):not(.message-coverage)').trim(), 'margin-top: var(--s4);');
  assert.match(rule('.message-body > .thinking + *'), /margin-top: var\(--s2\)/);
  assert.match(rule('.message.tool-only > .message-body > .thinking + .tool-shell'), /margin-top: var\(--s2\)/);
});

test('focus marks the actual editor and its local split identity without changing placement', () => {
  assert.match(rule('.composer textarea:focus-visible'), /outline: none/);
  assert.match(rule('.composer-input:has(textarea:focus-visible)'), /border-color: var\(--border-strong\); outline: none; box-shadow: none/);
  assert.match(rule('.composer-input'), /border: 1px solid var\(--rule\)/);
  assert.match(rule('.pane-leaf[data-focused=true] > .tab-bar .conversation-tab[aria-selected=true]'), /box-shadow: inset 0 -2px var\(--accent\)/);
  assert.doesNotMatch(css, /\.pane-heading/);
});

test('recovery controls are bounded buttons and a ready Message panel reserves no status row', () => {
  assert.match(rule('.connection-banner button'), /border: 0/);
  assert.match(rule('.message-panel-status > button'), /border: 0/);
  assert.match(rule('.message-panel-status:has(> span:empty):has(> button[hidden])'), /display: none/);
});

test('the local shell has no sign-in or access view', () => {
  assert.doesNotMatch(html, /access-view|access-title|access-retry|not signed in/);
  assert.doesNotMatch(css, /\.access-view/);
});

test('footer metadata keeps scoped groups and native details outside the composers', async () => {
  assert.match(rule('.usage-group'), /display: inline-flex;[^}]*gap: var\(--s1\); white-space: nowrap/);
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
  assert.match(rule('.transcript-image-caption'), /color: var\(--muted\); font-family: var\(--sans\); font-size: var\(--fs-meta\)/);
  assert.match(rule('.transcript-image-status'), /color: var\(--fg\)/);
  assert.match(rule('.transcript-image button'), /border: 0/);
  assert.doesNotMatch(rule('.transcript-image button'), /min-height:|opacity:|display: none/);
});
test('both themes use blue focus, never lavender or mauve', () => {
  const focus: Record<string, string> = {':where(:root)': '#9dbcf5', ':where(:root[data-appearance=light])': '#1d5f7e', ':where(:root[data-appearance=system])': '#1d5f7e'};
  for (const [selector, color] of Object.entries(focus)) assert.match(rule(selector), new RegExp(`--accent: ${color};`));
  for (const selector of Object.keys(focus)) {const accent=/--accent: (#[a-f0-9]{6});/i.exec(rule(selector))?.[1]; assert.ok(accent);assert.ok(Number.parseInt(accent.slice(5,7),16)>Number.parseInt(accent.slice(1,3),16),selector);}
});
test('dark is the base set and light is explicit and under the OS light preference', () => {
  assert.match(rule(':where(:root)'), /color-scheme: dark;/);
  assert.match(rule(':where(:root[data-appearance=light])'), /color-scheme: light;/);
  assert.match(rule(':where(:root[data-appearance=system])'), /color-scheme: light;/);
  assert.match(css, /@media \(prefers-color-scheme: light\) \{\s*:where\(:root\[data-appearance=system\]\)/);
});

test('mixed thinking and tool turns use compact spacing and raw inspections have one scroll owner', () => {
  assert.match(rule('.message-body > .thinking + *'), /margin-top: var\(--s2\)/);
  assert.match(rule('.message.tool-only > .message-body > .thinking'), /margin: 0/);
  assert.match(rule('.message.tool-only > .message-body > .thinking + .tool-shell'), /margin-top: var\(--s2\)/);
  assert.match(rule('.tool-inspection > pre'), /max-height: 320px/);
  assert.doesNotMatch(css, /\.tool-inspection\s*\{[^}]*overflow|max-height:[^}]*\.tool-inspection/);
});

test('navigation identities stay separate from ellipsis and overflow controls remain quiet', () => {
  assert.match(rule('.tab-identity'), /flex: 0 1 auto;.*max-width: 40%;.*font-size: var\(--fs-code\)/);
  assert.match(rule('.pane-actions'), /display: inline-flex; flex: none;[^}]*min-width: 24px; min-height: 24px;[^}]*color: var\(--muted\)/);
  assert.match(rule('.pane-actions:hover, .pane-actions[aria-expanded=true]'), /background: var\(--raised\); color: var\(--fg\)/);
  assert.doesNotMatch(rule('.pane-actions'), /overflow: hidden|text-overflow:|display: none/);
  assert.doesNotMatch(css, /\.tab-overflow\s*\{/);
  assert.match(rule('.conversation-tab.tab-dragging'), /background: var\(--raised\); border-top-color: var\(--edge\)/);
  assert.match(rule('.palette-title'), /overflow: hidden; text-overflow: clip/);
  assert.match(rule('.palette-identity'), /flex: none/);
  assert.match(rule('.palette-row[data-kind=conversation]'), /grid-template-columns: minmax\(0,1fr\) auto/);
  assert.match(rule('.picker-select'), /flex-direction: column/);
  assert.match(rule('.picker-session-tail'), /flex: none/);
  assert.match(rule('.picker-select .identity'), /overflow-wrap: anywhere/);
  assert.match(rule('.palette-row:hover'), /background: var\(--canvas\)/);
  assert.match(rule('.command-option:hover, .command-option[aria-selected=true]'), /background: var\(--menu-hover\)/);
});
test('the document selects the same-origin SVG favicon', () => {
  assert.match(html, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/);
});

test('drawer and overflow controls share accessible inline stroke icons', async () => {
  const button = html.match(/<button id="sidebar-close"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(button, /data-control-icon="navigation"/); assert.match(button, /aria-label="Hide sidebar"/);
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.equal([...app.matchAll(/const plus = cardAction\('plus'/g)].length, 1);
  assert.match(app, /cardAction\('plus', 'New tab', \(\) => choosePaneTarget\(leaf\.id\)/);
  assert.match(app, /plus\.setAttribute\('aria-haspopup', 'dialog'\)/);
  assert.match(app, /cardAction\('chevron', 'Tabs in this pane'/);
  assert.match(app, /bar\.append\(previous, next, tabs, plus, menu, actions\); node\.append\(bar, content\)/);
  assert.match(rule('.pane-menu > .card-icon'), /transform: rotate\(90deg\)/);
  assert.match(app, /cardAction\('previous', 'Previous tab'/); assert.match(app, /cardAction\('next', 'Next tab'/);
  assert.match(rule('.pane-actions'), /align-items: center; justify-content: center; min-width: 24px; min-height: 24px/);
  assert.match(media('@media (pointer:coarse)'), /\.message-menu, \.communication-unverified, \.message-source-close, \.pane-actions, \.context-menu > \.context-menu-item \{ min-height: 44px; min-width: 44px; \}/);
  assert.doesNotMatch(html, /id="tabs-list"|id="tabs-split"/);
  assert.doesNotMatch(css, /\.tab-overflow\s*\{|\.tab-actions\s*\{/);
});

test('the composer uses shared SVG selectors and visible effort at narrow widths', () => {
  assert.doesNotMatch(css, /\.composer-state::before|\.composer-model:not\(:disabled\)::after/);
  assert.match(rule('.composer-model, .composer-thinking'), /display: inline-flex; align-items: center/);
  assert.match(rule('.composer-setting-label'), /overflow: hidden; text-overflow: clip/);
  assert.match(rule('.composer-settings .card-icon-chevron'), /width: 12px; height: 12px/);
  assert.match(rule('.composer-settings'), /gap: var\(--s2\)/);
  assert.doesNotMatch(css, /\.composer-settings-text[^{}]*::after|\.composer-settings-effort[^{}]*::after/);
  assert.match(rule('.composer .attachment-sources'), /color: var\(--fg\)/);
  assert.doesNotMatch(css, /\.composer-thinking, \.composer-settings-effort \{ display: none/);
  assert.match(css, /@container composer \(max-width: 420px\) \{\s*\.composer-line \{ flex-wrap: wrap; \}/);
  assert.match(rule('.composer-settings'), /min-width: 0; max-width: 100%/);
});
test('empty composer regions collapse and plain intake/settings retain focus and open-state feedback', () => {
  assert.match(rule('.composer-utilities:not(:has(.composer-recall:not([hidden])))'), /display: none/);
  assert.match(rule('.composer-meta:not(:has(.composer-state:not([hidden]):not(.sr-only), .composer-state-details:not([hidden])))'), /display: none/);
  assert.match(rule('.composer .attachment-sources'), /background: transparent/);
  assert.match(rule('.composer .attachment-sources:hover:not(:disabled), .composer .attachment-sources[aria-expanded=true]:not(:disabled)'), /var\(--fg\) 2%, transparent/);
  for (const selector of ['.composer-model, .composer-thinking', '.composer-settings :is(.composer-model, .composer-thinking):not(:disabled):is(:hover,[aria-expanded=true])']) assert.match(rule(selector), /background: transparent/);
  assert.match(rule('.composer textarea'), /min-height: 26px;[^}]*font-size: var\(--fs-body\); line-height: 1\.65/);
  assert.doesNotMatch(rule('.composer-input'), /(?:^|;)\s*(?:min-)?height:/);
});
test('composer utilities share the column edges and keep expanded errors inside the pane', () => {
  assert.match(rule('.composer-utilities'), /display: grid; grid-template-columns: minmax\(0,1fr\) auto;[^}]*padding: 0;/);
  assert.match(rule('.composer-meta'), /padding: var\(--s2\) var\(--s5\) 0/);
  assert.match(rule('.composer-meta > .composer-state'), /grid-column: 1; grid-row: 1/);
  assert.match(rule('.composer-intake:has(> .latest)'), /flex-basis: 180px; max-width: 100%/);
  assert.match(rule('.composer-recall'), /grid-column: 1; grid-row: 1/);
  assert.match(rule('.composer-state-details'), /grid-column: 1 \/ -1/);
  assert.match(rule('.composer-state-details'), /overflow: auto;[^}]*white-space: pre-wrap; overflow-wrap: anywhere/);
  assert.match(rule('.composer .attachment-sources:disabled'), /background: transparent; color: var\(--dim\); opacity: \.55/);
  assert.doesNotMatch(css, /\.attachment-sources:hover(?!:not\(:disabled\))/);
});
test('the history note and composer state are plain lines with flat actions', () => {
  assert.match(rule('.history-note'), /flex: none/); assert.match(rule('.history-note > p'), /font-weight: 400/);
  assert.match(rule('.history-note'), /display: flex; flex: none; flex-wrap: wrap/);
  assert.match(rule('.history-note > button, #agent-message-retry'), /border: 0; border-radius: 0/);
  assert.doesNotMatch(rule('.history-note > button, #agent-message-retry'), /box-shadow|background/); assert.doesNotMatch(css, /agent-start-help|agent-absent|\.agent-state/);
  assert.match(rule('.composer-state'), /display: flex; flex: 1 1 auto; flex-wrap: nowrap; align-items: center/); assert.doesNotMatch(rule('.composer-state'), /background|box-shadow|border/);
  assert.match(rule('.composer-state-label'), /overflow: hidden; text-overflow: clip; mask-image: linear-gradient\([^;]*\); white-space: nowrap/); assert.doesNotMatch(css, /\.composer-state-line \{/);
  assert.match(rule('.conversation'), /display: flex; flex-direction: column;[^}]*min-height: 0/);
  assert.match(rule('.transcript-region'), /display: grid; grid-template-rows: minmax\(0,1fr\); flex: 1;[^}]*min-height: 0/);
  assert.doesNotMatch(css, /\.conversation\.agent-empty > \.transcript-region\s*\{/);
  assert.match(rule('.composer'), /flex: none/);
  assert.match(rule('.conversation.agent-empty .transcript'), /padding-block: 0/);
  assert.match(rule('.transcript-region > .empty-state'), /position: absolute/);
});

test('Message connection recovery shares flat state actions and retains native focus', () => {
  const action = rule('.history-note > button, #agent-message-retry');
  assert.match(action, /padding: var\(--s1\) 0; border: 0; border-radius: 0/);
  assert.doesNotMatch(action, /outline|box-shadow|background/);
  assert.match(rule(':focus-visible, .entry.own-message-focus, .thread-message.own-message-focus'), /outline: 2px solid var\(--accent\)/);
  assert.match(html, /id="agent-message-retry" type="button"/);
});

test('the sidebar footer stays at the bottom without a heavy separator', () => {
  assert.equal([...css.matchAll(/^\.sidebar-footer \{/gm)].length, 2); assert.match(css, /^\.sidebar-footer \{ display: grid; grid-template-columns: repeat\(3,auto\); justify-content: space-between; gap: var\(--s1\); \}/m);
  assert.match(rule('.sidebar-footer'), /align-items: center; gap: var\(--s1\); margin-top: auto; padding: var\(--s1\) var\(--s2\) 0/); assert.doesNotMatch(rule('.sidebar-footer'), /border-top:/);
});

test('coarse sidebar footer icons keep compact margins after later declarations', () => {
  const margins = [...css.matchAll(/(?:^|\n)\s*\.sidebar-footer > \.icon-button > \.card-icon\s*\{([^}]+)\}/g)]
    .flatMap(match => [...match[1].matchAll(/(?:^|;)\s*margin-inline:\s*([^;]+)/g)].map(declaration => declaration[1].trim()));
  assert.ok(margins.length > 0, 'Footer icon margins exist');
  assert.equal(margins.at(-1), 'var(--s1)', 'The effective coarse margin must retain the compact base value');
  assert.match(rule(':where(:root)'), /--s1: 4px;/);
  assert.match(media('@media (pointer:coarse)'), /\.status-controls > \.icon-button > \.card-icon \{ margin-inline: var\(--s3\); \}/);
});

test('the visible sidebar leads with its panel toggle at the same inset and inherits coarse pointer targets', () => {
  assert.match(rule('.sidebar-close'), /display: inline-flex/);
  assert.match(rule('.nav-top'), /padding: 0 var\(--s2\) 0 var\(--s2\)/); assert.match(rule('.navigation-access'), /padding: 0 var\(--s2\)/);
  assert.match(html, /id="sidebar-close" class="icon-button sidebar-close"[^>]+aria-label="Hide sidebar"/);
  assert.match(media('@media (max-width:743px)'), /\.sidebar-close \{ display: inline-flex/);
  assert.match(rule('.icon-button'), /width: 24px; height: 24px/);
  assert.match(media('@media (pointer:coarse)'), /min-height: 44px; min-width: 44px/);
});

test('source headers reserve controls outside local wrap scrollports and preserve diff line flow', () => {
  assert.match(rule('.source-header'), /display: flex/);
  assert.doesNotMatch(rule('.source-header button, .source-disclosure > .source-wrap'), /position: absolute|opacity:/);
  assert.match(rule('pre[data-wrap=false], .tool-source > pre[data-wrap=false]'), /white-space: pre; overflow-wrap: normal; overflow-x: auto/);
  assert.match(rule('pre'), /white-space: pre-wrap/);
  assert.doesNotMatch(rule('.diff-del, .diff-add'), /box-decoration-break/);
});
test('dialog word-button chrome never changes shared SVG action geometry', () => {
  const words = rule('#modal-body > button:not(.card-action, .icon-button), .dialog-actions > button:not(.card-action, .icon-button), .picker-project-actions > button:not(.card-action, .icon-button)');
  assert.match(words, /padding: var\(--s1\) var\(--s3\); border: 0/);
  assert.doesNotMatch(css, /(?:#modal-body|\.dialog-actions|\.picker-project-actions) > button(?:\s*,[^{}]+)?\s*\{[^}]*border:/);
  assert.match(rule('.card-action'), /padding: 0; border: 0/);
  assert.match(rule('.icon-button'), /min-width: 24px; height: 24px; padding: 0 var\(--s1\)/);
  assert.match(rule(':focus-visible, .entry.own-message-focus, .thread-message.own-message-focus'), /outline: 2px solid var\(--accent\)/);
});
test('primary history details and retry share a flat wrapping action row', () => {
  assert.match(rule('.history-actions'), /display: flex; flex-wrap: wrap; align-items: flex-start; gap: var\(--s1\) var\(--s3\)/);
  assert.match(rule('.history-actions > .history-details'), /min-width: 0; max-width: calc\(100% - 40px\)/);
  assert.match(rule('.history-actions > .card-action'), /flex: none/);
});
test('coarse roster timestamps and Message actions own disjoint columns at every roster width', () => {
  const coarse = media('@media (pointer:coarse)');
  assert.match(coarse, /\.agent-row:is\(\[data-action=message\],\[data-action=resume\]\) \{ grid-template-columns: minmax\(0,1fr\) max-content 44px/);
  assert.match(coarse, /\.agent-row > \.row-age \{ min-height: 44px/);
  assert.match(coarse, /\.agent-row > \.row-message \{ width: 44px; height: 44px/);
  assert.doesNotMatch(coarse, /\.agent-row > \.row-select|padding-right: var\(--s2\)/);
  assert.match(rule('.row-age time'), /overflow: hidden; text-overflow: clip;[^}]*white-space: nowrap/);
  assert.doesNotMatch(coarse, /visibility: hidden/);
});
test('source disclosure controls occupy the caption row without entering its click target', () => {
  assert.match(rule('.source-disclosure'), /position: relative/);
  assert.match(rule('.source-disclosure > summary.source-header'), /width: 100%; min-height: 29px; padding: var\(--s1\) var\(--s7\) var\(--s1\) var\(--s2\)/);
  assert.match(rule('.source-disclosure > .source-wrap'), /position: absolute; top: 2px; right: 6px/);
  assert.match(media('@media (pointer:coarse)'), /\.source-disclosure > summary\.source-header \{ min-height: 49px/);
  assert.doesNotMatch(rule('.source-disclosure'), /overflow|max-height/);
});
test('empty-session guidance has a distinct heading and caption inside the transcript region', async () => {
  const app = await readFile(new URL('./app.ts', import.meta.url), 'utf8');
  assert.match(app, /const region = element\('div', 'transcript-region'\); const absent = add\('empty', 'div', 'empty-state'\)/);
  assert.match(app, /absent\.append\(add\('empty-heading', 'h2'\), add\('empty-caption', 'p'\)\)/);
  assert.match(app, /region\.append\(absent, scroller\)/);
  assert.doesNotMatch(html, /id="primary-empty"|id="primary-empty-heading"|id="primary-empty-caption"/);
  assert.match(rule('.transcript-region'), /position: relative/);
  assert.match(rule('.transcript-region > .empty-state'), /position: absolute; top: 0; left: 0; right: 0/);
  assert.match(rule('.conversation > .transcript-region > .empty-state'), /grid-area: 1 \/ 1; align-self: start; padding-top: var\(--s5\)/);
  assert.match(rule('.conversation > .transcript-region > .empty-state > h2'), /color: var\(--fg\); font-size: var\(--fs-title\); font-weight: 600/);
  assert.match(rule('.conversation > .transcript-region > .empty-state > p:not(:empty)'), /margin-top: var\(--s2\); font-size: var\(--fs-ui\)/);
  assert.doesNotMatch(css, /#primary-empty\b/);
});

test('message coverage stays subordinate without restoring turn-sized margins', () => {
  assert.match(rule('.message-body > .secondary.message-coverage'), /margin: var\(--s1\) 0 0; font-size: var\(--fs-meta\); line-height: 18px; color: var\(--muted\)/);
});

test('prose fills the shared reading column without shrinking technical blocks', () => {
  assert.match(rule('.markdown-content:is(p, ul, ol, blockquote)'), /max-width: 100%/);
  assert.doesNotMatch(rule('.code-block'), /600px/);
  assert.doesNotMatch(rule('.markdown-content:is(table)'), /600px/);
  assert.match(rule('.message-body'), /font-size: var\(--fs-body\); line-height: 1\.65/);
});
test('Markdown file previews centre a bounded column without narrowing source editors or removing local scrolling', () => {
  const preview = rule('.file-content');
  assert.match(preview, /max-width: var\(--read-width\);/);
  assert.match(preview, /(?:^|;)\s*width: 100%;/);
  assert.match(preview, /margin-inline: auto;/);
  assert.match(preview, /font-size: var\(--fs-body\); line-height: 1\.65;/);
  assert.match(rule('.file-view'), /padding: 0 var\(--gutter\);/);
  const source = rule('.file-editor');
  assert.match(source, /width: 100%;/);
  assert.match(source, /white-space: pre; overflow: auto;/);
  assert.doesNotMatch(source, /max-width:/);
  assert.match(rule('.file-content pre'), /overflow: auto;/);
  assert.match(rule('.markdown-content:is(table)'), /overflow-x: auto;/);
});

test('phone drawer sections keep usable content inside one outer scroll owner', () => {
  const phone = media('@media (max-width:599px)');
  assert.match(phone,/\.app\.drawer-open \.sidebar-scroll \{ display: block; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain/);
  assert.match(phone,/\.app\.drawer-open \.files-section \{ flex: none; max-height: none; min-height: 0/);
  assert.match(phone,/\.app\.drawer-open #files-section-body \{ overflow: visible/);
  assert.match(phone,/\.app\.drawer-open \.sidebar-scroll > \.roster-section \{ flex: none/);
  assert.match(phone,/\.app\.drawer-open \.roster \{ flex: none; min-height: 44px; max-height: 50dvh/);
  const sectionEnd = html.indexOf('</div>\n<section id="agent-message-panel"');
  assert.ok(html.indexOf('<div class="sidebar-scroll">') < html.indexOf('id="sidebar-conversations"'));
  assert.match(rule('.nav-heading-row'), /height: 28px/);
  assert.ok(sectionEnd > html.indexOf('id="roster-section"'));
  assert.ok(sectionEnd < html.indexOf('class="sidebar-footer"'));
});
test('phone footer keeps direct settings and identity while full facts stay in the existing disclosure', () => {
  const phone = media('@media (max-width:599px)');
  assert.match(phone,/\.workbench-status > \.workbench-status-facts \{ display: contents/);
  assert.doesNotMatch(phone,/\.composer-meta \{|\.composer-settings \{/);
  assert.doesNotMatch(css, /\.composer-thinking, \.composer-settings-effort \{ display: none; \}/);
  assert.match(phone,/\.composer-details > summary > span:not\(\.composer-details-label\) \{ display: none/);
  assert.match(phone,/\.composer-details-label \{[^}]*min-width: 44px; min-height: 44px/);
  assert.match(phone,/\.workbench-status \.workbench-version \{ max-width: 14ch; overflow: hidden; text-overflow: clip;[^}]*white-space: nowrap/);
  assert.match(phone,/\.workbench-activity\[data-notice=true\] \{ display: block/);
  for(const id of ['primary-status-summary','agent-status-summary','agent-settings-detail']) assert.match(html,new RegExp(`<p id="${id}"></p>`));
  assert.doesNotMatch(css, /\.phone-status-facts/);
});
test('phone chrome removes redundant tab arrows and coarse tree names retain explicit touch controls', () => {
  const phone = media('@media (max-width:599px)'),coarse = media('@media (pointer:coarse)');
  assert.match(phone,/\.tab-bar > \.pane-tab-nav, \.navigation-access > \.compact-project-context, \.navigation-access > \.compact-project-button \{ display: none/);
  assert.match(coarse,/\.conversation-row \{ min-height: 44px; align-items: center/);
  assert.match(coarse,/\.file-name-input \{ min-height: 44px/);
  assert.match(coarse,/\.file-name-actions \{ display: inline-flex/);
  assert.match(rule('.file-name-actions'),/display: none/);
  assert.match(html,/viewport-fit=cover/);
  for(const edge of ['top','right','bottom','left'])assert.ok(rule('body').includes(`env(safe-area-inset-${edge})`));
  assert.match(rule('body'),/height: var\(--app-height, 100dvh\)/);
});
test('slash rows use the composer container and full-width descriptions at narrow pane widths', () => {
  const start = css.indexOf('@container composer (max-width: 540px)'); assert.ok(start >= 0);
  const rows = css.slice(start, css.indexOf('.command-empty', start));
  assert.match(rows, /\.command-source \{ grid-column: 2; grid-row: 1/);
  assert.match(rows, /\.command-desc \{ grid-column: 1 \/ -1; grid-row: 2; white-space: normal; overflow: visible/);
});

test('tool titles weigh more than their regular-weight supporting text', () => {
  assert.match(rule('.tool-name'), /color: inherit;[^}]*font-weight: 500; line-height: 24px/);
  assert.match(rule('.tool-shell'), /font-family: var\(--sans\); font-size: var\(--fs-ui\)/);
  assert.match(rule('.tool-card > summary'), /align-items: baseline/);
});
test('thinking keeps one quiet tier for streaming text and completed Markdown', () => {
  assert.match(rule('.thinking-content'), /color: var\(--muted\); font-size: var\(--fs-ui\); line-height: 1\.65/);
  assert.match(rule('.thinking > .stream-text'), /color: var\(--muted\); font-size: var\(--fs-ui\); line-height: 1\.65/);
  assert.match(rule('.thinking .thinking-content :is(strong, em)'), /color: inherit/);
  assert.equal(rule('.thinking .thinking-content .markdown-inline-code').trim(), 'color: inherit;');
  assert.equal(rule('.thinking .thinking-content .code-block > pre > code').trim(), 'color: inherit;');
  assert.doesNotMatch(css, /\.thinking[^{}]*\.syn-[^{}]*\{/);
  assert.match(rule('.thinking .thinking-content strong'), /font-weight: 500/);
  const heading = rule('.thinking .thinking-content .markdown-content:is(h1, h2, h3, h4, h5, h6)');
  assert.match(heading, /color: inherit; font-size: inherit; line-height: inherit; font-weight: 500/);
  assert.match(rule('.thinking .thinking-content .markdown-content:is(h1, h2, h3, h4, h5, h6):first-child'), /margin-top: 0/);
  assert.match(rule('.markdown-content strong'), /color: var\(--fg\)/);
  assert.match(rule('.markdown-content:is(h1)'), /font-size: var\(--fs-h1\)/);
});
test('prose previews read as short sans text while raw and source previews keep the source tier', () => {
  const prose = rule('.tool-preview > .tool-prose-preview');
  assert.match(prose, /color: var\(--muted\); font-family: var\(--sans\); font-size: var\(--fs-meta\); line-height: 20px; font-weight: 400; white-space: normal/);
  assert.match(prose, /-webkit-line-clamp: 3/); assert.match(prose, /overflow: hidden/);
  assert.match(rule('.tool-prose-preview .prose-preview-code'), /font-family: var\(--mono\); font-size: var\(--fs-code\)/);
  assert.match(rule('.tool-prose-preview .prose-preview-title'), /display: block; margin: 0; color: var\(--fg\); font-size: var\(--fs-meta\); line-height: 20px; font-weight: 500/);
  assert.doesNotMatch(css, /prose-preview-block \+ \.prose-preview-block/);
  assert.match(rule('.tool-preview'), /font-family: var\(--mono\); font-size: var\(--fs-code\); line-height: 1\.55; white-space: pre-wrap/);
  assert.match(rule('.tool-preview > .tool-content-preview'), /font: inherit/);
  assert.match(rule('pre.tool-document'), /font-family: var\(--mono\); font-size: var\(--fs-code\); line-height: 1\.55/);
});
test('the composer editor and its color layer share the editor-derived reading metrics', async () => {
  const overlay = await readFile(new URL('./composer-overlay.ts', import.meta.url), 'utf8');
  const metrics = /const metrics = \[([^\]]+)\] as const;/.exec(overlay)?.[1] ?? '';
  for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'whiteSpace', 'overflowWrap']) assert.match(metrics, new RegExp(`'${name}'`));
  assert.match(overlay, /getComputedStyle\(this\.editor\)/);
  assert.doesNotMatch(overlay, /\b(?:15|16|24|25\.6)px\b/);
  assert.match(rule('.composer textarea'), /padding: 0/);
  assert.match(rule('.communication-card > .communication-body'), /font-size: var\(--fs-body\)/);
  assert.match(rule('.task-answer, .step-answer'), /font-size: var\(--fs-body\); line-height: 1\.65/);
});
test('Markdown role colors leave chrome labels quiet and preserve syntax token colors', () => {
  const contentTokens = [...css.matchAll(/(?:^|\n)\s*([^{}]+)\{([^{}]*var\(--md-[^{}]*)\}/g)].map(match => match[1]?.trim() ?? '');
  assert.deepEqual(contentTokens.filter(selector => !/^(\.syn-md-|\.composer-colors::highlight\(composer-md-)/.test(selector)), ['.code-block > pre > code:not([data-syntax=known])']);
  assert.equal(rule('.code-block > pre > code:not([data-syntax=known])').trim(), 'color: var(--md-code);');
  assert.doesNotMatch(css, /(?:^|\n)\.code-block > pre > code\s*\{/);
  assert.match(rule('.markdown-content:is(h1, h2, h3, h4, h5, h6)'), /color: var\(--fg\)/);
  for (const tone of ['keyword', 'string', 'number', 'comment', 'type', 'fn', 'property', 'operator', 'punct']) assert.equal(rule(`.syn-${tone}`).trim(), `color: var(--syntax-${tone});`);
  assert.match(rule('.markdown-content a'), /color: var\(--link\)/);
  assert.match(rule('.markdown-content:is(blockquote)'), /border-left: 3px solid var\(--rule\)/);
  assert.match(rule('.message-role'), /color: var\(--muted\); font-size: var\(--fs-meta\); line-height: 18px; font-weight: 500/);
  assert.match(rule('.message-delivery'), /color: var\(--muted\); font-size: var\(--fs-meta\); line-height: 18px/);
  assert.match(rule('.message-error.warning'), /color: var\(--warning\)/);
  assert.doesNotMatch(css, /\.message\[data-role=assistant\] > \.message-header > \.message-role|\.message\.user > \.message-header > \.message-role/);
  assert.match(rule('.markdown-content .markdown-inline-code'), /color: var\(--fg\)/);
  assert.match(rule('.markdown-content .markdown-inline-code'), /padding: calc\(var\(--s1\) \/ 4\) calc\(var\(--s1\) \* 1\.25\)/);
  assert.doesNotMatch(css, /\.markdown-content em \{/);
  assert.match(rule('.message-actions'), /margin-left: auto/);
});
test('an unreachable tab arrow keeps its space and leaves the tab order', () => {
  assert.match(rule('.pane-tab-nav[data-unreachable=true]'), /visibility: hidden/);
});
test('sidebar heading rails keep the shared edge and plain labels reserve chevron space', () => {
  assert.match(rule('.nav-heading-row'), /padding: 0 var\(--s2\) 0 var\(--s3\)/); assert.match(rule('.conversation-group-title'), /padding: 0 var\(--s3\)/);
  assert.match(rule('.nav-row, .row-select'), /padding: 0 calc\(var\(--s6\) \* 2\) 0 var\(--s3\)/); assert.match(rule('.conversation-row'), /padding: 0 var\(--s3\);/);
  assert.match(rule('.file-row'), /padding: 0 var\(--s3\) 0 calc\(var\(--s3\) \+ var\(--file-depth,0\) \* var\(--fs-code\)\)/);
  assert.match(rule('.agent-row .row-select'), /padding: 0 var\(--s2\) 0 var\(--s3\)/); assert.match(rule('.nav-search'), /margin: 0 var\(--s3\)/);
});

test('the draft-save failure row wraps, stays visible and offers a quiet text retry', () => {
  assert.match(rule('.receipt-save-failure'), /display: flex; flex-wrap: wrap;/); assert.match(rule('.receipt-save-failure'), /overflow: visible;/);
  assert.match(rule('.receipt:has(> .receipt-save-failure:only-child)'), /max-height: none; overflow: visible;/);
  assert.match(rule('.receipt .receipt-save-failure > .receipt-retry'), /padding: var\(--s1\) 0; color: var\(--muted\); font-size: var\(--fs-meta\);/);
});

test('sidebar section headings keep their own row in normal flow so no heading draws over another', () => {
  const heading = rule('.nav-heading-row'); assert.match(heading, /height: 28px/); assert.doesNotMatch(heading, /position: (?:absolute|fixed)|margin-top: -|transform:/);
  assert.match(rule('.sidebar-scroll > :is(.roster-section, .files-section)[data-collapsed=true]'), /flex: none; min-height: 0/);
  const threads = rule('.threads-section'); assert.match(threads, /display: flex; flex-direction: column;/); assert.match(threads, /min-height: 28px/); assert.match(threads, /overflow: hidden/); assert.doesNotMatch(threads, /position: (?:absolute|fixed)|margin-top: -/);
  assert.match(rule('.threads-section > .nav-heading-row'), /flex: none/); assert.match(rule('.threads-body[hidden]'), /display: none/);
  assert.match(rule('.thread-scroll:focus-visible'), /outline-offset: 2px/); assert.doesNotMatch(css, /data-pointer/);
});
test('the transcript scroller is not positioned, because render.ts measures its rows by offsetTop against a shared offset parent', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(rule => (rule[1] ?? '').split(',').some(selector => /(?:^|[\s>+~])\.transcript$/.test(selector.trim())));
  assert.ok(rules.length > 0, 'the transcript scroller has a rule');
  for (const rule of rules) {
    assert.doesNotMatch(rule[2] ?? '', /(?:^|[;\s])position\s*:/, `${(rule[1] ?? '').trim()} must not declare position. The offsetTop sites in render.ts (anchor, restorePosition, historyAvailable, revealEntry) assume the scroller and its rows share one offset parent (.transcript-region). Positioning the scroller means moving those sites to rectangle geometry, as layoutOrigin does, in the same change.`);
  }
});
test('sidebar sections follow the document order Tabs, Recent, Agents, Sessions, Threads, Files and Files fills the rest', () => {
  const order = ['sidebar-conversations', 'recent-section', 'roster-section', 'primary-section', 'threads-section', 'files-section'].map(id => html.indexOf(`<section id="${id}"`));
  assert.ok(order.every((index, position) => index > 0 && (position === 0 || index > (order[position - 1] ?? 0))), 'sections appear in reading order');
  assert.doesNotMatch(rule('.files-section'), /max-height/);
  assert.match(rule('#files-section-body'), /flex: 1 1 auto; min-height: 0; overflow: auto/);
  assert.ok(html.indexOf('id="files-section"') < html.indexOf('id="agent-message-panel"'));
});
test('a status row holds sender, kind and first line on one 28px line without fill or border', () => {
  assert.match(rule('.communication-toggle'), /display: flex; flex: 1 1 auto; align-items: center;[^}]*height: 28px; overflow: hidden; color: var\(--muted\); font-size: var\(--fs-meta\);[^}]*white-space: nowrap/);
  assert.doesNotMatch(rule('.communication-toggle'), /background:|border:|box-shadow:/);
  assert.match(rule('.communication-line > .communication-header'), /min-height: 28px/);
  assert.match(rule('.communication-line-preview'), /flex: 1 1 0/);
  assert.match(rule('.communication-line-kind, .communication-line-preview'), /min-width: 0; overflow: hidden;[^}]*text-overflow: clip/);
  assert.match(rule('.communication-toggle > .communication-sender'), /font-weight: 500/);
});

test('the message box keeps its centered grip and its state beside the settings group', () => {
  assert.match(rule('.composer-input > .resizer[data-axis=y]'), /top: -5px; right: auto; left: 50%; width: 40px; height: 10px; margin-left: calc\(var\(--s1\) \* -5\)/);
  assert.match(rule('.resizer::after'), /opacity: 0/);
  assert.match(rule('.composer-input:hover > .resizer[data-axis=y]::after'), /opacity: 1/);
  assert.doesNotMatch(rule('.composer-settings'), /margin:.*auto/);
  assert.match(rule('.composer-state'), /margin: 0/);
  assert.match(rule('.composer-state[data-tone=error]'), /color: var\(--error\)/); assert.match(rule('.composer-state[data-tone=warning]'), /color: var\(--warning\)/);
  assert.doesNotMatch(css, /\.composer-state:not\(\[data-tone\]\) >|\.composer-meta:has\(> \.composer-state\[data-tone\]/);
  assert.match(rule('.composer-state-detail'), /min-width: 32px; min-height: 32px/);
});
test('the compact Add menu draws 32px rows with a 20px icon column and the trigger at the right, and the control row gives the action its width first', () => {
  assert.match(rule('.context-menu-compact'), /width: 272px/);
  assert.match(rule('.context-menu-compact > .context-menu-item'), /display: grid; grid-template-columns: 20px minmax\(0, 1fr\) auto/);
  assert.match(rule('.context-menu-compact > .context-menu-item'), /min-height: 32px/);
  assert.match(rule('.context-menu-compact .context-menu-label'), /overflow: hidden; text-overflow: clip/);
  assert.match(rule('.composer-bar'), /flex: none;[^}]*margin-left: auto/);
});

test('a responder name above a wait answer uses the shared metadata tier', () => {
  assert.match(rule('.tool-awaited-name'), /color: var\(--muted\); font-size: var\(--fs-meta\); line-height: 18px; font-weight: 500/);
  assert.match(rule('.tool-content > .tool-awaited-answer + .tool-awaited-answer'), /margin-top: var\(--s3\)/);
});

function assertCornerScale(selectors: string, body: string): void {
  for (const [, value] of body.matchAll(/border(?:-[a-z-]+)?-radius:\s*([^;]+)/g)) {
    for (const corner of value.trim().split(/\s+/)) assert.ok(['0', '6px', '8px', 'var(--r-sm)', 'var(--r-md)', 'var(--r-lg)', '50%'].includes(corner), `${selectors}: ${value}`);
    if (value === '50%') {
      assert.match(selectors, /(?:row-state|workbench-activity)\[data-busy=true\]::before|sidebar-content-row\[data-unread=true\] > \.row-title::before/);
      for (const [, dimension] of body.matchAll(/(?:width|height): (\d+)px/g)) assert.ok(Number(dimension) <= 12);
    }
  }
}
test('surface corners use the shared scale and only small status glyphs stay round', () => {
  for (const [name, size] of [['sm', 6], ['md', 10], ['lg', 16]]) assert.match(rule(':where(:root)'), new RegExp(`--r-${name}: ${size}px;`));
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selectors, body] of blocks) assertCornerScale(selectors, body);
  assert.doesNotMatch(css, /999px/);
  for (const selector of ['.tool-shell', '.message-body pre, .code-block > pre', '.message-source', '.context-menu', '.context-menu-compact']) assert.match(rule(selector), /border-radius: var\(--r-md\)/, selector);
  for (const selector of ['dialog', '.composer-input', '.message.user > .message-body']) assert.match(rule(selector), /border-radius: var\(--r-lg\)/, selector);
});
test('transcript surfaces have no enclosing borders and semantic side rules stay', () => {
  for (const selector of ['.tool-shell', '.message-body pre, .code-block > pre', '.tool-expanded pre', '.communication-card', '.message-source']) assert.match(rule(selector), /(?:^|;)\s*border: 0;/, selector);
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const forced = css.indexOf('@media (forced-colors:active)');
  for (const match of blocks) {
    const [, selectors, body] = match;
    if ((match.index ?? 0) >= forced || selectors.includes(':is(dialog:not([data-variant=find])') || !/\.(?:tool-shell|communication-card|session-event-group|thinking|markdown-content)\b|(?:^|,|\s)pre\b/.test(selectors)) continue;
    for (const [, property, value] of body.matchAll(/(?:^|;)\s*(border(?:-(?:top|right|bottom|left))?)\s*:\s*([^;]+)/g)) {
      if (property === 'border') assert.ok(['0', 'none'].includes(value.trim()), `${selectors}: ${value}`);
      else assert.match(value, /^(?:0|[123]px solid var\(--[a-z-]+\))$/, `${selectors}: ${value}`);
    }
  }
  assert.match(rule('.thinking-content'), /border-left: 2px solid var\(--rule\)/);
  assert.match(rule('.markdown-content:is(blockquote)'), /border-left: 3px solid var\(--rule\)/);
  assert.match(rule('.message.user > .message-body::before'), /border-left: 2px solid var\(--accent\)/);
});
test('soft tools keep full-width output, distinct inner code and the text-to-run gap', () => {
  assert.match(rule('.tool-shell'), /padding: var\(--s3\) var\(--s4\); border: 0; border-radius: var\(--r-md\); background: var\(--run-bg\)/);
  assert.equal(rule('.tool-shell:hover').trim(), 'background: var(--run-hover);');
  assert.match(rule('.tool-expanded pre'), /padding: var\(--s2\) var\(--s3\); border: 0; border-radius: var\(--r-sm\); background: var\(--code\)/);
  assert.match(rule('.tool-status'), /width: 14px; height: 14px/);
  assert.equal(rule('.tool-status > .card-icon').trim(), 'width: 14px; height: 14px;');
  assert.match(css, /^\.tool-status:empty \{ display: none; \}/m);
  assert.match(rule('.tool-state-word'), /flex: none; max-width: 50%; margin-left: auto;/);
  assert.match(rule('.tool-state-word'), /font-size: var\(--fs-meta\); text-overflow: clip;[^}]*white-space: nowrap/);
  assert.match(rule('.tool-state-word:empty'), /display: none/);
  for (const [state, tone] of [['error', 'error'], ['working', 'info'], ['missing', 'warning']]) assert.ok(rule(`.tool-state-word.${state}`).includes(`color: var(--${tone});`));
  assert.match(rule('.tool-status > .card-icon-working'), /animation: work-pulse 900ms linear infinite/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \.tool-status > \.card-icon-working \{ animation: none; \} \}/);
  assert.match(rule('.tool-name'), /font-weight: 500;[^}]*text-overflow: clip;[^}]*white-space: nowrap/);
  assert.match(rule('.entry:has(.message[data-role=assistant]):not(.compact-entry):has(+ .entry.compact-entry .tool-shell)'), /padding-bottom: var\(--s3\)/);
  assert.match(rule('.entry.compact-entry'), /padding-block: var\(--s1\)/);
  assert.match(rule('.message-body > :not(.tool-shell) + .tool-shell'), /margin-top: var\(--s4\)/);
  assert.match(rule('.message-body > .tool-shell + .tool-shell'), /margin-top: var\(--s2\)/);
});
test('Markdown code actions stay quiet until hover or focus and touch keeps them visible', () => {
  assert.match(rule('.code-block'), /position: relative; min-width: 0/);
  assert.match(rule('.code-block > .source-header'), /position: absolute; top: 0; right: 0;[^}]*border: 0; opacity: 0/);
  assert.match(rule('.code-block:hover > .source-header, .code-block:focus-within > .source-header'), /opacity: 1/);
  assert.match(media('@media (pointer:coarse)'), /\.code-block > \.source-header \{ position: static; opacity: 1/);
});
test('focus uses an offset accent outline without a blur and floating surfaces share one shadow', () => {
  assert.match(rule(':focus-visible, .entry.own-message-focus, .thread-message.own-message-focus'), /outline: 2px solid var\(--accent\); outline-offset: 2px/);
  assert.match(rule('.composer[data-file-drop=true] .composer-input'), /outline: 2px solid var\(--accent\); outline-offset: 2px/);
  assert.match(media('@media (forced-colors:active)'), /\.composer button:focus-visible, \.composer\[data-file-drop=true\] \.composer-input \{ outline: 2px solid Highlight; \}/); assert.match(media('@media (forced-colors:active)'), /\.composer-input:has\(textarea:focus-visible\) \{ border-color: Highlight; outline: 2px solid Highlight; outline-offset: 1px; \}/);
  assert.match(media('@media (forced-colors:active)'), /:root\[data-appearance\] :is\(dialog:not\(\[data-variant=find\]\),[^{}]+\{ border: 1px solid ButtonText;/);
  for (const [, selector, body] of css.matchAll(/([^{}]*:focus[^{}]*)\{([^{}]*)\}/g)) {
    assert.doesNotMatch(body, /box-shadow:(?!\s*none)/, selector);
  }
  for (const selector of ['dialog', '.context-menu', '.command-menu, .composer-intake-menu']) {
    assert.match(rule(selector), /box-shadow: var\(--shadow\)/);
    assert.match(rule(selector), /border: 0/);
  }
  assert.match(rule(':where(:root)'), /--shadow: 0 8px 28px color-mix\(in srgb, var\(--backdrop\) 40%, transparent\)/);
  for (const mode of ['light', 'system']) assert.match(rule(`:root[data-appearance=${mode}] :is(dialog:not([data-variant=find]), .context-menu, .command-menu, .composer-intake-menu, .workbench-status .composer-detail-body, .receipt-details pre)`), /border: 1px solid var\(--rule\)/);
  assert.match(rule('dialog'), /padding: var\(--s5\)/);
  assert.match(rule('.context-menu'), /padding: var\(--s1\)/);
  assert.match(rule('.context-menu > button'), /min-height: 32px; padding: var\(--s1\) var\(--s3\)/);
});
test('diff fills span each row and signs own a two-character gutter', () => {
  assert.match(rule('.diff-row'), /display: grid; grid-template-columns: 2ch minmax\(0,1fr\); width: 100%; min-width: 0/);
  assert.match(rule('.diff-marker'), /grid-column: 1; white-space: pre/);
  assert.match(rule('.diff-text'), /grid-column: 2; min-width: 0; white-space: inherit; overflow-wrap: inherit/);
  assert.equal(rule('.diff-del, .diff-add').trim(), 'padding: 0;');
  assert.match(rule('.diff-del'), /background: var\(--del-bg\); color: var\(--error\)/);
  assert.match(rule('.diff-add'), /background: var\(--add-bg\); color: var\(--success\)/);
});

test('the final coarse-pointer block wins over the density rules and restores 44px touch rows', () => {
  const marker = '@media (pointer:coarse) {\n  .sidebar .nav-row, .sidebar .sidebar-action';
  const start = css.lastIndexOf(marker); assert.ok(start > 0, 'Missing the final coarse-pointer block');
  assert.equal(css.indexOf('\n@media', start + 1) , -1, 'The coarse-pointer block must be the last media block');
  const block = css.slice(start), body = block.slice(block.indexOf('{') + 1);
  const rules = [...body.matchAll(/\n\s*([^{}\n]+)\{([^}]+)\}/g)].map(match => ({selector: (match[1] ?? '').trim(), text: match[2] ?? ''}));
  assert.ok(rules.length > 8);
  const before = css.slice(0, start);
  for (const {selector, text} of rules) {
    const height = /(?:^|[;\s])min-height:\s*(\d+)px/.exec(text);
    if (!height) continue;
    assert.ok(Number(height[1]) >= 44 || /grid-template-rows/.test(text) , `${selector} must keep a 44px minimum`);
    for (const part of selector.split(',').map(item => item.trim())) {
      const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const earlier = [...before.matchAll(new RegExp(`(?:^|[\\n,]\\s*)${escaped}\\s*[,{]`, 'g'))];
      assert.ok(before.length > 0 && earlier.every(match => match.index < start), `${part} density rule must precede the coarse block`);
    }
  }
  for (const needle of ['.sidebar .agent-row > .row-message', '.sidebar .conversation-row', '.sidebar .nav-row']) assert.ok(before.includes(needle), `${needle} density rule exists before the block`);
  assert.match(rule('.sidebar .nav-row, .sidebar .sidebar-action'), /height: 30px/);
});

test('the drawer media query and the persistent sidebar constant name the same width', () => {
  assert.ok(css.includes(`@media (max-width:${PERSISTENT_SIDEBAR_MIN_WIDTH - 1}px) {`));
  assert.equal(css.includes('@media (max-width:899px)'), false);
});
