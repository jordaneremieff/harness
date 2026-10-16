import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { DECORATION_BYTES, DECORATION_LINES, DECORATION_SPANS, composerSyntax } from './composer-syntax.ts';
import { FILE_SYNTAX_BYTES, FILE_SYNTAX_LINES, FILE_SYNTAX_SPANS, fileSyntaxRanges } from './file-syntax.ts';
import { tokenRanges, type TokenRange } from './highlight.ts';

function exactSource(text: string, ranges: TokenRange[]): void {
  let at = 0; let restored = '';
  for (const range of ranges) {
    assert.ok(Number.isInteger(range.start) && Number.isInteger(range.end));
    assert.ok(range.start >= at && range.end > range.start && range.end <= text.length);
    restored += text.slice(at, range.start) + text.slice(range.start, range.end); at = range.end;
  }
  assert.equal(restored + text.slice(at), text);
}
function decorated(path: string, text: string): TokenRange[] {
  const ranges = fileSyntaxRanges(path, text); assert.ok(ranges); exactSource(text, ranges); return ranges;
}

test('skill descriptions stay scalar-colored across plain folded literal and indented source', () => {
  for (const separator of ['\n', '\r\n', '\r']) for (const description of [
    ['description: Use C# on Desktop (examples) yes no off'],
    ['description: First line', '  Use C# on Desktop (examples)', '  Example: on or off'],
    ['description: >-', '  Use C# on Desktop (examples)', '  # literal body', '  Example: on or off'],
    ['description: |2', '  Use C# on Desktop (examples)', '  # literal body'],
    ['description:', '  Use C# on Desktop (examples)', '  Example: on or off'],
  ]) {
    const text = ['---', 'name: sample', ...description, 'enabled: true', '---', '# Heading'].join(separator);
    const ranges = decorated('SKILL.md', text); assert.deepEqual(ranges, composerSyntax(text)); assert.deepEqual(ranges, tokenRanges(text, 'md'));
    for (const word of ['Use', 'C#', 'Desktop', '(examples)']) assert.equal(ranges.find(range => range.start <= text.indexOf(word) && range.end > text.indexOf(word))?.tone, 'string', text);
    if (text.includes('# literal body')) assert.equal(ranges.find(range => range.start <= text.indexOf('# literal body') && range.end > text.indexOf('# literal body'))?.tone, 'string');
    if (text.includes('Example:')) assert.equal(ranges.find(range => range.start <= text.indexOf('Example:') && range.end > text.indexOf('Example:'))?.tone, 'string');
    assert.equal(ranges.find(range => range.start <= text.indexOf('enabled') && range.end > text.indexOf('enabled'))?.tone, 'property');
    assert.equal(ranges.find(range => range.start <= text.indexOf('Heading') && range.end > text.indexOf('Heading'))?.tone, 'md-heading');
  }
});
test('config scalar byte line and span excess returns complete plain fallback', () => {
  const exact = `description: ${'a'.repeat(FILE_SYNTAX_BYTES - 'description: '.length)}`;
  const ranges = decorated('skill.yaml', exact); assert.ok(ranges.some(range => range.tone === 'string'));
  for (const text of [`${exact}a`, `description: ${'é'.repeat(FILE_SYNTAX_BYTES / 2)}`, 'key: value\n'.repeat(FILE_SYNTAX_LINES)]) assert.equal(fileSyntaxRanges('skill.yaml', text), undefined);
  assert.equal(tokenRanges('key: value', 'yaml', 2), undefined);
  assert.equal(tokenRanges('key: [1, true, "x"]', 'toml', 2), undefined);
});

