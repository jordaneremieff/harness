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
for (const [theme, selector] of [['dark', ':root'], ['light', ':root[data-appearance=light]'], ['system light', ':root[data-appearance=system]']]) {
  test(`${theme} normal and secondary text pass AA on rendered surfaces`, () => {
    const colors = palette(selector);
    for (const foreground of ['text', 'secondary', 'muted', 'success', 'warning', 'danger', 'info', 'accent']) for (const background of ['canvas', 'surface', 'raised', 'user', 'custom', 'sidebar', 'hover', 'selected']) {
      const ratio = contrast(colors.get(foreground), colors.get(background));
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio}`);
    }
    assert.ok(contrast(colors.get('accent-text'), colors.get('accent')) >= 4.5);
  });
  test(`${theme} controls and focus pass graphical AA`, () => {
    const colors = palette(selector);
    for (const foreground of ['border', 'focus']) for (const background of ['canvas', 'surface', 'raised', 'user', 'sidebar', 'hover', 'selected']) assert.ok(contrast(colors.get(foreground), colors.get(background)) >= 3, `${foreground} on ${background}`);
  });
}
test('the native shell preserves separate labeled primary and agent composers', () => {
  assert.match(html, /id="primary-editor"/); assert.match(html, /id="agent-editor"/);
  assert.match(html, /for="primary-editor"/); assert.match(html, /for="agent-editor"/);
  assert.match(html, /<dialog id="modal" aria-labelledby="modal-title"/);
  assert.match(html, /src="\/web\/app.js"/); assert.doesNotMatch(html, /on(?:load|click|error)=|<script[^>]*>[^<]+<\/script>/);
});
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]+)\\}`).exec(css);
  assert.ok(match, `Missing ${selector}`); return match[1];
}
test('left navigation and conversation share a centered content column', () => {
  assert.match(rule('.app'), /grid-template-columns: var\(--sidebar-width,272px\) minmax\(0,1fr\)/);
  assert.match(rule('.app:has(> .sidebar[hidden])'), /grid-template-columns: minmax\(0,1fr\)/);
  assert.match(rule('.sidebar'), /border-right:/);
  assert.match(rule('.roster'), /overflow: auto/);
  assert.match(rule('.message, .custom-entry'), /max-width: 820px/);
  assert.match(rule('.composer'), /max-width: 820px/);
  assert.match(css, /\.app\.drawer-open > \.sidebar/);
  assert.match(rule('.workspace:has(> .sidebar-show:not([hidden])) .conversation-head'), /padding-left: 56px/);
});
test('Latest overlays its region without changing transcript geometry', () => {
  assert.match(rule('.latest'), /position: absolute/);
  assert.match(rule('.latest'), /width: auto; min-width: 96px/);
  assert.match(rule('.latest'), /white-space: nowrap/);
  assert.match(rule('.transcript-region'), /position: relative/);
  assert.match(rule('.transcript-region > .transcript'), /height: 100%/);
  assert.doesNotMatch(css, /:has\(\.latest/);
});
test('history controls align with the transcript and icon-only actions remain visible', () => {
  assert.match(rule('.transcript-actions'), /justify-content: center/);
  assert.match(rule('.transcript-actions'), /max-width: 820px; margin: 0 auto/);
  assert.doesNotMatch(rule('.transcript-actions'), /position: (?:absolute|fixed)/);
  assert.match(rule('.transcript'), /scrollbar-gutter: stable both-edges/);
  assert.match(rule('.icon'), /stroke-width: 1.75/);
  assert.match(rule('#session-actions'), /color: var\(--secondary\)/);
  assert.match(rule('#session-actions .icon'), /stroke-width: 3/);
});
test('completion shares the composer edge and gives selection a non-color cue', () => {
  const menu = rule('.command-menu');
  assert.match(menu, /position: absolute/); assert.match(menu, /bottom: 100%/);
  assert.match(menu, /left: -1px; right: -1px/); assert.match(menu, /border-bottom: 0/);
  assert.match(menu, /max-height: min\(320px,40vh\)/);
  assert.match(rule('.command-option[aria-selected=true]'), /box-shadow: inset 2px/);
  assert.match(rule('.command-name mark'), /background: transparent/);
  assert.match(rule('.command-hint'), /font-size: 11px; line-height: 16px/);
  assert.match(rule('.command-hint'), /color: var\(--muted\)/);
  assert.match(rule('.command-hint'), /position: sticky; bottom: 0/);
  assert.match(rule('.command-hint'), /background: var\(--raised\)/);
  assert.match(rule('.receipt:empty'), /display: none/);
});
test('focus, quiet actions, stable picker space and sticky modal heading remain available', () => {
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--focus\); outline-offset: 2px/);
  assert.match(rule('.skip-link:focus'), /translateY\(0\)/);
  assert.match(css, /\.message:focus-within \.copy/); assert.doesNotMatch(rule('.message .copy'), /display: none|visibility: hidden/);
  assert.match(rule('.picker-projects'), /height: min\(192px,25dvh\)/);
  assert.match(rule('.modal-heading'), /position: sticky/);
});
test('responsive layout has the specified collapse breakpoints and no animated liveness', () => {
  for (const width of [899, 599]) assert.ok(css.includes(`${width}px`));
  assert.match(css, /@media\s*\(max-height:599px\)/);
  assert.doesNotMatch(css, /#agent-panel|workspace-bar|1179px|1600px/);
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/); assert.match(css, /@media\s*\(pointer:\s*coarse\)/);
  assert.doesNotMatch(css, /animation:|transition:|scroll-behavior:smooth/);
});

test('sidebar message form has compact controls and bounded independent overflow', () => {
  assert.match(rule('.agent-message-panel'), /max-height: 50dvh; overflow: auto/);
  assert.match(rule('.agent-message-panel .composer'), /width: 100%/);
  assert.match(rule('.agent-message-panel .composer textarea'), /min-height: 60px; padding: 8px/);
  assert.match(rule('.agent-message-panel .composer-bar'), /flex-wrap: wrap; gap: 4px/);
  assert.match(rule('.message-panel-head > div'), /min-width: 0/);
});

test('an open Message panel reserves two roster rows and lets short sidebars scroll without overlap', () => {
  const open = '.sidebar:has(> .agent-message-panel:not([hidden]))';
  assert.match(rule(open), /overflow-y: auto/);
  assert.match(rule(`${open} > *`), /flex-shrink: 0/);
  assert.match(rule(`${open} .roster-section`), /display: grid; grid-template-rows: auto auto minmax\(220px,1fr\) auto/);
  assert.match(rule(`${open} .roster-section`), /flex: 1 0 0; min-height: min-content/);
  assert.match(rule(`${open} .roster`), /min-height: 220px/);
  assert.match(rule('.agent-message-panel'), /overflow: auto/);
});
