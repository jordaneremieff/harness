import { machineConfig } from "./settings-fixture.mts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import * as Durable from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { matchesSchema, schemaErrors } from "./schema-check.ts";
import { AgentCatalog } from "./catalog.ts";
import { createAgentContribution } from "./durable-agents.ts";
import { effortNoteRequestHooks } from "./effort-notes-native.ts";
import {
	EFFORT_AWARENESS_PROMPT_BYTES,
	EFFORT_AWARENESS_SELF_BYTES,
	formatEffortAwareness,
	readEffortAwareness,
} from "./effort-awareness.ts";
import { createPrimaryLocationResolver, LOCATION_BATCH_SPAWNS } from "./effort-location.ts";
import type { EffortReadResources } from "./effort-presence.ts";
import { EffortAwarenessSchema } from "./effort-schema.ts";
import type { PrimaryIntentClaim } from "./effort-presence.ts";
import { PRIMARY_ENDPOINT_VERSION, primaryEndpointPath } from "./primary-channel.ts";
import { StatusToolOutputSchema, structuredObservation } from "./observation-schema.ts";

function fixture(t: { after(fn: () => void): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "effort-awareness-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".primaries"));
	return { root, catalog: new AgentCatalog(root), self: { id: randomUUID(), cwd: root } };
}
/** One owned catalogue and location cache, as a manager or native contribution supplies. */
function resources(root: string, catalog = new AgentCatalog(root)): EffortReadResources {
	return { catalog, locations: createPrimaryLocationResolver() };
}
function readAwareness(root: string, self: Parameters<typeof readEffortAwareness>[1], catalog?: AgentCatalog) {
	return readEffortAwareness(resources(root, catalog), self);
}
function ambientPreferences(t: { after(fn: () => void): void }): string {
	const directory = mkdtempSync(join(tmpdir(), "effort-ambient-preferences-"));
	const previous = { directory: process.env.PI_AGENT_DIR, file: process.env.PI_HARNESS_FILE };
	const marker = "AMBIENT-EFFORT-PREFERENCES-MARKER";
	t.after(() => {
		if (previous.directory === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = previous.directory;
		if (previous.file === undefined) delete process.env.PI_HARNESS_FILE;
		else process.env.PI_HARNESS_FILE = previous.file;
		rmSync(directory, { recursive: true, force: true });
	});
	writeFileSync(
		join(directory, "harness.json"),
		JSON.stringify(machineConfig({ presets: {}, preferences: { reportingNotes: marker } })),
	);
	process.env.PI_AGENT_DIR = directory;
	delete process.env.PI_HARNESS_FILE;
	return marker;
}

function claim(purpose = "Own published purpose"): PrimaryIntentClaim {
	return {
		purpose,
		integration: "Run focused checks before integration",
		authority: "Operator: edit only the agent slice",
		scope: { paths: ["extensions/agent"], branches: ["topic"] },
		updatedAt: "2026-10-04T10:00:00.000Z",
	};
}
function publish(
	root: string,
	id: string,
	intentClaim: PrimaryIntentClaim | null = claim(),
	cwd = root,
	observedPurpose?: { source: "session-name" | "interactive-input"; text: string },
	extra: Record<string, unknown> = {},
): void {
	writeFileSync(
		primaryEndpointPath(root, id),
		JSON.stringify({
			id,
			version: PRIMARY_ENDPOINT_VERSION,
			serverId: randomUUID(),
			cwd,
			hostname: hostname(),
			pid: process.pid,
			socketPath: join(root, "missing.sock"),
			// A record of the current boot; an earlier start would read as a dead process.
			startedAt: new Date().toISOString(),
			...(intentClaim === null ? {} : { intentClaim }),
			...(observedPurpose === undefined ? {} : { observedPurpose }),
			...extra,
		}),
	);
}
function publishThread(
	catalog: AgentCatalog,
	root: string,
	title = "Active shared work",
	purpose = "Coordinate integration",
): string {
	const record = catalog.create({
		cwd: root,
		agentDir: root,
		packageDir: root,
		model: { provider: "faux", modelId: "faux-1" },
		thinkingLevel: "off",
		ownerId: "owner",
	});
	const id = `${record.storageId}/${"a".repeat(32)}`;
	catalog.updateView(
		record.storageId,
		{
			storageId: record.storageId,
			updatedAt: "2026-10-04T10:00:00.000Z",
			rows: [],
			coverage: { complete: true, omitted: 0 },
			intentClaims: { rows: {}, coverage: { complete: true, omitted: 0 } },
		},
		{
			items: [
				{
					id,
					title,
					purpose,
					updatedAt: 100,
					closed: false,
					members: 2,
				},
			],
			omitted: 0,
			updatedAt: "2026-10-04T10:00:00.000Z",
		},
	);
	return id;
}

it("names only project efforts and threads and keeps unrelated arrivals out of the prompt bytes", async (t) => {
	const { root, catalog, self } = fixture(t);
	const project = join(root, "project");
	const nested = join(project, "src");
	const other = join(root, "project-other");
	mkdirSync(nested, { recursive: true });
	mkdirSync(other);
	for (const cwd of [project, other]) execFileSync("git", ["init", "--quiet", cwd], { timeout: 3000 });
	const shared = resources(root, catalog);
	const current = { ...self, cwd: project };
	const prompt = async () =>
		formatEffortAwareness(await readEffortAwareness(shared, current, "canonical", "prompt"), "prompt");
	const peer = randomUUID();
	publish(root, peer, claim("In-project intent"), nested);
	const threadId = publishThread(catalog, nested);
	const before = await prompt();
	assert.match(before, /In-project intent/u);
	assert.match(before, /Active shared work/u);
	assert.ok(before.includes(threadId));
	const remote = randomUUID();
	publish(root, remote, claim("Other-repository intent"), other);
	publishThread(catalog, other, "Other-repository title", "Other-repository topic");
	const after = await prompt();
	assert.equal(after, before);
	assert.doesNotMatch(after, /Other-repository|outOfScope/u);
	const observation = await readEffortAwareness(shared, current);
	assert.equal(observation.presence.coverage.outOfScope, 1);
	assert.equal(observation.threads.coverage.outOfScope, 1);
	assert.match(after, /Use agent_intent read/u);
	publish(root, peer, claim("Revised in-project intent"), nested);
	assert.match(await prompt(), /Revised in-project intent/u);
	rmSync(primaryEndpointPath(root, peer));
	const threadOnly = await prompt();
	assert.doesNotMatch(threadOnly, /Revised in-project intent/u);
	assert.match(threadOnly, /Active shared work/u);
});

it("names live sessions in other repositories that used the same work items, with their first request", async (t) => {
	const { root, catalog, self } = fixture(t);
	const project = join(root, "project");
	const other = join(root, "other");
	mkdirSync(project);
	mkdirSync(other);
	for (const cwd of [project, other]) execFileSync("git", ["init", "--quiet", cwd], { timeout: 3000 });
	const design = { kind: "document", id: "md-design", title: "Service design" };
	const plan = { kind: "handover", id: "20261124T010203Z-plan", title: "Verification plan" };
	const reviewer = randomUUID();
	publish(
		root,
		reviewer,
		null,
		other,
		{ source: "interactive-input", text: "Review the service design for edge cases" },
		{ name: "SomeServiceFile.php", workRefs: [{ kind: "document", id: "md-other" }, design, plan] },
	);
	const declared = randomUUID();
	publish(root, declared, claim("Verify the plan"), other, undefined, { workRefs: [plan] });
	const unrelated = randomUUID();
	publish(
		root,
		unrelated,
		null,
		other,
		{ source: "interactive-input", text: "UNRELATED-WORK" },
		{
			workRefs: [{ kind: "document", id: "md-unrelated" }],
		},
	);
	const current = { ...self, cwd: project, workRefs: [plan, design] };
	const shared = resources(root, catalog);
	const view = await readEffortAwareness(shared, current, "canonical", "prompt");
	const prompt = formatEffortAwareness(view, "prompt");
	assert.ok(prompt.includes(reviewer), prompt);
	assert.ok(prompt.includes(declared));
	assert.doesNotMatch(prompt, /UNRELATED-WORK/u);
	assert.ok(prompt.includes(unrelated) === false);
	assert.match(prompt, /"sessionName":"SomeServiceFile\.php"/u);
	assert.match(prompt, /"request":"Review the service design for edge cases"/u);
	assert.match(prompt, /"sharedWork":\["document md-design","handover 20261124T010203Z-plan"\]/u);
	assert.doesNotMatch(prompt, /Service design|Verification plan/u, "producer titles stay out of the prompt row");
	const reordered = {
		...view,
		presence: {
			...view.presence,
			efforts: view.presence.efforts.map((effort) => ({ ...effort, sharedWork: effort.sharedWork?.toReversed() })),
		},
	};
	assert.equal(formatEffortAwareness(reordered, "prompt"), prompt, "recency order does not change prompt bytes");
	assert.match(prompt, /"purposeClaim":"Verify the plan"/u);
	assert.doesNotMatch(prompt, /Operator: edit only the agent slice/u, "another repository's intent stays purpose-only");
	assert.equal(
		formatEffortAwareness(await readEffortAwareness(shared, current, "canonical", "prompt"), "prompt"),
		prompt,
	);
	const withoutWork = formatEffortAwareness(
		await readEffortAwareness(shared, { ...self, cwd: project }, "canonical", "prompt"),
		"prompt",
	);
	assert.equal(withoutWork.includes(reviewer), false);
	const observation = await readEffortAwareness(shared, current);
	assert.equal(
		matchesSchema(EffortAwarenessSchema, observation),
		true,
		JSON.stringify(schemaErrors(EffortAwarenessSchema, observation, 10)),
	);
	assert.deepEqual(observation.self.workRefs, [plan, design]);
	const row = observation.presence.efforts.find((effort) => effort.id === reviewer);
	assert.equal(row?.relationship, "machine");
	assert.deepEqual(row?.sharedWork, [design, plan]);
	assert.equal(observation.presence.efforts.find((effort) => effort.id === unrelated)?.sharedWork, undefined);
});

it("keeps a shared-work row when the other session reorders more items than an observation shows", async (t) => {
	const { root, catalog, self } = fixture(t);
	const project = join(root, "project");
	const other = join(root, "other");
	mkdirSync(project);
	mkdirSync(other);
	for (const cwd of [project, other]) execFileSync("git", ["init", "--quiet", cwd], { timeout: 3000 });
	const items = Array.from({ length: 12 }, (_, index) => ({ kind: "document", id: `md-${index.toString(16)}` }));
	const peer = randomUUID();
	const current = { ...self, cwd: project, workRefs: items };
	const shared = resources(root, catalog);
	const rowFor = async (workRefs: typeof items) => {
		publish(root, peer, null, other, undefined, { workRefs });
		const prompt = formatEffortAwareness(await readEffortAwareness(shared, current, "canonical", "prompt"), "prompt");
		return prompt.split("\n").find((line) => line.includes(peer));
	};
	const before = await rowFor(items);
	assert.match(before ?? "", /"sharedWork":\["document md-0","document md-1","document md-2","document md-3"\]/u);
	assert.equal(await rowFor(items.toReversed()), before, "the newest eight of the other session do not select the row");
});

it("reads thread hints of shared-work peers but not of peers that share only a topic", async (t) => {
	const { root, catalog, self } = fixture(t);
	const project = join(root, "project");
	const other = join(root, "other");
	mkdirSync(project);
	mkdirSync(other);
	for (const cwd of [project, other]) execFileSync("git", ["init", "--quiet", cwd], { timeout: 3000 });
	const first = (text: string) => ({ source: "interactive-input" as const, text });
	const plan = { kind: "handover", id: "20261124T010203Z-plan" };
	const topical = randomUUID();
	publish(root, topical, null, other, first("Payment refund ledger reconciliation"));
	const working = randomUUID();
	publish(root, working, null, other, first("Unrelated words here"), { workRefs: [plan] });
	const peerThread = (owner: string, title: string) => {
		const { record } = catalog.createThreadStorage({
			cwd: other,
			agentDir: root,
			packageDir: root,
			model: { provider: "faux", modelId: "faux-1" },
			thinkingLevel: "off",
			ownerId: owner,
		});
		const id = `${record.storageId}/${"b".repeat(32)}`;
		catalog.updateView(
			record.storageId,
			{
				storageId: record.storageId,
				updatedAt: "2026-10-04T10:00:00.000Z",
				rows: [],
				coverage: { complete: true, omitted: 0 },
				intentClaims: { rows: {}, coverage: { complete: true, omitted: 0 } },
			},
			{
				items: [{ id, title, purpose: "Peer coordination", updatedAt: 100, closed: false, members: 2 }],
				omitted: 0,
				updatedAt: "2026-10-04T10:00:00.000Z",
			},
		);
		return id;
	};
	const topicContact = peerThread(topical, "Topic peer thread");
	peerThread(working, "Shared work peer thread");
	// The topic peer declares its own thread as its contact; the claim stays on its row only.
	publish(
		root,
		topical,
		{ ...claim("Payment refund ledger reconciliation"), contactThread: topicContact },
		other,
		first("Payment refund ledger reconciliation"),
	);
	const current = {
		...self,
		cwd: project,
		observedPurpose: first("Reconcile the payment refund ledger"),
		workRefs: [plan],
	};
	const view = await readEffortAwareness(resources(root, catalog), current, "canonical", "prompt");
	const prompt = formatEffortAwareness(view, "prompt");
	assert.ok(prompt.includes(topical), "the topic peer keeps its row");
	assert.ok(prompt.includes(`"contactThreadClaim":"${topicContact}"`), "its contact stays a claim on the row");
	assert.match(prompt, /Shared work peer thread/u);
	assert.doesNotMatch(prompt, /Topic peer thread/u, "a shared topic alone never promotes thread hints");
});

it("names sessions in other repositories whose purposes share a topic, strongest four, after project rows", async (t) => {
	const { root, catalog, self } = fixture(t);
	const project = join(root, "project");
	const other = join(root, "other");
	mkdirSync(project);
	mkdirSync(other);
	for (const cwd of [project, other]) execFileSync("git", ["init", "--quiet", cwd], { timeout: 3000 });
	const first = (text: string) => ({ source: "interactive-input" as const, text });
	const local = randomUUID();
	publish(root, local, null, project, first("Unrelated local chores"));
	const strong = randomUUID();
	publish(root, strong, null, other, first("Payment refund ledger reconciliation timeout"));
	const declared = randomUUID();
	publish(root, declared, claim("Audit payment refund ledger exports"), other);
	const weak: string[] = Array.from({ length: 5 }, () => randomUUID());
	for (const id of weak) publish(root, id, null, other, first("Refund ledger overview"));
	const single = randomUUID();
	publish(root, single, null, other, first("Ledger tidy-up"));
	const noise = randomUUID();
	publish(root, noise, null, other, first("Please check and fix the agent extension tests in this session"));
	const current = {
		...self,
		cwd: project,
		observedPurpose: first("Reconcile the payment refund ledger after the timeout incident"),
	};
	const shared = resources(root, catalog);
	const view = await readEffortAwareness(shared, current, "canonical", "prompt");
	const prompt = formatEffortAwareness(view, "prompt");
	const shown = view.presence.efforts.map((effort) => effort.id);
	assert.ok(shown.includes(local), "project rows stay");
	assert.ok(shown.includes(strong) && shown.includes(declared));
	assert.equal(shown.filter((id) => weak.includes(id)).length, 2, "topic-only rows stop at four");
	assert.equal(shown.includes(single), false, "one shared word is not a topic");
	assert.equal(shown.includes(noise), false, "generic words are not a topic");
	assert.match(prompt, /"sharedTopics":\["ledger","payment","refund","timeout"\]/u);
	assert.match(
		prompt,
		/"purposeClaim":"Audit payment refund ledger exports",.*"sharedTopics":\["ledger","payment","refund"\]/u,
	);
	assert.doesNotMatch(prompt, /Unrelated local chores"[^\n]*sharedTopics/u, "project rows carry no topic list");
	assert.equal(
		formatEffortAwareness(await readEffortAwareness(shared, current, "canonical", "prompt"), "prompt"),
		prompt,
	);
	const observation = await readEffortAwareness(shared, current);
	assert.equal(
		matchesSchema(EffortAwarenessSchema, observation),
		true,
		JSON.stringify(schemaErrors(EffortAwarenessSchema, observation, 10)),
	);
	assert.deepEqual(observation.presence.efforts.find((effort) => effort.id === strong)?.sharedTopics, [
		"ledger",
		"payment",
		"refund",
		"timeout",
	]);
});

it("unifies self-published purpose, related presence and active thread hints without schema drift", async (t) => {
	const { root, catalog, self } = fixture(t);
	const intentClaim = claim();
	publish(root, self.id, intentClaim);
	const peer = randomUUID();
	publish(root, peer, claim("Related effort"));
	const threadId = publishThread(catalog, root);
	const view = await readAwareness(
		root,
		{ ...self, intentClaim, observedPurpose: { source: "interactive-input", text: "First interactive input" } },
		catalog,
	);
	assert.equal(
		matchesSchema(EffortAwarenessSchema, view),
		true,
		JSON.stringify(schemaErrors(EffortAwarenessSchema, view, 10)),
	);
	assert.deepEqual(view.self.intentClaim, intentClaim);
	assert.equal(view.self.observedPurpose, undefined);
	assert.equal(JSON.stringify(view).includes("First interactive input"), false);
	assert.deepEqual(
		view.presence.efforts.map((effort) => effort.id),
		[peer],
	);
	assert.deepEqual(
		view.threads.items.map((thread) => thread.id),
		[threadId],
	);
	const prompt = formatEffortAwareness(view);
	assert.ok(
		prompt.includes(
			'"authority":"Operator: edit only the agent slice","scope":{"paths":["extensions/agent"],"branches":["topic"]}',
		),
	);
	assert.ok(prompt.includes("Own published purpose"));
	assert.ok(prompt.includes("Active shared work"));
	assert.ok(prompt.includes("do not grant authority to the reader"));
	assert.deepEqual(
		await readAwareness(
			root,
			{ ...self, intentClaim, observedPurpose: { source: "interactive-input", text: "First interactive input" } },
			catalog,
		),
		view,
	);
	assert.equal(formatEffortAwareness(view), prompt);
});

it("keeps prompt bytes stable when clocks, traversal counters and activity ordering change", async (t) => {
	const { root, catalog, self } = fixture(t);
	publish(root, randomUUID());
	publish(root, randomUUID());
	publishThread(catalog, root);
	const view = await readAwareness(root, { ...self, intentClaim: claim() }, catalog);
	const before = formatEffortAwareness(view, "prompt");
	const changed = {
		...view,
		self: { ...view.self, intentClaim: { ...claim(), updatedAt: "2026-10-29T12:00:00Z" } },
		presence: {
			...view.presence,
			efforts: [...view.presence.efforts].reverse().map((effort) => ({
				...effort,
				lastActivityAt: "2026-10-29T12:00:00Z",
				startedAt: "2026-10-29T10:00:00Z",
				...(effort.intentClaim ? { intentClaim: { ...effort.intentClaim, updatedAt: "2026-10-29T12:00:00Z" } } : {}),
			})),
			coverage: {
				...view.presence.coverage,
				visited: view.presence.coverage.visited + 1,
				dead: view.presence.coverage.dead + 1,
			},
		},
		threads: {
			...view.threads,
			coverage: { ...view.threads.coverage, visited: view.threads.coverage.visited + 1 },
			items: view.threads.items.map((thread) => ({ ...thread, updatedAt: thread.updatedAt + 1 })),
		},
	};
	assert.equal(formatEffortAwareness(changed, "prompt"), before);
	assert.notEqual(
		formatEffortAwareness(changed),
		formatEffortAwareness(view),
		"tools retain current clocks and coverage",
	);
	changed.self.intentClaim = { ...claim(), purpose: "New material purpose" };
	assert.notEqual(formatEffortAwareness(changed, "prompt"), before);
});

it("never emits observed competitors with declared intent, including compact prompt rows", async (t) => {
	const { root, self } = fixture(t);
	const observedPurpose = { source: "interactive-input" as const, text: "UNRELATED-LATER-REMARK" };
	const peer = randomUUID();
	publish(root, peer, claim("PEER-DECLARED-PURPOSE"), root, observedPurpose);
	const view = await readAwareness(root, { ...self, intentClaim: claim("SELF-DECLARED-PURPOSE"), observedPurpose });
	assert.equal(JSON.stringify(view).includes(observedPurpose.text), false);
	const raw = {
		...view,
		self: { ...view.self, observedPurpose },
		presence: { ...view.presence, efforts: view.presence.efforts.map((row) => ({ ...row, observedPurpose })) },
	};
	const prompt = formatEffortAwareness(raw);
	assert.equal(prompt.includes(observedPurpose.text), false);
	assert.ok(prompt.includes("SELF-DECLARED-PURPOSE"));
	assert.ok(prompt.includes("PEER-DECLARED-PURPOSE"));
	assert.ok(prompt.includes("Declared purpose takes precedence"));
	const largeClaim = {
		...claim(`${"p".repeat(127)}🧭`),
		authority: "😀".repeat(512),
		integration: "😀".repeat(512),
		scope: {
			paths: Array.from({ length: 4 }, () => "😀".repeat(64)),
			branches: Array.from({ length: 4 }, () => "😀".repeat(64)),
		},
	};
	const compact = {
		...raw,
		self: { ...raw.self, intentClaim: largeClaim },
		presence: {
			...raw.presence,
			efforts: raw.presence.efforts.map((row) => ({ ...row, cwd: "x".repeat(7000), intentClaim: largeClaim })),
		},
	};
	const shortPrompt = formatEffortAwareness(compact);
	assert.ok(shortPrompt.includes("Self detail shortened"));
	assert.ok(shortPrompt.includes(`"purposeClaim":"${"p".repeat(127)}"`));
	assert.doesNotMatch(shortPrompt, /\\ud83e/iu);
	assert.ok(shortPrompt.includes("Effort detail shortened"));
	assert.equal(shortPrompt.includes(observedPurpose.text), false);
	assert.ok(Buffer.byteLength(shortPrompt) <= EFFORT_AWARENESS_PROMPT_BYTES);
	const machine = {
		...raw,
		presence: {
			...raw.presence,
			efforts: raw.presence.efforts.map(({ intentClaim: _intent, ...row }) => ({
				...row,
				relationship: "machine" as const,
				purposeClaim: "MACHINE-DECLARED-PURPOSE",
			})),
		},
	};
	assert.equal(formatEffortAwareness(machine).includes(observedPurpose.text), false);
	assert.ok(formatEffortAwareness(machine).includes("MACHINE-DECLARED-PURPOSE"));
});

it("refreshes declared purpose and clear directly from current records without stale competitors", async (t) => {
	const { root, self } = fixture(t);
	const peer = randomUUID();
	const observedPurpose = { source: "session-name" as const, text: "Named origin, not current intent" };
	publish(root, peer, claim("OLD-PLAN"), root, observedPurpose);
	assert.ok(formatEffortAwareness(await readAwareness(root, self)).includes("OLD-PLAN"));
	publish(root, peer, claim("NEW-PLAN"), root, observedPurpose);
	const current = formatEffortAwareness(await readAwareness(root, self));
	assert.ok(current.includes("NEW-PLAN"));
	assert.equal(current.includes("OLD-PLAN"), false);
	assert.equal(current.includes(observedPurpose.text), false);
	publish(root, peer, null, root, observedPurpose);
	const cleared = await readAwareness(root, { ...self, observedPurpose });
	assert.equal(cleared.presence.efforts[0]?.intentClaim, undefined);
	assert.deepEqual(cleared.presence.efforts[0]?.observedPurpose, observedPurpose);
	assert.deepEqual(cleared.self.observedPurpose, observedPurpose);
	const prompt = formatEffortAwareness(cleared);
	assert.equal(prompt.includes("OLD-PLAN"), false);
	assert.equal(prompt.includes("NEW-PLAN"), false);
	assert.ok(prompt.includes('"source":"session-name"'));
	assert.ok(prompt.includes("it is not current intent"));
	publish(root, peer, null);
	const unknown = await readAwareness(root, self);
	assert.equal(unknown.presence.efforts[0]?.observedPurpose, undefined);
	assert.equal(formatEffortAwareness(unknown).includes(observedPurpose.text), false);
});

it("includes unrelated local purpose claims without full authority or integration detail", async (t) => {
	const { root, self } = fixture(t);
	const peer = randomUUID();
	const intentClaim = {
		...claim("Unrelated local purpose"),
		integration: "PRIVATE-INTEGRATION",
		authority: "PRIVATE-AUTHORITY",
		scope: { paths: ["PRIVATE-PATH"], branches: ["private-branch"], fullGate: true },
		contactThread: "contact/thread",
	};
	publish(root, peer, intentClaim, join(root, "other-cwd"));
	const view = await readAwareness(root, self);
	const effort = view.presence.efforts[0];
	assert.equal(effort?.id, peer);
	assert.equal(effort.relationship, "machine");
	assert.equal(effort.purposeClaim, "Unrelated local purpose");
	assert.equal(effort.contactThreadClaim, "contact/thread");
	assert.equal(effort.intentClaim, undefined);
	assert.ok(effort.sharedSubstrates?.includes("machine-gates"));
	assert.equal(matchesSchema(EffortAwarenessSchema, view), true);
	const serialized = JSON.stringify(view);
	const prompt = formatEffortAwareness(view);
	for (const secret of ["PRIVATE-INTEGRATION", "PRIVATE-AUTHORITY", "PRIVATE-PATH"]) {
		assert.equal(serialized.includes(secret), false);
		assert.equal(prompt.includes(secret), false);
	}
	assert.ok(prompt.includes("Unrelated local purpose"));
});

it("keeps machine-only prompt bytes stable when intentUpdatedAt alone changes", async (t) => {
	const { root, self } = fixture(t);
	publish(root, randomUUID(), claim("Machine-only purpose"), join(root, "other-cwd"));
	const view = await readAwareness(root, self);
	assert.equal(view.presence.efforts[0]?.relationship, "machine");
	assert.equal(view.presence.efforts[0]?.intentUpdatedAt, claim().updatedAt);
	const changed = {
		...view,
		presence: {
			...view.presence,
			efforts: view.presence.efforts.map((effort) => ({ ...effort, intentUpdatedAt: "2026-10-29T12:00:00.000Z" })),
		},
	};
	assert.equal(formatEffortAwareness(changed, "prompt"), formatEffortAwareness(view, "prompt"));
	assert.doesNotMatch(formatEffortAwareness(changed, "prompt"), /intentUpdatedAt/u);
	assert.notEqual(formatEffortAwareness(changed), formatEffortAwareness(view));
});

it("preserves repository state and declared full gates in the current self view", async (t) => {
	const { root, self } = fixture(t);
	publish(root, randomUUID());
	const intentClaim = { ...claim(), scope: { ...claim().scope, fullGate: true } };
	const view = await readAwareness(root, {
		...self,
		repository: "/repository/common",
		repositoryState: "git",
		intentClaim,
	});
	assert.equal(view.self.repositoryState, "git");
	assert.equal(view.self.repository, "/repository/common");
	assert.ok(formatEffortAwareness(view).includes('"fullGate":true'));
	const largeClaim = {
		...intentClaim,
		authority: "😀".repeat(512),
		integration: "😀".repeat(512),
		scope: {
			...intentClaim.scope,
			paths: Array.from({ length: 4 }, () => "😀".repeat(64)),
			branches: Array.from({ length: 4 }, () => "😀".repeat(64)),
		},
	};
	const wide = await readAwareness(root, { ...self, intentClaim: largeClaim });
	const prompt = formatEffortAwareness(wide);
	assert.ok(prompt.includes("Own published purpose"));
	assert.ok(prompt.includes("Self detail shortened"));
	assert.ok(Buffer.byteLength(prompt) <= EFFORT_AWARENESS_PROMPT_BYTES);
});

it("bounds self input with explicit omissions rather than a shortened authority claim", async (t) => {
	const { root, self } = fixture(t);
	const view = await readAwareness(root, { ...self, intentClaim: claim("x".repeat(EFFORT_AWARENESS_SELF_BYTES * 2)) });
	assert.equal(view.self.omitted, true);
	assert.equal(view.self.intentClaim, undefined);
	assert.ok(Buffer.byteLength(JSON.stringify(view.self)) <= EFFORT_AWARENESS_SELF_BYTES);
	assert.equal(matchesSchema(EffortAwarenessSchema, view), true);
});

it("reserves prompt space for active threads and retains or omits whole claims", async (t) => {
	const { root, catalog, self } = fixture(t);
	const longClaim = claim("😀".repeat(256));
	longClaim.scope.paths.push(...Array.from({ length: 12 }, (_, index) => `extensions/agent/${index}`));
	for (let index = 0; index < 20; index++) publish(root, randomUUID(), longClaim);
	publishThread(catalog, root);
	const view = await readAwareness(root, self, catalog);
	const prompt = formatEffortAwareness(view);
	assert.ok(Buffer.byteLength(prompt) <= EFFORT_AWARENESS_PROMPT_BYTES);
	assert.ok(prompt.includes("Active shared work"));
	const retained = prompt
		.split("\n")
		.filter((line) => line.startsWith("Related effort: "))
		.map((line) => JSON.parse(line.slice("Related effort: ".length)));
	assert.ok(retained.some((row) => row.intentClaim));
	for (const row of retained) if (row.intentClaim) assert.deepEqual(row.intentClaim, longClaim);
	assert.equal(prompt.includes("Claim text or scope shortened"), false);
	assert.match(prompt, /Prompt omissions: self 0, related efforts [0-9]+, active threads 0/u);
	assert.equal(formatEffortAwareness(view), prompt);
});

it("keeps zero-live-effort context to one line without losing unknown coverage", async (t) => {
	const { root, catalog, self } = fixture(t);
	const view = await readAwareness(root, { ...self, intentClaim: claim("Do not repeat my whole claim") }, catalog);
	assert.equal(formatEffortAwareness(view), "No other live efforts or active thread hints in the covered sources.");
	publishThread(catalog, root);
	const withThread = await readAwareness(root, self, catalog);
	const unknownView = {
		...withThread,
		self: { ...self, omitted: true },
		presence: {
			...withThread.presence,
			efforts: [
				{ id: "unknown", cwd: root, startedAt: "now", relationship: "cwd" as const, liveness: "unknown" as const },
				{
					id: "incompatible",
					cwd: root,
					startedAt: "now",
					relationship: "cwd" as const,
					liveness: "incompatible" as const,
				},
			],
			coverage: { ...withThread.presence.coverage, complete: false, omitted: 2, unreadable: 3 },
		},
	};
	unknownView.threads.coverage = {
		...unknownView.threads.coverage,
		complete: false,
		omittedHints: 2,
		omittedResults: 1,
		missingHints: 1,
		unreadable: 4,
		unvisited: true,
	};
	const line = formatEffortAwareness(unknownView);
	assert.equal(line.split("\n").length, 1);
	assert.ok(Buffer.byteLength(line) < 512);
	for (const label of [
		"1 unknown",
		"1 incompatible",
		"2 omitted",
		"3 unreadable",
		"Active thread hints: 1",
		"2 source omissions",
		"1 result omissions",
		"1 missing",
		"4 unreadable",
		"unvisited yes",
		"Own detail incomplete",
		"agent_intent read",
	])
		assert.ok(line.includes(label), label);
});

/** One faux-model Durable host over the given storage, with this extension's contribution installed. */
async function nativeHost(
	t: { after(fn: () => Promise<void> | void): void },
	sessionsRoot: string,
	storage: Durable.Storage,
	respond: (request: { messages: Message[] }, index: number) => ReturnType<typeof fauxAssistantMessage>,
	storageId = randomUUID(),
	extensions: readonly Durable.Extension[] = [],
) {
	const requests: Message[][] = [];
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 40 }, (_, index) => (request) => {
			requests.push([...request.messages]);
			return respond(request as { messages: Message[] }, index);
		}),
	);
	const registry = Durable.createRegistry();
	const extension = createAgentContribution({
		configureSettings: () => {},
		source: "/extensions/agent/index.ts",
	}).create({
		onClose() {},
		durable: Durable,
		storageId,
		catalogRoot: join(sessionsRoot, "durable"),
		cwd: sessionsRoot,
		agentDir: sessionsRoot,
		services: { modelRuntime: { getModel: (provider, modelId) => models.getModel(provider, modelId) } },
	});
	registry.install(extension);
	for (const other of extensions) registry.install(other);
	// The host installs the effort-note hook after every contribution, as its runtime does.
	const notesExtension = Durable.defineExtension({
		name: "agent.effort-notes",
		hooks: [Durable.hook(Durable.GenerationTask, effortNoteRequestHooks(storageId))],
	});
	registry.install(notesExtension);
	const context = BACKGROUND_CONTEXT;
	const harness = await Durable.Harness.open(storage, { models, registry }, context);
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		await harness.close(context);
	};
	t.after(close);
	harness.resume();
	const model = { provider: "faux", modelId: "faux-1" };
	const root = await harness.root(context, { agent: { model } });
	const say = async (conversation: Durable.Conversation = root) => {
		const submission = await conversation.submit({ type: "input", content: "Read current view" }, context);
		await submission.wait(context);
	};
	return { requests, harness, extension, notesExtension, model, root, say, close, storageId };
}
const effortPatches = (messages: Message[] | undefined) =>
	(messages ?? []).filter((message) => message.role === "system" && message.sections?.["agent-efforts"] !== undefined)
		.length;
