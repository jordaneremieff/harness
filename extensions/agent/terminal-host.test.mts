import { onStoredCommit } from "./commit-observation.ts";
import { deliveryState as readRetainedDelivery } from "./delivery-store.ts";
import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NavigationFrame } from "../../operator-ui/index.ts";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { settleDeliveries, type AgentDeliveryState } from "./durable-controls.ts";
import { actionView, committedChoices, type ActionResult, type AgentFormHost } from "./agent-forms.ts";
import { agentState } from "./dashboard-state.ts";
import { RequestContextDoc } from "./request-context.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { startDurableDelivery } from "./durable-delivery.ts";
import { eventLog } from "./host-fixture.mts";
import type { ConversationFrame } from "./live-frames.ts";
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { TerminalController, terminalForms, type TerminalManager } from "./terminal-client.ts";
import { theme } from "./dashboard-test-fixture.mts";
import { controlledGate, createSibling, terminalHostFixture, type ControlledTerminalHost } from "./terminal-host-fixture.mts";

/** Poll a condition against real host work, with a deadline and a failure message. */
async function waitFor(condition: () => boolean, what: string, ms = 10000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/**
 * The row the work view addresses for one identity: the listed row of a storage root, or, for a
 * conversation outside the list such as a sibling, the placeholder it pins with what is known.
 */
async function rowOf(manager: TerminalManager, id: string): Promise<AgentConversationSummary> {
	const found = (await manager.dashboardPage()).rows.find((item) => item.id === id);
	return found ?? { id, storageId: id.split(":")[0] ?? id, cwd: "", modifiedAt: Date.now(), owner: "unknown", state: "unavailable", cost: Number.NaN, partial: true };
}

/** The terminal's forms for one captured target, with each reported result kept for the test. */
function formsFor(controller: TerminalController, target: AgentConversationSummary): AgentFormHost & { readonly results: ActionResult[] } {
	const results: ActionResult[] = [];
	return { ...terminalForms(controller, new Map(), target), outcome: (result) => results.push(result), results };
}

/** Mount one form as the work view's inspector does, then run its labelled action until the form closes. */
async function runForm(name: string, host: AgentFormHost, ready: RegExp, action: string, prepare?: (frame: NavigationFrame) => void): Promise<void> {
	let closed = false;
	const frame = new NavigationFrame({
		theme,
		target: { id: host.row.id, label: "Target" },
		destinations: () => [{ key: name, label: name, open: (view) => actionView(name, host, view) }],
		rows: () => 30,
		requestRender: () => {},
		close: () => {
			closed = true;
		},
	});
	const text = () => frame.render(100).map(stripVTControlCharacters).join("\n");
	await waitFor(() => ready.test(text()), `the ${name} form`);
	prepare?.(frame);
	const control = frame.viewActions.find((candidate) => candidate.label === action);
	assert.ok(control, `no action ${action}: ${frame.viewActions.map((candidate) => candidate.label).join(", ")}`);
	control.run();
	await waitFor(() => closed, `the ${name} form to close:\n${text()}`);
}

async function rewindEntry(host: ControlledTerminalHost, manager: TerminalManager): Promise<string> {
	const gate = controlledGate();
	host.gates.set("seed", gate);
	const input = await host.durable.request("submit", { message: "gate:seed", requestId: "seed" }) as { submissionId: number };
	await gate.started;
	gate.release();
	await host.settled(input.submissionId);
	const snapshot = await manager.snapshot(host.record.storageId);
	const entryId = committedChoices(snapshot.entries).find((entry) => entry.label.startsWith("Agent:"))?.id;
	assert.ok(entryId);
	return entryId;
}

it("terminal schedule requests a timer owned by the caller, for the captured target, without another input", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("schedule", { timers: true });
	const manager = fixture.manager();
	const caller = { id: `terminal:${randomUUID()}`, cwd: fixture.root };
	const controller = new TerminalController({ manager, caller });
	t.after(() => controller.close());
	const row = await rowOf(manager, host.record.storageId);
	const forms = formsFor(controller, row);
	agentState(controller.state, row.id).schedule = { message: "gate:schedule", time: "+1m", mode: "steer" };
	const before = Date.now();
	await runForm("schedule", forms, /Schedule a message/u, "Schedule");
	const returned = forms.results[0];
	assert.ok(returned && typeof returned === "object");
	assert.equal(returned.sessionId, row.id);
	assert.match(returned.text, /Scheduled timer/u);
	const request = host.calls.find((call) => call.method === "timer-schedule");
	assert.equal(request?.params?.selfOwned, true);
	assert.equal(request?.params?.ownerId, caller.id);
	assert.equal(request?.params?.sessionId, row.id);
	assert.equal(request?.params?.mode, "steer");
	const deadline = Number(request?.params?.deliverAt);
	assert.ok(deadline >= before + 59_000 && deadline <= Date.now() + 61_000, "the relative time becomes an absolute deadline");
	assert.equal(host.requests.length, 0, "scheduling starts no model turn");
});

