import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { findSessionFile, readSessionModel } from "./primary-session-model.ts";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "session-model-"));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}
const model = (provider: string, modelId: string) => JSON.stringify({ type: "model_change", provider, modelId });
const thinking = (thinkingLevel: string) => JSON.stringify({ type: "thinking_level_change", thinkingLevel });
const assistant = (provider: string, id: string) =>
	JSON.stringify({ type: "message", message: { role: "assistant", provider, model: id } });

it("finds a session by its exact filename suffix in a working-directory folder", async () => {
	await fixture(async (root) => {
		const id = "session-12345678";
		const folder = join(root, "workspace");
		await mkdir(folder);
		await writeFile(join(folder, `time_${id}-other.jsonl`), "");
		await writeFile(join(folder, `time_${id}.jsonl.backup`), "");
		const file = join(folder, `time_${id}.jsonl`);
		await writeFile(file, "");
		assert.equal(await findSessionFile(root, id), file);
		assert.equal(await findSessionFile(root, "absent-12345678"), undefined);
	});
});

it("ignores hidden folders and files outside a working-directory folder", async () => {
	await fixture(async (root) => {
		const id = "session-12345678";
		await mkdir(join(root, ".hidden"));
		await writeFile(join(root, ".hidden", `time_${id}.jsonl`), "");
		await writeFile(join(root, `time_${id}.jsonl`), "");
		assert.equal(await findSessionFile(root, id), undefined);
	});
});

it("returns undefined for invalid identities and absent or unreadable session roots", async () => {
	await fixture(async (root) => {
		for (const id of ["", "short", "../session-12345678", "x".repeat(129), "session_12345678"])
			assert.equal(await findSessionFile(root, id), undefined);
		assert.equal(await findSessionFile(join(root, "absent"), "session-12345678"), undefined);
		const file = join(root, "not-a-directory");
		await writeFile(file, "");
		assert.equal(await findSessionFile(file, "session-12345678"), undefined);
	});
});

it("uses the newest model and thinking level independently", async () => {
	await fixture(async (root) => {
		const file = join(root, "session.jsonl");
		await writeFile(
			file,
			[
				model("first", "one"),
				thinking("low"),
				assistant("second", "two"),
				thinking("high"),
				model("last", "three"),
				thinking("max"),
			].join("\n"),
		);
		assert.deepEqual(await readSessionModel(file), { provider: "last", modelId: "three", thinkingLevel: "max" });
		await writeFile(file, [model("first", "one"), thinking("medium"), assistant("last", "two")].join("\n"));
		assert.deepEqual(await readSessionModel(file), { provider: "last", modelId: "two", thinkingLevel: "medium" });
	});
});

it("keeps model facts from the head when a long session has no model change in its tail", async () => {
	await fixture(async (root) => {
		const file = join(root, "session.jsonl");
		const padding =
			`${JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(1024) } })}\n`.repeat(400);
		await writeFile(file, `${model("head", "initial")}\n${thinking("low")}\n${padding}${thinking("high")}\n`);
		assert.deepEqual(await readSessionModel(file), { provider: "head", modelId: "initial", thinkingLevel: "high" });
	});
});

it("reads newest facts from the tail of a long session and ignores partial boundary records", async () => {
	await fixture(async (root) => {
		const file = join(root, "session.jsonl");
		const longRecord = JSON.stringify({
			type: "message",
			message: { role: "user", content: `model thinking ${"x".repeat(400 * 1024)}` },
		});
		await writeFile(
			file,
			`${model("head", "initial")}\n${thinking("low")}\n${longRecord}\n${assistant("tail", "latest")}\n${thinking("xhigh")}\n`,
		);
		assert.deepEqual(await readSessionModel(file), { provider: "tail", modelId: "latest", thinkingLevel: "xhigh" });
	});
});

it("ignores malformed records and other message roles without losing valid model facts", async () => {
	await fixture(async (root) => {
		const file = join(root, "session.jsonl");
		await writeFile(
			file,
			[
				model("valid", "selected"),
				'{"type":"model_change",',
				"null",
				"[]",
				JSON.stringify({ type: "model_change", provider: "bad", modelId: 3 }),
				JSON.stringify({ type: "thinking_level_change", thinkingLevel: 3 }),
				JSON.stringify({ type: "message", message: { role: "user", provider: "wrong", model: "ignored" } }),
			].join("\n"),
		);
		assert.deepEqual(await readSessionModel(file), { provider: "valid", modelId: "selected" });
	});
});

it("returns undefined for absent, unreadable, empty or model-free session files", async () => {
	await fixture(async (root) => {
		assert.equal(await readSessionModel(join(root, "absent")), undefined);
		assert.equal(await readSessionModel(root), undefined);
		const file = join(root, "session.jsonl");
		for (const content of ["", "not json model thinking", thinking("high")]) {
			await writeFile(file, content);
			assert.equal(await readSessionModel(file), undefined);
		}
	});
});