const effortNotes = (messages: Message[] | undefined) =>
	(messages ?? []).flatMap((message) =>
		message.role === "user" && Array.isArray(message.content)
			? message.content.flatMap((part) =>
					part.type === "text" && part.text.startsWith("<agent-efforts-update>") ? [part.text] : [],
				)
			: [],
	);

it("keeps native sections between runs and sends changed rows as frozen notes", async (t) => {
	const ambientMarker = ambientPreferences(t);
	const { root: sessionsRoot, catalog } = fixture(t);
	const peer = randomUUID();
	publish(sessionsRoot, peer, claim("BEFORE-PURPOSE"));
	const threadId = publishThread(catalog, sessionsRoot);
	const host = await nativeHost(t, sessionsRoot, new Durable.MemoryStorage(), () => fauxAssistantMessage("DONE"));
	const { requests, say, root } = host;
	await say();
	const first = getCurrentSystemPrompt(requests.at(-1) ?? []);
	assert.equal(
		first.includes(ambientMarker),
		false,
		"native effort fixtures must not read ambient machine preferences",
	);
	assert.ok(first.includes("BEFORE-PURPOSE"), first);
	await say();
	assert.equal(effortPatches(requests.at(-1)), 1);
	assert.deepEqual(effortNotes(requests.at(-1)), []);
	const count = requests.length;
	publish(sessionsRoot, peer, claim("AFTER-PURPOSE"));
	assert.equal(requests.length, count, "a published endpoint does not wake a model");
	await say();
	const changed = requests.at(-1);
	assert.equal(getCurrentSystemPrompt(changed ?? []), first, "the section keeps its bytes");
	assert.equal(effortPatches(changed), 1);
	const [note] = effortNotes(changed);
	assert.match(note ?? "", /AFTER-PURPOSE/u);
	const position = (changed ?? []).findIndex((message) => JSON.stringify(message).includes("<agent-efforts-update>"));
	assert.equal(position, (changed?.length ?? 0) - 1, "the note follows the message that started the run");
	await say();
	const later = requests.at(-1) ?? [];
	assert.equal(
		JSON.stringify(later.slice(0, changed?.length)),
		JSON.stringify(changed),
		"later requests extend the request that carried the note",
	);
	assert.equal(effortNotes(later).length, 1, "the note is not repeated");

	const child = await host.harness.createConversation(
		{
			ownership: { kind: "ownerless" },
			agent: { model: host.model, extensions: [host.extension, host.notesExtension] },
		},
		BACKGROUND_CONTEXT,
	);
	await say(child);
	const childPrompt = getCurrentSystemPrompt(requests.at(-1) ?? []);
	assert.ok(childPrompt.includes("AFTER-PURPOSE") && childPrompt.includes("Active shared work"));
	rmSync(primaryEndpointPath(sessionsRoot, peer));
	const record = catalog.read(threadId.split("/")[0]);
	assert.ok(record.view && record.threads);
	catalog.updateView(record.storageId, record.view, {
		...record.threads,
		items: record.threads.items.map((thread) => ({ ...thread, closed: true })),
	});
	await say(child);
	assert.equal(getCurrentSystemPrompt(requests.at(-1) ?? []), childPrompt);
	const [removed] = effortNotes(requests.at(-1));
	assert.match(removed ?? "", new RegExp(`Related effort removed: \\{"id":"${peer}"\\}`, "u"));
	assert.match(removed ?? "", new RegExp(`Active thread removed: \\{"id":"${threadId}"\\}`, "u"));
	assert.ok(root);
});

