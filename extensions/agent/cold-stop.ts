/** A single stop under the same writer lease as the serving process. No endpoint or recovery driver is started. */
import { fork } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HostError, startGatePath, writerLeasePaths, type HostMetadata } from "./host-protocol.ts";
import { tryNativeWriterLeases, waitNativeWriterLease } from "./native-lease.ts";
import type { stopBeforeResume } from "./durable-host.ts";

export type ColdStopResult = Awaited<ReturnType<typeof stopBeforeResume>>;
type Reply = { busy: true } | { result: ColdStopResult };
/** The writer's own answer when its caller did not confirm the passed gate in time; it changed nothing. */
type Unconfirmed = { unconfirmed: true };
/**
 * The writer reports passing the start gate and takes the writer leases only after the caller answers that it will not
 * withdraw, or after the caller has gone. Until then it has changed nothing.
 */
const GATE_PASSED = { phase: "gate-passed" } as const;
const PROCEED = { phase: "proceed" } as const;

function isPhase(value: unknown, phase: string): boolean {
	return value !== null && typeof value === "object" && (value as { phase?: unknown }).phase === phase;
}

/**
 * The writer holds the start gate while it waits for its caller's answer, which blocks every runner of the storage,
 * so a caller that does not answer this soon (stopped or blocked) lets the writer leave without a stop.
 */
export const CALLER_ANSWER_WAIT_MS = 5_000;

/**
 * Report the passed gate and wait for the caller's answer: true to proceed, false when no answer came in time. A
 * caller that has gone cannot withdraw.
 */
function confirmGatePassed(): Promise<boolean> {
	if (!process.connected || !process.send) return Promise.resolve(true);
	return new Promise((resolve) => {
		const done = (proceed: boolean) => {
			clearTimeout(timer);
			process.off("message", answered);
			process.off("disconnect", gone);
			resolve(proceed);
		};
		const answered = (message: unknown) => {
			if (isPhase(message, PROCEED.phase)) done(true);
		};
		const gone = () => done(true);
		const timer = setTimeout(() => done(false), CALLER_ANSWER_WAIT_MS);
		process.on("message", answered);
		process.once("disconnect", gone);
		process.send?.(GATE_PASSED);
	});
}
/**
 * A cold stop waits this long for a host of the same storage to finish starting. Until the writer passes the start
 * gate it has changed nothing, so the wait ends without effect.
 */
export const COLD_STOP_GATE_WAIT_MS = 30_000;

/** Only the winner opens storage. A busy lease requests attachment to its actual writer, never another launch. */
export async function withColdWriter(
	metadata: HostMetadata,
	stop: () => Promise<ColdStopResult>,
): Promise<Reply | Unconfirmed> {
	// The caller that reads these diagnostics can exit first. A closed pipe must not end the stop or hold its lease.
	for (const stream of [process.stdout, process.stderr]) stream.on("error", () => {});
	const leases = writerLeasePaths(metadata);
	for (const path of [...leases, startGatePath(metadata)]) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	// A host that is still starting holds the start gate; its endpoint answers once the gate opens.
	const gate = waitNativeWriterLease(startGatePath(metadata));
	if (!(await confirmGatePassed())) {
		gate.release();
		return { unconfirmed: true };
	}
	const writer = tryNativeWriterLeases(leases);
	gate.release();
	if (writer.kind === "busy") return { busy: true };
	// Bound this one-shot writer, including configured setup and teardown. An incomplete stop has no success reply.
	const lifetime = setTimeout(() => {
		process.stderr.write("Cold stop writer exceeded its two-minute lifetime.\n");
		process.exit(1);
	}, 120_000);
	lifetime.unref();
	// If construction or close fails, process death releases the lease after the partial runtime is gone.
	const result = await stop();
	writer.lease.release();
	clearTimeout(lifetime);
	return { result };
}