test('file extensions reuse the current lexical families for every requested code language', () => {
  const fixtures: Record<string, string> = {
    ts: 'export const n: number = parseInt("2", 10); // note',
    tsx: 'const n = <Example title="x"/>;', js: 'const n = 42;', jsx: 'const n = <Example/>;',
    mjs: 'export const n = 1;', mts: 'export const n = 1;', json: '{"n": 2, "ready": true}',
    css: 'body { color: "red"; width: 12px; /* note */ }', html: '<div title="x">exact 42</div><!-- note -->',
    sh: 'if true; then echo "yes"; fi # note', bash: 'echo "hi" # note', zsh: 'echo 4',
    yaml: 'value: 2 # note', yml: 'ready: true', toml: 'value = "text" # note',
    py: 'def greet():\n  return "hello" # note', go:'func main() { var count int = 2 }', rs:'fn main() { let count: u32 = 2; }', rust:'fn main() {}', diff:'@@ -1 +1 @@\n-old\n+new', patch:'@@ -1 +1 @@\n-old\n+new',
  };
  for (const [extension, text] of Object.entries(fixtures)) {
    const ranges = decorated(`/source/file.${extension}`, text);
    assert.ok(ranges.length > 0, extension);
    assert.deepEqual(ranges, tokenRanges(text, extension, FILE_SYNTAX_SPANS));
  }
  assert.deepEqual(fileSyntaxRanges('/source/FILE.TS', fixtures.ts ?? ''), fileSyntaxRanges('file.ts', fixtures.ts ?? ''));
});

test('unknown files remain plain even when source resembles supported languages', () => {
  for (const path of ['README', 'source.unknown', 'ts', '/folder.ts/no-extension', 'file.__proto__', 'notes.txt']) {
    assert.equal(fileSyntaxRanges(path, 'const n = 2; # Heading'), undefined, path);
  }
  assert.deepEqual(fileSyntaxRanges('empty.ts', ''), []);
  assert.deepEqual(fileSyntaxRanges('empty.md', ''), []);
});

test('code source offsets preserve escapes, Unicode, CRLF, tabs and lone surrogates', () => {
  const text = '😀\r\n\tconst s = "é\\"😀"; // λ\r\n\ud800';
  const ranges = decorated('unicode.ts', text);
  const keyword = ranges.find(range => range.tone === 'keyword');
  assert.equal(keyword?.start, text.indexOf('const'));
  assert.deepEqual(ranges.filter(range => range.tone === 'string').map(range => text.slice(range.start, range.end)), ['"é\\"😀"']);
});

test('Markdown adds headings, list markers, task markers, quotes, rules and balanced link destinations', () => {
  const text = '# Heading 😀\r\n- [x] task\n12. item\n> quote\n---\n[link](docs/a_(b).md) and ![image](pic.png)\nTitle\n===';
  const ranges = decorated('README.MD', text);
  const slices = ranges.map(range => [text.slice(range.start, range.end), range.tone]);
  for (const expected of [['# Heading 😀', 'md-heading'], ['- [x] ', 'md-marker'], ['12. ', 'md-marker'], ['> ', 'md-marker'], ['---', 'md-marker'], ['[link](docs/a_(b).md)', 'md-link'], ['[image](pic.png)', 'md-link'], ['===', 'md-heading']]) {
    assert.ok(slices.some(slice => slice[0] === expected[0] && slice[1] === expected[1]), expected.join(':'));
  }
  assert.deepEqual(fileSyntaxRanges('guide.markdown', text), ranges);
});

test('Markdown retains composer inline and fence semantics without decorating their source twice', () => {
  const text = '# Text `x < y`\n```ts\nconst x = "[label](url)";\n```\n~~~unknown\n# raw [label](url) `literal`\n~~~\n[real](dest)';
  const base = composerSyntax(text); assert.ok(base);
  const ranges = decorated('guide.md', text);
  for (const range of base) assert.ok(ranges.some(candidate => candidate.start === range.start && candidate.end === range.end && candidate.tone === range.tone));
  const raw = text.indexOf('# raw');
  assert.equal(ranges.some(range => range.start >= raw && range.start < text.indexOf('\n~~~', raw)), false);
  assert.equal(ranges.filter(range => text.slice(range.start, range.end) === '(url)').length, 0);
  assert.ok(ranges.some(range => text.slice(range.start, range.end) === '[real](dest)'));
});

