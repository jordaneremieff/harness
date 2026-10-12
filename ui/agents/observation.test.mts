import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/chord";
import { HostLink } from "./client.mts";
import type { ConversationFrame } from "./contract.mts";
import { CHILD, deferred, descriptor, FakeHost, frame, snapshot, STORAGE } from "./fake-host.mts";
import { ObservationManager, type AvailabilityState } from "./observation.mts";

interface Seen {
	workspace: string;
	identity: string;
	epoch: number;
	revision: number;
}
function observer(getLink: (identity: string) => Promise<HostLink>) {
	const seen: Seen[] = [];
	const availability: { identity: string; state: AvailabilityState }[] = [];
	const waiters: { predicate: (value: Seen) => boolean; resolve: (value: Seen) => void }[] = [];
	const unavailable = deferred<void>();
	const manager = new ObservationManager({
		getLink,
		onFrame: (workspace, identity, epoch, value) => {
			const received = { workspace, identity, epoch, revision: value.revision };
			seen.push(received);
			for (const waiter of [...waiters])
				if (waiter.predicate(received)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(received);
				}
		},
		onAvailability: (_workspace, identity, _epoch, state) => {
			availability.push({ identity, state });
			if (state === "unavailable") unavailable.resolve();
		},
	});
	return {
		manager,
		seen,
		availability,
		unavailable,
		wait: (predicate: (value: Seen) => boolean): Promise<Seen> => {
			const existing = seen.find(predicate);
			return existing ? Promise.resolve(existing) : new Promise((resolve) => waiters.push({ predicate, resolve }));
		},
	};
}

test("subscription baseline replaces older open and snapshot state", async (t) => {
	const held = deferred<JsonValue>();
	const host = await FakeHost.start({
		openFrame: (identity) => frame(2, identity),
		subscriptionFrame: (identity) => frame(7, identity),
		handler: (call) => (call.member === "snapshot" ? held.promise : undefined),
	});
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	const selected = watch.manager.select("workspace", CHILD);
	const baseline = await watch.wait((value) => value.revision === 7);
	assert.equal(baseline.identity, CHILD);
	const older = snapshot();
	older.revision = "newer-history-response";
	older.entries = [{ id: "99", kind: "user", data: { text: "not the selected frame" } }];
	held.resolve(older);
	await selected;
	await turn();
	assert.deepEqual(
		watch.seen.map((value) => value.revision),
		[7],
	);
	assert.equal(host.tokenCount, 1);
	await watch.manager.hide("workspace");
	assert.equal(host.tokenCount, 0);
	const events = host.lifecycle.map((event) => event.kind);
	assert.ok(events.indexOf("unsubscribe") < events.indexOf("close"));
	assert.equal(host.calls.filter((call) => call.member === "abort").length, 0);
});

test("hide prevents a delayed link acquisition from opening an observation", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const held = deferred<HostLink>();
	const watch = observer(() => held.promise);
	t.after(() => watch.manager.close());
	const selected = watch.manager.select("workspace", STORAGE);
	await watch.manager.hide("workspace");
	held.resolve(link);
	await selected;
	await turn();
	assert.equal(host.calls.length, 0);
	assert.deepEqual(watch.seen, []);
	assert.deepEqual(watch.manager.identities(), []);
});

test("hiding one target suppresses its delayed selection without replacing another pane", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const held = deferred<HostLink>();
	const watch = observer((identity) => (identity === STORAGE ? held.promise : Promise.resolve(link)));
	t.after(() => watch.manager.close());
	const previous = watch.manager.select("workspace", STORAGE);
	await watch.manager.select("workspace", CHILD);
	await watch.wait((value) => value.identity === CHILD);
	await watch.manager.hide("workspace", STORAGE);
	held.resolve(link);
	await previous;
	await turn();
	assert.deepEqual(
		watch.seen.map((value) => value.identity),
		[CHILD],
	);
	assert.deepEqual(watch.manager.identities(), [CHILD]);
	assert.equal(host.tokenCount, 1);
	assert.ok(host.calls.every((call) => call.member !== "observe-open" || call.params?.sessionId === CHILD));
});