it("keeps native awareness for the rest of a run and sends the change at the next run", async (t) => {
	ambientPreferences(t);
	const { root: sessionsRoot } = fixture(t);
	const peer = randomUUID();
	publish(sessionsRoot, peer, claim("BEFORE-PURPOSE"));
	const { requests, say } = await nativeHost(t, sessionsRoot, new Durable.MemoryStorage(), (_request, index) => {
		if (index !== 0) return fauxAssistantMessage("DONE");
		// A peer changes its claim while this run still has a tool round to go.
		publish(sessionsRoot, peer, claim("MID-RUN-PURPOSE"));
		return fauxAssistantMessage([fauxToolCall("agent_intent", { action: "read" })], { stopReason: "toolUse" });
	});
	await say();
	assert.equal(requests.length, 2, "one run with one tool round makes two requests");
	const result = requests[1].findLast((message) => message.role === "toolResult");
	assert.ok(result && !result.isError);
	assert.match(JSON.stringify(result.content), /MID-RUN-PURPOSE/u, "explicit reads use fresh peer evidence");
	const laterRound = getCurrentSystemPrompt(requests[1]);
	assert.ok(laterRound.includes("BEFORE-PURPOSE"), laterRound);
	assert.deepEqual(effortNotes(requests[1]), [], "a running prompt keeps its run's awareness");
	assert.equal(effortPatches(requests[1]), effortPatches(requests[0]), "no awareness patch lands mid-run");
	await say();
	const nextRun = requests.at(-1) ?? [];
	assert.equal(getCurrentSystemPrompt(nextRun), laterRound, "the next run keeps the section");
	assert.match(effortNotes(nextRun)[0] ?? "", /MID-RUN-PURPOSE/u);
});

