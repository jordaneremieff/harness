import assert from "node:assert/strict";
import { test } from "node:test";
import { scripts, plain } from "../../test/load.mts";
const { reader } = scripts(["app/core/source-model.ts"]);
for (const source of [
	"**bold and *nested italic***",
	"``literal ` tick`` and `code`",
	"[a *nested* link](https://example.test/a(b))",
	"![alt][reference] and [short]",
	"<https://example.test> and <a@example.test>",
	"\\*literal &amp; ~~removed~~",
	"_not_ intraword_a_b",
	"## Heading\n> - Nested paragraph",
]) {
	test(`cosmetic tokens retain exact characters: ${source}`, () => {
		const tokens = plain(reader.sourceModel.tokens(source));
		assert.equal(tokens.map((t) => t.text).join(""), source);
		assert.ok(tokens.every((t) => t.text.length > 0));
	});
}
test("nested emphasis and arbitrary backtick runs carry real typography", () => {
	const bold = plain(reader.sourceModel.tokens("**bold *inside* text**"));
	assert.ok(bold.some((t) => t.kind.includes("bold") && t.kind.includes("italic")));
	const code = plain(reader.sourceModel.tokens("``a ` b``"));
	assert.ok(code.some((t) => t.kind === "code" && t.text === "a ` b"));
});
test("unclosed markup remains plain source", () => {
	assert.deepEqual(plain(reader.sourceModel.tokens("**unclosed")), [{ text: "**unclosed", kind: "plain" }]);
});
test("native map snaps unequal entity segments and refuses uncovered boundaries", () => {
	class FakeElement {
		nodeType = 1;
		childNodes: unknown[] = [];
		matches() {
			return false;
		}
	}
	const { reader: r } = scripts(["app/core/source-model.ts"], { Element: FakeElement });
	const element = new FakeElement();
	element.childNodes = [{ nodeType: 3, data: "a & z", length: 5 }];
	const block = {
		key: "b",
		start: 0,
		end: 14,
		type: "paragraph",
		map: [
			[0, 1, 0, 1],
			[2, 1, 2, 5],
			[4, 1, 8, 1],
		],
	};
	const result = r.sourceModel.map(block as ReaderMappedBlock, "a &amp; z", element as unknown as HTMLElement);
	assert.deepEqual(plain(result.boundaries), [0, 1, 2, 7, 8, 9]);
	const missing = r.sourceModel.map(
		{ ...block, map: [[0, 1, 0, 1]] } as ReaderMappedBlock,
		"a &amp; z",
		element as unknown as HTMLElement,
	);
	assert.equal(missing.boundaries[4], null);
});
class TextNode {
	nodeType = 3;
	childNodes: TextNode[] = [];
	data: string;
	constructor(data: string) {
		this.data = data;
	}
	get length() {
		return this.data.length;
	}
}
class ElementNode {
	nodeType = 1;
	childNodes: (ElementNode | TextNode)[];
	control: boolean;
	constructor(childNodes: (ElementNode | TextNode)[] = [], control = false) {
		this.childNodes = childNodes;
		this.control = control;
	}
	matches(selector: string) {
		return selector === "[data-reader-control]" && this.control;
	}
}
const asNode = (node: ElementNode | TextNode) => node as unknown as Node;
test("offsets, points and inline maps share the traversal that excludes controls", () => {
	const { sourceModel } = scripts(["app/core/source-model.ts"], { Element: ElementNode }).reader;
	const a = new TextNode("a "),
		b = new TextNode("&"),
		z = new TextNode(" z😀");
	const buttonText = new TextNode("Copy source");
	const control = new ElementNode([new ElementNode([buttonText])], true);
	const span = new ElementNode([b]);
	const element = new ElementNode([a, control, span, z]);
	const root = asNode(element);
	assert.equal(
		sourceModel
			.textNodes(root)
			.map((node) => node.data)
			.join(""),
		"a & z😀",
	);
	assert.equal(sourceModel.offset(root, asNode(z), 2), 5);
	assert.equal(sourceModel.offset(root, root, 0), 0);
	assert.equal(sourceModel.offset(root, root, 1), 2);
	assert.equal(sourceModel.offset(root, root, 2), 2);
	assert.equal(sourceModel.offset(root, root, 3), 3);
	assert.equal(sourceModel.offset(root, root, 4), 7);
	assert.equal(sourceModel.offset(root, asNode(span), 1), 3);
	assert.equal(sourceModel.offset(root, asNode(control), 0), null);
	assert.equal(sourceModel.offset(root, asNode(buttonText), 1), null);
	assert.equal(sourceModel.offset(asNode(control), asNode(buttonText), 0), null);
	assert.equal(sourceModel.offset(root, asNode(new TextNode("elsewhere")), 0), null);
	for (const position of [-1, 8, 1.5, NaN]) assert.equal(sourceModel.offset(root, asNode(z), position), null);
	assert.equal(sourceModel.offset(root, root, 5), null);
	for (let position = 0; position <= 7; position++) {
		const point = sourceModel.point(root, position);
		assert.equal(sourceModel.offset(root, point.node, point.offset), position);
	}
	const block: ReaderMappedBlock = {
		key: "b",
		start: 0,
		end: 11,
		type: "paragraph",
		map: [
			[0, 2, 0, 2],
			[2, 1, 2, 5],
			[3, 4, 7, 4],
		],
	};
	const mapped = sourceModel.map(block, "a &amp; z😀", root as HTMLElement);
	assert.equal(mapped.text, "a & z😀");
	assert.deepEqual(plain(mapped.boundaries), [0, 1, 2, 7, 8, 9, 10, 11]);
	buttonText.data = "Metadata with a much longer label";
	assert.deepEqual(plain(sourceModel.map(block, "a &amp; z😀", root as HTMLElement)), plain(mapped));
	assert.equal(sourceModel.offset(root, asNode(z), 2), 5);
});
test("invalid native map segments stay unmapped and empty text has a usable point", () => {
	const { sourceModel } = scripts(["app/core/source-model.ts"], { Element: ElementNode }).reader;
	const element = new ElementNode([new TextNode("ab")]);
	const block: ReaderMappedBlock = {
		key: "b",
		start: 0,
		end: 2,
		type: "paragraph",
		map: [
			[0, 2, 0, -1],
			[0, 1, 0, 1],
			[1, 1, 1, 9],
		],
	};
	assert.deepEqual(plain(sourceModel.map(block, "ab", asNode(element) as HTMLElement).boundaries), [0, 1, null]);
	const empty = asNode(new ElementNode());
	const point = sourceModel.point(empty, 0);
	assert.equal(point.node, empty);
	assert.equal(sourceModel.offset(empty, point.node, point.offset), 0);
});
