import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import proof from "./index.ts";

const FIXTURE = fileURLToPath(new URL("./meter-fixture.mts", import.meta.url));
const saved = ["PI_CODING_AGENT_DIR", "PI_HARNESS_FILE", "PI_PROOF_METER_PATH", "PI_PROOF_TIMEOUT_MS", "PI_PROOF_TEST_LOG"].map(
	(key) => [key, process.env[key]] as const,
);
let dir = "";
let log = "";

type Handler = (event: unknown) => Promise<{ entries?: { customType: string; content: string; display: boolean }[]; continue?: boolean } | undefined> | undefined;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "proof-index-"));
	log = join(dir, "runs.log");
	await writeFile(log, "");
	process.env.PI_CODING_AGENT_DIR = dir;
	delete process.env.PI_HARNESS_FILE;
	process.env.PI_PROOF_METER_PATH = FIXTURE;
	process.env.PI_PROOF_TIMEOUT_MS = "1500";
	process.env.PI_PROOF_TEST_LOG = log;
});
afterEach(async () => {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await rm(dir, { recursive: true, force: true });
});

function load() {
	const handlers = new Map<string, Handler>();
	const events = createEventBus();
	proof({ events, on: (name: string, handler: Handler) => void handlers.set(name, handler) } as never);
	const settle = (text: string, outcome = "completed") =>
		handlers.get("agent_before_settle")?.({
			type: "agent_before_settle",
			outcome,
			entries: [],
			continue: false,
			context: { llmMessages: [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "text", text }] }] },
		});
	const start = () => handlers.get("before_agent_start")?.({ type: "before_agent_start" });
	return { settle, start };
}
const runs = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean).length;

test("hard findings produce one hidden findings message and a continuation", async () => {
	const { settle } = load();
	const result = await settle("reply HARD text");
	assert.equal(result?.continue, true);
	assert.equal(result?.entries?.length, 1);
	const entry = result?.entries?.[0];
	assert.equal(entry?.display, false);
	assert.match(entry?.content ?? "", /punctuation\.em-dash line 2 "x": Em dash found/u);
	assert.match(entry?.content ?? "", /Score 10, band green/u);
	assert.match(entry?.content ?? "", /cohort fixture cohort \(n=12, 2026-01-01\)/u);
	assert.match(entry?.content ?? "", /Do not swap one tell for its neighbour/u);
});

test("a clean reply returns nothing", async () => {
	const { settle } = load();
	assert.equal(await settle("plain reply"), undefined);
});

test("a reliable amber score notifies at the default band and not at red", async () => {
	const first = load();
	const result = await first.settle("AMBER reply");
	assert.equal(result?.continue, true);
	assert.match(result?.entries?.[0]?.content ?? "", /Filler phrase/u);
	process.env.PI_PROOF_NOTIFY_BAND = "red";
	try {
		assert.equal(await load().settle("AMBER reply"), undefined);
	} finally {
		delete process.env.PI_PROOF_NOTIFY_BAND;
	}
});

test("a short reply with two scored findings and no reliable band notifies", async () => {
	const result = await load().settle("SHORT2 reply");
	assert.equal(result?.continue, true);
	const content = result?.entries?.[0]?.content ?? "";
	assert.match(content, /lexical\.filler line 1/u);
	assert.match(content, /lexical\.filler line 2/u);
	assert.match(content, /Score not reliable/u);
});

test("a short reply with one scored finding does not notify, and the threshold is configurable", async () => {
	assert.equal(await load().settle("SHORT1 reply"), undefined);
	process.env.PI_PROOF_MIN_SCORED_FINDINGS = "1";
	try {
		assert.equal((await load().settle("SHORT1 reply"))?.continue, true);
	} finally {
		delete process.env.PI_PROOF_MIN_SCORED_FINDINGS;
	}
});