it("terminal rewind owns its result in the executing conversation without another input", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("rewind");
	const manager = fixture.manager();
	const caller = { id: `terminal:${randomUUID()}`, cwd: fixture.root };
	const controller = new TerminalController({ manager, caller });
	t.after(() => controller.close());
	const row = await rowOf(manager, host.record.storageId);
	const entryId = await rewindEntry(host, manager);
	const gate = controlledGate();
	host.gates.set("rewind", gate);
	const returned = await formsFor(controller, row).run("rewind", [entryId, "gate:rewind"]);
	assert.ok(returned && typeof returned === "object" && returned.sessionId);
	const started = await gate.started;
	const status = await host.status(returned.sessionId);
	const submissionId = status.submissions.find((input) => input.type === "input")?.id;
	assert.ok(submissionId);
	const request = host.calls.find((call) => call.method === "rewind");
	assert.equal(request?.params?.selfOwned, true);
	assert.equal(request?.params?.ownerId, caller.id, "the manager preserves the caller before host ownership resolution");
	assert.equal(status.owner, caller.id, "fork provenance stays with the caller");
	gate.release();
	assert.equal((await host.settled(submissionId) as { status: string }).status, "done");
	await settleDeliveries(host.durable.harness, BACKGROUND_CONTEXT);
	const state = await readRetainedDelivery(host.durable.harness, BACKGROUND_CONTEXT, true);
	assert.equal(state?.receipts[String(submissionId)]?.ownerId, returned.sessionId);
	assert.equal(state?.receipts[String(submissionId)]?.conversationId, started.conversationId);
	const errors = eventLog<Error>();
	const passes = eventLog<void>();
	const watcher = startDurableDelivery({ host: host.durable, metadata: hostMetadata(host.record), catalog: new AgentCatalog(fixture.agentDir), signal: new AbortController().signal, onError: (error) => errors.push(error), onIdle: () => passes.push(undefined) });
	try {
		await passes.waitForCount(2);
	} finally { await watcher.close(); }
	const delivered = await readRetainedDelivery(host.durable.harness, BACKGROUND_CONTEXT, true);
	assert.equal(delivered?.receipts[String(submissionId)]?.acknowledged, true);
	assert.deepEqual(errors, []);
	assert.equal((await host.durable.request("status", { sessionId: returned.sessionId }) as { deliveryError?: string }).deliveryError, undefined);
	assert.equal(host.requests.length, 4, "only the seed and requested work use provider turns");
});

