import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { AgentDeliveryDoc, settleDeliveries, type AgentDeliveryState } from "./durable-controls.ts";
import { committedChoices } from "./action-dialogs.ts";
import { RequestContextDoc } from "./request-context.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import { startDurableDelivery } from "./durable-delivery.ts";
import { eventLog } from "./host-fixture.mts";
import type { ConversationFrame } from "./live-frames.ts";
import { TerminalController } from "./terminal-client.ts";
import { terminalAction } from "./terminal-actions.ts";
import { controlledGate, createSibling, terminalHostFixture, type ControlledTerminalHost } from "./terminal-host-fixture.mts";

async function rewindEntry(host: ControlledTerminalHost, manager: TerminalController["manager"]): Promise<string> {
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

for (const action of ["rewind", "schedule"] as const) it(`terminal ${action} owns its result in the executing conversation without another input`, { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host(action, { timers: action === "schedule" });
	const manager = fixture.manager();
	const caller = { id: `terminal:${randomUUID()}`, cwd: fixture.root };
	const controller = new TerminalController({ manager, caller });
	t.after(() => controller.close());
	await controller.attach(host.record.storageId);
	const row = controller.row;
	assert.ok(row);
	const entryId = action === "rewind" ? await rewindEntry(host, manager) : undefined;
	const gate = controlledGate();
	host.gates.set(action, gate);
	const answers = action === "rewind" ? [entryId, `gate:${action}`] : [`gate:${action}`, new Date(Date.now() - 1).toISOString()];
	const returned = await terminalAction(controller, async () => answers.shift(), action, row);
	assert.ok(returned?.sessionId);
	const started = await gate.started;
	const status = await host.status(returned.sessionId);
	const submissionId = status.submissions.find((input) => input.type === "input")?.id;
	assert.ok(submissionId);
	const request = host.calls.find((call) => call.method === (action === "rewind" ? "rewind" : "timer-schedule"));
	assert.equal(request?.params?.selfOwned, true);
	assert.equal(request?.params?.ownerId, caller.id, "the manager preserves the caller before host ownership resolution");
	if (action === "rewind") assert.equal(status.owner, caller.id, "fork provenance stays with the caller");
	else {
		const context = await host.durable.harness.snapshot(RequestContextDoc, started.conversationId as ConversationId, BACKGROUND_CONTEXT);
		assert.equal(context?.requests[0]?.requester, caller.id);
		assert.equal(context?.requests[0]?.replyTo, returned.sessionId);
	}
	gate.release();
	assert.equal((await host.settled(submissionId) as { status: string }).status, "done");
	await settleDeliveries(host.durable.harness, BACKGROUND_CONTEXT);
	const state = await host.durable.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
	assert.equal(state?.receipts[String(submissionId)]?.ownerId, returned.sessionId);
	assert.equal(state?.receipts[String(submissionId)]?.conversationId, started.conversationId);
	const errors = eventLog<Error>();
	const passes = eventLog<void>();
	const watcher = startDurableDelivery({ host: host.durable, metadata: hostMetadata(host.record), catalog: new AgentCatalog(fixture.agentDir), signal: new AbortController().signal, onError: (error) => errors.push(error), onIdle: () => passes.push(undefined) });
	try {
		await passes.waitForCount(2);
	} finally { await watcher.close(); }
	const delivered = await host.durable.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
	assert.equal(delivered?.receipts[String(submissionId)]?.acknowledged, true);
	assert.deepEqual(errors, []);
	assert.equal((await host.durable.request("status", { sessionId: returned.sessionId }) as { deliveryError?: string }).deliveryError, undefined);
	assert.equal(host.requests.length, action === "rewind" ? 4 : 2, "only the seed and requested work use provider turns");
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
	const state = await host.durable.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
	assert.equal(state?.receipts[String(submissionId)]?.ownerId, selfOwned ? identity : caller);
	assert.equal(state?.receipts[String(submissionId)]?.origin, "operator");
	if (action === "rewind") assert.equal(result.identity, identity);
});

function frameWhen(controller: TerminalController, accept: (frame: ConversationFrame) => boolean): Promise<ConversationFrame> {
	return new Promise((resolve) => {
		const check = () => {
			const frame = controller.frame;
			if (frame && accept(frame)) { off(); resolve(frame); }
		};
		const off = controller.subscribe(check);
		check();
	});
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
	const off = host.durable.harness.subscribeCommits((publication) => {
		for (const change of publication.changes) {
			if (change.type === "document" && change.record.kind === "agent.delivery" && change.value !== null)
				revisions.push(change.value as unknown as AgentDeliveryState);
		}
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
		const state = await host.durable.harness.snapshot(AgentDeliveryDoc, BACKGROUND_CONTEXT);
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
	await controller.attach(a.record.storageId);
	await controller.send("gate:a");
	const startedA = await gateA.started;
	const inputA = await activeInput(a);
	await controller.attach(b.record.storageId);
	await controller.send("gate:b");
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
		await controller.attach(host.record.storageId);
		const frame = await frameWhen(controller, (value) => value.storageId === host.record.storageId && value.status.busy);
		assert.equal(controller.target, host.record.storageId);
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
		await controller.attach(identity);
		await controller.send(`gate:c${index}`);
		const gate = gates[index];
		assert.ok(gate);
		await gate.started;
		submissions.push(await activeInput(host, identity));
	}
	const before = await Promise.all(identities.map((identity) => host.identityState(identity)));
	await controller.attach(target);
	const frame = await frameWhen(controller, (value) => `${value.storageId}:${value.conversationId}` === target && value.status.busy);
	assert.equal(controller.target, target);
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
	await first.attach(host.record.storageId);
	await second.attach(host.record.storageId);
	await Promise.all([frameWhen(first, () => true), frameWhen(second, () => true)]);
	await host.waitForObservations(2);
	await first.send("gate:first");
	await firstGate.started;
	const firstInput = await activeInput(host);
	second.setMode("followUp");
	await second.send("gate:second");
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
	const continued = frameWhen(second, (frame) => frame.status.busy && frame.status.submissions.some((submission) => submission.id === secondInput) && frame.entries.some((entry) => JSON.stringify(entry).includes("released:first")));
	firstGate.release();
	await secondGate.started;
	await continued;
	assert.equal((await host.settled(firstInput) as { status: string }).status, "done");
	assert.equal(secondGate.calls, 1);
	assert.equal(host.observations.size, 1);
	const finished = frameWhen(second, (frame) => !frame.status.busy && frame.entries.some((entry) => JSON.stringify(entry).includes("answer:second")));
	secondGate.release();
	assert.equal((await host.settled(secondInput) as { status: string }).status, "done");
	await finished;
	assert.equal(second.target, host.record.storageId);
	assertNoAbort(host);
});

it("dispatches native commands with a distinct invocation ID and the target captured before the dialog", { timeout: 20000 }, async (t) => {
	const fixture = terminalHostFixture(t);
	const host = await fixture.host("commands");
	const target = await createSibling(host);
	const controller = new TerminalController({ manager: fixture.manager(), caller: { id: "terminal-command", cwd: fixture.root } });
	t.after(() => controller.close());
	await controller.attach(target);
	const row = controller.row;
	assert.ok(row);
	let enterArgs!: () => void;
	const entered = new Promise<void>((resolve) => { enterArgs = resolve; });
	let answerArgs!: (args: string) => void;
	const argumentsReply = new Promise<string>((resolve) => { answerArgs = resolve; });
	let questions = 0;
	const pending = terminalAction(controller, async () => {
		if (++questions === 1) return "echo";
		enterArgs();
		return argumentsReply;
	}, "command", row);
	await entered;
	await controller.attach(host.record.storageId);
	answerArgs("hello");
	const result = await pending;
	assert.ok(result);
	const command = host.commandCalls[0];
	assert.ok(command);
	assert.equal(command.args, "hello");
	assert.equal(host.durable.identity(command.conversation.id), target);
	assert.equal(command.host, host.contributionHost);
	assert.equal(command.harness, host.durable.harness);
	assert.match(command.invocationId, /^[a-f0-9-]{36}$/u);
	assert.equal(controller.target, host.record.storageId);
	assert.equal((JSON.parse(result.text) as { identity: string }).identity, target);
	const inputs = ["echo", "hello"];
	await terminalAction(controller, async () => inputs.shift(), "command", row);
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
	const controller = new TerminalController({ manager: fixture.manager(), caller: { id: "terminal-configure", cwd: fixture.root } });
	t.after(() => controller.close());
	await controller.attach(target);
	const row = controller.row;
	assert.ok(row);
	const model = { provider: host.record.model.provider, modelId: "alternate" };
	const rootBefore = await host.status();
	const result = await terminalAction(controller, async () => JSON.stringify({ model }), "configure", row);
	assert.ok(result);
	assert.equal((JSON.parse(result.text) as { outcome: string }).outcome, "applied");
	assert.deepEqual((await host.status(target)).agent.model, model);
	assert.deepEqual((await host.status()).agent, rootBefore.agent);
	const configure = host.calls.find((call) => call.method === "configure");
	assert.equal(configure?.params?.sessionId, target);
	assert.deepEqual(configure?.params?.model, model);
	await assert.rejects(terminalAction(controller, async () => JSON.stringify({ model: "provider/model" }), "configure", row), /Use model: \{provider,modelId\}, not a provider\/model string/u);
	assert.equal(host.calls.filter((call) => call.method === "configure").length, 1, "invalid model shape stops before native dispatch");
	assert.deepEqual((await host.status(target)).agent.model, model);
	assert.equal(host.requests.length, 0, "model selection and rejected shape do not invoke the provider");
	assert.equal((await host.status(target)).busy, false);
});
