import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsPromises, { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { NamedData } from "./data.ts";
import { namedDataRevision, type RuleEvent, RuleRegistry } from "./local-rules.ts";
import { type PackageDefinitionRow, packageRowRevision } from "./rule.ts";

const audit = { surface: "command" as const, at: "2026-09-12T00:00:00.000Z", session: "synthetic", model: null };
const agent = { ...audit, surface: "agent-tool" as const };
const lockName = ".rules-lock";
const row = (): PackageDefinitionRow => {
	const value = {
		id: "synthetic.catalog",
		purpose: "Bound synthetic output.",
		authority: "steer-or-block" as const,
		matcher: { kind: "declarative" as const, language: "command-shape/v1" as const, spec: { command: "synthetic" } },
		effect: "block" as const,
		note: "Use bounded output.",
	};
	return { ...value, revision: packageRowRevision(value) };
};
const binding = (value: string): NamedData => {
	const data = {
		name: "synthetic",
		kind: "table" as const,
		source: "operator",
		capturedAt: 1000,
		rows: [{ key: "key", value }],
	};
	return { ...data, revision: namedDataRevision(data) };
};
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function directory(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "policy-transactions-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}
const registry = (dir: string, catalog: PackageDefinitionRow[] = []) =>
	new RuleRegistry(dir, { catalog, onNotice() {} });
type Internals = {
	append: (...args: unknown[]) => Promise<void>;
	transaction: <T>(action: () => Promise<T>) => Promise<T>;
};
function pause(reg: RuleRegistry, method: "append" | "transaction") {
	const entered = deferred();
	const release = deferred();
	const internal = reg as unknown as Internals;
	if (method === "append") {
		const original = internal.append.bind(reg);
		internal.append = async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		};
	} else {
		const original = internal.transaction.bind(reg);
		internal.transaction = (action) =>
			original(async () => {
				entered.resolve();
				await release.promise;
				return action();
			});
	}
	return { entered: entered.promise, release: release.resolve };
}
function observeContention(t: TestContext) {
	const contended = deferred();
	const original = fsPromises.open;
	const replacement = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
		try {
			return await original(...args);
		} catch (error) {
			if (String(args[0]).endsWith(lockName) && (error as NodeJS.ErrnoException).code === "EEXIST") contended.resolve();
			throw error;
		}
	});
	syncBuiltinESMExports();
	t.after(() => {
		replacement.mock.restore();
		syncBuiltinESMExports();
	});
	return contended.promise;
}
async function events(reg: RuleRegistry): Promise<RuleEvent[]> {
	return (await readFile(reg.path, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
async function conflictEvents(
	reg: RuleRegistry,
	kind: string,
): Promise<[Exclude<RuleEvent, { kind: "catalog" }>, Exclude<RuleEvent, { kind: "catalog" }>]> {
	const old = binding("old");
	if (kind === "approve/reject") {
		const definition = row();
		const proposal = await reg.proposeAdd(
			{
				id: "synthetic.local",
				purpose: definition.purpose,
				authority: definition.authority,
				matcher: definition.matcher,
				note: definition.note,
			},
			"Bound output.",
			agent,
		);
		return [
			{ kind: "decision", id: randomUUID(), proposalId: proposal.id, decision: "approved", effect: "block", audit },
			{ kind: "decision", id: randomUUID(), proposalId: proposal.id, decision: "rejected", audit },
		];
	}
	await reg.setData(old, null, audit);
	return [
		{ kind: "data", id: randomUUID(), operation: "set", data: binding("next"), expectedRevision: old.revision, audit },
		kind === "set/remove"
			? { kind: "data", id: randomUUID(), operation: "remove", name: old.name, expectedRevision: old.revision, audit }
			: {
					kind: "data",
					id: randomUUID(),
					operation: "set",
					data: binding("other"),
					expectedRevision: old.revision,
					audit,
				},
	];
}
function conflictPattern(kind: string) {
	return kind === "approve/reject" ? /no pending proposal/ : /revision changed/;
}
async function assertWinner(reg: RuleRegistry, winner: RuleEvent) {
	const snapshot = await reg.snapshot();
	assert.equal(snapshot.health.status, "ok");
	assert.equal(snapshot.pending.length, 0);
	if (winner.kind === "data" && winner.operation === "set")
		assert.equal(snapshot.data.get(winner.data.name)?.revision, winner.data.revision);
	if (winner.kind === "decision") assert.equal(snapshot.records.get("synthetic.local")?.definition.effect, "block");
	assert.equal(
		(await events(reg)).filter((event) => "id" in event && event.id === (winner as { id: string }).id).length,
		1,
	);
	await assert.rejects(lstat(join(reg.path, "..", lockName)), /ENOENT/);
}
type Message = { type: string; error?: string };
function inbox(child: ChildProcess) {
	const messages: Message[] = [];
	const waiting = new Map<string, (message: Message) => void>();
	child.on("message", (message: Message) => {
		const waiter = waiting.get(message.type);
		if (waiter) {
			waiting.delete(message.type);
			waiter(message);
		} else messages.push(message);
	});
	return (type: string) => {
		const index = messages.findIndex((message) => message.type === type);
		if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
		return new Promise<Message>((resolve) => waiting.set(type, resolve));
	};
}
interface ChildConfig {
	dir: string;
	catalog: PackageDefinitionRow[];
	event?: RuleEvent;
	hold?: "append" | "transaction";
}
function worker(t: TestContext, config: ChildConfig) {
	const child = fork(fileURLToPath(import.meta.url), ["--transaction-child", JSON.stringify(config)], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const next = inbox(child);
	let stderr = "";
	child.stderr!.on("data", (chunk: Buffer) => {
		stderr = (stderr + String(chunk)).slice(-4000);
	});
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited;
		assert.equal(stderr, "");
	});
	return { child, next, exited };
}

if (process.argv[2] === "--transaction-child") {
	const config = JSON.parse(process.argv[3]) as ChildConfig;
	const reg = registry(config.dir, config.catalog);
	if (config.event) await reg.snapshot();
	const next = inbox(process as unknown as ChildProcess);
	const gate = config.hold ? pause(reg, config.hold) : undefined;
	if (gate) {
		void gate.entered.then(() => process.send!({ type: "held" }));
		void next("release").then(() => gate.release());
	}
	const original = fsPromises.open;
	let notified = false;
	fsPromises.open = (async (...args: Parameters<typeof fsPromises.open>) => {
		try {
			return await original(...args);
		} catch (error) {
			if (!notified && String(args[0]).endsWith(lockName) && (error as NodeJS.ErrnoException).code === "EEXIST") {
				notified = true;
				process.send!({ type: "contended" });
			}
			throw error;
		}
	}) as typeof fsPromises.open;
	syncBuiltinESMExports();
	process.send!({ type: "ready" });
	await next("start");
	try {
		if (config.event) await reg.writeEvent(config.event as Exclude<RuleEvent, { kind: "catalog" }>);
		else assert.equal((await reg.snapshot()).health.status, "ok");
		process.send!({ type: "result" });
	} catch (error) {
		process.send!({ type: "result", error: String(error) });
	}
	process.disconnect();
} else {
	describe("rule registry transactions", { timeout: 15000 }, () => {
		it("keeps same-instance data creation serialized", async (t) => {
			const dir = await directory(t);
			const reg = registry(dir);
			const results = await Promise.allSettled([
				reg.setData(binding("first"), null, audit),
				reg.setData(binding("second"), null, audit),
			]);
			assert.deepEqual(
				results.map((result) => result.status),
				["fulfilled", "rejected"],
			);
			assert.equal((await reg.snapshot()).data.get("synthetic")?.revision, binding("first").revision);
		});
		for (const kind of ["set/set", "set/remove", "approve/reject"]) {
			it(`rejects the conflicting ${kind} across registry instances`, async (t) => {
				const dir = await directory(t);
				const first = registry(dir);
				const second = registry(dir);
				await Promise.all([first.snapshot(), second.snapshot()]);
				const [left, right] = await conflictEvents(first, kind);
				const gate = pause(first, "append");
				t.after(gate.release);
				const contended = observeContention(t);
				const success = first.writeEvent(left);
				await gate.entered;
				const conflict = assert.rejects(second.writeEvent(right), conflictPattern(kind));
				await contended;
				gate.release();
				await Promise.all([success, conflict]);
				assert.equal(
					(await events(first)).some((event) => "id" in event && event.id === right.id),
					false,
				);
				await assertWinner(first, left);
			});
			it(`rejects the conflicting ${kind} across OS processes`, async (t) => {
				const dir = await directory(t);
				const reg = registry(dir);
				const [left, right] = await conflictEvents(reg, kind);
				const first = worker(t, { dir, catalog: [], event: left, hold: "append" });
				const second = worker(t, { dir, catalog: [], event: right });
				await Promise.all([first.next("ready"), second.next("ready")]);
				first.child.send({ type: "start" });
				await first.next("held");
				second.child.send({ type: "start" });
				await second.next("contended");
				first.child.send({ type: "release" });
				assert.equal((await first.next("result")).error, undefined);
				assert.match((await second.next("result")).error ?? "", conflictPattern(kind));
				await Promise.all([first.exited, second.exited]);
				assert.equal(
					(await events(reg)).some((event) => "id" in event && event.id === right.id),
					false,
				);
				await assertWinner(reg, left);
			});
		}
		it("serializes catalog initialization across instances", async (t) => {
			const dir = await directory(t);
			const rows = [row()];
			const first = registry(dir, rows);
			const second = registry(dir, rows);
			const gate = pause(first, "transaction");
			t.after(gate.release);
			const contended = observeContention(t);
			const left = first.snapshot();
			await gate.entered;
			const right = second.snapshot();
			await contended;
			gate.release();
			for (const state of await Promise.all([left, right])) assert.equal(state.health.status, "ok");
			assert.equal((await events(first)).filter((event) => event.kind === "catalog").length, 1);
		});
		it("serializes catalog initialization across OS processes", async (t) => {
			const dir = await directory(t);
			const catalog = [row()];
			const first = worker(t, { dir, catalog, hold: "transaction" });
			const second = worker(t, { dir, catalog });
			await Promise.all([first.next("ready"), second.next("ready")]);
			first.child.send({ type: "start" });
			await first.next("held");
			second.child.send({ type: "start" });
			await second.next("contended");
			first.child.send({ type: "release" });
			for (const result of await Promise.all([first.next("result"), second.next("result")]))
				assert.equal(result.error, undefined);
			await Promise.all([first.exited, second.exited]);
			assert.equal((await events(registry(dir, catalog))).filter((event) => event.kind === "catalog").length, 1);
		});
		it("rejects a conflicting exact catalog import before append", async (t) => {
			const dir = await directory(t);
			const rows = [row()];
			const first = registry(dir, rows);
			const second = registry(dir, rows);
			await Promise.all([first.snapshot(), second.snapshot()]);
			const plan = await first.planImport("--all");
			const gate = pause(first, "append");
			t.after(gate.release);
			const contended = observeContention(t);
			const left = first.importCatalog("--all", plan.revision, audit);
			await gate.entered;
			const right = assert.rejects(second.importCatalog("--all", plan.revision, audit), /import revision changed/);
			await contended;
			gate.release();
			await Promise.all([left, right]);
			assert.equal((await events(first)).filter((event) => event.kind === "import").length, 1);
		});
		it("rejects a conflicting catalog import across OS processes", async (t) => {
			const dir = await directory(t);
			const catalog = [row()];
			const reg = registry(dir, catalog);
			const plan = await reg.planImport("--all");
			const event = {
				kind: "import" as const,
				id: randomUUID(),
				rows: plan.rows,
				targets: plan.targets,
				revision: plan.revision,
				audit,
			};
			const first = worker(t, { dir, catalog, event, hold: "append" });
			const second = worker(t, { dir, catalog, event: { ...event, id: randomUUID() } });
			await Promise.all([first.next("ready"), second.next("ready")]);
			first.child.send({ type: "start" });
			await first.next("held");
			second.child.send({ type: "start" });
			await second.next("contended");
			first.child.send({ type: "release" });
			assert.equal((await first.next("result")).error, undefined);
			assert.match((await second.next("result")).error ?? "", /import target identity changed/);
			await Promise.all([first.exited, second.exited]);
			assert.equal((await events(reg)).filter((item) => item.kind === "import").length, 1);
		});
		it("releases the lock after validation and append failures", async (t) => {
			const dir = await directory(t);
			const reg = registry(dir);
			await reg.snapshot();
			await assert.rejects(reg.setData(binding("bad"), "000000000000", audit), /revision changed/);
			await assert.rejects(lstat(join(dir, lockName)), /ENOENT/);
			const original = fsPromises.open;
			const failure = t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
				const handle = await original(...args);
				if (String(args[0]) === reg.path)
					handle.write = async () => {
						throw new Error("synthetic append failure");
					};
				return handle;
			});
			syncBuiltinESMExports();
			try {
				await assert.rejects(reg.setData(binding("bad"), null, audit), /synthetic append failure/);
			} finally {
				failure.mock.restore();
				syncBuiltinESMExports();
			}
			await assert.rejects(lstat(join(dir, lockName)), /ENOENT/);
			await reg.setData(binding("good"), null, audit);
		});
		for (const kind of ["symlink", "directory", "mode", "ownership"]) {
			it(`refuses a lock with unsafe ${kind} without removing it`, async (t) => {
				const dir = await directory(t);
				const reg = registry(dir);
				await reg.snapshot();
				const path = join(dir, lockName);
				if (kind === "symlink") await symlink(reg.path, path);
				else if (kind === "directory") await mkdir(path, { mode: 0o700 });
				else await writeFile(path, "", { mode: 0o600 });
				if (kind === "mode") await chmod(path, 0o644);
				const original = fsPromises.lstat;
				const mock =
					kind === "ownership"
						? t.mock.method(fsPromises, "lstat", async (...args: Parameters<typeof fsPromises.lstat>) => {
								const info = await original(...args);
								if (String(args[0]) === path) return Object.assign(info, { uid: (process.getuid?.() ?? 0) + 1 });
								return info;
							})
						: undefined;
				syncBuiltinESMExports();
				try {
					await assert.rejects(
						reg.setData(binding("bad"), null, audit),
						/regular non-symlink|mode is not private|not owned/,
					);
				} finally {
					mock?.mock.restore();
					syncBuiltinESMExports();
				}
				await lstat(path);
				assert.equal((await reg.snapshot()).data.size, 0);
			});
		}
		it("bounds contention and preserves the orphan lock after process death", async (t) => {
			const dir = await directory(t);
			const reg = registry(dir);
			const [event] = await conflictEvents(reg, "set/set");
			const owner = worker(t, { dir, catalog: [], event, hold: "append" });
			await owner.next("ready");
			owner.child.send({ type: "start" });
			await owner.next("held");
			owner.child.kill("SIGKILL");
			await owner.exited;
			const started = performance.now();
			await assert.rejects(reg.writeEvent(event), /transaction conflict: lock remains held/);
			assert.ok(performance.now() - started < 10000);
			assert.equal((await lstat(join(dir, lockName))).mode & 0o777, 0o600);
			assert.equal((await reg.snapshot()).data.get("synthetic")?.revision, binding("old").revision);
			await rm(join(dir, lockName));
			await reg.writeEvent(event);
			await assertWinner(reg, event);
		});
		it("retains a replaced lock and refuses a success acknowledgement", async (t) => {
			const dir = await directory(t);
			const reg = registry(dir);
			await reg.snapshot();
			const internal = reg as unknown as Internals;
			const original = internal.append.bind(reg);
			internal.append = async (...args) => {
				await original(...args);
				await rm(join(dir, lockName));
				await writeFile(join(dir, lockName), "replacement", { mode: 0o600 });
			};
			await assert.rejects(reg.setData(binding("committed"), null, audit), /lock changed; refusing to remove/);
			assert.equal(await readFile(join(dir, lockName), "utf8"), "replacement");
		});
		it("reports lock cleanup failure without a success acknowledgement", async (t) => {
			const dir = await directory(t);
			const reg = registry(dir);
			await reg.snapshot();
			const original = fsPromises.unlink;
			const failure = t.mock.method(fsPromises, "unlink", async (...args: Parameters<typeof fsPromises.unlink>) => {
				if (String(args[0]) === join(dir, lockName)) throw new Error("synthetic lock cleanup failure");
				return original(...args);
			});
			syncBuiltinESMExports();
			try {
				await assert.rejects(reg.setData(binding("committed"), null, audit), /synthetic lock cleanup failure/);
			} finally {
				failure.mock.restore();
				syncBuiltinESMExports();
			}
			assert.equal((await reg.snapshot()).data.get("synthetic")?.revision, binding("committed").revision);
			await lstat(join(dir, lockName));
		});
	});
}
