import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { highlight, knownSyntax, languageFromPath, HIGHLIGHT_BYTES, HIGHLIGHT_LINES, TONES, tokenRanges } from './highlight.ts';

class Node {
  children: Node[] = []; className = ''; private text = '';
  readonly tag: string;
  constructor(tag: string) { this.tag = tag; }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  append(...nodes: Node[]): void { this.children.push(...nodes); }
  set innerHTML(_value: string) { throw new Error('Unsafe HTML'); }
}
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
afterEach(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document'); });
function setup(): void {
  Object.defineProperty(globalThis, 'document', {configurable: true, value: {
    createElement: (tag: string) => new Node(tag), createDocumentFragment: () => new Node('#fragment'),
    createTextNode: (value: string) => { const node = new Node('#text'); node.textContent = value; return node; },
  }});
}
function output(text: string, language?: string): Node { return highlight(text, language) as unknown as Node; }
function tones(node: Node): string[] { return node.children.filter(child => child.tag === 'span').map(child => child.className); }
const allowed = new Set(TONES.map(tone=>`syn-${tone}`));

test('TypeScript tokens retain exact text and emit only the allowed inert span classes', () => {
  setup(); const text = 'export const count: number = parseInt("42", 10); // <script>inert</script>\nclass Example {}\nconst options = {ready: true};';
  const node = output(text, 'ts'); assert.equal(node.textContent, text);
  for (const tone of ['keyword','string','number','comment','type','fn','property','operator','punct']) assert.ok(tones(node).includes(`syn-${tone}`), tone);
  assert.equal(node.children.every(child => child.tag === '#text' || (child.tag === 'span' && allowed.has(child.className))), true);
});
test('properties require key positions and keywords retain their code roles', () => {
  const text = `const obj = {name: "value", 'key': true}; cond ? 'a' : 'b'; cond ? a : b;\nswitch(x) { case 'x': break; default: break; }\ncond ?\n a : b;\ncase\n 'y':`;
  const ranges = tokenRanges(text, 'ts'); assert.ok(ranges);
  const toneAt = (word: string) => ranges.find(range => range.start <= text.indexOf(word) && range.end > text.indexOf(word))?.tone;
  for (const word of ['name', "'key'"]) assert.equal(toneAt(word), 'property', word);
  for (const word of ["'a'", "'b'", "'x'", "'y'"]) assert.equal(toneAt(word), 'string', word);
  assert.equal(toneAt('a : b'), undefined); assert.equal(toneAt('default'), 'keyword');
  assert.deepEqual(ranges.filter(range => range.tone === 'property').map(range => text.slice(range.start, range.end)), ['name', "'key'"]);
  setup(); assert.equal(output(text, 'ts').textContent, text);
});
test('CSS pseudo selectors stay plain while declaration properties keep their role', () => {
  const text = 'a:hover { color: red; content: "{"; --tone: blue; }\n@media (width > 1px) { li:first-child { width: 2px; } }';
  const ranges = tokenRanges(text, 'css'); assert.ok(ranges);
  assert.deepEqual(ranges.filter(range => range.tone === 'property').map(range => text.slice(range.start, range.end)), ['color', 'content', '--tone', 'width']);
  setup(); assert.equal(output(text, 'css').textContent, text);
});
test('config scalar comments and types depend on whole values, not prose words', () => {
  const text = `description: Use C# on Desktop (examples) yes no off # actual comment\nquoted: "C# # literal" # note\nnumber: -2.5e+2\nflag: true\nwords: true enough\nsettings:\n  enabled: false\nitems = ["text", 2, true]`;
  const ranges = tokenRanges(text, 'yaml'); assert.ok(ranges);
  const toneAt = (word: string) => ranges.find(range => range.start <= text.indexOf(word) && range.end > text.indexOf(word))?.tone;
  for (const word of ['Use', 'C#', 'Desktop', '(examples)', 'yes', 'no off', 'true enough', '"C# # literal"']) assert.equal(toneAt(word), 'string', word);
  assert.equal(toneAt('# actual'), 'comment'); assert.equal(toneAt('# note'), 'comment');
  assert.equal(toneAt('-2.5e+2'), 'number'); assert.equal(toneAt('true\nwords'), 'keyword'); assert.equal(toneAt('false'), 'keyword');
  assert.equal(toneAt('enabled'), 'property');
  setup(); for (const language of ['yaml', 'toml']) assert.equal(output(text, language).textContent, text);
});

test('shell paths, hashes, dates and capitalized arguments stay plain without partial numeric tones', () => {
  const text = 'node /Projects/sample/Workspace/dump/x-2026-10-21/run.mts --expected-commit 99c8d87 \\\n';
  for (const language of ['sh', 'bash', 'zsh']) {
    const ranges=tokenRanges(text,language);assert.ok(ranges);
    const toneAt=(word:string)=>ranges.find(range=>range.start<=text.indexOf(word)&&range.end>text.indexOf(word))?.tone;
    assert.equal(toneAt('node'),undefined);assert.equal(toneAt('--expected-commit'),undefined);
    for(const word of ['Projects','Workspace','2026-10-21','99c8d87'])assert.equal(toneAt(word),undefined,`${language}: ${word}`);
    assert.equal(ranges.some(range=>range.tone==='type'||range.tone==='number'),false);
    setup();assert.equal(output(text,language).textContent,text);
  }
  const textArguments='printf Users Workspace Type number 42abc abc42 123/456 5.txt v2.5 2026-10-21 abc-42 0xff 1e3 12_000';
  const ranges=tokenRanges(textArguments,'bash');assert.ok(ranges);
  assert.deepEqual(ranges.map(range=>[textArguments.slice(range.start,range.end),range.tone]),[['printf','fn']]);
});
test('shell numbers require whole signed or decimal words bounded by whitespace or shell operators', () => {
  const text='sleep 5; printf -2 +3 1.25 .5 5. +.75 -.25|node 8&&echo 9>10\t11\r\n12';
  const ranges=tokenRanges(text,'bash');assert.ok(ranges);
  assert.deepEqual(ranges.filter(range=>range.tone==='number').map(range=>text.slice(range.start,range.end)),['5','-2','+3','1.25','.5','5.','+.75','-.25','8','9','10','11','12']);
  assert.ok(ranges.some(range=>range.tone==='operator'&&text.slice(range.start,range.end)==='&&'));
  const fragments='echo x"quoted"42 42"suffix" x\\ 42 1.2.3 123abc foo/42 /42 +42px 2026-10-21';
  assert.equal(tokenRanges(fragments,'bash')?.some(range=>range.tone==='number'),false);
});
test('shell command positions and plain arguments keep their existing uncolored words', () => {
  const text='node PlainArgument /Projects/sample/node.mts && node OtherArgument; node FinalArgument | node LastArgument';
  const ranges=tokenRanges(text,'bash');assert.ok(ranges);
  assert.deepEqual(ranges.filter(range=>range.tone==='fn'),[]);
  for(const word of ['PlainArgument','/Projects/sample/node.mts','OtherArgument','FinalArgument','LastArgument']){
    const at=text.indexOf(word);assert.equal(ranges.some(range=>range.start<at+word.length&&range.end>at),false,word);
  }
});
test('shell keywords, builtins, strings and comments keep their tones without new flag coloring', () => {
  const text='if true; then printf --format "%s 42" -n 5; fi # comment 99c8d87';
  const ranges=tokenRanges(text,'bash');assert.ok(ranges);
  const toneAt=(word:string)=>ranges.find(range=>range.start<=text.indexOf(word)&&range.end>text.indexOf(word))?.tone;
  for(const word of ['if','then','fi #'])assert.equal(toneAt(word),'keyword');
  assert.equal(toneAt('printf'),'fn');assert.equal(toneAt('--format'),undefined);assert.equal(toneAt('-n'),undefined);
  assert.equal(toneAt('"%s 42"'),'string');assert.equal(toneAt('# comment'),'comment');
  setup();assert.equal(output(text,'bash').textContent,text);
  assert.ok(tokenRanges('class Example {} const count = 0xff + 1.2e3;','ts')?.some(range=>range.tone==='type'));
  assert.deepEqual(tokenRanges('0xff 1.2e3','ts')?.filter(range=>range.tone==='number').map(range=>'0xff 1.2e3'.slice(range.start,range.end)),['0xff','1.2e3']);
});

test('all requested fence aliases and file extensions select supported languages', () => {
  setup();
  const samples: Record<string, string> = {
    ts: 'const value = 42;', js: 'const value = 42;', tsx: 'const value = <Example title="x"/>;', jsx: 'const value = <Example/>;', mjs: 'export const n = 3;', mts: 'export const n = 3;',
    json: '{"value": 2, "ready": true}', sh: 'if true; then echo "yes"; fi # done', bash: 'echo "hi" # note', zsh: 'echo 4',
    py: 'def greet():\n  return "hello" # note', css: 'body { color: "red"; width: 12px; /* note */ }', html: '<div title="x">hello 12</div><!--note-->', xml: '<node id="2"/>',
    md:'# Heading *em*', markdown:'# Heading **strong**', mdown:'[label](url) `code`', yaml: 'value: 2 # note', toml: 'value = "text" # note', go: 'func main() { var value int = 2 } // note', rust: 'fn main() { let value: u32 = 2; } // note', diff: '@@ -1,2 +1,2 @@\n-old\n+new',
  };
  for (const [language, text] of Object.entries(samples)) { assert.equal(knownSyntax(language), true); const node = output(text, language); assert.equal(node.textContent, text); assert.ok(tones(node).length > 0, language); assert.equal(languageFromPath(`folder/source.${language}`), language); }
  for (const language of ['typescript', 'javascript', 'python', 'yml', 'rs', 'patch']) assert.ok(tones(output('value = "x" # note', language)).length > 0, language);
  assert.equal(languageFromPath('/code/SOURCE.TS'), 'ts');
  for (const path of ['README', '/folder.ts/no-extension', '/folder/code.unknown', 'ts', undefined]) assert.equal(languageFromPath(path), undefined);
});
test('known syntax uses explicit language evidence independently of token output', () => {
  for (const language of ['typescript', 'javascript', 'python', 'yml', 'rs', 'patch', ' TS ', 'MARKDOWN']) assert.equal(knownSyntax(language), true, language);
  for (const language of [undefined, '', ' ', 'unknown', 'custom-grammar', '__proto__', 'constructor']) assert.equal(knownSyntax(language), false, language);
  assert.deepEqual(tokenRanges('identifier', 'ts'), []);
  assert.equal(knownSyntax('ts'), true);
  assert.equal(tokenRanges('x'.repeat(HIGHLIGHT_BYTES + 1), 'ts'), undefined);
  assert.equal(knownSyntax('ts'), true);
});
test('markup text is plain and strings and comments shield their content from token classification', () => {
  setup();
  const html = output('<div title="return 42">return 42</div><!-- const x = 3 -->', 'html');
  assert.ok(html.children.some(node => node.className === '' && node.textContent === 'return 42'));
  assert.ok(html.children.some(node => node.className === 'syn-string' && node.textContent === '"return 42"'));
  assert.ok(html.children.some(node => node.className === 'syn-comment' && node.textContent === '<!-- const x = 3 -->'));
  const python = output('"""multi\nreturn 2\n"""\nreturn 3', 'py'); assert.equal(python.children[0]?.className, 'syn-string');
  assert.ok(python.children.some(node => node.className === 'syn-number' && node.textContent === '3'));
  const rust = output("fn borrow<'a>(value: &'a str) { let c = 'x'; }", 'rust');
  assert.equal(rust.children.filter(node => node.className === 'syn-string').map(node => node.textContent).join(''), "'x'");
});
test('malformed and unterminated strings, comments, markup, and Unicode remain exact and finite', () => {
  setup();
  for (const [language, text] of [['ts', '`open value'], ['ts', '/* unterminated'], ['py', '"""open'], ['html', '<!--open'], ['html', '<node'], ['ts', 'const emoji = "😀";\nπ = 2;'], ['ts', '\ud800'], ['ts', '0x 1e+ 1..2']] as const) {
    assert.equal(output(text, language).textContent, text);
  }
});
test('unknown languages and byte, line, or token-density excess stay plain without lost text', () => {
  setup();
  for (const [text, language] of [['const n = 2', 'unknown'], ['const n = 2', '__proto__'], ['x'.repeat(HIGHLIGHT_BYTES + 1), 'ts'], ['é'.repeat(HIGHLIGHT_BYTES / 2 + 1), 'ts'], ['😀'.repeat(HIGHLIGHT_BYTES / 4 + 1), 'ts'], ['\n'.repeat(HIGHLIGHT_LINES), 'ts'], ['a+'.repeat(HIGHLIGHT_BYTES / 2), 'ts']] as const) {
    const node = output(text, language); assert.equal(node.textContent, text); assert.equal(node.children.length, 1); assert.equal(node.children[0]?.tag, '#text');
  }
  const bounded = output('é'.repeat(HIGHLIGHT_BYTES / 2), 'ts'); assert.equal(bounded.textContent.length, HIGHLIGHT_BYTES / 2);
});
test('line accounting handles LF, CRLF, and CR at the exact boundary', () => {
  setup();
  for (const separator of ['\n', '\r\n', '\r']) {
    const line = 'const n = 2;'; const exact = `${line}${separator}`.repeat(HIGHLIGHT_LINES - 1) + line;
    const node = output(exact, 'ts'); assert.equal(node.textContent, exact); assert.ok(tones(node).includes('syn-keyword'));
    const excessive = output(exact + separator, 'ts'); assert.equal(excessive.children.length, 1); assert.equal(excessive.children[0]?.tag, '#text');
  }
});
test('escaped delimiters and numeric bases remain inside their lexical spans', () => {
  setup(); const text = String.raw`const s = "say \"return\""; const n = 0xff + 1.25e-3;`;
  const node = output(text, 'ts'); assert.equal(node.textContent, text);
  assert.deepEqual(node.children.filter(child => child.className === 'syn-string').map(child => child.textContent), [String.raw`"say \"return\""`]);
  assert.deepEqual(node.children.filter(child => child.className === 'syn-number').map(child => child.textContent), ['0xff', '1.25e-3']);
});
test('a 64 KiB TypeScript block completes within a generous bound', context => {
  setup(); const line = 'const value: number = parseInt("42", 10); // comment\n';
  const text = line.repeat(Math.ceil(HIGHLIGHT_BYTES / line.length)).slice(0, HIGHLIGHT_BYTES);
  assert.equal(Buffer.byteLength(text), HIGHLIGHT_BYTES); assert.ok(text.split('\n').length <= HIGHLIGHT_LINES);
  const start = performance.now(); const node = output(text, 'ts'); const elapsed = performance.now() - start;
  assert.ok(tones(node).includes('syn-keyword')); assert.equal(node.textContent, text);
  context.diagnostic(`64 KiB TypeScript highlight: ${elapsed.toFixed(2)} ms`);
  assert.ok(elapsed < 1000, `Highlight took ${elapsed.toFixed(2)} ms`);
});
