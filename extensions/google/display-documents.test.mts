import assert from "node:assert/strict";
import test from "node:test";
import type { Data, ResultContext } from "./display-data.ts";
import { documentsPresenters } from "./display-documents.ts";

const sourceId = "00a1b2c3d4e5f678";
const revisionId = "revision-opaque-001";

function result(args: Data, data: Data): ResultContext {
	return { args, data, error: {}, status: "ok", isError: false };
}

test("Docs presents the retained Markdown page and continues in the resolved tab", () => {
	const docs = documentsPresenters.docs_get;
	const retained = ["# Agenda", "", "- First 🗓", "- Second", "- Third", "- Fourth", "- Fifth", ""];
	const page = retained.join("\n");
	const limit = [...page].length;
	const args = { documentId: "doc-1", offset: 0, limit };
	assert.deepEqual(docs.call(args), { subject: "doc-1", facts: ["first tab", `limit ${limit}`] });
	const card = docs.result(
		result(args, {
			documentId: "doc-1",
			revisionId,
			tabId: "tab-first",
			externalData: {
				source: "docs",
				trust: "untrusted",
				title: "Meeting notes",
				tabs: [
					{ tabId: "tab-first", title: "Agenda", nestingLevel: 0 },
					{ tabId: "tab-child", title: "Decisions", nestingLevel: 1, parentTabId: "tab-first" },
				],
				tabsTruncated: false,
				content: {
					format: "markdown",
					text: page,
					truncated: true,
					nextOffset: limit,
					totalCodePoints: limit + 20,
					sourceId,
				},
			},
		}),
	);
	assert.match(card?.outcome ?? "", /first page of the tab.*more text/);
	assert.deepEqual(card?.body, retained);
	assert.deepEqual(card?.next, { args: { documentId: "doc-1", tabId: "tab-first", offset: limit, sourceId, limit } });
	assert.match(card?.details?.join("\n") ?? "", /Meeting notes[\s\S]*Revision: revision-opaque-001/);
	assert.ok(card?.details?.includes("Tab tab-child: Decisions (parent tab-first)"));
});

test("Slides presents the index, preserves the page cursor and distinguishes a final page", () => {
	const slides = documentsPresenters.slides_get;
	const beforeNotes = "## Slide 1 (slide-1)\n\n**Speaker notes**\n\n";
	const notes = "Note".padEnd(12000 - beforeNotes.length, ".");
	const tail = "\n\n## Slide 2 (slide-2)\n\nLast notes";
	const total = 12000 + tail.length;
	const first = slides.result(
		result(
			{ presentationId: "deck-1" },
			{
				presentationId: "deck-1",
				slideCount: 2,
				externalData: {
					source: "slides",
					trust: "untrusted",
					title: "Plan",
					slides: [
						{ objectId: "slide-1", slideNumber: 1, offset: 0, notesOffset: beforeNotes.length },
						{ objectId: "slide-2", slideNumber: 2, offset: 12002 },
					],
					slidesTruncated: false,
					content: {
						format: "markdown",
						text: beforeNotes + notes,
						truncated: true,
						nextOffset: 12000,
						totalCodePoints: total,
						sourceId,
					},
				},
			},
		),
	);
	assert.deepEqual(first?.next, { args: { presentationId: "deck-1", offset: 12000, sourceId } });
	assert.ok(first?.details?.includes(`Slide 1 (slide-1): offset 0; speaker notes at offset ${beforeNotes.length}`));
	assert.deepEqual(first?.body?.slice(-3), ["**Speaker notes**", "", notes]);

	assert.ok(first?.next);
	const final = slides.result(
		result(first.next.args, {
			presentationId: "deck-1",
			slideCount: 2,
			externalData: {
				source: "slides",
				trust: "untrusted",
				title: "Plan",
				content: { format: "markdown", text: tail, truncated: false, totalCodePoints: total, sourceId },
			},
		}),
	);
	assert.match(final?.outcome ?? "", /rest of the presentation from offset 12000/);
	assert.deepEqual(final?.body, tail.split("\n"));
	assert.equal(final?.next, undefined);
});

test("Docs handles an empty rendered tab without a placeholder or continuation", () => {
	const card = documentsPresenters.docs_get.result(
		result(
			{ documentId: "doc-empty" },
			{
				documentId: "doc-empty",
				tabId: "tab-empty",
				externalData: {
					source: "docs",
					trust: "untrusted",
					title: "Draft",
					tabs: [{ tabId: "tab-empty", title: "Tab 1", nestingLevel: 0 }],
					tabsTruncated: false,
					content: { format: "markdown", text: "", truncated: false, totalCodePoints: 0, sourceId },
				},
			},
		),
	);
	assert.match(card?.outcome ?? "", /no rendered text/);
	assert.equal(card?.body, undefined);
	assert.equal(card?.next, undefined);
	assert.ok(card?.details?.includes("Source length: 0 code points"));
});

test("Docs write calls show text sizes, never the mutation text", () => {
	const revision = { documentId: "doc-1", expectedRevisionId: "before-revision" };
	const append = documentsPresenters.docs_append.call({ ...revision, text: "🌏\nsecret", tabId: "tab-child" });
	assert.deepEqual(append, {
		subject: "doc-1",
		facts: ["tab tab-child"],
		args: { expectedRevisionId: "before-revision", text: "8 characters" },
	});
	const replace = documentsPresenters.docs_replace_text.call({
		...revision,
		find: "secret",
		replacement: "",
		matchCase: false,
	});
	assert.deepEqual(replace, {
		subject: "doc-1",
		facts: ["all tabs", "case-insensitive"],
		args: { expectedRevisionId: "before-revision", find: "6 characters", replacement: "0 characters" },
	});
});

test("Docs distinguishes append, replacement counts, missing evidence and a revision refusal", () => {
	const { docs_append: append, docs_replace_text: replace } = documentsPresenters;
	const args = { documentId: "doc-1", expectedRevisionId: "before-revision" };
	const data = { documentId: "doc-1", revisionId };
	const appendCard = append.result(result(args, data));
	assert.match(appendCard?.outcome ?? "", /^Appended text/);
	assert.deepEqual(appendCard?.body, [`Revision ${revisionId}`]);

	const replaced = replace.result(result(args, { ...data, occurrencesChanged: 2 }));
	assert.match(replaced?.outcome ?? "", /^Replaced 2 occurrences/);
	assert.deepEqual(replaced?.body, [`Revision ${revisionId}`]);
	assert.match(replace.result(result(args, { ...data, occurrencesChanged: 0 }))?.outcome ?? "", /no occurrences/);
	assert.match(replace.result(result(args, data))?.outcome ?? "", /does not confirm/);
	assert.match(append.result(result(args, {}))?.outcome ?? "", /does not confirm/);
	assert.equal(
		append.result({ args, data: {}, status: "error", isError: true, error: { code: "DOCUMENT_CHANGED" } }),
		undefined,
	);
});