for (const action of ["rewind", "timer-schedule"] as const) for (const selfOwned of [undefined, false, true]) it(`host ${action} preserves caller provenance with selfOwned ${selfOwned}`, { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("host-options", { timers: action === "timer-schedule" });
	const caller = `terminal:${randomUUID()}`;
	const manager = fixture.manager();
	const entryId = action === "rewind" ? await rewindEntry(host, manager) : undefined;
	const gate = controlledGate();
	host.gates.set("options", gate);
	const sibling = action === "timer-schedule" ? await createSibling(host) : host.record.storageId;
	const target = action === "timer-schedule" ? `${host.record.storageId}:${sibling.split(":")[1]?.padStart(3, "0")}` : sibling;
	const result = await host.durable.request(action, { sessionId: target, message: "gate:options", correction: "gate:options", entryId, ownerId: caller, requestId: "host-options", scheduleId: "host-options", deliverAt: Date.now() - 1, origin: "operator", ...(selfOwned === undefined ? {} : { selfOwned }) }) as { submissionId?: number; identity: string };
	const started = await gate.started;
	const identity = host.durable.identity(started.conversationId as ConversationId);
	const status = await host.status(identity);
	const submissionId = status.submissions.find((input) => input.type === "input")?.id;
	assert.ok(submissionId);
	if (action === "rewind") assert.equal(status.owner, caller);
	else {
		const context = await host.durable.harness.snapshot(RequestContextDoc, started.conversationId as ConversationId, BACKGROUND_CONTEXT);
		assert.equal(context?.requests[0]?.requester, caller);
		assert.equal(context?.requests[0]?.replyTo, selfOwned ? identity : caller);
		assert.notEqual(target, identity, "the host resolves the padded selector to its canonical target identity");
	}
	gate.release();
	await host.settled(submissionId);
	await settleDeliveries(host.durable.harness, BACKGROUND_CONTEXT);
	const state = await readRetainedDelivery(host.durable.harness, BACKGROUND_CONTEXT, true);
	assert.equal(state?.receipts[String(submissionId)]?.ownerId, selfOwned ? identity : caller);
	assert.equal(state?.receipts[String(submissionId)]?.origin, "operator");
	if (action === "rewind") assert.equal(result.identity, identity);
});

/** Resolve with the selected identity's live frame once `accept` holds. */
function frameWhen(controller: TerminalController, id: string, accept: (frame: ConversationFrame) => boolean): Promise<ConversationFrame> {
	return new Promise((resolve) => {
		const check = () => {
			const frame = controller.source.frame(id);
			if (frame && accept(frame)) {
				off();
				resolve(frame);
			}
		};
		const off = controller.source.subscribe(check);
		check();
	});
}

const viewing = new WeakSet<TerminalController>();

/**
 * Select one identity as the work view does: the view listens for its whole life, and selection
 * is passive, with the live observation and owner modules of the chosen identity.
 */
function observe(controller: TerminalController, id: string, accept: (frame: ConversationFrame) => boolean = () => true): Promise<ConversationFrame> {
	if (!viewing.has(controller)) {
		viewing.add(controller);
		controller.source.subscribe(() => {});
	}
	controller.select(id);
	controller.source.select(id);
	return frameWhen(controller, id, accept);
}

async function activeInput(host: ControlledTerminalHost, identity = host.record.storageId) {
	const status = await host.status(identity);
	const inputs = status.submissions.filter((submission) => submission.type === "input");
	assert.equal(inputs.length, 1);
	assert.equal(status.busy, true);
	assert.ok(status.tasks.some((task) => task.kind === "pi.tool"));
	const input = inputs[0];
	assert.ok(input);
	return input.id;
}

function assertNoAbort(host: ControlledTerminalHost) {
	assert.equal(host.calls.some((call) => ["abort", "configure", "compact", "reset", "rewind"].includes(call.method)), false);
	for (const gate of host.gates.values()) assert.equal(gate.aborts, 0);
}