test('Markdown code fences keep identity, length, unknown labels, and unterminated bodies', () => {
  for (const text of ['````ts\nconst x=1\n```\n# still code\n````\n# heading', '~~~unknown\n# plain\n```\n[not](link)', '```ts\nconst x=1']) {
    const ranges = decorated('fences.md', text); const base = composerSyntax(text); assert.ok(base);
    for (const range of base) assert.ok(ranges.some(candidate => candidate.start === range.start && candidate.end === range.end && candidate.tone === range.tone));
    assert.equal(ranges.some(range => text.slice(range.start, range.end) === '(link)'), false);
  }
  assert.deepEqual(fileSyntaxRanges('bad.md', '```bad`label\nplain'), []);
});

test('Markdown escapes and inline code shield link destinations with exact UTF-16 offsets', () => {
  const text = '😀 `code [label](raw)` \\[escaped](no) [ok](a\\)b) [broken](unterminated';
  const ranges = decorated('links.md', text);
  assert.deepEqual(ranges.filter(range => range.tone === 'md-code' || range.tone === 'md-link').map(range => text.slice(range.start, range.end)), ['`code [label](raw)`', '[ok](a\\)b)']);
  assert.ok(ranges.some(range => range.start === text.indexOf('[ok]')));
});

test('all code budgets fall back to whole-file plain text, including UTF-8 and span density', () => {
  assert.ok(fileSyntaxRanges('limit.ts', 'x'.repeat(FILE_SYNTAX_BYTES)));
  assert.ok(fileSyntaxRanges('limit.ts', 'é'.repeat(FILE_SYNTAX_BYTES / 2)));
  assert.ok(fileSyntaxRanges('limit.ts', '😀'.repeat(FILE_SYNTAX_BYTES / 4)));
  for (const text of ['x'.repeat(FILE_SYNTAX_BYTES + 1), 'é'.repeat(FILE_SYNTAX_BYTES / 2 + 1), '😀'.repeat(FILE_SYNTAX_BYTES / 4 + 1), '\n'.repeat(FILE_SYNTAX_LINES), 'a+'.repeat(FILE_SYNTAX_SPANS + 1)]) {
    assert.equal(fileSyntaxRanges('limit.ts', text), undefined);
  }
  assert.ok(fileSyntaxRanges('limit.ts', '\n'.repeat(FILE_SYNTAX_LINES - 1)));
});

test('Markdown uses the full file budget while drafts retain their smaller bounds', () => {
  for (const text of [`# Heading\n${'x'.repeat(DECORATION_BYTES + 1)}`, `# Heading\n${'\n'.repeat(DECORATION_LINES)}`, '`x` '.repeat(DECORATION_SPANS + 1)]) {
    assert.ok(fileSyntaxRanges('limit.md', text)); assert.equal(composerSyntax(text), undefined);
  }
  for (const text of ['x'.repeat(FILE_SYNTAX_BYTES + 1), 'é'.repeat(FILE_SYNTAX_BYTES / 2 + 1), '\n'.repeat(FILE_SYNTAX_LINES), '`x` '.repeat(FILE_SYNTAX_SPANS + 1)]) assert.equal(fileSyntaxRanges('limit.md', text), undefined);
  assert.ok(fileSyntaxRanges('limit.md', 'x'.repeat(FILE_SYNTAX_BYTES)));
  assert.ok(fileSyntaxRanges('limit.md', '\n'.repeat(FILE_SYNTAX_LINES - 1)));
  assert.equal(tokenRanges('`a` `b`', 'markdown', 1), undefined);
});