const userTexts = (messages: readonly Message[]) =>
	messages.flatMap((message) =>
		message.role === "user"
			? [
					typeof message.content === "string"
						? message.content
						: message.content.map((part) => ("text" in part ? part.text : "")).join(""),
				]
			: [],
	);

it("keeps effort notes away from the request hooks of other contributions", async (t) => {
	ambientPreferences(t);
	const { root: sessionsRoot } = fixture(t);
	const seen: string[][] = [];
	const recorder = Durable.defineExtension({
		name: "later-contribution",
		hooks: [
			Durable.hook(Durable.GenerationTask, {
				beforeRequest(request: { messages: readonly Message[] }) {
					seen.push(userTexts(request.messages));
					return undefined;
				},
			}),
		],
	});
	const host = await nativeHost(
		t,
		sessionsRoot,
		new Durable.MemoryStorage(),
		() => fauxAssistantMessage("DONE"),
		randomUUID(),
		[recorder],
	);
	await host.say();
	publish(sessionsRoot, randomUUID(), claim("PEER-PURPOSE"));
	await host.say();
	assert.match(effortNotes(host.requests.at(-1))[0] ?? "", /PEER-PURPOSE/u, "the model receives the note");
	assert.ok(seen.length >= 2);
	assert.ok(
		seen.every((texts) => texts.every((text) => !text.startsWith("<agent-efforts-update>"))),
		"a contribution's hook never receives an effort note",
	);
});

