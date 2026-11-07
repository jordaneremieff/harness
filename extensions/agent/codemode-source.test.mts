import assert from "node:assert/strict";
import { it } from "node:test";
import { parseCodemodeSource } from "@earendil-works/pi-codemode";
import { DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS, prepareNativeCodemodeArguments, replaceCodemodeTimeout } from "./codemode-source.ts";

it("gives a script without an options line the default finite budget", () => {
	const code = 'const value = 1;\nreturn value;';
	const prepared = prepareNativeCodemodeArguments({ code });
	assert.deepEqual(prepared, { code: `// @options: {"timeout_ms":${DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS}}\n${code}` });
	assert.equal(parseCodemodeSource(prepared.code).options.timeoutMs, DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS);
	assert.equal(parseCodemodeSource(prepared.code).code, `\n${code}`);
});

it("adds the default budget to existing options and retains max_output_tokens", () => {
	const prepared = prepareNativeCodemodeArguments({ code: '// @options: {"max_output_tokens": 2000}\nreturn 1;' });
	assert.deepEqual(parseCodemodeSource(prepared.code).options, { maxOutputTokens: 2000, timeoutMs: DEFAULT_NATIVE_CODEMODE_TIMEOUT_MS });
});

it("preserves an explicit timeout byte for byte", () => {
	for (const code of [
		'// @options: {"timeout_ms": 5000}\nreturn 1;',
		'// @options: {"max_output_tokens":10,"timeout_ms":1}\nreturn 1;',
		'  // @options: {"timeout_ms": 5000}\r\nreturn 1;',
	]) {
		assert.equal(prepareNativeCodemodeArguments({ code }).code, code);
	}
});

it("leaves invalid and misplaced directives as errors", () => {
	assert.throws(() => prepareNativeCodemodeArguments({ code: '// @options: {"timeout_ms": 0}\nreturn 1;' }), /timeout_ms/u);
	assert.throws(() => prepareNativeCodemodeArguments({ code: '// @options: {"unknown": 1}\nreturn 1;' }), /only supports/u);
	assert.throws(() => prepareNativeCodemodeArguments({ code: 'return 1;\n// @options: {"timeout_ms": 5000}' }), /first line/u);
	assert.throws(() => prepareNativeCodemodeArguments({ code: '// @options: {"timeout_ms": 5000}' }), /subsequent lines/u);
	assert.throws(() => prepareNativeCodemodeArguments({ code: "   " }), /non-empty/u);
});

it("keeps preparation idempotent", () => {
	const once = prepareNativeCodemodeArguments({ code: '// @options: {"max_output_tokens": 5}\nreturn 1;' });
	const twice = prepareNativeCodemodeArguments(once);
	assert.equal(twice.code, once.code);
});

it("rejects arguments without a code string and preserves other fields", () => {
	assert.throws(() => prepareNativeCodemodeArguments(undefined), /object with a `code` string/u);
	assert.throws(() => prepareNativeCodemodeArguments("return 1;"), /object with a `code` string/u);
	assert.throws(() => prepareNativeCodemodeArguments([{ code: "return 1;" }]), /object with a `code` string/u);
	assert.throws(() => prepareNativeCodemodeArguments({}), /`code` argument must be a string/u);
	assert.throws(() => prepareNativeCodemodeArguments({ code: 1 }), /`code` argument must be a string/u);
	const prepared = prepareNativeCodemodeArguments({ code: "return 1;", unexpected: true });
	assert.equal((prepared as { readonly unexpected?: boolean }).unexpected, true, "other fields reach normal schema validation");
});

it("replaces a timeout while keeping the source text, indentation and line ending", () => {
	const crlf = replaceCodemodeTimeout('  // @options: {"max_output_tokens": 9}\r\nreturn "x";', 2500);
	assert.equal(crlf, '  // @options: {"max_output_tokens":9,"timeout_ms":2500}\r\nreturn "x";');
	assert.deepEqual(parseCodemodeSource(crlf).options, { maxOutputTokens: 9, timeoutMs: 2500 });
	const replaced = replaceCodemodeTimeout('// @options: {"timeout_ms": 9000}\nreturn 1;', 1000);
	assert.equal(parseCodemodeSource(replaced).options.timeoutMs, 1000);
});

it("refuses an invalid replacement budget", () => {
	for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		assert.throws(() => replaceCodemodeTimeout("return 1;", value), /positive integer/u);
	}
});
