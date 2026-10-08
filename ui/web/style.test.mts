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
    for (const foreground of ['text', 'secondary', 'muted', 'success', 'warning', 'danger', 'info', 'accent']) for (const background of ['canvas', 'surface', 'raised', 'user', 'custom']) {
      const ratio = contrast(colors.get(foreground), colors.get(background));
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio}`);
    }
    assert.ok(contrast(colors.get('accent-text'), colors.get('accent')) >= 4.5);
  });
  test(`${theme} controls and focus pass graphical AA`, () => {
    const colors = palette(selector);
    for (const foreground of ['border', 'accent']) for (const background of ['canvas', 'surface', 'raised', 'user']) assert.ok(contrast(colors.get(foreground), colors.get(background)) >= 3, `${foreground} on ${background}`);
  });
}
test('the native shell preserves separate labeled primary and agent composers', () => {
  assert.match(html, /id="primary-editor"/); assert.match(html, /id="agent-editor"/);
  assert.match(html, /for="primary-editor"/); assert.match(html, /for="agent-editor"/);
  assert.match(html, /<dialog id="modal" aria-labelledby="modal-title"/);
  assert.match(html, /src="\/web\/app.js"/); assert.doesNotMatch(html, /on(?:load|click|error)=|<script[^>]*>[^<]+<\/script>/);
});
test('responsive layout has the specified collapse breakpoints and no animated liveness', () => {
  for (const width of [1600, 1179, 899, 599]) assert.ok(css.includes(`${width}px`));
  assert.match(css, /@media\s*\(forced-colors:\s*active\)/); assert.match(css, /@media\s*\(pointer:\s*coarse\)/);
  assert.doesNotMatch(css, /animation:|transition:|scroll-behavior:smooth/);
});