it("extends each request's prefix when another hook inserts frozen notices after user messages", async (t) => {
	ambientPreferences(t);
	const { root: sessionsRoot } = fixture(t);
	// Stands in for memory's recall: a frozen notice after every user message it receives.
	const notices = Durable.defineExtension({
		name: "memory-like",
		hooks: [
			Durable.hook(Durable.GenerationTask, {
				beforeRequest(request: { messages: readonly Message[] }) {
					const messages: Message[] = [];
					for (const message of request.messages) {
						messages.push(message);
						if (message.role === "user")
							messages.push({
								role: "user",
								content: [{ type: "text", text: `notice for ${userTexts([message])[0]?.length}` }],
								timestamp: message.timestamp,
							});
					}
					return { messages };
				},
			}),
		],
	});
	// One request for the first run, three for the run after the change (two tool rounds), one after.
	const host = await nativeHost(
		t,
		sessionsRoot,
		new Durable.MemoryStorage(),
		(_request, index) =>
			index === 1 || index === 2
				? fauxAssistantMessage([fauxToolCall("agent_intent", { action: "read" })], { stopReason: "toolUse" })
				: fauxAssistantMessage("DONE"),
		randomUUID(),
		[notices],
	);
	await host.say();
	const baseline = host.requests.length;
	publish(sessionsRoot, randomUUID(), claim("PEER-PURPOSE"));
	await host.say();
	await host.say();
	const run = host.requests.slice(baseline);
	assert.equal(run.length, 4, "three requests of one run and the next run's first");
	assert.equal(effortNotes(run[0]).length, 1);
	assert.ok(
		userTexts(run[0]).indexOf(effortNotes(run[0])[0] as string) >
			userTexts(run[0]).findLastIndex((text) => text.startsWith("notice for")),
		"the note follows the other hook's notice",
	);
	for (let index = 1; index < 4; index++)
		assert.equal(
			JSON.stringify(run[index].slice(0, run[index - 1].length)),
			JSON.stringify(run[index - 1]),
			`request ${index} extends the request before it`,
		);
});