test("hide closes a token when subscription setup completes late", async (t) => {
	const gate = deferred<void>();
	const subscribed = deferred<void>();
	const host = await FakeHost.start({ subscriptionGate: gate.promise, onSubscribe: () => subscribed.resolve() });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	const selected = watch.manager.select("workspace", STORAGE);
	await subscribed.promise;
	await watch.manager.hide("workspace");
	gate.resolve();
	await selected;
	await turn();
	assert.equal(host.tokenCount, 0);
	assert.deepEqual(watch.seen, []);
	assert.equal(host.lifecycle.filter((event) => event.kind === "close").length, 1);
});

test("replacement frames coalesce and stale revisions do not replace current state", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	let deliver!: (value: ConversationFrame) => void;
	const wrapped = {
		require: link.require.bind(link),
		request: link.request.bind(link),
		onDisconnect: link.onDisconnect.bind(link),
		capabilities: link.capabilities.bind(link),
		get connected() {
			return link.connected;
		},
		subscribeObservation: async (...args: Parameters<HostLink["subscribeObservation"]>) => {
			deliver = args[1];
			return link.subscribeObservation(...args);
		},
	} as HostLink;
	const watch = observer(async () => wrapped);
	t.after(() => watch.manager.close());
	await watch.manager.select("workspace", STORAGE);
	await watch.wait((value) => value.revision === 1);
	// Synchronous producer replacements make the microtask-independent coalescing boundary deterministic.
	for (const revision of [2, 3, 4, 3]) deliver(frame(revision) as unknown as ConversationFrame);
	await watch.wait((value) => value.revision === 4);
	await turn();
	assert.deepEqual(
		watch.seen.map((value) => value.revision),
		[1, 4],
	);
});

test("disconnect keeps last frame and reconnect creates a fresh baseline and token", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const links: HostLink[] = [];
	let acquisitions = 0;
	const watch = observer(async () => {
		acquisitions++;
		const link = await HostLink.connect(host.endpoint);
		links.push(link);
		return link;
	});
	t.after(async () => {
		await watch.manager.close();
		await Promise.all(links.map((link) => link.close()));
	});
	await watch.manager.select("workspace", STORAGE);
	await watch.wait((value) => value.epoch === 1);
	const firstToken = host.calls.find((call) => call.member === "observe-open")?.params?.token;
	await host.publish(frame(8));
	await watch.wait((value) => value.revision === 8);
	await host.disconnect();
	await watch.unavailable.promise;
	await host.waitForRelease();
	await turn();
	assert.equal(host.tokenCount, 0);
	assert.equal(acquisitions, 1);
	assert.equal(watch.seen.at(-1)?.revision, 8);
	assert.equal(host.calls.filter((call) => ["abort", "configure", "task-submit"].includes(call.member)).length, 0);
	await watch.manager.reconnect("workspace", STORAGE);
	await watch.wait((value) => value.epoch === 2);
	const opens = host.calls.filter((call) => call.member === "observe-open");
	assert.equal(opens.length, 2);
	assert.notEqual(opens[1].params?.token, firstToken);
	assert.deepEqual(watch.seen.at(-1), { workspace: "workspace", identity: STORAGE, epoch: 2, revision: 1 });
	assert.equal(acquisitions, 2);
	await watch.manager.close();
	assert.equal(host.tokenCount, 0);
});

for (const member of ["snapshot", "observe-open", "observe-frame", "observe-close"] as const) {
	test(`selection requires compatible ${member} before any observation request`, async (t) => {
		const remote = await descriptor();
		delete (remote.operations as Record<string, JsonValue>)[member];
		const host = await FakeHost.start({ descriptor: remote });
		t.after(() => host.close());
		const link = await HostLink.connect(host.endpoint);
		t.after(() => link.close());
		const watch = observer(async () => link);
		t.after(() => watch.manager.close());
		await assert.rejects(watch.manager.select("workspace", STORAGE));
		assert.deepEqual(watch.availability, [{ identity: STORAGE, state: "incompatible" }]);
		assert.equal(host.calls.length, 0);
		assert.equal(link.supports("task-submit"), true);
	});
}

