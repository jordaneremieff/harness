import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compile } from "@earendil-works/pi-schema";
import type { NamedData } from "./data.ts";
import { type LocalRuleCandidate, namedDataRevision, proposalRevision, RuleRegistry } from "./local-rules.ts";
import type { AgentRuleAudit, OperatorRuleAudit } from "./rule.ts";
import {
	COMMAND_PAGE_BYTES,
	type PolicyCapabilities,
	PolicyRulesParams,
	policyDataCommand,
	registerRuleTools,
	validateInspectionParams,
} from "./tools.ts";

const TOOL_TEXT_CAP = 50 * 1024;
const COMMAND_TEXT_CAP = 32 * 1024;
const operator: OperatorRuleAudit = {
	surface: "command",
	at: "2026-11-21T10:00:00.000Z",
	session: "pages-test",
	model: "provider/model",
};
const agent: AgentRuleAudit = { ...operator, surface: "agent-tool" };
const context = {
	cwd: "/work",
	model: { provider: "provider", id: "model" },
	sessionManager: { getSessionId: () => "pages-test" },
} as unknown as ExtensionContext;

interface Result {
	content: Array<{ text: string }>;
	details: Record<string, unknown>;
}
interface Tool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<Result>;
}

async function registry(t: TestContext): Promise<RuleRegistry> {
	const dir = await mkdtemp(join(tmpdir(), "policy-pages-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return new RuleRegistry(join(dir, "state"), { catalog: [] });
}
function rulesTool(reg: RuleRegistry, inspect?: (view: string) => Promise<unknown>): Tool {
	let registered: Tool | undefined;
	const pi = {
		registerTool(tool: Tool) {
			if (tool.name === "policy_rules") registered = tool;
		},
	} as unknown as ExtensionAPI;
	registerRuleTools(pi, { registry: reg, loadRegistry: () => reg.snapshot(), ...(inspect ? { inspect } : {}) });
	assert.ok(registered);
	return registered;
}
const call = (tool: Tool, params: Record<string, unknown>) =>
	tool.execute("pages-call", params, undefined, undefined, context);

function candidate(index: number): LocalRuleCandidate {
	return {
		id: `local.rule-${String(index).padStart(2, "0")}`,
		purpose:
			`Keep tool arguments valid for sample tool ${index}. ${"Purpose text that makes each listing entry substantial. ".repeat(5)}`.trim(),
		authority: "exact",
		matcher: {
			kind: "declarative",
			language: "facts/v1",
			spec: {
				phase: "input",
				selector: { tools: [`sample_${index}`] },
				when: { op: "exists", path: ["input", "old"] },
				action: { kind: "rename-key", path: [], from: "old", to: "new" },
				onUnavailable: "skip",
			},
		},
		note: `Use the declared key for sample tool ${index}; rename old to new before the call.`,
		scope: { models: ["provider/model"] },
	};
}
function table(name: string, rows: number, value: (index: number) => string): NamedData {
	const raw = {
		name,
		kind: "table" as const,
		source: "operator-table",
		capturedAt: 1000,
		rows: Array.from({ length: rows }, (_, index) => ({ key: `key-${index}`, value: value(index) })),
	};
	return { ...raw, revision: namedDataRevision(raw) };
}
function capabilities(names: readonly string[], active: (name: string) => boolean): PolicyCapabilities {
	return {
		phases: ["input", "result", "completion", "context"],
		actions: ["deny", "require-approval", "rename-key", "substitute", "assert-error", "guide", "observe"],
		mode: "enforce",
		effectiveMode: "enforce",
		schemas: {
			available: true,
			tools: names.map((name) => ({ name, active: active(name), configured: true })),
		},
		innerSchemas: "Unavailable; decoded argument corrections are unsupported",
		dataKinds: ["table"],
		observationStorage: "memory",
		projection: "full transcript with retained guidance, no new turn",
	};
}
/** Follow nextCursor through every page; each page must parse and stay below the tool cap. */
async function jsonPages(tool: Tool, params: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
	const pages: Array<Record<string, unknown>> = [];
	let cursor: string | null = null;
	do {
		const result = await call(tool, cursor === null ? params : { ...params, cursor });
		const text = result.content[0].text;
		assert.ok(Buffer.byteLength(text, "utf8") <= TOOL_TEXT_CAP, "page stays below the tool text cap");
		const page = JSON.parse(text) as Record<string, unknown>;
		assert.deepEqual(result.details.page, page.page);
		pages.push(page);
		cursor = (page.page as { nextCursor: string | null }).nextCursor;
	} while (cursor !== null && pages.length < 64);
	assert.equal(cursor, null, "the listing ends within the test bound");
	return pages;
}

describe("policy_rules paged views", () => {
	it("pages the all-rules listing through every rule and pending proposal", async (t) => {
		const reg = await registry(t);
		for (let index = 0; index < 51; index++) {
			const proposal = await reg.proposeAdd(candidate(index), "Correct the argument key.", agent);
			await reg.decide(proposal.id, "approved", undefined, operator, proposalRevision(proposal));
		}
		const pending = await reg.proposeAdd(candidate(99), "Correct one more key.", agent);
		const tool = rulesTool(reg);
		const texts: string[] = [];
		let cursor: string | undefined;
		do {
			const result = await call(tool, cursor === undefined ? { view: "rules" } : { view: "rules", cursor });
			const text = result.content[0].text;
			assert.ok(Buffer.byteLength(text, "utf8") <= TOOL_TEXT_CAP);
			assert.doesNotMatch(text, /policy text truncated/);
			const line = text.match(/^page: entries (\d+)-(\d+) of (\d+) \| next cursor: (\S+)$/m);
			assert.ok(line, "every listing page states its position and continuation");
			const next = line[4] === "(none)" ? null : line[4];
			assert.deepEqual(result.details.page, {
				start: Number(line[1]) - 1,
				returned: Number(line[2]) - Number(line[1]) + 1,
				total: 52,
				nextCursor: next,
			});
			assert.equal(result.details.rules, 51);
			assert.equal(result.details.pending, 1);
			texts.push(text);
			cursor = next ?? undefined;
		} while (cursor !== undefined && texts.length < 20);
		assert.equal(cursor, undefined);
		assert.ok(texts.length >= 2, "the listing needs more than one page");
		const ids = texts.flatMap((text) => [...text.matchAll(/^(local\.rule-\d+) \| source=/gm)].map((match) => match[1]));
		assert.deepEqual(
			ids,
			Array.from({ length: 51 }, (_, index) => `local.rule-${String(index).padStart(2, "0")}`),
		);
		const proposals = texts.flatMap((text) => [...text.matchAll(/^([0-9a-f-]{36}) \| add \| local\.rule-99 /gm)]);
		assert.deepEqual(
			proposals.map((match) => match[1]),
			[pending.id],
		);
		assert.ok(texts.every((text, index) => text.includes("\nPENDING PROPOSALS\n") === (index === texts.length - 1)));
		assert.ok(texts.slice(1).every((text) => !text.includes("\nRULES\n(none)")));
	});

	it("refuses a rules cursor after the listing changes and keeps id lookups complete", async (t) => {
		const reg = await registry(t);
		for (let index = 0; index < 40; index++) {
			const proposal = await reg.proposeAdd(candidate(index), "Correct the argument key.", agent);
			await reg.decide(proposal.id, "approved", undefined, operator, proposalRevision(proposal));
		}
		const tool = rulesTool(reg);
		const first = await call(tool, { view: "rules" });
		const cursor = (first.details.page as { nextCursor: string | null }).nextCursor;
		assert.ok(cursor);
		await reg.proposeAdd(candidate(98), "A later proposal changes the listing.", agent);
		await assert.rejects(call(tool, { view: "rules", cursor }), /listing changed after this cursor was issued/);
		const lookup = await call(tool, { view: "rules", id: "local.rule-07" });
		assert.match(lookup.content[0].text, /^local\.rule-07 \| source=/m);
		assert.doesNotMatch(lookup.content[0].text, /^page:/m);
		assert.equal(lookup.details.page, undefined);
	});

	it("pages 585 configured tools as valid JSON in name order with the engine fields on every page", async (t) => {
		const names = Array.from(
			{ length: 585 },
			(_, index) => `mcp__server_${index % 11}__configured_tool_with_a_descriptive_name_${index}`,
		);
		let flip = false;
		const tool = rulesTool(await registry(t), async () => capabilities(names, (name) => flip !== name.endsWith("0")));
		const pages = await jsonPages(tool, { view: "capabilities" });
		assert.ok(pages.length >= 2, "585 tools need more than one page");
		const listed = pages.flatMap((page) => (page.schemas as { tools: Array<{ name: string }> }).tools);
		assert.deepEqual(
			listed.map((entry) => entry.name),
			[...names].sort(),
		);
		for (const page of pages) {
			assert.deepEqual(page.actions, capabilities([], () => true).actions);
			assert.equal(page.mode, "enforce");
			assert.equal((page.schemas as { available: boolean }).available, true);
		}
		// Activation changes between calls do not invalidate a cursor; a changed tool inventory does.
		const cursor = (pages[0].page as { nextCursor: string }).nextCursor;
		flip = true;
		assert.equal(
			(JSON.parse((await call(tool, { view: "capabilities", cursor })).content[0].text) as { page: { start: number } })
				.page.start,
			(pages[0].page as { returned: number }).returned,
		);
		names.push("late_registered_tool");
		await assert.rejects(call(tool, { view: "capabilities", cursor }), /listing changed after this cursor was issued/);
	});

	it("summarizes data bindings without rows and pages one binding's rows bound to its revision", async (t) => {
		const reg = await registry(t);
		const large = table("sample-lookup", 1500, (index) => `canonical value ${index} ${"x".repeat(60)}`);
		await reg.setData(large, null, operator);
		await reg.setData(
			table("small", 2, (index) => `small ${index}`),
			null,
			operator,
		);
		const tool = rulesTool(reg);
		const [list] = await jsonPages(tool, { view: "data" });
		assert.deepEqual(
			(list.bindings as Array<Record<string, unknown>>).map(({ name, rows, kind, status }) => ({
				name,
				rows,
				kind,
				status,
			})),
			[
				{ name: "sample-lookup", rows: 1500, kind: "table", status: "ready" },
				{ name: "small", rows: 2, kind: "table", status: "ready" },
			],
		);
		assert.ok((list.bindings as Array<Record<string, unknown>>).every((binding) => !("data" in binding)));
		const pages = await jsonPages(tool, { view: "data", id: "sample-lookup" });
		assert.ok(pages.length >= 3, "the large table needs several pages");
		assert.deepEqual(
			pages.flatMap((page) => page.rows as unknown[]),
			large.rows,
		);
		assert.ok(pages.every((page) => (page.binding as { revision: string }).revision === large.revision));
		const cursor = (pages[0].page as { nextCursor: string }).nextCursor;
		const replaced = table("sample-lookup", 1500, (index) => `replacement ${index}`);
		await reg.setData(replaced, large.revision, operator);
		await assert.rejects(
			call(tool, { view: "data", id: "sample-lookup", cursor }),
			/listing changed after this cursor was issued/,
		);
		await assert.rejects(call(tool, { view: "data", id: "small", cursor }), /different policy_rules view or id/);
		const missing = JSON.parse((await call(tool, { view: "data", id: "absent" })).content[0].text);
		assert.deepEqual(missing.binding, { name: "absent", status: "missing" });
		assert.deepEqual(missing.page, { start: 0, returned: 0, total: 0, nextCursor: null });
	});

	it("keeps JSON views valid when stored values contain DEL or C1 controls", async (t) => {
		const reg = await registry(t);
		const value = "before\u0085middle\u007fafter\u009b";
		await reg.setData(
			table("controls", 1, () => value),
			null,
			operator,
		);
		const text = (await call(rulesTool(reg), { view: "data", id: "controls" })).content[0].text;
		assert.doesNotMatch(text, /[\u007f-\u009f]/);
		assert.equal(JSON.parse(text).rows[0].value, value);
	});

	it("pages /policy data within the command notice cap and continues with a cursor", async (t) => {
		const reg = await registry(t);
		const large = table("sample-lookup", 1500, (index) => `canonical value ${index} ${"x".repeat(60)}`);
		await reg.setData(large, null, operator);
		const confirm = async () => true;
		const rows: unknown[] = [];
		let args = "show sample-lookup";
		for (let pages = 0; pages < 64; pages++) {
			const text = await policyDataCommand(reg, args, operator, confirm);
			assert.ok(Buffer.byteLength(text, "utf8") <= COMMAND_TEXT_CAP);
			const page = JSON.parse(text);
			rows.push(...page.rows);
			if (page.page.nextCursor === null) break;
			args = `show sample-lookup ${page.page.nextCursor}`;
		}
		assert.deepEqual(rows, large.rows);
		assert.ok(COMMAND_PAGE_BYTES < COMMAND_TEXT_CAP);
		const list = JSON.parse(await policyDataCommand(reg, "list", operator, confirm));
		assert.equal(list.bindings[0].rows, 1500);
		await assert.rejects(policyDataCommand(reg, "list one two", operator, confirm), /only an optional cursor/);
		await assert.rejects(policyDataCommand(reg, "show", operator, confirm), /one name and an optional cursor/);
	});

	it("accepts cursor only for paged views and only with their own selection", () => {
		const schema = compile(PolicyRulesParams);
		assert.equal(schema.check({ view: "data", id: "table", cursor: "WyJkYXRhIl0" }), true);
		assert.equal(schema.check({ view: "rules", cursor: "not a cursor" }), false);
		validateInspectionParams({ view: "capabilities", cursor: "WyJkYXRhIl0" });
		validateInspectionParams({ cursor: "WyJkYXRhIl0" });
		assert.throws(() => validateInspectionParams({ view: "state", cursor: "WyJkYXRhIl0" }), /"cursor" is not valid/);
		assert.throws(() => validateInspectionParams({ view: "catalog", cursor: "WyJkYXRhIl0" }), /"cursor" is not valid/);
		assert.throws(() => validateInspectionParams({ view: "data", cursor: "a b" }), /nextCursor text/);
		assert.throws(
			() => validateInspectionParams({ view: "rules", id: "local.rule", cursor: "WyJkYXRhIl0" }),
			/one complete artifact/,
		);
	});
});