it("acknowledges terminal input without submitting its answer back to the target", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("self-owned");
	const gate = controlledGate();
	host.gates.set("answer", gate);
	const controller = new TerminalController({ manager: fixture.manager(), caller: { id: `terminal:${randomUUID()}`, cwd: fixture.root } });
	const revisions = eventLog<AgentDeliveryState>();
	const off = onStoredCommit(host.durable.harness, (publication) => {
		const receipts = { ...revisions.at(-1)?.receipts };
		let changed = false;
		for (const change of publication.changes) {
			if (change.type !== "document" || change.kind !== "change" || change.record.kind !== "agent.delivery-row" || change.value.kind !== "receipt" || change.value.value == null) continue;
			const receipt = JSON.parse(JSON.stringify(change.value.value)) as AgentDeliveryState["receipts"][string];
			receipts[String(receipt.submissionId)] = receipt;
			changed = true;
		}
		if (changed) revisions.push({ intents: [], receipts, reports: [] });
	});
	const errors = eventLog<Error>();
	const watcher = startDurableDelivery({ host: host.durable, metadata: hostMetadata(host.record), catalog: new AgentCatalog(fixture.agentDir), signal: new AbortController().signal, onError: (error) => errors.push(error) });
	try {
		const admitted = await controller.admit(host.record.storageId, "gate:answer", "steer");
		const id = (admitted.raw as { submissionId: number }).submissionId;
		await gate.started;
		assert.equal(host.requests.length, 1);
		gate.release();
		assert.equal((await host.settled(id) as { status: string }).status, "done");
		await revisions.waitFor((states) => states.some((state) => state.receipts[String(id)]?.acknowledged === true));
		await watcher.close();
		const state = await readRetainedDelivery(host.durable.harness, BACKGROUND_CONTEXT, true);
		assert.equal(state?.receipts[String(id)]?.origin, "operator");
		assert.equal(state?.receipts[String(id)]?.ownerId, host.record.storageId);
		assert.equal(state?.receipts[String(id)]?.acknowledged, true);
		const status = await host.status();
		for (const input of status.submissions) if (input.type === "input") await host.settled(input.id);
		const entries = await host.durable.root().entries({}, 50, undefined, BACKGROUND_CONTEXT);
		assert.deepEqual({ modelRequests: host.requests.length, resultInputs: entries.items.filter((entry) => entry.kind === "pi.user" && JSON.stringify(entry).includes("Agent result from")).length },
			{ modelRequests: 2, resultInputs: 0 }, "only the tool call and its answer request the model; no answer is fed back as input");
		assert.deepEqual(errors, []);
	} finally { gate.release(); off(); await watcher.close(); await controller.close(); }
});

it("switches A-B-A observations without replay, identity changes, or a model turn while both native tools block", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const a = await fixture.host("a");
	const b = await fixture.host("b");
	const gateA = controlledGate();
	const gateB = controlledGate();
	a.gates.set("a", gateA);
	b.gates.set("b", gateB);
	const controller = new TerminalController({ manager: fixture.manager(), caller: { id: "terminal-one", cwd: fixture.root } });
	t.after(() => controller.close());
	await observe(controller, a.record.storageId);
	await controller.admit(a.record.storageId, "gate:a", "steer");
	const startedA = await gateA.started;
	const inputA = await activeInput(a);
	await observe(controller, b.record.storageId);
	await controller.admit(b.record.storageId, "gate:b", "steer");
	const startedB = await gateB.started;
	const inputB = await activeInput(b);
	const identitiesA = await a.identityState();
	const identitiesB = await b.identityState();
	assert.equal(a.requests.length, 1);
	assert.equal(b.requests.length, 1);
	assert.ok(a.requests[0]?.sessionId);
	assert.ok(b.requests[0]?.sessionId);
	assert.notEqual(a.requests[0]?.sessionId, b.requests[0]?.sessionId);
	for (const host of [a, b, a]) {
		const frame = await observe(controller, host.record.storageId, (value) => value.storageId === host.record.storageId && value.status.busy);
		assert.equal(controller.selected, host.record.storageId);
		assert.equal(frame.conversationId, 1);
		assert.equal(frame.status.submissions[0]?.id, host === a ? inputA : inputB);
		assert.deepEqual(await a.identityState(), identitiesA);
		assert.deepEqual(await b.identityState(), identitiesB);
		assert.equal(a.requests.length, 1, "observation changes do not request a model turn");
		assert.equal(b.requests.length, 1, "observation changes do not request a model turn");
		assert.equal(gateA.calls, 1, "the native effect is not replayed");
		assert.equal(gateB.calls, 1, "the native effect is not replayed");
	}
	assert.ok((await a.status()).tasks.some((task) => task.id === startedA.taskId));
	assert.ok((await b.status()).tasks.some((task) => task.id === startedB.taskId));
	assertNoAbort(a);
	assertNoAbort(b);
	gateA.release();
	gateB.release();
	assert.equal((await a.settled(inputA) as { status: string }).status, "done");
	assert.equal((await b.settled(inputB) as { status: string }).status, "done");
	assert.equal(a.requests.length, 2, "only the normal post-tool answer requests another turn");
	assert.equal(b.requests.length, 2);
	assert.equal(a.requests[1]?.sessionId, a.requests[0]?.sessionId);
	assert.equal(b.requests[1]?.sessionId, b.requests[0]?.sessionId);
});