test("two workspaces retain separate owned tokens and close never shuts down the host", async (t) => {
	const host = await FakeHost.start();
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	await Promise.all([watch.manager.select("one", STORAGE), watch.manager.select("two", CHILD)]);
	await watch.wait((value) => value.workspace === "one");
	await watch.wait((value) => value.workspace === "two");
	assert.equal(host.tokenCount, 2);
	await watch.manager.hide("one");
	assert.equal(host.tokenCount, 1);
	await watch.manager.close();
	assert.equal(host.tokenCount, 0);
	assert.equal(link.connected, true);
	assert.equal(host.calls.filter((call) => call.member === "close" || call.member === "abort").length, 0);
	await assert.rejects(watch.manager.select("one", STORAGE), { code: "not_ready" });
});

test("malformed open receipt closes the original owned token", async (t) => {
	const host = await FakeHost.start({ openResult: (_token, value) => ({ token: "wrong", frame: value }) });
	t.after(() => host.close());
	const link = await HostLink.connect(host.endpoint);
	t.after(() => link.close());
	const watch = observer(async () => link);
	t.after(() => watch.manager.close());
	await assert.rejects(watch.manager.select("workspace", CHILD), { code: "protocol_error" });
	const opened = host.calls.find((call) => call.member === "observe-open");
	const closed = host.calls.find((call) => call.member === "observe-close");
	assert.ok(opened?.params?.token);
	assert.equal(closed?.params?.token, opened.params.token);
	assert.notEqual(closed?.params?.token, "wrong");
	assert.equal(host.tokenCount, 0);
	assert.equal(host.lifecycle.filter((event) => event.kind === "subscribe").length, 0);
	assert.deepEqual(watch.seen, []);
	assert.deepEqual(watch.manager.identities(), []);
});