it("replaces the section when a conversation's requests never reach the note hook", async (t) => {
	ambientPreferences(t);
	const { root: sessionsRoot } = fixture(t);
	const peer = randomUUID();
	publish(sessionsRoot, peer, claim("FIRST-PURPOSE"));
	const host = await nativeHost(t, sessionsRoot, new Durable.MemoryStorage(), () => fauxAssistantMessage("DONE"));
	const lone = await host.harness.createConversation(
		{ ownership: { kind: "ownerless" }, agent: { model: host.model, extensions: [host.extension] } },
		BACKGROUND_CONTEXT,
	);
	await host.say(lone);
	publish(sessionsRoot, peer, claim("SECOND-PURPOSE"));
	await host.say(lone);
	publish(sessionsRoot, peer, claim("THIRD-PURPOSE"));
	await host.say(lone);
	const prompt = getCurrentSystemPrompt(host.requests.at(-1) ?? []);
	assert.match(prompt, /THIRD-PURPOSE/u, "without notes the section carries the change");
	assert.deepEqual(effortNotes(host.requests.at(-1)), []);
});

it("restores the native section from the transcript after a host restart", async (t) => {
	ambientPreferences(t);
	const { root: sessionsRoot } = fixture(t);
	const peer = randomUUID();
	publish(sessionsRoot, peer, claim("BEFORE-PURPOSE"));
	const path = join(sessionsRoot, "restart.sqlite");
	const first = await nativeHost(t, sessionsRoot, await openNodeSqliteStorage(path), () =>
		fauxAssistantMessage("DONE"),
	);
	await first.say();
	const before = getCurrentSystemPrompt(first.requests.at(-1) ?? []);
	await first.close();
	publish(sessionsRoot, peer, claim("AFTER-RESTART"));
	const second = await nativeHost(
		t,
		sessionsRoot,
		await openNodeSqliteStorage(path),
		() => fauxAssistantMessage("DONE"),
		first.storageId,
	);
	await second.say();
	const resumed = second.requests.at(-1) ?? [];
	assert.equal(getCurrentSystemPrompt(resumed), before, "a new host keeps the stored section");
	assert.equal(effortPatches(resumed), 1);
	assert.match(effortNotes(resumed)[0] ?? "", /AFTER-RESTART/u);
});

