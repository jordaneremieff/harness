import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

	it("keeps malformed binding rows intact when a mutation refuses the book", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			const raw = JSON.stringify({
				places: [
					{ area: "/work/area", sessionId: "ok", boundAt: "2026-01-01T00:00:00.000Z" },
					{ area: "/work/other" },
					null,
				],
			});
			writeFileSync(book.file, raw);
			assert.deepEqual(
				book.read().map((binding) => binding.sessionId),
				["ok"],
				"lookups retain usable bindings",
			);
			assert.equal(book.readState().kind, "corrupt");
			assert.throws(() => book.bind("/work/new", "new"), PlaceBookError);
			assert.equal(readFileSync(book.file, "utf8"), raw);
			assert.throws(() => book.unbind("/work/area"), PlaceBookError);
			assert.equal(readFileSync(book.file, "utf8"), raw);
			let invoked = false;
			await assert.rejects(
				book.withArea("/work/new", async () => {
					invoked = true;
					return { sessionId: "new", value: undefined };
				}),
				PlaceBookError,
			);
			assert.equal(invoked, false, "a corrupt book never starts a place operation");
			assert.equal(readFileSync(book.file, "utf8"), raw);
			assert.equal(existsSync(`${book.file}.lock`), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses unmarked live, foreign, invalid and dead claims of the exclusive-create protocol", () => {
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
			assert.throws(
				() => book.bind("/work/area", "session"),
				/exclusive-create protocol of older code, which takes no kernel lock/u,
			);
			assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "dead", "the dead claim stays");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses an exclusive-create claim at once instead of waiting for it", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root, { lockWaitMs: 5000 });
			writeFileSync(`${book.file}.lock`, claim(root, process.pid, "live"));
			const began = Date.now();
			await assert.rejects(
				book.withArea("/work/area", async () => "area"),
				PlaceLockedError,
			);
			assert.ok(Date.now() - began < 1000, "a claim that waiting cannot clear refuses without the lock wait");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses an empty lock file at any age while an exclusive-create creator can be between its two steps", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root, { lockWaitMs: 200 });
			const lock = `${book.file}.lock`;
			// The exclusive-create protocol creates the file, then writes its claim in a second call.
			closeSync(openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
			for (const offsetMs of [-10_000, 60_000, 0]) {
				const at = new Date(Date.now() + offsetMs);
				utimesSync(lock, at, at);
				await assert.rejects(
					book.withArea("/work/area", async (_current, reserve) => {
						reserve("new-session")();
						return "area";
					}),
					/exclusive-create protocol of older code/u,
				);
				assert.equal(readFileSync(lock, "utf8"), "", "the creator's file stays untouched");
			}
			// The paused creator resumes and writes its claim: the new writer still refuses until it releases.
			writeFileSync(lock, claim(root, process.pid, "older"));
			assert.throws(() => book.bind("/work/area", "new-session"), /exclusive-create protocol of older code/u);
			unlinkSync(lock);
			book.bind("/work/area", "new-session");
			assert.equal(book.exact("/work/area")?.sessionId, "new-session", "the new writer proceeds after the release");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes its lock file with the marked claim already written and leaves no private file", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			const lock = `${book.file}.lock`;
			await book.withArea("/work/area", async (_current, reserve) => {
				const held = JSON.parse(readFileSync(lock, "utf8"));
				assert.equal(held.kernel, true);
				assert.equal(lstatSync(lock).nlink, 1, "the private name is gone once the lock path names the file");
				reserve("session")();
				return "area";
			});
			assert.deepEqual(
				readdirSync(dirname(book.file)).filter((name) => name.includes("places.json.lock")),
				[],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("holds the lock across an asynchronous place operation and releases it", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			const first = await book.withArea("/work/area", async (current, reserve) => {
				assert.equal(current, undefined, "no retained owner");
				assert.throws(() => book.bind("/work/nested", "nested"), PlaceLockedError, "the lock is held");
				const publish = reserve("session-one", "the area");
				assert.equal(book.exact("/work/area"), undefined);
				publish();
				assert.equal(book.exact("/work/area")?.sessionId, "session-one");
				return "spawned";
			});
			assert.equal(first.created, true);
			assert.equal(first.binding.sessionId, "session-one");
			assert.equal(first.binding.topic, "the area");
			assert.equal(first.value, "spawned");
			const second = await book.withArea("/work/area", async (current) => {
				assert.equal(current?.sessionId, "session-one", "the retained owner is visible");
				return "reused";
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
				return "reused";
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

describe("place book kernel lock", () => {
	it("takes over the lock of an exited holder without manual cleanup", async () => {
		const root = base();
		try {
			const moduleUrl = new URL("./places.ts", import.meta.url).href;
			const script = join(root, "exit-holding.mjs");
			writeFileSync(
				script,
				`import { PlaceBook } from ${JSON.stringify(moduleUrl)};\n` +
					"const book = new PlaceBook(process.argv[2]);\n" +
					"await book.withArea('/work/held', async () => process.exit(0));\n",
			);
			assert.equal(spawnSync(process.execPath, [script, root]).status, 0);
			const book = new PlaceBook(root);
			const left = JSON.parse(readFileSync(`${book.file}.lock`, "utf8"));
			assert.equal(left.kernel, true, "the exited holder left its marked claim");
			book.bind("/work/area", "session");
			assert.equal(book.exact("/work/area")?.sessionId, "session");
			assert.equal(existsSync(`${book.file}.lock`), false, "the release removes the lock file");
			writeFileSync(`${book.file}.lock`, "", { mode: 0o600 });
			assert.throws(
				() => book.bind("/work/second", "second"),
				/exclusive-create protocol of older code/u,
				"an empty file can belong to an exclusive-create creator, so it refuses",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("waits a bounded time for a live holder and excludes the exclusive-create protocol", async () => {
		const root = base();
		try {
			const holder = new PlaceBook(root);
			let publish: () => void = () => {};
			let entered: () => void = () => {};
			const inside = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let finish: () => void = () => {};
			const done = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const held = holder.withArea("/work/first", async (_current, reserve) => {
				publish = reserve("first");
				entered();
				await done;
				return "first";
			});
			await inside;
			assert.throws(
				() => openSync(`${holder.file}.lock`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600),
				/EEXIST/u,
				"an exclusive-create holder sees the lock as taken",
			);
			await assert.rejects(
				new PlaceBook(root, { lockWaitMs: 50 }).withArea("/work/other", async () => "other"),
				(error: Error) => error.name === "PlaceLockedError" && error.message.includes(`process ${process.pid}`),
			);
			const waiting = new PlaceBook(root, { lockWaitMs: 10_000 }).withArea("/work/other", async (current, reserve) => {
				assert.equal(current, undefined);
				reserve("other")();
				return "other";
			});
			publish();
			const second = await waiting;
			assert.equal(second.binding.sessionId, "other", "the waiter proceeds once the holder publishes");
			finish();
			assert.equal((await held).value, "first");
			assert.equal(existsSync(`${holder.file}.lock`), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("measures the wait for a live holder on a clock that wall-clock steps do not move", async (t) => {
		const root = base();
		try {
			const holder = new PlaceBook(root);
			let publish: () => void = () => {};
			let entered: () => void = () => {};
			const inside = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let finish: () => void = () => {};
			const done = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const held = holder.withArea("/work/first", async (_current, reserve) => {
				publish = reserve("first");
				entered();
				await done;
				return "first";
			});
			await inside;
			// The wall clock steps an hour forward after the waiter's first reading.
			const wall = Date.now;
			let readings = 0;
			t.mock.method(Date, "now", () => wall() + (++readings > 1 ? 3_600_000 : 0));
			const waiting = new PlaceBook(root, { lockWaitMs: 10_000 }).withArea("/work/other", async (_current, reserve) => {
				reserve("other")();
				return "other";
			});
			// The first attempt runs in the call itself: the waiter found the lock busy and decided to wait or refuse.
			publish();
			assert.equal((await waiting).binding.sessionId, "other", "the waiter kept waiting and took the lock");
			finish();
			await held;
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs a reuse operation and the work after publication outside the lock", async () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/area", "owner");
			const reused = await book.withArea("/work/area", async (current) => {
				assert.equal(current?.sessionId, "owner");
				book.bind("/work/elsewhere", "during-reuse");
				return "reused";
			});
			assert.equal(reused.value, "reused");
			await book.withArea("/work/new", async (_current, reserve) => {
				reserve("new")();
				book.bind("/work/after-publication", "after");
				return "created";
			});
			assert.equal(book.exact("/work/elsewhere")?.sessionId, "during-reuse");
			assert.equal(book.exact("/work/after-publication")?.sessionId, "after");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
