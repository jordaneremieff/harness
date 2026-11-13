import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { materializeAndReveal, readLaunchOrigin, revealNotice, revealSaved, saveResponse, selectStored, waitForAcceptance, type RevealRuntime } from "./reveal.ts";
import { MarkdownStore } from "./store.ts";
import { responseSnapshot } from "./responses.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

async function fixture(build: unknown = { contract: 1 }) {
	const root = await mkdtemp(join(tmpdir(), "markdown-reveal-"));
	const app = join(root, "client", "Reader.app");
	const resources = join(app, "Contents", "Resources");
	await mkdir(resources, { recursive: true });
	if (build !== null) await writeFile(join(resources, "build.json"), JSON.stringify(build));
	const store = new MarkdownStore(join(root, "host-store"));
	const result = await store.create({ title: "Saved", source: "Exact saved Markdown", contentOrigin: { kind: "tool", capturedAt: new Date().toISOString() } });
	const saved = await selectStored(store.root, result.document.id);
	const previous = process.env.PI_MARKDOWN_APP;
	process.env.PI_MARKDOWN_APP = app;
	const calls: { executable: string; args: string[] }[] = [];
	const runtime: RevealRuntime = { platform: "darwin", acceptanceMs: 5, run: async (executable, args) => { calls.push({ executable, args }); return { stdout: "null" }; } };
	return { root, app, store, saved, calls, runtime, cleanup: async () => { if (previous === undefined) delete process.env.PI_MARKDOWN_APP; else process.env.PI_MARKDOWN_APP = previous; await rm(root, { recursive: true, force: true }); } };
}
test("reveal opens the client app for a host-store document with pinned identity and request-only origin", async () => {
	const f = await fixture();
	try {
		const origin = { version: 1, terminal: "Rex", application: { bundleId: "com.superlogical.rex" }, exact: { opaque: "target" } };
		const runtime: RevealRuntime = { ...f.runtime, run: async (exe, args) => { f.calls.push({ executable: exe, args }); return { stdout: JSON.stringify(origin) }; } };
		const result = await revealSaved(f.saved, new AbortController().signal, runtime);
		assert.equal(result.state, "not-confirmed");
		assert.equal(f.calls[0].executable, process.execPath);
		assert.match(f.calls[0].args[0], /extensions\/rex\/terminal-origin\.ts$/u);
		assert.equal(f.calls[0].args[1], "capture");
		assert.equal(f.calls[1].executable, "/usr/bin/open");
		assert.deepEqual(f.calls[1].args.slice(0, 2), ["-a", f.app]);
		assert.equal(f.calls[1].args.length, 3);
		const request = JSON.parse(await readFile(f.calls[1].args[2], "utf8"));
		assert.deepEqual(request.launchOrigin, origin);
		assert.equal(request.document, f.saved.documentId);
		assert.equal(request.revision, 1);
		assert.equal(request.storeId, f.saved.storeId);
		assert.equal(request.digest, f.saved.digest);
		assert.equal("launchOrigin" in (await f.store.get(f.saved.documentId)).revision, false);
		await assert.rejects(selectStored(f.store.root, f.saved.documentId, "0".repeat(32)), /differs/u);
		await assert.rejects(selectStored(join(f.root, "remote-store"), f.saved.documentId, f.saved.storeId), /not readable/u);
	} finally { await f.cleanup(); }
});
test("a missing published directory under the expected store is not locally available", async () => {
	const f = await fixture();
	try {
		await rm(join(f.store.root, "documents", f.saved.documentId), { recursive: true });
		assert.equal((await f.store.identity())?.storeId, f.saved.storeId);
		await assert.rejects(selectStored(f.store.root, f.saved.documentId, f.saved.storeId), /The published document is not locally available\./u);
	} finally { await f.cleanup(); }
});
test("a successful open with a failed acceptance watch remains not-confirmed", async () => {
	const f = await fixture();
	try {
		const result = await revealSaved(f.saved, new AbortController().signal, { ...f.runtime, run: async (exe, args) => {
			if (exe === "/usr/bin/open") await rm(dirname(args[2]), { recursive: true });
			return f.runtime.run(exe, args, { timeout: 1000, maxBuffer: 8192 });
		} });
		assert.equal(f.calls.filter((call) => call.executable === "/usr/bin/open").length, 1);
		assert.equal(result.state, "not-confirmed");
		assert.equal((await f.store.get(f.saved.documentId)).source, "Exact saved Markdown");
	} finally { await f.cleanup(); }
});
test("stale before save starts no process; stale after save never launches the reader", async () => {
	const f = await fixture();
	try {
		let saves = 0;
		const first = new AbortController(); first.abort();
		await assert.rejects(materializeAndReveal(async () => { saves++; return f.saved; }, first.signal, { gui: true, runtime: f.runtime }));
		assert.equal(saves, 0);
		const second = new AbortController();
		await assert.rejects(materializeAndReveal(async () => { saves++; second.abort(); return f.saved; }, second.signal, { gui: true, runtime: f.runtime }));
		assert.equal(saves, 1);
		assert.equal(f.calls.length, 1, "origin capture overlaps materialization");
		assert.equal(f.calls[0].executable, process.execPath);
		assert.equal((await f.store.get(f.saved.documentId)).source, "Exact saved Markdown");
	} finally { await f.cleanup(); }
});
test("stale after origin capture never invokes open", async () => {
	const f = await fixture();
	try {
		const controller = new AbortController();
		await assert.rejects(revealSaved(f.saved, controller.signal, { ...f.runtime, run: async (exe, args) => { f.calls.push({ executable: exe, args }); controller.abort(); return { stdout: "null" }; } }));
		assert.equal(f.calls.length, 1);
		assert.equal(f.calls[0].executable, process.execPath);
	} finally { await f.cleanup(); }
});
test("missing, incompatible, non-Mac and failed launch retain saved source", async () => {
	for (const [build, platform, failure, expected] of [[null, "darwin", false, "app-missing"], [{ contract: 2 }, "darwin", false, "app-incompatible"], [{ contract: 1 }, "linux", false, "unsupported-platform"], [{ contract: 1 }, "darwin", true, "launch-failed"]] as const) {
		const f = await fixture(build);
		try {
			const result = await revealSaved(f.saved, new AbortController().signal, { ...f.runtime, platform, run: async (exe) => { if (failure && exe === "/usr/bin/open") throw new Error("launch failed"); return { stdout: "null" }; } });
			assert.equal(result.state, "reveal-failed");
			if (result.state === "reveal-failed") { assert.equal(result.reason, expected); if (expected !== "unsupported-platform") assert.match(result.remedy, /native\/build\.mts/u);
				assert.match(revealNotice(result), /^Saved md-[a-f0-9]{8} revision 1\. The reader/u); }
			assert.equal((await f.store.get(f.saved.documentId)).source, "Exact saved Markdown");
		} finally { await f.cleanup(); }
	}
});
test("origin capture failure does not block reveal; reader acceptance and headless save remain distinct", async () => {
	const f = await fixture();
	try {
		const result = await revealSaved(f.saved, new AbortController().signal, { ...f.runtime, run: async (exe, args) => {
			if (exe === process.execPath) throw new Error("missing helper");
			assert.equal(JSON.parse(await readFile(args[2], "utf8")).launchOrigin, null);
			await rm(args[2]);
			return f.runtime.run(exe, args, { timeout: 1000, maxBuffer: 8192 });
		} });
		assert.equal(result.state, "accepted");
		const before = f.calls.length;
		assert.equal((await materializeAndReveal(async () => f.saved, new AbortController().signal, { gui: false, runtime: f.runtime })).state, "saved");
		assert.equal(f.calls.length, before);
		assert.equal(readLaunchOrigin({ version: 1, terminal: "Rex", application: { bundleId: "untrusted" } }), null);
	} finally { await f.cleanup(); }
});
test("origin capture starts alongside saving and both finish before the request", async () => {
	const f = await fixture();
	try {
		let finishOrigin: (value: { stdout: string }) => void = () => {};
		let finishSave: (value: typeof f.saved) => void = () => {};
		let captureStarted = false;
		const runtime: RevealRuntime = { ...f.runtime, run: async (exe, args) => {
			if (exe === process.execPath) { captureStarted = true; return new Promise((resolve) => { finishOrigin = resolve; }); }
			await rm(args[2]);
			return f.runtime.run(exe, args, { timeout: 1000, maxBuffer: 8192 });
		} };
		const pending = materializeAndReveal(() => {
			assert.equal(captureStarted, true);
			return new Promise((resolve) => { finishSave = resolve; });
		}, new AbortController().signal, { gui: true, runtime });
		finishSave(f.saved);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(await readdir(join(f.store.root, "opens")), []);
		finishOrigin({ stdout: "null" });
		const accepted = await pending;
		assert.equal(accepted.state, "accepted");
		assert.equal(revealNotice(accepted), `Markdown Reader accepted ${f.saved.documentId.slice(0, 11)} revision 1.`);
		assert.equal(revealNotice({ ...f.saved, state: "saved" }), `Saved ${f.saved.documentId.slice(0, 11)} revision 1. No window was opened.`);
		assert.match(revealNotice({ ...f.saved, state: "not-confirmed", request: "unused" }), /did not confirm within 5 seconds\. If no window appeared, run node extensions\/markdown\/native\/build\.mts/u);
	} finally { await f.cleanup(); }
});
test("response labels use the working directory and local response time, with capture time as fallback", async () => {
	const f = await fixture();
	try {
		const response = responseSnapshot(fauxAssistantMessage("Response source", { timestamp: new Date(2026, 0, 2, 3, 4).getTime() }), "42", { kind: "native-response", session: "s", conversation: "1", cwd: "/work/example" });
		assert.ok(response);
		const saved = await saveResponse(response, f.store.root);
		assert.equal((await f.store.get(saved.documentId)).document.title, "Response · example · 2026-01-02 03:04");
		response.entryId = "43";
		response.timestamp = undefined;
		response.provenance.capturedAt = new Date(2026, 1, 3, 4, 5).toISOString();
		const fallback = await saveResponse(response, f.store.root);
		assert.equal((await f.store.get(fallback.documentId)).document.title, "Response · example · 2026-02-03 04:05");
	} finally { await f.cleanup(); }
});
test("the default acceptance deadline permits five seconds", async (t) => {
	const f = await fixture();
	try {
		const request = await f.store.writeOpenRequest(f.saved.documentId, f.saved.revision);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		let settled = false;
		const waiting = waitForAcceptance(request, new AbortController().signal).then((value) => { settled = true; return value; });
		t.mock.timers.tick(4999);
		await Promise.resolve();
		assert.equal(settled, false);
		t.mock.timers.tick(1);
		assert.equal(await waiting, false);
	} finally { t.mock.timers.reset(); await f.cleanup(); }
});
test("request pruning removes old UUID envelopes only; acceptance wait aborts", async () => {
	const f = await fixture();
	try {
		const old = "00000000-0000-0000-0000-000000000000.json";
		await writeFile(join(f.store.root, "opens", old), "{}");
		await writeFile(join(f.store.root, "opens", "unrelated.json"), "{}");
		await utimes(join(f.store.root, "opens", old), new Date(0), new Date(0));
		const request = await f.store.writeOpenRequest(f.saved.documentId, f.saved.revision);
		assert.equal((await readdir(join(f.store.root, "opens"))).includes(old), false);
		assert.ok((await readdir(join(f.store.root, "opens"))).includes("unrelated.json"));
		const controller = new AbortController();
		const waiting = waitForAcceptance(request, controller.signal);
		controller.abort();
		await assert.rejects(waiting, /abort/iu);
	} finally { await f.cleanup(); }
});