it("attaches the exact nonroot identity without changing root or sibling work", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("nonroot");
	const target = await createSibling(host);
	const sibling = await createSibling(host);
	const identities = [host.record.storageId, target, sibling];
	const gates = identities.map((_identity, index) => {
		const gate = controlledGate();
		host.gates.set(`c${index}`, gate);
		return gate;
	});
	const controller = new TerminalController({ manager: fixture.manager(), caller: { id: "terminal-nonroot", cwd: fixture.root } });
	t.after(() => controller.close());
	const submissions: number[] = [];
	for (const [index, identity] of identities.entries()) {
		await observe(controller, identity);
		await controller.admit(identity, `gate:c${index}`, "steer");
		const gate = gates[index];
		assert.ok(gate);
		await gate.started;
		submissions.push(await activeInput(host, identity));
	}
	const before = await Promise.all(identities.map((identity) => host.identityState(identity)));
	const frame = await observe(controller, target, (value) => `${value.storageId}:${value.conversationId}` === target && value.status.busy);
	assert.equal(controller.selected, target);
	assert.equal(frame.status.identity, target);
	assert.equal(frame.status.submissions[0]?.id, submissions[1]);
	assert.deepEqual(await Promise.all(identities.map((identity) => host.identityState(identity))), before);
	assert.equal(host.requests.length, 3);
	assert.equal(new Set(host.requests.map((request) => request.sessionId)).size, 3);
	for (const gate of gates) assert.equal(gate.calls, 1);
	assertNoAbort(host);
	for (const gate of gates) gate.release();
	for (const id of submissions) assert.equal((await host.settled(id) as { status: string }).status, "done");
});

it("admits two clients to one target and closes only the first client's observations", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("shared");
	const firstGate = controlledGate();
	const secondGate = controlledGate();
	host.gates.set("first", firstGate);
	host.gates.set("second", secondGate);
	const first = new TerminalController({ manager: fixture.manager(), caller: { id: "terminal-first", cwd: fixture.root } });
	const second = new TerminalController({ manager: fixture.manager(), caller: { id: "terminal-second", cwd: fixture.root } });
	t.after(async () => { await first.close(); await second.close(); });
	const id = host.record.storageId;
	await Promise.all([observe(first, id), observe(second, id)]);
	await host.waitForObservations(2);
	await first.admit(id, "gate:first", "steer");
	await firstGate.started;
	const firstInput = await activeInput(host);
	await second.admit(id, "gate:second", "followUp");
	const queued = await host.status();
	assert.equal(queued.submissions.length, 2, "both clients address the same conversation through native admission");
	const secondInput = queued.submissions.find((submission) => submission.id !== firstInput)?.id;
	assert.ok(secondInput);
	const beforeClose = await host.identityState();
	const released = host.waitForObservations(1);
	await first.close();
	await released;
	assert.equal(host.observations.size, 1, "only the first client's token is released");
	assert.deepEqual(await host.identityState(), beforeClose);
	assert.equal(firstGate.calls, 1);
	assert.equal(host.requests.length, 1);
	assertNoAbort(host);
	const continued = frameWhen(second, id, (frame) => frame.status.busy && frame.status.submissions.some((submission) => submission.id === secondInput) && frame.entries.some((entry) => JSON.stringify(entry).includes("released:first")));
	firstGate.release();
	await secondGate.started;
	await continued;
	assert.equal((await host.settled(firstInput) as { status: string }).status, "done");
	assert.equal(secondGate.calls, 1);
	assert.equal(host.observations.size, 1);
	const finished = frameWhen(second, id, (frame) => !frame.status.busy && frame.entries.some((entry) => JSON.stringify(entry).includes("answer:second")));
	secondGate.release();
	assert.equal((await host.settled(secondInput) as { status: string }).status, "done");
	await finished;
	assert.equal(second.selected, id);
	assertNoAbort(host);
});

