import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, hostMetadata } from "./catalog.ts";
import { CATALOG_VIEW_BUDGET_BYTES, parseCatalogView } from "./catalog-view.ts";
import { runtimeFixture } from "./durable-runtime-fixture.mts";
import { createDurableRuntime } from "./durable-runtime.ts";
import { parseHostChanges, type HostChanges } from "./host-changes.ts";
import { connectHost, type HostConnection } from "./host-client.ts";
import { eventLog } from "./host-fixture.mts";
import { runHost } from "./host-process.ts";
import { PrimaryLiveActivity, withLiveActivity, type LiveActivityReplacement } from "./live-activity.ts";
import { AgentManager } from "./manager.ts";
import { createPrimaryChannel, type PrimaryChannelOptions } from "./primary-channel.ts";
import { createTestRuntime, testModel } from "./test-runtime.mts";

const base = {
	storageId: "storage",
	updatedAt: "2026-01-01T00:00:00.000Z",
	rows: [],
	coverage: { complete: true, omitted: 0 },
};
const row = { id: "item", conversationId: 1, label: "Command", startedAt: 100 };

type Producer = Parameters<typeof withLiveActivity>[1][number];
const unitSource = { source: "fixture.activity", read: () => [row] };

it("keeps the base publication intact when activity is absent, invalid or over budget", () => {
	assert.equal(withLiveActivity(base, [], 1), base);
	const unusable = {
		source: "bad",
		read: () => {
			throw new Error("presentation only");
		},
	};
	const expected = { source: unitSource.source, items: [row] };
	const scoped = withLiveActivity(base, [unusable, unitSource], 1);
	assert.deepEqual(scoped.liveActivity, [expected]);
	assert.equal(
		parseCatalogView(scoped),
		scoped,
		"the base parser used by non-opted-in readers accepts the bounded view",
	);
	const frame = { revision: 0, writerId: "writer", view: scoped };
	assert.deepEqual(parseHostChanges(frame, "writer", "storage").view, base);
	assert.deepEqual(parseHostChanges(frame, "writer", "storage", true).view, scoped);
	assert.deepEqual(
		parseHostChanges({ ...frame, view: { ...base, liveActivity: [expected, expected] } }, "writer", "storage", true)
			.view,
		base,
	);

	const padded = { ...base, pad: "" };
	padded.pad = "x".repeat(CATALOG_VIEW_BUDGET_BYTES - Buffer.byteLength(JSON.stringify(padded)));
	assert.equal(withLiveActivity(padded, [unitSource], 1), padded);
	assert.deepEqual(
		parseHostChanges({ ...frame, view: { ...padded, liveActivity: [expected] } }, "writer", "storage", true).view,
		padded,
	);

	let requested = 0;
	const many: Producer = {
		source: "only-read-a-prefix",
		read: () =>
			new Proxy(
				Array.from({ length: 100 }, (_, i) => ({ ...row, id: `${i}` })),
				{
					get(target, key) {
						if (typeof key === "string" && /^\d+$/u.test(key)) requested++;
						return Reflect.get(target, key);
					},
				},
			),
	};
	assert.equal(withLiveActivity(base, [many], 1).liveActivity?.[0].items.length, 8);
	assert.equal(requested, 8);
	const dense = {
		source: "payload-bound",
		read: () =>
			Array.from({ length: 8 }, (_, i) => ({ ...row, id: `${"命".repeat(127)}${i}`, label: "界".repeat(160) })),
	};
	assert.equal(withLiveActivity(base, [dense], 1), base);
});

it("replaces the scope only on changes and withdraws obsolete writer generations", () => {
	const events: LiveActivityReplacement[] = [];
	const projection = new PrimaryLiveActivity((owner) =>
		owner === "primary" ? (event) => events.push(event) : undefined,
	);
	const link = {};
	const view = withLiveActivity(base, [unitSource], 1);
	projection.replace(base.storageId, link, "primary", "old", view);
	projection.replace(base.storageId, link, "primary", "old", structuredClone(view));
	projection.withdraw(base.storageId, {});
	assert.deepEqual(
		events.map(({ items }) => items.length),
		[1],
	);
	projection.replace(base.storageId, link, "primary", "new", view);
	projection.replace(base.storageId, link, "primary", "new", base);
	projection.withdraw(base.storageId, link);
	assert.deepEqual(
		events.map(({ items }) => items.length),
		[1, 0, 1, 0],
	);
});