function memoryLink() {
  let connected = true; let closes = 0; let failClose = false;
  const subscriptions: {identity:string; receive:(value:ConversationFrame)=>void; fail:(error:Error)=>void; disposed:boolean}[] = [];
  const calls: {member:string; params:Record<string,unknown>}[] = [];
  const link = {
    get connected() {return connected;}, require: () => {}, capabilities: () => ({snapshot:true,'observe-open':true,'observe-frame':true,'observe-close':true}),
    onDisconnect: () => () => {},
    request: async (member:string, params:Record<string,unknown>) => {calls.push({member,params}); if(member==='observe-close' && failClose) throw Error('Uncertain close'); return {};},
    subscribeObservation: async (_token:string, receive:(value:ConversationFrame)=>void, identity:string, fail:(error:Error)=>void) => {
      const subscription = {identity,receive,fail,disposed:false}; subscriptions.push(subscription);
      return {baseline:frame(1,identity) as unknown as ConversationFrame,start:()=>{},dispose:async()=>{subscription.disposed=true;}};
    }, close: async () => {closes++; connected=false;},
  } as unknown as HostLink;
  return {link,calls,subscriptions,get closes(){return closes;},set failClose(value:boolean){failClose=value;}};
}
test('pure concurrent observations isolate targets, workspace lifetimes, reconnect and late callbacks', async () => {
  const memory = memoryLink(); const seen:Seen[]=[]; const states:{identity:string;epoch:number;state:AvailabilityState}[]=[];
  const manager = new ObservationManager({getLink:async()=>memory.link,
    onFrame:(workspace,identity,epoch,value)=>seen.push({workspace,identity,epoch,revision:value.revision}),
    onAvailability:(_workspace,identity,epoch,state)=>states.push({identity,epoch,state})});
  try {
    await Promise.all([manager.select('w',STORAGE,1),manager.select('w',CHILD,2),manager.select('other',STORAGE,3)]); await turn();
    assert.deepEqual(seen.map(({workspace,identity,epoch})=>[workspace,identity,epoch]),[['w',STORAGE,1],['w',CHILD,2],['other',STORAGE,3]]);
    await manager.select('w',STORAGE,1); assert.equal(memory.subscriptions.length,3);
    await manager.hide('w',STORAGE);
    memory.subscriptions[0]?.receive(frame(9) as unknown as ConversationFrame); memory.subscriptions[0]?.fail(Error('Late failure'));
    memory.subscriptions[1]?.receive(frame(7,CHILD) as unknown as ConversationFrame); await turn();
    assert.deepEqual(seen.at(-1),{workspace:'w',identity:CHILD,epoch:2,revision:7}); assert.equal(states.length,3);
    await manager.reconnect('w',CHILD,4); await turn();
    memory.subscriptions[1]?.receive(frame(90,CHILD) as unknown as ConversationFrame); await turn();
    assert.deepEqual(seen.at(-1),{workspace:'w',identity:CHILD,epoch:4,revision:1});
    assert.deepEqual(manager.identities().sort(),[CHILD,STORAGE].sort()); assert.equal(memory.closes,0);
    assert.ok(memory.calls.every(call=>['snapshot','observe-open','observe-close'].includes(call.member)));
  } finally {await manager.close();}
});
test('pure concurrent observation caps count disposed asynchronous setups without retaining target history', async () => {
  const held = deferred<HostLink>(); const memory=memoryLink(); let frames=0;
  const manager=new ObservationManager({getLink:()=>held.promise,onFrame:()=>{frames++;}});
  const setups:Promise<void>[]=[];
  try {
    for(let i=0;i<16;i++) {setups.push(manager.select(`w${i}`,STORAGE,i+1)); await manager.hide(`w${i}`);}
    await assert.rejects(manager.select('overflow',STORAGE,17),{code:'capacity'});
    held.resolve(memory.link); await Promise.all(setups); await turn();
    assert.equal(memory.calls.length,0); assert.equal(frames,0);
    await manager.select('fresh',STORAGE,18); await turn(); assert.equal(frames,1);
    await Promise.all([manager.select('fresh',CHILD,19),manager.select('fresh',`${STORAGE}:3`,20),manager.select('fresh',`${STORAGE}:4`,21)]);
    await assert.rejects(manager.select('fresh',`${STORAGE}:5`,22),{code:'capacity'});
  } finally {held.resolve(memory.link); await Promise.allSettled(setups); await manager.close();}
});
test('pure concurrent late native open closes its original token after early disposal',async context=> {
  const memory=memoryLink();const entered=deferred<void>();const release=deferred<void>();const tokens=new Set<string>();let closeCalls=0;let seen=0;
  context.mock.method(memory.link,'request',async (member:string,params:Record<string,unknown>)=> {
    if(member==='observe-open') {entered.resolve();await release.promise;tokens.add(params.token as string);}
    if(member==='observe-close') {closeCalls++;tokens.delete(params.token as string);}return {};
  });
  const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{seen++;}});
  const setup=manager.select('w',STORAGE,1);await entered.promise;await manager.hide('w',STORAGE);
  assert.equal(closeCalls,1);release.resolve();await setup;await turn();
  assert.equal(closeCalls,2);assert.equal(tokens.size,0);assert.equal(seen,0);assert.equal(memory.subscriptions.length,0);await manager.close();
});
test('pure concurrent failed token cleanup preserves shared links and reserves bounded capacity', async () => {
  const memory=memoryLink(); const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  try {
    await manager.select('healthy',STORAGE,1); memory.failClose=true;
    for(let i=0;i<15;i++) {await manager.select(`retired${i}`,CHILD,i+2); await manager.hide(`retired${i}`,CHILD);}
    assert.equal(memory.closes,0); assert.equal(memory.link.connected,true); assert.deepEqual(manager.identities(),[STORAGE]);
    await assert.rejects(manager.select('full',CHILD,17),{code:'capacity'});
    await memory.link.close(); memory.failClose=false;
    await manager.select('fresh',CHILD,18);
  } finally {await manager.close();}
});
