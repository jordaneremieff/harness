import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import type { JsonValue } from "@earendil-works/chord";
import { AgentError, HostLink } from "./client.mts";
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
  let connected = true; let closes = 0; let failClose = false; let failDispose = false;
  const subscriptions: {identity:string; receive:(value:ConversationFrame)=>void; fail:(error:Error)=>void; disposed:boolean}[] = [];
  const lifecycle:string[]=[];
  const calls: {member:string; params:Record<string,unknown>}[] = [];
  const link = {
    get connected() {return connected;}, require: () => {}, capabilities: () => ({snapshot:true,'observe-open':true,'observe-frame':true,'observe-close':true}),
    onDisconnect: () => () => {},
    request: async (member:string, params:Record<string,unknown>) => {calls.push({member,params}); lifecycle.push(member); if(member==='observe-close' && failClose) throw Error('Invalid close response'); return {};},
    subscribeObservation: async (_token:string, receive:(value:ConversationFrame)=>void, identity:string, fail:(error:Error)=>void) => {
      const subscription = {identity,receive,fail,disposed:false}; subscriptions.push(subscription);
      return {baseline:frame(1,identity) as unknown as ConversationFrame,start:()=>{},dispose:async()=>{lifecycle.push('release');if(failDispose) throw Error('Release failed');subscription.disposed=true;}};
    }, close: async () => {closes++; connected=false;},
  } as unknown as HostLink;
  return {link,calls,subscriptions,lifecycle,get closes(){return closes;},set failClose(value:boolean){failClose=value;},set failDispose(value:boolean){failDispose=value;}};
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
test('manager close reports failed cleanup after a late native open', async context => {
  const memory=memoryLink();const entered=deferred<void>();const opened=deferred<void>();const earlyClose=deferred<void>();let closes=0;
  context.mock.method(memory.link,'request',async (member:string)=> {
    if(member==='observe-open') {entered.resolve();await opened.promise;}
    if(member==='observe-close') {
      if(++closes===1) {earlyClose.resolve();return {closed:false};}
      throw Error('Late token close failed');
    }
    return {};
  });
  const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  const setup=manager.select('w',STORAGE,1);await entered.promise;
  const setupRejected=assert.rejects(setup,/Late token close failed/);
  const closed=manager.close();const closeRejected=assert.rejects(closed,/Late token close failed/);
  await earlyClose.promise;opened.resolve();await setupRejected;await closeRejected;
  assert.equal(closes,2);assert.equal(memory.subscriptions.length,0);
});
for(const rejected of [false,true]) test(`manager close joins ${rejected?'rejected':'acknowledged'} cleanup after hide`, async context => {
  const memory=memoryLink();const entered=deferred<void>();const release=deferred<void>();let closeDone=false;
  context.mock.method(memory.link,'request',async (member:string)=> {
    if(member==='observe-close') {
      entered.resolve();await release.promise;
      if(rejected) throw Error('Hidden token close failed');
      return {closed:false};
    }
    return {};
  });
  const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  await manager.select('w',STORAGE,1);const hidden=manager.hide('w');await entered.promise;
  const closed=manager.close();void closed.then(()=>{closeDone=true;},()=>{closeDone=true;});
  const outcomes=Promise.allSettled([hidden,closed]);
  try {
    await turn();assert.equal(closeDone,false);assert.equal(memory.subscriptions[0].disposed,true);
    release.resolve();const results=await outcomes;
    assert.deepEqual(results.map(result=>result.status),rejected?['rejected','rejected']:['fulfilled','fulfilled']);
    if(rejected) for(const result of results) assert.ok(result.status==='rejected' && /Hidden token close failed/.test(String(result.reason)));
  } finally {release.resolve();await outcomes;}
});
for(const code of ['host_unavailable','protocol_error']) test(`late token cleanup distinguishes disconnected ${code} from native refusal`, async context => {
  const memory=memoryLink();const entered=deferred<void>();const opened=deferred<void>();const lateClose=deferred<void>();const cancelled=deferred<void>();let closes=0;
  context.mock.method(memory.link,'request',async(member:string)=>{
    if(member==='observe-open') {entered.resolve();await opened.promise;}
    if(member==='observe-close' && ++closes===2) {lateClose.resolve();await cancelled.promise;throw new AgentError(code,'Late close rejected');}
    return {closed:false};
  });
  const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  const setup=manager.select('w',STORAGE,1);await entered.promise;const setupOutcome=Promise.allSettled([setup]);
  const closed=manager.close(async()=>{opened.resolve();await lateClose.promise;await memory.link.close();cancelled.resolve();});
  const closeOutcome=Promise.allSettled([closed]);const results=[...(await setupOutcome),...(await closeOutcome)];
  assert.deepEqual(results.map(result=>result.status),code==='host_unavailable'?['fulfilled','fulfilled']:['rejected','rejected']);
  if(code==='protocol_error') for(const result of results) assert.ok(result.status==='rejected' && result.reason.code===code);
});
test('manager close does not convert a pending setup refusal into a cleanup error', async () => {
  const held=deferred<HostLink>();const manager=new ObservationManager({getLink:()=>held.promise,onFrame:()=>{}});
  const setup=manager.select('w',STORAGE,1);const setupRejected=assert.rejects(setup,/Setup refused/);
  const closed=manager.close();held.reject(Error('Setup refused'));await setupRejected;await closed;
});
test('Feed disposal precedes acknowledged token close and false receipts release capacity', async context => {
  const memory=memoryLink();const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  const request=memory.link.request.bind(memory.link);
  context.mock.method(memory.link,'request',async (...args:Parameters<HostLink['request']>)=>{await request(...args);return {closed:false};});
  try {
    for(let index=0;index<20;index++) {
      await manager.select(`w${index}`,STORAGE,index+1);await manager.hide(`w${index}`);
      assert.deepEqual(memory.lifecycle.slice(-2),['release','observe-close']);
    }
    assert.equal(memory.closes,0);assert.equal(memory.link.connected,true);
  } finally {await manager.close();}
});
test('hide awaits the explicit close acknowledgement after Feed disposal', async context => {
  const memory=memoryLink();const entered=deferred<void>();const acknowledged=deferred<void>();let hidden=false;
  const request=memory.link.request.bind(memory.link);
  context.mock.method(memory.link,'request',async (...args:Parameters<HostLink['request']>)=>{
    await request(...args);
    if(args[0]==='observe-close') {entered.resolve();await acknowledged.promise;return {closed:false};}
    return {};
  });
  const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  try {
    await manager.select('w',STORAGE,1);const hide=manager.hide('w').then(()=>{hidden=true;});
    await entered.promise;assert.equal(memory.subscriptions[0].disposed,true);assert.equal(hidden,false);
    acknowledged.resolve();await hide;assert.equal(hidden,true);
  } finally {acknowledged.resolve();await manager.close();}
});
test('disconnected links need no explicit token close', async () => {
  const memory=memoryLink();const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  try {
    await manager.select('w',STORAGE,1);await memory.link.close();await manager.hide('w');
    assert.equal(memory.calls.filter(call=>call.member==='observe-close').length,0);
  } finally {await manager.close();}
});
test('rejected token cleanup stays visible and reserves capacity despite local Feed disposal', async () => {
  const memory=memoryLink();const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  try {
    memory.failClose=true;
    for(let index=0;index<16;index++) {
      await manager.select(`w${index}`,STORAGE,index+1);await assert.rejects(manager.hide(`w${index}`),/Invalid close response/);
      assert.equal(memory.subscriptions.at(-1)?.disposed,true);
    }
    await assert.rejects(manager.select('full',CHILD,17),{code:'capacity'});assert.equal(memory.closes,0);
    await memory.link.close();memory.failClose=false;
  } finally {await manager.close();}
});
test('local Feed disposal failure does not bypass explicit native close', async () => {
  const memory=memoryLink();const manager=new ObservationManager({getLink:async()=>memory.link,onFrame:()=>{}});
  try {
    memory.failDispose=true;await manager.select('w',STORAGE,1);
    await assert.rejects(manager.hide('w'),/Release failed/);
    assert.deepEqual(memory.lifecycle.slice(-2),['release','observe-close']);assert.equal(memory.closes,0);
  } finally {memory.failDispose=false;await manager.close();}
});
