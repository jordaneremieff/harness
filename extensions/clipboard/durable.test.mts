/** Drive the clipboard Durable contribution through model-issued calls in a real Harness. */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { clipboardContribution, type DurableContributionHost } from "./durable.ts";
import { appendEntry, makeEntry, readEntries } from "./store.ts";

function detailsOf(message: ToolResultMessage | undefined): Record<string, unknown> {
	const details = message?.details;
	return typeof details === "object" && details !== null && !Array.isArray(details)
		? (details as Record<string, unknown>)
		: {};
}

function textOf(message: ToolResultMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

test("serves every clipboard tool to a Durable model and classifies replay", { timeout: 60000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "clipboard-durable-test-"));
	const agentDir = join(root, "agent");
	const archive = join(agentDir, "clipboard");
	const bin = join(root, "bin");
	const clipboardFile = join(root, "clipboard.txt");
	const previous = {
		path: process.env.PATH,
		archiveDir: process.env.PI_CLIPBOARD_DIR,
		destination: process.env.CLIPBOARD_TEST_DESTINATION,
	};
	try {
		await Promise.all([mkdir(agentDir), mkdir(bin)]);
		// Synthetic clipboard executables keep the test off the system clipboard.
		await writeFile(
			join(bin, "pbcopy"),
			`#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.CLIPBOARD_TEST_DESTINATION, fs.readFileSync(0));\n`,
		);
		await writeFile(
			join(bin, "pbpaste"),
			`#!${process.execPath}\nconst fs = require("node:fs");\nprocess.stdout.write(fs.readFileSync(process.env.CLIPBOARD_TEST_DESTINATION));\n`,
		);
		await Promise.all([chmod(join(bin, "pbcopy"), 0o700), chmod(join(bin, "pbpaste"), 0o700)]);
		process.env.PATH = `${bin}:${previous.path ?? ""}`;
		delete process.env.PI_CLIPBOARD_DIR;
		process.env.CLIPBOARD_TEST_DESTINATION = clipboardFile;
		await writeFile(clipboardFile, "initial clipboard");
		await appendEntry(archive, makeEntry("seeded body", "seed", new Date("2026-02-03T04:05:06Z"), "seeded-entry"));

		const source = fileURLToPath(new URL("./index.ts", import.meta.url));
		const contribution = clipboardContribution(source);
		assert.equal(contribution.source, source, "the contribution names its emitting entrypoint");

		const host: DurableContributionHost = {
			durable: Durable,
			// The clipboard contribution reads no services; the host supplies them for other slices.
			services: {} as DurableContributionHost["services"],
			cwd: root,
			agentDir,
			storageId: "clipboard-durable-test",
			signal: new AbortController().signal,
			inventory: {
				contributions: [{ name: "clipboard", source, commands: [] }],
				ordinaryOnly: [],
			},
		};
		const extension = await contribution.create(host);
		const replay = new Map((extension.tools ?? []).map((tool) => [tool.name, tool.replay]));
		assert.deepEqual(Object.fromEntries(replay), {
			clipboard_copy: "unsafe",
			clipboard_paste: "safe",
			clipboard_list: "safe",
			clipboard_get: "safe",
			clipboard_restore: "unsafe",
		});

		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = Durable.createRegistry();
		registry.install(extension);
		const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
		try {
			const conversation = await harness.root(BACKGROUND_CONTEXT, {
				agent: { model: { provider: "faux", modelId: "faux-1" } },
			});
			faux.setResponses([
				fauxAssistantMessage(fauxToolCall("clipboard_copy", { content: "copied body", label: "written" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("clipboard_paste", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("clipboard_list", { limit: 10 }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("clipboard_get", { id: "seeded-entry" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("clipboard_restore", { id: "seeded-entry" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Clipboard exercise complete."),
			]);
			const settled = await (
				await conversation.submit({ type: "input", content: "Exercise the clipboard tools." }, BACKGROUND_CONTEXT)
			).wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done");

			const page = await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
			const results = page.items
				.filter((entry) => Durable.ToolResultEntry.is(entry))
				.map((entry) => entry.model?.[0] as ToolResultMessage)
				.reverse();
			assert.equal(results.length, 5, "the model called every clipboard tool once");
			const [copy, paste, list, get, restore] = results;
			for (const [name, result] of [
				["clipboard_copy", copy],
				["clipboard_paste", paste],
				["clipboard_list", list],
				["clipboard_get", get],
				["clipboard_restore", restore],
			] as const) {
				assert.notEqual(result, undefined, `${name} returned a result`);
				assert.equal(result?.isError, false, `${name} succeeded`);
			}

			const copiedId = detailsOf(copy).id;
			if (typeof copiedId !== "string") assert.fail("the copy result carries the archive id");
			assert.match(textOf(copy), /Copied to clipboard \| written \(1 lines, 11 chars\)/u);
			assert.match(textOf(copy), /Preview: copied body/u);
			assert.equal((await readEntries(archive, { id: copiedId }))[0]?.content, "copied body");

			assert.match(textOf(paste), /1 lines, 11 characters/u);
			assert.match(textOf(paste), /copied body/u);

			assert.match(textOf(list), /seeded-entry/u);
			assert.ok(textOf(list).includes(copiedId), "the copied id appears in the recent list");
			assert.equal(detailsOf(list).count, 2);

			assert.match(textOf(get), /seeded body/u);
			assert.equal(detailsOf(get).id, "seeded-entry");

			assert.match(textOf(restore), /Restored seeded-entry to clipboard \(1 lines, 11 chars\)\./u);
			assert.equal(await readFile(clipboardFile, "utf8"), "seeded body");
			const restored = (await readEntries(archive, { limit: 1, contentChars: 32 }))[0];
			assert.equal(restored?.content, "seeded body");
			assert.equal(restored?.label, "seed (restored)");

			const { messages } = await conversation.context(BACKGROUND_CONTEXT);
			const sections = messages.flatMap((message) => (message.role === "system" ? [message.sections ?? {}] : []));
			assert.ok(
				sections.some(
					(section) => typeof section.clipboard === "string" && section.clipboard.includes("clipboard_list"),
				),
				"the contribution renders its usage guidance as a prompt section",
			);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
	} finally {
		if (previous.path === undefined) delete process.env.PATH;
		else process.env.PATH = previous.path;
		if (previous.archiveDir === undefined) delete process.env.PI_CLIPBOARD_DIR;
		else process.env.PI_CLIPBOARD_DIR = previous.archiveDir;
		if (previous.destination === undefined) delete process.env.CLIPBOARD_TEST_DESTINATION;
		else process.env.CLIPBOARD_TEST_DESTINATION = previous.destination;
		await rm(root, { recursive: true, force: true });
	}
});
