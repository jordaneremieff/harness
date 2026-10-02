import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PLACE_FILE_MAX_BYTES, PlaceBook, PlaceBookError, PlaceLockedError } from "./places.ts";

function base(): string {
	return mkdtempSync(join(tmpdir(), "agent-places-"));
}

/** One shared-shape lock claim for the book in `root`. */
function claim(root: string, pid: number, token: string, host = hostname()): string {
	return `${JSON.stringify({
		token,
		pid,
		host,
		sessionId: "agent.places",
		cwd: root,
		createdAt: new Date().toISOString(),
	})}\n`;
}

describe("place bindings", () => {
	it("resolves the longest matching area and keeps unrelated areas separate", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/project", "session-root");
			book.bind("/work/project/extensions/agent", "session-agent", "the agent slice");
			assert.equal(book.resolve("/work/project/README.md")?.sessionId, "session-root");
			assert.equal(book.resolve("/work/project/extensions/agent")?.sessionId, "session-agent");
			assert.equal(book.resolve("/work/project/extensions/agent/worker.ts")?.sessionId, "session-agent");
			assert.equal(book.resolve("/work/project-two/file.ts"), undefined);
			assert.equal(book.exact("/work/project/extensions")?.sessionId, undefined);
			assert.equal(book.resolve("/work/project/extensions/agent")?.topic, "the agent slice");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rebinds an area in place and unbinds it", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/area", "first");
			book.bind("/work/area", "second", "topic");
			assert.equal(book.read().length, 1);
			assert.equal(book.exact("/work/area")?.sessionId, "second");
			assert.equal(book.unbind("/work/area")?.sessionId, "second");
			assert.equal(book.unbind("/work/area"), undefined);
			assert.deepEqual(book.read(), []);
			assert.equal(existsSync(`${book.file}.lock`), false, "no lock remains after mutations");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports corruption and refuses to replace a damaged book", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/area", "session-one");
			assert.deepEqual(JSON.parse(readFileSync(book.file, "utf8")).places[0].sessionId, "session-one");
			writeFileSync(book.file, "{ not json", "utf8");
			assert.equal(book.readState().kind, "corrupt", "corruption is explicit");
			assert.deepEqual(book.read(), [], "lookup reads stay tolerant");
			assert.equal(book.resolve("/work/area"), undefined);
			assert.throws(
				() => book.bind("/work/area", "session-two"),
				PlaceBookError,
				"a mutation refuses the damaged book",
			);
			assert.equal(readFileSync(book.file, "utf8"), "{ not json", "the damaged bytes are kept");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops records that are not bindings", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			writeFileSync(
				book.file,
				JSON.stringify({
					places: [
						{ area: "/work/area", sessionId: "ok", boundAt: "2026-01-01T00:00:00.000Z" },
						{ area: "/work/other" },
						null,
					],
				}),
				"utf8",
			);
			assert.deepEqual(
				book.read().map((binding) => binding.sessionId),
				["ok"],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a live or foreign lock and recovers a dead local one", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			const lock = `${book.file}.lock`;
			writeFileSync(lock, claim(root, process.pid, "live"));
			assert.throws(() => book.bind("/work/area", "session"), PlaceLockedError, "a live holder refuses the mutation");
			assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "live", "the live claim stays");
			writeFileSync(lock, claim(root, process.pid, "foreign", "another-host"));
			assert.throws(() => book.bind("/work/area", "session"), PlaceLockedError, "a foreign host claim is unverifiable");
			assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "foreign", "the foreign claim stays");
			writeFileSync(lock, `${JSON.stringify({ token: "invalid" })}\n`);
			assert.throws(() => book.bind("/work/area", "session"), PlaceLockedError, "an invalid claim refuses");
			const dead = spawnSync(process.execPath, ["-e", ""]);
			assert.ok(dead.pid, "the helper process has a pid");
			writeFileSync(lock, claim(root, dead.pid, "dead"));
			book.bind("/work/area", "session");
			assert.equal(book.exact("/work/area")?.sessionId, "session");
			assert.equal(existsSync(lock), false, "the stale local lock is gone");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("holds the lock across an asynchronous place operation and releases it", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			const first = await book.withArea("/work/area", async (current) => {
				assert.equal(current, undefined, "no retained owner");
				assert.throws(() => book.bind("/work/nested", "nested"), PlaceLockedError, "the lock is held");
				return { value: "spawned", sessionId: "session-one", topic: "the area" };
			});
			assert.equal(first.created, true);
			assert.equal(first.binding.sessionId, "session-one");
			assert.equal(first.binding.topic, "the area");
			assert.equal(first.value, "spawned");
			const second = await book.withArea("/work/area", async (current) => {
				assert.equal(current?.sessionId, "session-one", "the retained owner is visible");
				return { value: "reused", sessionId: current.sessionId, topic: current.topic };
			});
			assert.equal(second.created, false);
			assert.equal(second.value, "reused");
			assert.equal(book.exact("/work/area")?.sessionId, "session-one");
			await assert.rejects(
				book.withArea("/work/area", async () => {
					throw new Error("operation failed");
				}),
				/operation failed/u,
			);
			assert.equal(existsSync(`${book.file}.lock`), false, "no lock leaks on failure");
			book.bind("/work/area", "session-two");
			assert.equal(book.exact("/work/area")?.sessionId, "session-two");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reuses a parent binding for a subdirectory without writing a narrower binding", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/project", "session-parent", "parent");
			const transaction = await book.withArea("/work/project/extensions", async (current) => {
				assert.equal(current?.sessionId, "session-parent", "the parent binding is current");
				return { value: "reused", sessionId: current.sessionId, topic: current.topic };
			});
			assert.equal(transaction.created, false);
			assert.equal(transaction.binding.sessionId, "session-parent");
			assert.equal(book.exact("/work/project/extensions"), undefined, "no narrower binding is written");
			assert.equal(book.exact("/work/project")?.sessionId, "session-parent");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not read or write through a symlinked book", () => {
		if (!constants.O_NOFOLLOW) return;
		const root = base();
		try {
			const victim = join(root, "victim.json");
			writeFileSync(
				victim,
				JSON.stringify({ places: [{ area: "/victim", sessionId: "victim", boundAt: "2026-01-01T00:00:00.000Z" }] }),
				"utf8",
			);
			const book = new PlaceBook(root);
			symlinkSync(victim, book.file);
			assert.equal(book.readState().kind, "corrupt", "a symlinked book is explicit corruption");
			assert.deepEqual(book.read(), [], "a symlinked book reads as absent");
			assert.throws(() => book.bind("/work/area", "session-one"), PlaceBookError, "a mutation refuses the symlink");
			assert.equal(JSON.parse(readFileSync(victim, "utf8")).places[0].sessionId, "victim", "the target is unchanged");
			assert.equal(lstatSync(book.file).isSymbolicLink(), true, "the symlink is kept");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses to replace a book that is too large to read", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			writeFileSync(book.file, "x".repeat(PLACE_FILE_MAX_BYTES + 1));
			assert.equal(book.readState().kind, "corrupt", "the oversized book is explicit corruption");
			assert.deepEqual(book.read(), [], "the bounded read reports nothing");
			assert.throws(() => book.bind("/work/area", "session"), PlaceBookError);
			assert.equal(
				readFileSync(book.file, "utf8").length,
				PLACE_FILE_MAX_BYTES + 1,
				"the oversized file keeps its data",
			);
			assert.equal(existsSync(`${book.file}.lock`), false, "the refused mutation releases its lock");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a book path that is not a regular file", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			mkdirSync(book.file);
			assert.equal(book.readState().kind, "corrupt");
			assert.throws(() => book.bind("/work/area", "session"), PlaceBookError);
			assert.ok(lstatSync(book.file).isDirectory(), "the directory is kept");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serializes concurrent independent process mutations", async () => {
		const root = base();
		try {
			const moduleUrl = new URL("./places.ts", import.meta.url).href;
			const children = 6;
			const each = 30;
			await Promise.all(Array.from({ length: children }, (_, id) => runBinder(moduleUrl, root, id, each)));
			const book = new PlaceBook(root);
			assert.equal(book.read().length, children * each, "every concurrent binding survives");
			assert.equal(book.exact(`/work/${children - 1}/${each - 1}`)?.sessionId, `session-${children - 1}-${each - 1}`);
			assert.equal(existsSync(`${book.file}.lock`), false, "no lock remains");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

/** Run one child process that performs several independent bind mutations against the same book. */
function runBinder(moduleUrl: string, root: string, id: number, count: number): Promise<void> {
	const script = join(root, `bind-${id}.mjs`);
	writeFileSync(
		script,
		`import { PlaceBook } from ${JSON.stringify(moduleUrl)};\n` +
			"const [root, id, count] = process.argv.slice(2);\n" +
			"const book = new PlaceBook(root);\n" +
			"for (let index = 0; index < Number(count); index++) {\n" +
			'  const area = "/work/" + id + "/" + index;\n' +
			'  const session = "session-" + id + "-" + index;\n' +
			"  for (;;) {\n" +
			"    try { book.bind(area, session); break; }\n" +
			'    catch (error) { if (error?.name !== "PlaceLockedError") throw error; }\n' +
			"  }\n" +
			"}\n",
		"utf8",
	);
	return new Promise<void>((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, [script, root, String(id), String(count)], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", rejectRun);
		child.once("exit", (code) => {
			if (code === 0) resolveRun();
			else rejectRun(new Error(`binder ${id} exited with ${String(code)}: ${stderr}`));
		});
	});
}