test('malformed code and Markdown remain finite and exact', () => {
  for (const [path, text] of [['x.ts', '/* unterminated'], ['x.py', '"""unterminated'], ['x.html', '<!--open'], ['x.md', '[a]('.repeat(3000)], ['x.md', '` '.repeat(3000)], ['x.md', `[a](${'('.repeat(8000)}`]]) {
    decorated(path ?? '', text ?? '');
  }
  assert.equal(fileSyntaxRanges('huge.md', '['.repeat(1_000_000)), undefined);
  assert.equal(fileSyntaxRanges('huge.ts', `/*${'x'.repeat(1_000_000)}`), undefined);
});

test('Markdown source shares semantic ranges across files drafts and rendered code aliases',()=> {
  const text='---\r\nname: "hello"\r\ncount: 2\r\nready: true\r\n---\r\n# Heading *em* **strong** [label](dest) `code`\r\n\r\nTitle\r\n===\r\nplain paragraph';
  const ranges=decorated('skill.mdown',text), toneAt=(word:string)=>ranges.find(range=>range.start<=text.indexOf(word)&&range.end>text.indexOf(word))?.tone;
  assert.deepEqual(ranges,tokenRanges(text,'markdown'));assert.deepEqual(ranges,composerSyntax(text));
  assert.equal(toneAt('name'),'property');assert.equal(toneAt('"hello"'),'string');assert.equal(toneAt('2'),'number');assert.equal(toneAt('true'),'keyword');
  assert.equal(toneAt('Heading'),'md-heading');assert.equal(toneAt('*em*'),'md-em');assert.equal(toneAt('**strong**'),'md-strong');assert.equal(toneAt('[label]'),'md-link');assert.equal(toneAt('`code`'),'md-code');assert.equal(toneAt('Title'),'md-heading');assert.equal(toneAt('plain paragraph'),undefined);
});
test('only closed opening frontmatter receives config colors and Markdown fences have a finite nesting depth',()=> {
  for(const text of ['---\nname: value','plain\n\n---\nname: value\n---']) {const ranges=decorated('x.md',text);assert.equal(ranges.some(range=>range.tone==='property'),false);}
  const nested='```markdown\n~~~markdown\n# shielded\n~~~\n```';const ranges=decorated('x.md',nested);assert.equal(ranges.some(range=>range.start>=nested.indexOf('# shielded')&&range.start<nested.indexOf('\n~~~',nested.indexOf('# shielded'))),false);
  for(const text of ['**unclosed','\\*escaped*','[label](unclosed','😀\r\n*em*\r\n','```ts\r\nconst n=2;\r\n```'])exactSource(text,decorated('x.md',text));
});
test('properties operators and delimiters keep separate semantic roles',()=> {
  const text='const object = {title: "plain", count: 2}; object.run();';const ranges=decorated('x.ts',text);
  assert.ok(ranges.some(range=>range.tone==='property'&&text.slice(range.start,range.end)==='title'));
  assert.ok(ranges.some(range=>range.tone==='operator'&&text.slice(range.start,range.end)==='='));
  assert.ok(ranges.some(range=>range.tone==='punct'&&text.slice(range.start,range.end).includes('{')));
  assert.ok(ranges.some(range=>range.tone==='fn'&&text.slice(range.start,range.end)==='run'));
  const json='{"key":"value"}';assert.deepEqual(decorated('x.json',json).filter(range=>range.tone==='property').map(range=>json.slice(range.start,range.end)),['"key"']);
});
test('bounded Markdown and code scans finish within a generous local time bound', context => {
  const markdown = `[a](${'('.repeat(DECORATION_BYTES - 4)}`;
  const line = 'const value: number = parseInt("42", 10); // comment\n';
  const code = line.repeat(Math.ceil(FILE_SYNTAX_BYTES / line.length)).slice(0, FILE_SYNTAX_BYTES);
  const start = performance.now(); decorated('speed.md', markdown); decorated('speed.ts', code);
  const elapsed = performance.now() - start;
  context.diagnostic(`Bounded file syntax scans: ${elapsed.toFixed(2)} ms`);
  assert.ok(elapsed < 1000, `Scans took ${elapsed.toFixed(2)} ms`);
});