test("hard findings are listed before scored findings", async () => {
	const { needsRepair, repairText } = await import("./check.ts");
	const finding = (rule: string, severity: "hard" | "scored") => ({ rule, severity, message: "m", line: 1 });
	const report = {
		contract: 1 as const,
		meterVersion: "t",
		hard: [finding("h.one", "hard")],
		scored: [finding("s.one", "scored")],
		score: { sq: 1, band: null, reliable: false },
		calibration: null,
		omitted: { hard: 0, scored: 0 },
	};
	const text = repairText(report, 12);
	assert.ok(text.indexOf("h.one") < text.indexOf("s.one"));
	assert.equal(repairText(report, 1).includes("s.one"), false);
	assert.equal(needsRepair({ ...report, hard: [], scored: [] }, "amber", 2), false);
});

test("an unreliable score without hard findings returns nothing", async () => {
	assert.equal(await load().settle("UNRELIABLE reply"), undefined);
});

test("one repair pass per run; the next run is checked again", async () => {
	const { settle, start } = load();
	await start();
	assert.equal((await settle("HARD one"))?.continue, true);
	assert.equal(await settle("HARD repaired still"), undefined);
	assert.equal(await runs(), 1, "the repair pass is not measured");
	await start();
	assert.equal((await settle("HARD next run"))?.continue, true);
	assert.equal(await runs(), 2);
});

test("skips empty text, aborted runs and error runs without running the meter", async () => {
	const { settle } = load();
	assert.equal(await settle("   "), undefined);
	assert.equal(await settle("HARD x", "aborted"), undefined);
	assert.equal(await settle("HARD x", "error"), undefined);
	assert.equal(await runs(), 0);
});

test("a disabled extension does not run the meter", async () => {
	process.env.PI_PROOF_ENABLED = "0";
	try {
		assert.equal(await load().settle("HARD x"), undefined);
		assert.equal(await runs(), 0);
	} finally {
		delete process.env.PI_PROOF_ENABLED;
	}
});

test("input is capped at maxChars", async () => {
	process.env.PI_PROOF_MAX_CHARS = "100";
	try {
		await load().settle("a".repeat(500));
		assert.equal((await readFile(log, "utf8")).trim(), "100");
	} finally {
		delete process.env.PI_PROOF_MAX_CHARS;
	}
});

for (const [marker, pattern] of [
	["EXIT4", /meter failed \(usage or input error: usage: bad input\)/u],
	["EXIT9", /meter failed \(exit status 9\)/u],
	["NOTJSON", /meter failed \(unusable output/u],
	["BADCONTRACT", /unknown contract 2/u],
] as const) {
	test(`${marker} appends one notice, settles, and is silent afterwards`, async () => {
		const { settle } = load();
		const first = await settle(`reply ${marker}`);
		assert.equal(first?.continue, undefined);
		assert.equal(first?.entries?.length, 1);
		assert.equal(first?.entries?.[0]?.customType, "proof-notice");
		assert.match(first?.entries?.[0]?.content ?? "", /did not run/u);
		assert.match(first?.entries?.[0]?.content ?? "", pattern);
		assert.equal(await settle(`reply ${marker}`), undefined);
	});
}

test("a missing meter appends a notice", async () => {
	process.env.PI_PROOF_METER_PATH = join(dir, "absent.mts");
	const result = await load().settle("reply");
	assert.match(result?.entries?.[0]?.content ?? "", /meter file was not found/u);
});

test("a hanging meter is killed at the time limit and noticed", async () => {
	process.env.PI_PROOF_TIMEOUT_MS = "300";
	const started = Date.now();
	const result = await load().settle("HANG");
	assert.ok(Date.now() - started < 3000);
	assert.match(result?.entries?.[0]?.content ?? "", /meter timed out/u);
	const pid = Number((await readFile(log, "utf8")).match(/pid (\d+)/u)?.[1]);
	assert.ok(pid > 0);
	await new Promise((done) => setTimeout(done, 100));
	assert.throws(() => process.kill(pid, 0), "the timed-out meter process is gone");
});

test("the notice repeats only after the meter works again", async () => {
	const { settle } = load();
	assert.ok((await settle("EXIT4"))?.entries);
	assert.equal(await settle("EXIT4"), undefined);
	assert.equal(await settle("fine"), undefined);
	assert.ok((await settle("EXIT4"))?.entries);
});