it("omits awareness from compact native status and preserves selected detail", async (t) => {
	const ambientMarker = ambientPreferences(t);
	const { root: sessionsRoot } = fixture(t);
	const peer = randomUUID();
	publish(sessionsRoot, peer);
	const requests: Message[][] = [];
	const calls: Readonly<Record<string, unknown>>[] = [];
	const hostStatus = {
		conversations: [],
		live: false,
		storageId: randomUUID(),
		coverage: { complete: true, returned: 0, scanned: 0, next: null },
	};
	const selectedStatus = {
		live: false,
		storageId: peer,
		conversation: {
			conversationId: 1,
			identity: peer,
			busy: false,
			lastText: null,
			live: null,
			inbox: null,
			agent: { thinkingLevel: "off", extensions: [], tools: [] },
			tasks: [],
			submissions: [],
		},
	};
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(
		Array.from({ length: 20 }, () => (request) => {
			requests.push([...request.messages]);
			const last = request.messages.findLast((message) => message.role !== "system");
			if (last?.role !== "user") return fauxAssistantMessage("DONE");
			const args: Durable.JsonObject =
				last.content === "selected"
					? { sessionId: peer }
					: last.content === "detail"
						? { sessionId: peer, detail: true }
						: last.content === "fleet"
							? { view: "fleet" }
							: {};
			return fauxAssistantMessage([fauxToolCall("agent_status", args)], { stopReason: "toolUse" });
		}),
	);
	const registry = Durable.createRegistry();
	registry.install(
		createAgentContribution({
			configureSettings: () => {},
			source: "/extensions/agent/index.ts",
			dispatch: async (method, params) => {
				assert.equal(method, "status");
				calls.push(params);
				return params.sessionId === peer ? selectedStatus : hostStatus;
			},
		}).create({
			onClose() {},
			durable: Durable,
			storageId: randomUUID(),
			catalogRoot: join(sessionsRoot, "durable"),
			cwd: sessionsRoot,
			agentDir: sessionsRoot,
			services: { modelRuntime: { getModel: (provider, modelId) => models.getModel(provider, modelId) } },
		}),
	);
	const context = BACKGROUND_CONTEXT;
	const harness = await Durable.Harness.open(new Durable.MemoryStorage(), { models, registry }, context);
	t.after(async () => {
		await harness.close(context);
	});
	harness.resume();
	const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	const say = async (content: string) => {
		const submission = await root.submit({ type: "input", content }, context);
		await submission.wait(context);
	};
	await say("overview");
	assert.equal(
		getCurrentSystemPrompt(requests.at(-1) ?? []).includes(ambientMarker),
		false,
		"native status fixtures must not read ambient machine preferences",
	);
	const overview = requests.at(-1)?.findLast((message) => message.role === "toolResult");
	assert.equal(overview?.role, "toolResult");
	const text =
		overview?.role === "toolResult"
			? overview.content.flatMap((part) => (part.type === "text" && part.text.startsWith("{") ? [part.text] : [])).at(0)
			: "";
	assert.ok(text, JSON.stringify(overview));
	const structured = JSON.parse(text ?? "") as typeof hostStatus & { format: string; omitted: string[] };
	structuredObservation(StatusToolOutputSchema, structured);
	assert.deepEqual(
		{
			conversations: structured.conversations,
			live: structured.live,
			storageId: structured.storageId,
			coverage: structured.coverage,
		},
		hostStatus,
	);
	assert.equal(structured.format, "compact");
	assert.equal("awareness" in structured, false);
	assert.equal("createdAgents" in structured, false);
	assert.deepEqual(structured.omitted, ["host inventory", "effort awareness", "created-agent detail"]);
	await say("selected");
	const selected = requests.at(-1)?.findLast((message) => message.role === "toolResult");
	const selectedText =
		selected?.role === "toolResult"
			? selected.content.flatMap((part) => (part.type === "text" && part.text.startsWith("{") ? [part.text] : [])).at(0)
			: "";
	const selectedResult = JSON.parse(selectedText ?? "");
	structuredObservation(StatusToolOutputSchema, selectedResult);
	assert.equal(selectedResult.format, "compact");
	assert.equal(selectedResult.conversation.identity, peer);
	assert.equal("awareness" in selectedResult, false);
	await say("detail");
	const detail = requests.at(-1)?.findLast((message) => message.role === "toolResult");
	const detailText =
		detail?.role === "toolResult"
			? detail.content.flatMap((part) => (part.type === "text" && part.text.startsWith("{") ? [part.text] : [])).at(0)
			: "";
	assert.deepEqual(JSON.parse(detailText ?? ""), selectedStatus);
	await say("fleet");
	const fleet = requests.at(-1)?.findLast((message) => message.role === "toolResult");
	const fleetText =
		fleet?.role === "toolResult"
			? fleet.content.flatMap((part) => (part.type === "text" && part.text.startsWith("{") ? [part.text] : [])).at(0)
			: "";
	const fleetResult = JSON.parse(fleetText ?? "");
	assert.equal(fleetResult.view, "fleet");
	assert.equal("awareness" in fleetResult, false);
	assert.deepEqual(calls, [{}, { sessionId: peer }, { sessionId: peer }]);
});

