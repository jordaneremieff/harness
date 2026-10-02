/**
 * Helpers for the durable-runtime production SIGKILL tests.
 *
 * The fixture builds an isolated agent home whose settings load the on-disk
 * `testdata/durable-runtime` extension, the metadata the production runner
 * consumes, and file markers the fixture extension writes. The tests launch
 * the production `durable-runner.ts` through `acquireHost`; no fixture runner
 * and no real provider are used.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { AgentCatalog, hostMetadata, type CatalogRecord } from "./catalog.ts";
import type { DeliveryReceipt } from "./durable-controls.ts";
import type { HostConnection } from "./host-client.ts";
import type { HostMetadata } from "./host-protocol.ts";

export interface RuntimeFixture {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	/** Directory for the fixture extension's readiness markers and effect file. */
	readonly testDir: string;
	/** Cross-cwd target for the spawn regression. */
	readonly childCwd: string;
	readonly storagePath: string;
	readonly ownerId: string;
	readonly metadata: HostMetadata;
	/** Child environment for one fixture mode. */
	env(mode: "request" | "effect" | "answer" | "spawn"): Record<string, string>;
}

/** Build an isolated agent home for one durable runtime test. */
export function runtimeFixture(t: { after(fn: () => void): void }, options: { withAgentExtension?: boolean } = {}): RuntimeFixture {
	const root = mkdtempSync(join(tmpdir(), "durable-runtime-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "work");
	const agentDir = join(root, "agent");
	const testDir = join(root, "control");
	const childCwd = join(root, "child-work");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	mkdirSync(testDir);
	mkdirSync(childCwd);
	const extensionPath = fileURLToPath(new URL("./testdata/durable-runtime/index.ts", import.meta.url));
	const extensions = [extensionPath];
	if (options.withAgentExtension === true) extensions.push(fileURLToPath(new URL("./index.ts", import.meta.url)));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions, cacheWarming: { mode: "off" }, retry: { enabled: false } }));
	const ownerId = "primary-owner";
	const record = new AgentCatalog(root).create({
		cwd,
		agentDir,
		packageDir: getPackageDir(),
		model: { provider: "durable-runtime-fixture", modelId: "fixture-model" },
		thinkingLevel: "off",
		name: "Durable runtime kill fixture",
		trust: true,
		ownerId,
	}, "primary");
	const metadata = hostMetadata(record);
	return {
		root,
		cwd,
		agentDir,
		testDir,
		childCwd,
		storagePath: metadata.storagePath,
		ownerId,
		metadata,
		env: (mode) => ({ DURABLE_TEST_DIR: testDir, DURABLE_TEST_CHILD_CWD: childCwd, DURABLE_TEST_MODE: mode, PI_AGENT_IDLE_MINUTES: "0.05" }),
	};
}

/** The storage record the cross-cwd spawn created, excluding the owner record. */
export async function childCatalogRecord(f: RuntimeFixture): Promise<CatalogRecord> {
	const page = await new AgentCatalog(dirname(dirname(f.storagePath))).page({ limit: 20 });
	const record = page.records.find((item) => item.storageId !== f.metadata.storageId);
	if (!record) throw new Error("no child storage record was created");
	return record;
}

/** Kill one host process and never fail when it already exited. */
export function killHost(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// The host already exited.
	}
}

/** Kill every tracked host when the test ends, even on failure. */
export function trackHost(t: { after(fn: () => void): void }, pid: number): void {
	t.after(() => killHost(pid));
}

/** Resolve when a marker file exists, driven by the directory watch, never by a fixed sleep. */
export function waitForFile(path: string, timeoutMs = 30000): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		function finish(error?: Error): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			watcher.close();
			if (error) reject(error);
			else resolve();
		}
		const watcher = watch(dirname(path), () => {
			if (existsSync(path)) finish();
		});
		const timer = setTimeout(() => finish(new Error(`timed out waiting for ${path}`)), timeoutMs);
		watcher.on("error", (error) => finish(error));
		if (existsSync(path)) finish();
	});
}

/** Wait for the delivery receipt of one submission; the host waits on commits, not polling. */
export async function waitForReceipt(host: HostConnection, ownerId: string, submissionId: string | number, timeoutMs = 60000): Promise<DeliveryReceipt> {
	const response = await host.request("receipts", { ownerId, wait: true }, { signal: AbortSignal.timeout(timeoutMs) }) as { receipts: DeliveryReceipt[] };
	const receipt = response.receipts.find((item) => String(item.submissionId) === String(submissionId));
	if (!receipt) throw new Error(`no delivery receipt for submission ${submissionId}`);
	return receipt;
}
