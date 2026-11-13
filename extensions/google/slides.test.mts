import assert from "node:assert/strict";
import { test } from "node:test";
import { createFake, errorCode, methodCalls } from "./fake-gws.test-support.mts";
import { SCOPES } from "./gws.ts";

const GET = "slides presentations get";

function body(...paragraphs: { content: string; nestingLevel?: number }[]) {
	return {
		textElements: paragraphs.flatMap((item) => [
			{ paragraphMarker: item.nestingLevel === undefined ? {} : { bullet: { nestingLevel: item.nestingLevel } } },
			{ textRun: { content: `${item.content}\n` } },
		]),
	};
}

const PRESENTATION = {
	presentationId: "p1",
	title: "Deck",
	revisionId: "rev-9",
	slides: [
		{
			objectId: "s1",
			pageElements: [
				{ objectId: "e1", shape: { placeholder: { type: "TITLE" }, text: body({ content: "Welcome" }) } },
				{
					objectId: "e2",
					shape: { text: body({ content: "Point one", nestingLevel: 0 }, { content: "Detail", nestingLevel: 1 }) },
				},
				{ objectId: "e3", title: "Growth chart", image: {} },
			],
			slideProperties: {
				notesPage: {
					notesProperties: { speakerNotesObjectId: "n1" },
					pageElements: [
						{ objectId: "n0", shape: {} },
						{ objectId: "n1", shape: { text: body({ content: "Say hello" }) } },
					],
				},
			},
		},
		{
			objectId: "s2",
			pageElements: [
				{
					table: { tableRows: [{ tableCells: [{ text: body({ content: "A" }) }, { text: body({ content: "B" }) }] }] },
				},
			],
			slideProperties: { isSkipped: true },
		},
	],
};

const MARKDOWN = [
	"## Slide 1 (s1)",
	"",
	"### Welcome",
	"",
	"- Point one",
	"  - Detail",
	"",
	"[image: Growth chart]",
	"",
	"**Speaker notes**",
	"",
	"Say hello",
	"",
	"## Slide 2 (s2) [skipped]",
	"",
	"| A | B |",
	"| --- | --- |",
].join("\n");

type SlidesData = {
	presentationId: string;
	revisionId: string;
	slideCount: number;
	externalData: {
		trust: string;
		title: string;
		slides?: { objectId: string; slideNumber: number; offset: number; notesOffset?: number }[];
		slidesTruncated?: boolean;
		content: { text: string; truncated: boolean; nextOffset?: number; totalCodePoints: number };
	};
};

test("slides_get renders slide text and speaker notes with the slide offsets", async () => {
	const fake = await createFake({ responses: { [GET]: { stdout: PRESENTATION } } });
	try {
		const result = await fake.tool("slides_get", { presentationId: "p1" });
		assert.equal(result.status, "ok", JSON.stringify(result));
		const data = result.data as SlidesData;
		assert.equal(data.presentationId, "p1");
		assert.equal(data.revisionId, "rev-9");
		assert.equal(data.slideCount, 2);
		assert.equal(data.externalData.trust, "untrusted");
		assert.equal(data.externalData.title, "Deck");
		assert.equal(data.externalData.content.text, MARKDOWN);
		assert.deepEqual(data.externalData.slides, [
			{ objectId: "s1", slideNumber: 1, offset: 0, notesOffset: MARKDOWN.indexOf("Say hello") },
			{ objectId: "s2", slideNumber: 2, offset: MARKDOWN.indexOf("## Slide 2") },
		]);
		assert.equal(data.externalData.slidesTruncated, false);
		const [call] = methodCalls(await fake.calls(), GET);
		assert.deepEqual(JSON.parse(call.args[call.args.indexOf("--params") + 1]), {
			presentationId: "p1",
			fields: "presentationId,title,revisionId,slides",
		});
	} finally {
		await fake.cleanup();
	}
});

test("slides_get continues from a slide offset without repeating the slide list", async () => {
	const fake = await createFake({ responses: { [GET]: { stdout: PRESENTATION } } });
	try {
		const offset = MARKDOWN.indexOf("## Slide 2");
		const first = (await fake.tool("slides_get", { presentationId: "p1", limit: offset })).data as SlidesData;
		assert.equal(first.externalData.content.nextOffset, offset);
		const rest = (await fake.tool("slides_get", { presentationId: "p1", offset })).data as SlidesData;
		assert.equal(rest.externalData.content.text, MARKDOWN.slice(offset));
		assert.equal(rest.externalData.content.truncated, false);
		assert.equal(rest.externalData.slides, undefined);
	} finally {
		await fake.cleanup();
	}
});

test("slides_get accepts a Drive read grant and refuses an unrelated grant", async () => {
	const granted = await createFake({ scopes: [SCOPES.driveRead], responses: { [GET]: { stdout: PRESENTATION } } });
	const unrelated = await createFake({ scopes: [SCOPES.tasks], responses: { [GET]: { stdout: PRESENTATION } } });
	try {
		assert.equal((await granted.tool("slides_get", { presentationId: "p1" })).status, "ok");
		const refused = await unrelated.tool("slides_get", { presentationId: "p1" });
		assert.equal(errorCode(refused), "SCOPE_REQUIRED");
		assert.ok((refused.error as { requiredAnyOf?: string[] }).requiredAnyOf?.includes(SCOPES.slidesRead));
		assert.equal(methodCalls(await unrelated.calls(), GET).length, 0);
	} finally {
		await granted.cleanup();
		await unrelated.cleanup();
	}
});