function abortError(signal: AbortSignal | undefined): Error {
	const reason: unknown = signal?.reason;
	return reason instanceof Error
		? reason
		: new Error("The abort was withdrawn before its stop started; nothing was stopped.");
}

/** The confirmed reply of a writer that exited cleanly, a refusal that stopped nothing, or undefined when unconfirmed. */
function writerOutcome(answer: Reply | Unconfirmed | undefined, background: boolean): Reply | Error | undefined {
	if (answer === undefined) return undefined;
	if ("unconfirmed" in answer)
		return new HostError(
			"The stop writer did not receive this caller's confirmation in time and left without a stop; nothing was stopped. Repeat the abort.",
			"unavailable",
		);
	if ("busy" in answer) return answer.busy === true ? answer : undefined;
	return answer.result?.background === background ? answer : undefined;
}

/** The isolated writer outlives its caller's wait. Its exit confirms that its lease is no longer held. */
export function stopColdStorage(
	metadata: HostMetadata,
	sessionId: string,
	background: boolean,
	options: { readonly signal?: AbortSignal; readonly gateWaitMs?: number } = {},
): Promise<Reply> {
	options.signal?.throwIfAborted();
	// Node reports a missing cwd as `spawn <executable> ENOENT`, which names the wrong path.
	if (!statSync(metadata.cwd, { throwIfNoEntry: false })?.isDirectory())
		return Promise.reject(
			new HostError(
				`The agent's working directory no longer exists: ${metadata.cwd}. No host runs for this agent and a stop needs one there, so nothing was stopped. Its retained work cannot run until the directory exists again; restore it and repeat the abort to stop that work.`,
				"invalid",
			),
		);
	const runner = fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	const child = fork(runner, [JSON.stringify(metadata), "stop", sessionId, String(background)], {
		cwd: metadata.cwd,
		execArgv: [],
		detached: true,
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	return new Promise((resolve, reject) => {
		let reply: Reply | Unconfirmed | undefined;
		let diagnostic = "";
		let gatePassed = false;
		let withdrawn: Error | undefined;
		// Before the writer passes the start gate it has changed nothing, so the caller's signal or the gate bound ends it.
		const withdraw = (reason: Error) => {
			if (gatePassed || withdrawn) return;
			withdrawn = reason;
			child.kill("SIGKILL");
		};
		const gateTimer = setTimeout(
			() =>
				withdraw(
					new HostError(
						`A host of this storage is still starting after ${Math.round((options.gateWaitMs ?? COLD_STOP_GATE_WAIT_MS) / 1000)} s; nothing was stopped. A start that cannot finish ends itself within 90 s, or within 7 minutes while it waits for a project trust decision; then repeat the abort.`,
						"unavailable",
					),
				),
			options.gateWaitMs ?? COLD_STOP_GATE_WAIT_MS,
		);
		const aborted = () => withdraw(abortError(options.signal));
		options.signal?.addEventListener("abort", aborted, { once: true });
		const passGate = () => {
			gatePassed = true;
			clearTimeout(gateTimer);
			options.signal?.removeEventListener("abort", aborted);
		};
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			diagnostic = (diagnostic + chunk).slice(-2048);
		});
		child.on("message", (message: unknown) => {
			if (isPhase(message, GATE_PASSED.phase)) {
				if (withdrawn) return;
				passGate();
				child.send(PROCEED);
			} else reply = message as Reply | Unconfirmed;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			passGate();
			const outcome = withdrawn ?? writerOutcome(code === 0 ? reply : undefined, background);
			if (outcome instanceof Error) reject(outcome);
			else if (outcome) resolve(outcome);
			else
				reject(
					new Error(
						`Cold stop outcome unconfirmed (exit ${code ?? signal}): ${diagnostic.trim() || "no confirmed stop result"}. The stop can have marked part of the scope. Do not repeat the abort or release: a repeat can stop the target twice. Check the target with agent_status.`,
					),
				);
		});
	});
}