it("runs native commands with a distinct invocation ID on the target captured when the form opened", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("commands");
	const target = await createSibling(host);
	const manager = fixture.manager();
	const controller = new TerminalController({ manager, caller: { id: "terminal-command", cwd: fixture.root } });
	t.after(() => controller.close());
	await observe(controller, target);
	const forms = formsFor(controller, await rowOf(manager, target));
	const listed = await forms.commands();
	assert.ok(listed?.some((choice) => choice.value === "echo"), "the host's inventory backs the command list");
	assert.ok(listed?.some((choice) => choice.value === "reload"));
	await observe(controller, host.record.storageId);
	const result = await forms.run("command", ["echo", "hello"]);
	assert.ok(result && typeof result === "object");
	const command = host.commandCalls[0];
	assert.ok(command);
	assert.equal(command.args, "hello");
	assert.equal(host.durable.identity(command.conversation.id), target);
	assert.equal(command.host, host.contributionHost);
	assert.equal(command.harness, host.durable.harness);
	assert.match(command.invocationId, /^[a-f0-9-]{36}$/u);
	assert.equal(controller.selected, host.record.storageId, "running a command never moves the selection");
	assert.equal(result.sessionId, target);
	assert.match(result.text, /Ran command echo/u);
	await forms.run("command", ["echo", "hello"]);
	assert.equal(host.commandCalls.length, 2);
	assert.notEqual(host.commandCalls[1]?.invocationId, command.invocationId);
	const dispatched = host.calls.filter((call) => call.method === "command");
	assert.equal(dispatched.length, 2);
	for (const call of dispatched) {
		assert.equal(call.params?.sessionId, target);
		assert.ok(typeof call.params?.invocationId === "string" && call.params.invocationId.length > 0);
	}
	assert.equal(host.requests.length, 0, "command dispatch does not request a model turn");
});

it("configures the native model object on an idle exact target without provider calls", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("configuration");
	const target = await createSibling(host);
	const manager = fixture.manager();
	const controller = new TerminalController({ manager, caller: { id: "terminal-configure", cwd: fixture.root } });
	t.after(() => controller.close());
	const forms = formsFor(controller, await rowOf(manager, target));
	const model = { provider: host.record.model.provider, modelId: "alternate" };
	const rootBefore = await host.status();
	const offered = await forms.models();
	assert.ok(offered.some((choice) => choice.identity === `${model.provider}/${model.modelId}`), "the host's own model list backs the picker");
	await runForm("configure", forms, /Configure /u, "Apply", (frame) => {
		frame.handleInput("\r");
		for (const character of "alternate") frame.handleInput(character);
	});
	const result = forms.results[0];
	assert.ok(result && typeof result === "object");
	assert.match(result.text, /Updated configuration/u);
	assert.deepEqual((await host.status(target)).agent.model, model);
	assert.deepEqual((await host.status()).agent, rootBefore.agent);
	const configure = host.calls.filter((call) => call.method === "configure");
	assert.equal(configure.length, 1);
	assert.equal(configure[0]?.params?.sessionId, target);
	assert.deepEqual(configure[0]?.params?.model, model);
	assert.equal(host.requests.length, 0, "model selection does not invoke the provider");
	assert.equal((await host.status(target)).busy, false);
});