it("resolves the reader location through the supplied resolver and only when the caller has no repository", async (t) => {
	const { root, catalog, self } = fixture(t);
	const resolved: string[] = [];
	const locations = {
		resolve: async (cwd: string) => {
			resolved.push(cwd);
			return { cwd, repositoryState: "git" as const, repository: "/shared/common" };
		},
		resolveMany: async () => ({ locations: new Map(), unresolved: 0 }),
		invalidate() {},
		clear() {},
	};
	const view = await readEffortAwareness({ catalog, locations }, self);
	assert.deepEqual(resolved, [root]);
	assert.equal(view.self.repository, "/shared/common");
	await readEffortAwareness({ catalog, locations }, { ...self, repository: "/known", repositoryState: "git" });
	assert.deepEqual(resolved, [root], "a supplied repository needs no discovery");
});

it("reads current peer intent on every call even when the catalogue and locations are reused", async (t) => {
	const { root, catalog, self } = fixture(t);
	const shared = resources(root, catalog);
	const peer = randomUUID();
	publish(root, peer, claim("FIRST"));
	assert.ok(formatEffortAwareness(await readEffortAwareness(shared, self)).includes("FIRST"));
	publish(root, peer, claim("SECOND"));
	const current = formatEffortAwareness(await readEffortAwareness(shared, self));
	assert.ok(current.includes("SECOND"));
	assert.equal(current.includes("FIRST"), false);
});

/** A Git on PATH that counts its starts; `asksGit` sets a ceiling that bounds no path but makes the resolver ask Git. */
function countingGit(t: { after(fn: () => void): void }, root: string, asksGit: boolean) {
	const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const bin = join(root, "bin");
	const log = join(root, "git-calls.log");
	mkdirSync(bin);
	writeFileSync(log, "");
	writeFileSync(join(bin, "git"), `#!/bin/sh\necho call >> '${log}'\nexec '${real}' "$@"\n`);
	chmodSync(join(bin, "git"), 0o755);
	const saved = { path: process.env.PATH, ceiling: process.env.GIT_CEILING_DIRECTORIES };
	process.env.PATH = `${bin}:${saved.path ?? ""}`;
	if (asksGit) process.env.GIT_CEILING_DIRECTORIES = join(root, "no-ceiling");
	else delete process.env.GIT_CEILING_DIRECTORIES;
	t.after(() => {
		for (const [key, value] of [
			["PATH", saved.path],
			["GIT_CEILING_DIRECTORIES", saved.ceiling],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	return () => readFileSync(log, "utf8").split("\n").filter(Boolean).length;
}

function distinctThreadRecords(catalog: AgentCatalog, root: string, count: number): void {
	for (let index = 0; index < count; index++) {
		const cwd = join(root, "dirs", `d${index}`);
		mkdirSync(cwd, { recursive: true });
		publishThread(catalog, cwd, `Thread ${index}`);
	}
}

it("reads threads in more distinct directories than any bounded cache without starting Git again", {
	timeout: 60000,
}, async (t) => {
	const { root, catalog, self } = fixture(t);
	const calls = countingGit(t, root, false);
	distinctThreadRecords(catalog, root, 320);
	const shared = resources(root, catalog);
	const current = { ...self, cwd: join(root, "self") };
	mkdirSync(current.cwd);
	const first = await readEffortAwareness(shared, current, "canonical", "prompt");
	assert.equal(first.threads.coverage.records, 320);
	const spawned = calls();
	const second = await readEffortAwareness(shared, current, "canonical", "prompt");
	assert.equal(calls(), spawned, "a second read over 320 directories starts no Git process");
	assert.equal(spawned, 0, "outside Git, the entries Git reads settle every directory");
	assert.deepEqual(second.threads.items, [], "threads of other directories stay out of the prompt");
	assert.ok(!second.threads.coverage.reasons.includes("location-unresolved"));
});

it("bounds the Git processes of one read and converges on the directories it left unresolved", {
	timeout: 60000,
}, async (t) => {
	const { root, catalog, self } = fixture(t);
	const calls = countingGit(t, root, true);
	const count = LOCATION_BATCH_SPAWNS * 3 + 5;
	distinctThreadRecords(catalog, root, count);
	const shared = resources(root, catalog);
	const current = { ...self, cwd: join(root, "self") };
	mkdirSync(current.cwd);
	await readEffortAwareness(shared, current, "canonical", "prompt");
	let spawned = calls();
	const first = await readEffortAwareness(shared, current, "canonical", "prompt");
	assert.ok(calls() - spawned <= LOCATION_BATCH_SPAWNS, "one read starts at most the batch bound");
	assert.ok(first.threads.coverage.reasons.includes("location-unresolved"));
	assert.equal(first.threads.coverage.complete, false);
	for (let read = 0; read < 4; read++) await readEffortAwareness(shared, current, "canonical", "prompt");
	spawned = calls();
	const settled = await readEffortAwareness(shared, current, "canonical", "prompt");
	assert.equal(calls(), spawned, "settled directories start no Git process");
	assert.ok(!settled.threads.coverage.reasons.includes("location-unresolved"), "coverage converges");
	assert.equal(settled.threads.coverage.outOfScope, count);
});