it("uses an existing writer feed to reach only the admitted creating primary", { timeout: 20000 }, async (t) => {
	const fixture = runtimeFixture(t);
	const extension = join(fixture.agentDir, "synthetic-activity.ts");
	writeFileSync(join(fixture.agentDir, "settings.json"), JSON.stringify({ extensions: [extension] }));
	writeFileSync(
		extension,
		`
export default function (pi) {
  let created;
  let reads = 0;
  let active = true;
  pi.events.emit("durable:contribution", {
    name: "fixture.activity", source: new URL(import.meta.url).pathname,
    create(host) {
      created = host;
      return host.durable.defineExtension({ name: "fixture.activity" });
    },
    liveActivity(host) {
      if (host !== created) throw new Error("Host identity changed");
      ++reads;
      return active ? [{ id: "job-one", conversationId: 1, label: "Live command", startedAt: 100 }] : [];
    },
    commands: [{ name: "fixture-activity", description: "Set or read fixture activity", async run({ args }) {
      if (args === "start") active = true;
      if (args === "stop") active = false;
      return String(reads);
    } }],
  });
}
`,
	);
	const catalog = new AgentCatalog(fixture.root);
	const record = catalog.create(
		{
			...fixture.metadata,
			name: "Agent with activity",
			model: { provider: testModel.provider, modelId: testModel.id },
			ownerId: fixture.metadata.storageId,
		},
		"primary",
	);
	const metadata = hostMetadata(record);
	const modelRuntime = await createTestRuntime();
	const host = await runHost(() => createDurableRuntime(metadata, { modelRuntime }), {
		metadata,
		idleMs: 0,
		announceReady: () => {},
	});
	const options = {
		root: fixture.root,
		agentDir: fixture.agentDir,
		packageDir: metadata.packageDir,
		observeLiveActivity: true,
	};
	const unrelated = randomUUID();
	const foreignFrames = eventLog<HostChanges>();
	const foreignTokens: (string | undefined)[] = [];
	const foreign = new AgentManager({
		...options,
		connect: async (target, opts) => {
			const link = await connectHost(target, opts);
			const subscribe = link.subscribeChanges?.bind(link);
			assert.ok(subscribe);
			link.subscribeChanges = (listen, signal, activity) => {
				foreignTokens.push(activity?.sessionId);
				return subscribe(
					(frame) => {
						foreignFrames.push(frame);
						listen(frame);
					},
					signal,
					activity,
				);
			};
			return link;
		},
	});
	let releaseRegistration!: () => void;
	const gate = new Promise<void>((resolve) => {
		releaseRegistration = resolve;
	});
	const manager = new AgentManager({
		...options,
		createPrimary: async (input: PrimaryChannelOptions) => {
			await gate;
			return createPrimaryChannel(input);
		},
	});
	const ownerBus = createEventBus();
	const foreignBus = createEventBus();
	const events = eventLog<LiveActivityReplacement>();
	const foreignEvents = eventLog<unknown>();
	ownerBus.on("harness:live-activity", (event) => {
		events.push(event as LiveActivityReplacement);
	});
	foreignBus.on("harness:live-activity", (event) => {
		foreignEvents.push(event);
	});
	const client = (bus: typeof ownerBus) => ({
		signal: new AbortController().signal,
		cwd: fixture.cwd,
		freshSession: true,
		send: () => {},
		liveActivity: (event: LiveActivityReplacement) => bus.emit("harness:live-activity", event),
	});
	const command = async (link: HostConnection, args: string) => {
		const result = (await link.request("command", { name: "fixture-activity", args, invocationId: randomUUID() })) as {
			text: string;
		};
		return Number(result.text);
	};
	let wrong: HostConnection | undefined;
	try {
		await foreign.registerPrimary(unrelated, client(foreignBus));
		const passive = await foreign.connectNative(metadata.storageId, false);
		await foreignFrames.waitFor((frames) => frames.some(({ view }) => view !== undefined));
		assert.deepEqual(foreignTokens, [undefined]);
		wrong = await connectHost(metadata, { retryAttempts: 0 });
		const wrongFrames = eventLog<HostChanges>();
		assert.ok(wrong.subscribeChanges);
		await wrong.subscribeChanges(
			(frame) => {
				wrongFrames.push(frame);
			},
			undefined,
			{
				sessionId: unrelated,
				active: () => true,
				unavailable: () => {},
			},
		);
		await wrongFrames.waitFor((frames) => frames.some(({ view }) => view !== undefined));
		assert.equal(await command(passive, "read"), 0, "unscoped and mismatched feeds never call the getter");

		const owner = client(ownerBus);
		const registered = manager.registerPrimary(fixture.ownerId, owner);
		void registered.catch(() => {});
		const connected = await manager.connectNative(metadata.storageId, false);
		assert.ok((await command(connected, "read")) > 0);
		assert.equal(events.length, 0, "no publication arrives before the owner registers");
		releaseRegistration();
		await registered;
		await events.waitForCount(1);
		assert.deepEqual(events[0], {
			sessionId: fixture.ownerId,
			source: "fixture.activity",
			storageId: metadata.storageId,
			items: [
				{ id: "job-one", conversationId: 1, label: "Live command", startedAt: 100, agentName: "Agent with activity" },
			],
		});
		assert.equal((catalog.read(metadata.storageId).view as HostChanges["view"])?.liveActivity, undefined);
		const ownerEvidence = connected.ownerEvidence;
		assert.ok(ownerEvidence?.kind === "verified");
		assert.equal((ownerEvidence.view as HostChanges["view"])?.liveActivity, undefined);

		await command(connected, "stop");
		await connected.request("configure", { name: "Agent after activity" });
		await events.waitForCount(2);
		assert.deepEqual(events[1], { ...events[0], items: [] });
		await foreignFrames.waitFor((frames) => frames.some(({ view }) => view?.rows[0]?.name === "Agent after activity"));
		await command(connected, "start");
		await connected.request("configure", { name: "Agent active again" });
		await events.waitForCount(3);
		assert.equal(events[2].items[0]?.agentName, "Agent active again");
		await connected.close();
		await events.waitForCount(4);
		assert.deepEqual(events[3], { ...events[2], items: [] });

		const reconnected = await manager.connectNative(metadata.storageId, false);
		await events.waitForCount(5);
		await manager.closePrimary(fixture.ownerId, owner.signal);
		assert.deepEqual(events[5], { ...events[4], items: [] });
		assert.equal(reconnected.closed, true);
		assert.equal(foreignEvents.length, 0);
		assert.ok(foreignFrames.every(({ view }) => view?.liveActivity === undefined));
		assert.ok(wrongFrames.every(({ view }) => view?.liveActivity === undefined));
	} finally {
		releaseRegistration();
		await Promise.all([manager.close(), foreign.close(), wrong?.close()]);
		await host.close();
	}
});
