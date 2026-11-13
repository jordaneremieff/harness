import { fileURLToPath } from "node:url";
import {
	beginOwnership,
	boundedText,
	changeOwnership,
	fullId,
	requestDigest,
	sameServer,
	validateOwnershipState,
} from "./ownership.ts";
import type { OwnershipRecord, OwnershipState, OwnershipStore, ResourceRef, ServerRef } from "./ownership.ts";
import { createRexBudget, deadlineCoverage, RexStopped, type RexBudget, type BudgetPhase } from "./deadline.ts";
import { CliTransport } from "./transport.ts";
import type { CliResult, RexTransport } from "./transport.ts";

export interface TargetIntent {
	server?: string;
	session?: string;
	window?: string;
	block?: string;
	client?: string;
	source?: "explicit" | "inherited" | "focus";
}
export interface ResolvedTarget {
	server: ServerRef;
	source: "explicit" | "inherited" | "focus" | "server";
	sessionId?: string;
	windowId?: string;
	blockId?: string;
	clientId?: string;
}
interface RequestBase {
	target?: TargetIntent;
	timeoutMs?: number;
}
export type RexRequest =
	| (RequestBase & { op: "environment" })
	| (RequestBase & { op: "resolve"; kind: "session" | "window" | "block" | "client"; query?: string })
	| (RequestBase & {
			op: "create";
			kind: "session" | "window" | "split" | "float";
			label: string;
			command?: string[];
			cwd?: string;
			shell?: string;
			direction?: "right" | "left" | "above" | "below";
			ratio?: number;
			bounds?: number[];
			keepOpen?: boolean;
			focus?: boolean;
	  })
	| (RequestBase & {
			op: "inspect";
			view?: "summary" | "capture" | "process" | "status" | "structure";
			maxBytes?: number;
	  })
	| (RequestBase & { op: "input"; text?: string; keys?: string[]; observe?: boolean })
	| (RequestBase & {
			op: "wait";
			condition: "child_exit" | "text" | "status";
			text?: string;
			statusId?: string;
			state?: string;
			maxSnapshots?: number;
	  })
	| (RequestBase & {
			op: "native";
			kind: "catalog" | "describe" | "api" | "lua" | "action";
			method?: string;
			query?: string;
			offset?: number;
			limit?: number;
			args?: Record<string, unknown>;
			code?: string;
			action?: string;
	  })
	| (RequestBase & { op: "owned"; recordId?: string; phase?: OwnershipRecord["phase"]; offset?: number; limit?: number })
	| { op: "observe"; recordId?: string; phase?: OwnershipRecord["phase"]; offset?: number; limit?: number; timeoutMs?: number; maxBytes?: number }
	| (RequestBase & {
			op: "reconcile";
			recordId?: string;
			release?: boolean;
			recover?: boolean;
			note?: string;
			offset?: number;
			limit?: number;
	  })
	| (RequestBase & { op: "cleanup"; recordId: string; forget?: boolean });
/** Requests that select or run work; retained-record operations are handled before target selection. */
type DispatchingRequest = Exclude<RexRequest, { op: "owned" | "observe" | "reconcile" | "cleanup" }>;
export interface RexCallContext {
	ownerId: string;
	callId: string;
	cwd: string;
	signal?: AbortSignal;
	budget?: RexBudget;
}
export interface RexResult {
	ok: boolean;
	outcome: string;
	target?: ResolvedTarget;
	data?: unknown;
	records?: { recordId: string; server: ServerRef; resources: ResourceRef[] }[];
	error?: string;
	effects: { state: "none" | "confirmed" | "unknown"; recordId?: string; resources?: ResourceRef[]; note?: string };
	coverage: {
		bounded: true;
		deadline?: { effectiveMs: number; elapsedMs: number; phase: BudgetPhase; overrunMs?: number };
		truncated?: boolean;
		note?: string;
		totalRecords?: number;
		returnedRecords?: number;
		omittedRecords?: number;
		nextOffset?: number;
		dataOmitted?: boolean;
		pageOffset?: number;
		nextPageOffset?: number;
		emittedRecordRefs?: number;
		omittedRecordRefs?: number;
		omittedRecordIds?: string[];
		truncatedFields?: ("error" | "effects.note" | "coverage.note")[];
	};
}
export interface RexCoreOptions {
	executable?: string;
	store: OwnershipStore;
	transport?: RexTransport;
	env?: Readonly<Record<string, string | undefined>>;
	server?: string;
	maxOutputBytes?: number;
	maxWaitMs?: number;
	maxRecords?: number;
	isCallActive?: (ownerId: string, callId: string) => boolean;
}

/** Aggregate envelope budget shared by domain results and host model-output limits. */
export function resultByteLimit(maxOutputBytes: number): number {
	return maxOutputBytes + 98304;
}

/** Default retained bytes from one Rex CLI process when the configured value is absent. */
export const DEFAULT_MAX_OUTPUT_BYTES = 65536;
/** Shortest interval between two output snapshots of one text wait. */
const TEXT_REFRESH_MIN_MS = 250;

/**
 * A bounded slice of a terminal's screen and scrollback: bytes `start` to `end` of `total`.
 * Content that reaches `total` ends with the most recent output, which is what readiness
 * and completion checks need.
 */
export interface Capture {
	content: string;
	total: number;
	start: number;
	end: number;
}
export function deadlineResult(value: RexResult, budget: RexBudget | undefined, operation: string): RexResult {
	if (!budget) return value;
	const stop = budget.stopReason();
	const established = value.effects.state === "confirmed" || ["child_completed", "child_failed", "condition_observed", "observation_failed"].includes(value.outcome);
	const stopped = stop && !established ? { ...value, ok: false, outcome: stop, data: { ...object(value.data), operation, phase: budget.phase } } : value;
	return { ...stopped, coverage: { ...stopped.coverage, deadline: deadlineCoverage(budget) } };
}
export class RexCore {
	private readonly transport: RexTransport;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly maxOutputBytes: number;
	private readonly maxWaitMs: number;
	private readonly maxRecords: number;
	private readonly options: RexCoreOptions;
	constructor(options: RexCoreOptions) {
		this.options = options;
		this.env = options.env ?? process.env;
		this.transport = options.transport ?? new CliTransport(options.executable, this.env);
		this.maxOutputBytes = boundedInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, 4096, 1048576, "output bytes");
		this.maxWaitMs = boundedInteger(options.maxWaitMs ?? 120000, 1000, 300000, "wait duration");
		this.maxRecords = boundedInteger(options.maxRecords ?? 128, 2, 256, "ownership records");
	}

	dispose(): void {
		this.transport.dispose();
	}

	async execute(request: RexRequest, context: RexCallContext): Promise<RexResult> {
		let owned: RexBudget | undefined;
		const finish = (value: RexResult) => boundResult(deadlineResult(value, context.budget, request.op), resultByteLimit(this.maxOutputBytes));
		try {
			if (!boundedText(context.ownerId, 1024) || !boundedText(context.callId, 1024))
				throw new Error("Rex requires stable owner and call identities.");
			if (Buffer.byteLength(JSON.stringify(request), "utf8") > 131072)
				throw new Error("Rex request exceeds its byte limit.");
			if (!context.budget) owned = createRexBudget(request.timeoutMs, this.maxWaitMs, context.signal);
			context = { ...context, budget: context.budget ?? owned, signal: (context.budget ?? owned)?.signal };
			context.budget?.check("resolve");
			const response = finish(await this.dispatch(request, context));
			return request.timeoutMs !== undefined && request.timeoutMs > this.maxWaitMs ? this.cappedDeadline(response, request.timeoutMs) : response;
		} catch (error) {
			return finish(executionFailure(error, context.budget));
		} finally { owned?.dispose(); }
	}

	private async dispatch(request: RexRequest, context: RexCallContext): Promise<RexResult> {
		if (request.op === "owned") return this.owned(request, context);
		if (request.op === "observe") return this.observeOwned(request, context);
		if (request.op === "reconcile" || request.op === "cleanup") return this.manage(request, context);
		if (request.op === "native" && request.kind !== "catalog" && [request.query, request.offset, request.limit].some((value) => value !== undefined)) throw new Error("query, offset and limit apply only to native catalog discovery.");
		const server = await this.selectServer(request.target, context);
		if (request.op === "environment") return this.environment(server, context);
		if (request.op === "resolve") {
			const target = await this.resolve(request.target, server, context, request.kind, request.query);
			return result(true, "resolved", target, target);
		}
		if (request.op === "native" && ["catalog", "describe"].includes(request.kind))
			return this.native(request, { server, source: "server" }, context);
		const target = await this.requestedTarget(request, server, context);
		this.validateNativeContext(request, target);
		return this.dispatchTarget(request, target, context);
	}

	private async requestedTarget(request: DispatchingRequest, server: ServerRef, context: RexCallContext): Promise<ResolvedTarget> {
		const need = targetNeed(request);
		if (request.op === "native") {
			if (request.kind === "catalog" || request.kind === "describe") return { server, source: "server" };
			const focus = request.target?.source === "focus";
			if (focus || request.target?.source === "inherited" || hasResources(request.target))
				return this.resolve(request.target, server, context, focus ? "block" : need);
			return { server, source: "server" };
		}
		if (need || hasResources(request.target)) return this.resolve(request.target, server, context, need);
		return { server, source: "server" };
	}

	/** Lua and actions need a real session when they take inherited context; they never fall back to focus. */
	private validateNativeContext(request: RexRequest, target: ResolvedTarget): void {
		if (request.op !== "native" || (request.kind !== "lua" && request.kind !== "action")) return;
		if (target.source === "inherited" && !target.sessionId) validateDefaultTarget(target.source, "session");
	}

	private dispatchTarget(request: RexRequest, target: ResolvedTarget, context: RexCallContext): Promise<RexResult> {
		switch (request.op) {
			case "create":
				return this.create(request, target, context);
			case "inspect":
				return this.inspect(request, target, context);
			case "input":
				return this.input(request, target, context);
			case "wait":
				return this.wait(request, target, context);
			case "native":
				return this.native(request, target, context);
			default:
				throw new Error("Unknown Rex operation.");
		}
	}

	private prefix(server?: string): string[] {
		return ["--autostart=false", "--color=never", "--timeout=10s", ...(server ? ["--server", server] : [])];
	}
	private async cli(
		args: string[],
		server: string | undefined,
		context: RexCallContext,
		timeoutMs = 15000,
	): Promise<CliResult> {
		context.budget?.check(context.budget.phase);
		context.signal?.throwIfAborted();
		const allowance = Math.floor(Math.min(timeoutMs, context.budget?.remaining("work") ?? this.maxWaitMs));
		if (allowance < 1) throw new RexStopped(context.budget?.stopReason() ?? "timeout", "resolve");
		const response = await this.transport.run([...this.prefix(server), ...args], {
			cwd: context.cwd,
			signal: context.signal,
			finaliseSignal: context.budget?.finaliseSignal,
			timeoutMs: allowance,
			maxOutputBytes: this.maxOutputBytes,
		});
		context.budget?.check(context.budget.phase);
		return response;
	}
	private async json(
		args: string[],
		server: string | undefined,
		context: RexCallContext,
		timeoutMs = 15000,
	): Promise<unknown> {
		const response = await this.cli(args, server, context, timeoutMs);
		if (response.outcome !== "exited" || response.exitCode !== 0) throw new NativeFailure(cliResult(response));
		try {
			return JSON.parse(response.stdout);
		} catch {
			throw new NativeFailure(
				result(
					false,
					"invalid_response",
					undefined,
					{ stdout: response.stdout, stderr: response.stderr },
					"Rex did not return complete JSON.",
				),
			);
		}
	}
	private async api(
		method: string,
		args: Record<string, unknown>,
		server: ServerRef,
		context: RexCallContext,
	): Promise<unknown> {
		return this.json(["api", "call", method, JSON.stringify(args)], server.endpoint, context);
	}
	private async block(
		method: string,
		args: Record<string, unknown>,
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<unknown> {
		requireBlock(target);
		return this.api(
			`com.superlogical.terminal.${method}`,
			{ session_id: target.sessionId, block_id: target.blockId, args },
			target.server,
			context,
		);
	}
	/** Read a bounded suffix of one format snapshot without treating replacement text as raw-byte progress. */
	private async capture(target: ResolvedTarget, context: RexCallContext, maxBytes: number): Promise<Capture> {
		// Rex's content budget excludes the enclosing JSON string quotes.
		const pageBytes = maxBytes - 2;
		const first = object(
			await this.block("format", { format: "text", trim: true, unwrap: true, max_bytes: pageBytes }, target, context),
		);
		const content = typeof first.content === "string" ? first.content : "";
		const total = typeof first.total === "number" ? first.total : Buffer.byteLength(content);
		if (!Number.isSafeInteger(total) || total < 0) throw new Error("Rex returned an invalid capture byte total.");
		verifyCaptureEnd(first);
		if (typeof first.id !== "number" || first.eof === true) return { content, total, start: 0, end: total };
		let low = Math.max(0, total - pageBytes);
		let high = total;
		let offset = low;
		let suffix: string | undefined;
		// EOF anchors the raw end even when an arbitrary starting byte becomes replacement text.
		// Search only the final pageBytes raw bytes: at most 1 + ceil(log2(pageBytes)) reads.
		while (low < high) {
			const part = object(
				await this.block("blob_read", { id: first.id, offset, max_bytes: pageBytes }, target, context),
			);
			context.budget?.check("observe");
			if (part.id !== first.id || part.total !== total || typeof part.data !== "string" || typeof part.eof !== "boolean")
				throw new Error("Rex returned an inconsistent capture continuation.");
			if (part.eof) {
				suffix = completeUtf8Suffix(part.data, total - offset);
				high = offset;
			} else low = offset + 1;
			offset = Math.floor((low + high) / 2);
		}
		if (suffix === undefined) throw new Error("Rex continuation did not reach the snapshot end.");
		const tail = tailText(suffix, maxBytes, high > 0);
		return { content: tail, total, start: total - Buffer.byteLength(tail), end: total };
	}
	/** Best-effort recent output beside a completion result; a capture failure never hides the exit. */
	private async captureOutput(
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<{ capture: Capture } | { captureError: string }> {
		try {
			return { capture: await this.capture(target, context, this.defaultCaptureBytes()) };
		} catch (error) {
			return { captureError: errorText(error) };
		}
	}
	private defaultCaptureBytes(): number {
		return Math.min(16384, Math.floor(this.maxOutputBytes / 4));
	}
	private async selectServer(intent: TargetIntent | undefined, context: RexCallContext): Promise<ServerRef> {
		context.signal?.throwIfAborted();
		const selection = intent?.server ?? this.options.server ?? this.env.REX_SERVER;
		if (selection !== undefined && !boundedText(selection, 4096)) throw new Error("Rex server selector is invalid.");
		const data = object(await this.json(["whoami", "--json"], selection, context));
		if (!boundedText(data.endpoint, 4096) || !boundedText(data.host_id, 128) || !boundedText(data.instance_id, 128))
			throw new Error("Rex did not report an exact endpoint, host ID and server instance ID.");
		return {
			endpoint: data.endpoint,
			hostId: data.host_id,
			instanceId: data.instance_id,
			selection: selection ?? "home",
		};
	}

	private async resolve(
		intent: TargetIntent | undefined,
		server: ServerRef,
		context: RexCallContext,
		required?: TargetKind,
		query?: string,
	): Promise<ResolvedTarget> {
		const source = targetSource(intent, query);
		if (source === "inherited") await this.checkLaunchServer(intent, server, context);
		const selected = selectors(intent, source === "inherited" ? this.env : {});
		const base: ResolvedTarget = { server, source };
		for (const [kind, value] of selected) {
			if (value) await this.lookup(kind, value, base, context);
		}
		if (query !== undefined && required) await this.lookup(required, query, base, context);
		else if (required && !base[targetKey(required)]) {
			validateDefaultTarget(source, required);
			await this.lookup(required, "", base, context);
		}
		return base;
	}

	private async checkLaunchServer(
		intent: TargetIntent | undefined,
		server: ServerRef,
		context: RexCallContext,
	): Promise<void> {
		if (intent?.server === undefined && this.options.server === undefined) return;
		if (!this.env.REX_SERVER)
			throw new Error("The launch server is unknown. Select resources explicitly for the configured server.");
		if (server.selection === this.env.REX_SERVER) return;
		const launch = object(await this.json(["whoami", "--json"], this.env.REX_SERVER, context));
		if (
			launch.endpoint !== server.endpoint ||
			launch.host_id !== server.hostId ||
			launch.instance_id !== server.instanceId
		) {
			throw new Error(
				"The selected server differs from the launch server. Select resources explicitly; inherited IDs were not used.",
			);
		}
	}

	private async lookup(kind: TargetKind, value: string, base: ResolvedTarget, context: RexCallContext): Promise<void> {
		const args: Record<string, unknown> = { kinds: [kind], queries: [value] };
		if (kind !== "session" && base.sessionId) {
			args.scope = { session: base.sessionId, ...(kind === "block" && base.windowId ? { window: base.windowId } : {}) };
		}
		const raw = object(await this.api("target.resolve", args, base.server, context));
		const entry = object(Array.isArray(raw.results) ? raw.results[0] : undefined);
		if (entry.status !== "resolved" || !entry.target) {
			throw new NativeFailure(
				result(
					false,
					entry.status === "ambiguous" ? "ambiguous_target" : "target_not_found",
					base,
					entry,
					"Rex target did not resolve uniquely. Select exact IDs; no fallback target was used.",
				),
			);
		}
		mergeResolvedTarget(base, kind, object(entry.target));
	}

	private async environment(server: ServerRef, context: RexCallContext): Promise<RexResult> {
		const [sessions, clients, version, hosts] = await Promise.all([
			this.api("session.list", {}, server, context),
			this.api("client.list", {}, server, context),
			this.api("server.version", {}, server, context),
			this.json(["hosts", "--json"], server.endpoint, context),
		]);
		return result(
			true,
			"environment",
			{ server, source: "server" },
			{
				selectedServer: server,
				version,
				sessions,
				clients,
				hosts,
				inherited: {
					server: this.env.REX_SERVER,
					session: this.env.REX_SESSION,
					block: this.env.REX_BLOCK,
					client: this.env.REX_CLIENT,
				},
				inheritedContext: "Launch environment only. It is not operator focus or ownership proof.",
				luaLocality:
					"Lua and rex.exec run in the CLI process host. Rex API calls target the selected server; explicit rex.server calls select other configured hosts.",
			},
		);
	}

	private async startEffect(request: RexRequest, target: ResolvedTarget, context: RexCallContext): Promise<void> {
		const record = pendingRecord(request, target, context);
		context.budget?.check("effect");
		await this.options.store.update(context.ownerId, (state) => {
			context.budget?.check("effect");
			return beginOwnership(state, record, this.maxRecords - 1);
		}, "work");
	}
	private async settleEffect(
		context: RexCallContext,
		phase: "confirmed" | "unknown",
		resources: ResourceRef[],
		note: string,
	): Promise<void> {
		await this.options.store.update(context.ownerId, (state) => {
			const record = state.records.find(
				(entry) => entry.callId === context.callId && entry.ownerId === context.ownerId,
			);
			if (!record || record.phase === "released" || record.phase === "closed")
				throw new Error("Rex effect claim was released or closed before outcome retention.");
			context.budget?.check("finalise");
			return changeOwnership(state, context.callId, { phase, resources, note }, this.maxRecords);
		}, "finalise");
	}
	private async effect(
		request: RexRequest,
		target: ResolvedTarget,
		context: RexCallContext,
		action: () => Promise<unknown>,
		resources: (data: unknown) => ResourceRef[] = () => [],
	): Promise<RexResult> {
		await this.startEffect(request, target, context);
		let data: unknown;
		let refs: ResourceRef[] = [];
		let dispatched = false;
		let settlementAttempted = false;
		try {
			if (context.signal?.aborted)
				throw new NativeFailure(
					result(
						false,
						"cancelled",
						target,
						undefined,
						"The call stopped after intent retention; no CLI effect was requested.",
					),
				);
			context.budget?.check("effect");
			dispatched = true;
			data = await action();
			refs = resources(data);
			settlementAttempted = true;
			await this.settleEffect(
				context,
				"confirmed",
				refs,
				"The CLI acknowledged the operation. This is not proof of application success.",
			);
			return {
				...result(true, "acknowledged", target, data),
				effects: { state: "confirmed", recordId: context.callId, resources: refs },
			};
		} catch (error) {
			return this.failedEffect(error, target, context, { data, refs, dispatched, settlementAttempted });
		}
	}

	private async failedEffect(error: unknown, target: ResolvedTarget, context: RexCallContext, progress: { data: unknown; refs: ResourceRef[]; dispatched: boolean; settlementAttempted: boolean }): Promise<RexResult> {
		const { data, refs, dispatched, settlementAttempted } = progress;
		if (!dispatched) return {
			...result(false, context.budget?.stopReason() ?? "cancelled", target, undefined, errorText(error)),
			effects: { state: "none", recordId: context.callId, note: "Intent remains retained; no CLI effect was requested." },
		};
		let persistenceError = settlementAttempted ? errorText(error) : undefined;
		try {
			if (!settlementAttempted) await this.settleEffect(context, "unknown", refs, "Reconcile current state before any retry. Earlier effects may remain.");
		} catch (failure) { persistenceError = errorText(failure); }
		const failed = error instanceof NativeFailure ? error.result : result(false, "effect_error", target, data, errorText(error));
		return {
			...failed, target,
			effects: {
				state: "unknown", recordId: context.callId, resources: refs,
				note: persistenceError ? `Pending intent remains; outcome persistence failed: ${persistenceError}` : "The operation was not replayed. Inspect current state before more effects.",
			},
		};
	}

	private async create(
		request: Extract<RexRequest, { op: "create" }>,
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<RexResult> {
		const { method, args } = creationCall(request, target);
		const response = await this.effect(
			request,
			target,
			context,
			() => this.api(method, args, target.server, context),
			(raw) => createdResources(request.kind, target, raw),
		);
		if (response.ok) {
			const ref = response.effects.resources?.[0];
			response.target = {
				...target,
				source: "explicit",
				sessionId: ref?.sessionId,
				windowId: ref?.windowId,
				blockId: ref?.blockId,
			};
			response.outcome = "created";
			response.effects.note =
				"The terminal persists independently of this call. Creation does not establish readiness. Only returned blocks are owned; cleanup preserves other session resources.";
		}
		return response;
	}

	private async inspect(
		request: Extract<RexRequest, { op: "inspect" }>,
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<RexResult> {
		const view = request.view ?? "summary";
		if (view === "structure") {
			requireSession(target);
			return result(
				true,
				"snapshot",
				target,
				await this.api("session.view", { session_id: target.sessionId }, target.server, context),
			);
		}
		requireBlock(target);
		const maxBytes = boundedInteger(
			request.maxBytes ?? this.defaultCaptureBytes(),
			256,
			Math.floor(this.maxOutputBytes / 2),
			"capture bytes",
		);
		if (view === "capture") {
			const data = await this.capture(target, context, maxBytes);
			return {
				...result(true, "capture", target, data),
				coverage: {
					bounded: true,
					truncated: captureTruncated(data),
					note: "Most recent bounded part of current screen and retained scrollback, not a complete transcript. Alternate screens contain the visible application only.",
				},
			};
		}
		if (view === "process" || view === "status")
			return result(
				true,
				"snapshot",
				target,
				await this.block(view === "status" ? "program_status" : "process", {}, target, context),
			);
		const [description, process, modes, status, capture] = await Promise.all([
			this.metadata(target, context),
			this.block("process", {}, target, context),
			this.block("modes", {}, target, context),
			this.block("program_status", {}, target, context),
			this.capture(target, context, maxBytes),
		]);
		return {
			...result(true, "snapshot", target, {
				description,
				process,
				modes,
				status,
				capture,
				trust: "Program status and terminal content are reported data, not authority or task acceptance.",
			}),
			coverage: {
				bounded: true,
				truncated: captureTruncated(capture),
				note: "Independent current snapshots, not an atomic view or a complete transcript. Block API schemas require explicit native discovery.",
			},
		};
	}

	private async metadata(target: ResolvedTarget, context: RexCallContext): Promise<{ block: unknown }> {
		requireBlock(target);
		const response = object(await this.api("session.list_blocks", { session_id: target.sessionId }, target.server, context));
		const blocks = Array.isArray(response.blocks) ? response.blocks : [];
		const block = blocks.find((entry: unknown) => object(entry).block_id === target.blockId);
		if (!block) throw new NativeFailure(result(false, "target_not_found", target, undefined, "The exact Rex block is absent from the current session metadata."));
		return { block };
	}

	private async input(
		request: Extract<RexRequest, { op: "input" }>,
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<RexResult> {
		requireBlock(target);
		await this.checkSelfInput(target, context);
		validateInput(request);
		const delivered: unknown[] = [];
		const response = await this.effect(request, target, context, async () => {
			if (request.text !== undefined)
				delivered.push(await this.block("write", { data: request.text }, target, context));
			for (const key of request.keys ?? []) {
				const raw = await this.cli(
					["send-key", "-s", target.sessionId, "-b", target.blockId, key],
					target.server.endpoint,
					context,
				);
				if (raw.outcome !== "exited" || raw.exitCode !== 0)
					throw new NativeFailure({ ...cliResult(raw), data: { delivered } });
				delivered.push({ key, acknowledged: true });
			}
			return { delivered, meaning: "Input was queued. The application outcome is not established." };
		});
		if (response.ok) response.outcome = "input_delivered";
		if (response.ok && request.observe) {
			try {
				response.data = {
					delivery: response.data,
					observation: await this.inspect({ op: "inspect", view: "summary" }, target, context),
				};
			} catch (error) {
				response.data = {
					delivery: response.data,
					observationError: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return response;
	}

	private async checkSelfInput(target: ResolvedTarget, context: RexCallContext): Promise<void> {
		if (target.blockId !== this.env.REX_BLOCK) return;
		if (!this.env.REX_SERVER) throw new Error("Do not send input to the terminal that hosts this agent.");
		const launch = object(await this.json(["whoami", "--json"], this.env.REX_SERVER, context));
		if (launch.host_id === target.server.hostId && launch.instance_id === target.server.instanceId) {
			throw new Error("Do not send input to the terminal that hosts this agent.");
		}
	}

	/**
	 * The effective deadline for one request. A request above the configured cap waits for the
	 * cap instead of failing, and the result names the shorter deadline it actually used.
	 */
	private deadline(requested: number | undefined, name: string): number {
		const value = boundedInteger(requested ?? Math.min(30000, this.maxWaitMs), 1, 300000, name);
		return Math.min(value, this.maxWaitMs);
	}
	private cappedDeadline(response: RexResult, requested: number | undefined): RexResult {
		const note = `The requested ${requested} ms deadline exceeded the configured ${this.maxWaitMs} ms cap (rex.maxWaitMs); the operation used ${this.maxWaitMs} ms.`;
		return { ...response, coverage: { ...response.coverage, note: response.coverage.note ? `${note} ${response.coverage.note}` : note } };
	}

	private async wait(
		request: Extract<RexRequest, { op: "wait" }>,
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<RexResult> {
		requireBlock(target);
		const timeoutMs = this.deadline(request.timeoutMs, "wait duration");
		return this.observe(request, target, context, timeoutMs);
	}
	private async observe(
		request: Extract<RexRequest, { op: "wait" }>,
		target: ResolvedTarget & { sessionId: string; blockId: string },
		context: RexCallContext,
		timeoutMs: number,
	): Promise<RexResult> {
		context.budget?.check("observe");
		if (request.condition === "child_exit") {
			const before = object(await this.block("process", {}, target, context));
			if (before.last_exit)
				return childResult(target, before, "current process snapshot", await this.captureOutput(target, context));
			const allowance = Math.floor(context.budget?.remaining("work") ?? timeoutMs);
			const execution = allowance - Math.min(1000, Math.max(1, Math.floor(allowance / 10)));
			const waitMs = execution - Math.min(1000, Math.max(1, Math.floor(execution / 10)));
			if (waitMs < 1) throw new RexStopped(context.budget?.stopReason() ?? "timeout", "observe");
			const deadline = Date.now() + waitMs;
			const observer = await this.cli(
				["wait", "-s", target.sessionId, target.blockId, "--for", `${waitMs}ms`, "--json"],
				target.server.endpoint,
				context,
				allowance,
			);
			let after: unknown;
			try {
				after = await this.block("process", {}, target, context);
			} catch {
				/* Return the observer result when the resource disappeared. */
			}
			if (object(after).last_exit)
				return childResult(
					target,
					object(after),
					"current process snapshot after native event-informed wait",
					await this.captureOutput(target, context),
				);
			const response = cliResult(observer);
			return {
				...response,
				ok: false,
				target,
				outcome: childObservationOutcome(observer, deadline),
				data: { observer: response.data, process: after, operation: "wait", phase: "observe" },
				coverage: {
					bounded: true,
					note: "The wait observes the terminal's direct child, not commands typed into its shell. Observer termination does not stop terminal work.",
				},
			};
		}
		return this.waitCondition(request, target, context, timeoutMs);
	}

	private async waitCondition(
		request: Extract<RexRequest, { op: "wait" }>,
		target: ResolvedTarget,
		context: RexCallContext,
		timeoutMs: number,
	): Promise<RexResult> {
		validateCondition(request);
		const maxSnapshots = boundedInteger(request.maxSnapshots ?? 24, 2, 64, "snapshot count");
		const observer = new EventObserver(
			this.transport,
			[...this.prefix(target.server.endpoint), "events", "-s", target.sessionId ?? "", "--json"],
			context,
			Math.ceil(context.budget?.remaining("finalise") ?? timeoutMs),
			Math.min(this.maxOutputBytes, 32768),
			target.blockId,
		);
		let observation: ConditionObservation | undefined;
		let observationError: unknown;
		let observerResult: CliResult;
		try {
			observation = await this.observeSnapshots(request, target, context, observer, timeoutMs, maxSnapshots);
		} catch (error) { observationError = error; }
		finally { observerResult = await observer.stop(); }
		if (!observation) {
			if (!observer.failure) throw observationError;
			observation = { snapshot: undefined, snapshots: 0, matched: false, deadline: context.budget?.workEndsAt ?? 0, observerEnded: true };
		}
		if (observer.failure) observation.matched = false;
		return conditionResult(request, target, context, observation, observer, observerResult);
	}

	private async observeSnapshots(
		request: WaitRequest,
		target: ResolvedTarget,
		context: RexCallContext,
		observer: EventObserver,
		timeoutMs: number,
		maxSnapshots: number,
	): Promise<ConditionObservation> {
		const deadline = context.budget?.workEndsAt ?? performance.now() + timeoutMs;
		// The budget owns its clock; only a call without a budget reads the process clock.
		const remainingMs = () => context.budget ? context.budget.remaining("work") : deadline - performance.now();
		const observation: ConditionObservation = {
			snapshot: undefined,
			snapshots: 0,
			matched: false,
			deadline,
			observerEnded: false,
		};
		while (observation.snapshots < maxSnapshots && !context.signal?.aborted) {
			context.budget?.check("observe");
			const seen = observer.generation;
			observation.snapshot =
				request.condition === "text"
					? await this.capture(target, context, this.defaultCaptureBytes())
					: await this.block("program_status", {}, target, context);
			context.budget?.check("observe");
			observation.snapshots++;
			observation.matched = !observer.failure && conditionMatches(request, observation.snapshot);
			if (observation.matched || remainingMs() <= 0 || observer.ended) break;
			const remaining = maxSnapshots - observation.snapshots;
			// Early refreshes double from the minimum so quick readiness shows quickly; the even
			// spread of the remaining snapshots caps them, so the last one reaches the deadline.
			const refreshMs = request.condition === "text" && remaining > 0
				? Math.max(TEXT_REFRESH_MIN_MS, Math.ceil(Math.min(remainingMs() / remaining, TEXT_REFRESH_MIN_MS * 2 ** Math.min(observation.snapshots - 1, 16))))
				: undefined;
			await observer.wait(seen, context.signal, refreshMs);
		}
		observation.observerEnded = observer.ended;
		return observation;
	}

	private async native(
		request: Extract<RexRequest, { op: "native" }>,
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<RexResult> {
		validateNativeTarget(request, target);
		if (request.kind === "catalog") return this.catalog(request, target, context);
		if (request.kind === "describe") {
			if (!boundedText(request.method, 256) || request.method.startsWith("-"))
				throw new Error("Select an exact Rex method to describe.");
			return result(
				true,
				"schema",
				target,
				await this.json(["api", "describe", request.method, "--json"], target.server.endpoint, context),
			);
		}
		const timeoutMs = this.deadline(request.timeoutMs, "native duration");
		const cli = nativeCommand(request, target);
		const verifiedRead = request.kind === "api" && VERIFIED_READ_METHODS.has(request.method ?? "");
		const response = verifiedRead
			? await this.verifiedRead(request, target, context, cli, timeoutMs)
			: await this.effect(request, target, context, async () => {
					const raw = await this.cli(cli, target.server.endpoint, context, timeoutMs);
					if (raw.outcome !== "exited" || raw.exitCode !== 0) throw new NativeFailure(cliResult(raw));
					return nativeResponse(raw, request.kind);
				});
		if (response.ok)
			response.effects.note = verifiedRead
				? "Verified read-only API method: no ownership record was retained. Outer CLI success only; returned data is not an application outcome."
				: "Outer CLI success only. No inner application outcome was established. Returned failure tables and child results remain application data, even if bulk data is omitted.";
		return response;
	}

	/** A verified read keeps its real CLI outcome and leaves the ownership store untouched. */
	private async verifiedRead(
		request: Extract<RexRequest, { op: "native" }>,
		target: ResolvedTarget,
		context: RexCallContext,
		cli: string[],
		timeoutMs: number,
	): Promise<RexResult> {
		const raw = await this.cli(cli, target.server.endpoint, context, timeoutMs);
		if (raw.outcome === "exited" && raw.exitCode === 0)
			return result(true, "acknowledged", target, nativeResponse(raw, request.kind));
		return {
			...cliResult(raw),
			target,
			effects: {
				state: "none",
				note: "Verified read-only API method: no ownership record was created. The reported outcome is the CLI result, not an unknown mutation.",
			},
		};
	}

	private async catalog(
		request: Extract<RexRequest, { op: "native" }>,
		target: ResolvedTarget,
		context: RexCallContext,
	): Promise<RexResult> {
		if (request.query !== undefined && !boundedText(request.query, 256)) throw new Error("Use a nonempty literal method query within 256 characters.");
		const offset = boundedInteger(request.offset ?? 0, 0, 1048576, "catalogue offset");
		const limit = boundedInteger(request.limit ?? 50, 1, 100, "catalogue page size");
		const raw = await this.cli(["api", "list", "--quiet"], target.server.endpoint, context);
		if (raw.outcome !== "exited" || raw.exitCode !== 0) throw new NativeFailure(cliResult(raw));
		if (raw.truncated) throw new NativeFailure({ ...cliResult(raw), ok: false, outcome: "output_limit", error: "The installed method catalogue exceeded the CLI output limit. No complete catalogue was available to filter." });
		const installed = raw.stdout.split(/\r?\n/).filter(Boolean);
		const query = request.query;
		const matched = query === undefined ? installed : installed.filter((method) => method.includes(query));
		const methods = matched.slice(offset, offset + limit);
		const response = result(true, "catalog", target, {
			methods, totalMethods: installed.length, matchedMethods: matched.length, returnedMethods: methods.length,
			omittedMethods: matched.length - methods.length, offset,
			...(offset + methods.length < matched.length ? { nextOffset: offset + methods.length } : {}),
			note: "Follow nextOffset with the same query. Counts describe this current catalogue, not a frozen snapshot. Use describe for current schemas, examples and validation notes. Native API and Lua remain open to newly installed methods.",
		});
		response.coverage.truncated = methods.length < matched.length;
		return response;
	}

	private async owned(request: Extract<RexRequest, { op: "owned" }>, context: RexCallContext): Promise<RexResult> {
		const state = validateOwnershipState(await this.options.store.read(context.ownerId), this.maxRecords);
		const own = state.records.filter((record) => record.ownerId === context.ownerId);
		const selected = selectRecords(own, request);
		const page = recordPage(selected, request);
		return {
			...result(true, "owned", undefined, {
				records: page.records,
				inheritedRecords: state.records.length - own.length,
				note: "Stored phases are retained claims, not current presence or cleanup permission. Foreign-owner records do not authorise cleanup. Pending records after interruption have unknown effects.",
			}),
			records: recordRefs(page.records),
			coverage: pageCoverage(page, page.records.length),
		};
	}

	private async observeOwned(request: Extract<RexRequest, { op: "observe" }>, context: RexCallContext): Promise<RexResult> {
		this.deadline(request.timeoutMs, "observation duration");
		const maxBytes = boundedInteger(request.maxBytes ?? this.defaultCaptureBytes(), 256, 16384, "observation tail bytes");
		context.budget?.check("observe");
		const signal = context.signal ?? new AbortController().signal;
		const scoped = context;
		const budget = { remaining: this.maxOutputBytes };
		const state = validateOwnershipState(await this.options.store.read(context.ownerId), this.maxRecords);
		const selected = selectRecords(state.records.filter((record) => record.ownerId === context.ownerId), request);
		const page = recordPage(selected, request);
		const reports: WorkReport[] = [];
		for (const record of page.records) reports.push(await this.observeWorkRecord(record, scoped, maxBytes, budget));
		const complete = !signal.aborted && reports.every((report) => report.complete);
		const response: RexResult = {
			...result(complete, complete ? "observed" : context.budget?.stopReason() ?? (signal.aborted ? "cancelled" : "observation_incomplete"), undefined, { reports, operation: "observe", phase: "observe" }),
			records: recordRefs(page.records),
			coverage: {
				...pageCoverage(page, reports.length),
				truncated: !complete || page.records.length < page.total || reports.some((report) => report.observations.some((entry) => entry.capture && captureTruncated(entry.capture))),
				note: "Read-only independent snapshots, not an atomic view. Stored phase is unchanged. Child state describes only the direct child; status and output do not establish task success. Cancellation stops observation only. Field bytes share the configured output budget; unavailable fields remain explicit. Use exact recordId or a smaller page for partial reports.",
			},
		};
		return response;
	}

	private async observeWorkRecord(record: OwnershipRecord, context: RexCallContext, maxBytes: number, budget: ObservationBudget): Promise<WorkReport> {
		const report: WorkReport = { recordId: record.callId, phase: record.phase, observedAt: new Date().toISOString(), complete: false, observations: [] };
		if (record.resources.length === 0) {
			report.error = "No acknowledged resource IDs. The retained claim remains unresolved; no absence or completion is established.";
			return report;
		}
		let server: ServerRef;
		try { server = await this.recordServer(record, context); }
		catch (error) {
			report.error = observationError(error, context);
			report.observations = record.resources.map((resource) => unavailableWork(resource, observationError(error, context)));
			return report;
		}
		for (const resource of record.resources) report.observations.push(await this.observeWorkResource(resource, server, context, maxBytes, budget));
		report.complete = report.observations.every((entry) => entry.presence === "absent" || entry.presence === "present" && !entry.processError && !entry.statusError && !entry.captureError && entry.childState !== "unknown");
		return report;
	}

	private async observeWorkResource(resource: ResourceRef, server: ServerRef, context: RexCallContext, maxBytes: number, budget: ObservationBudget): Promise<WorkObservation> {
		const presence = await this.observeResource(resource, server, context);
		if (presence.error) presence.error = boundedDiagnosticText(presence.error, 512);
		if (presence.presence !== "present") return { ...unavailableWork(resource, presence.error ?? "The exact resource is absent."), ...presence };
		const target: ResolvedTarget = { server, source: "explicit", ...presence.resource };
		const observation: WorkObservation = { ...presence, observedAt: new Date().toISOString(), childState: "unavailable" };
		try {
			observation.process = await this.observationField(() => this.block("process", {}, target, context), budget, context);
			const process = object(observation.process);
			observation.childState = Number.isInteger(object(process.child).pid) ? "running" : Number.isInteger(object(process.last_exit).exit_code) ? "exited" : "unknown";
		} catch (error) { observation.processError = observationError(error, context); }
		try { observation.status = await this.observationField(() => this.block("program_status", {}, target, context), budget, context); }
		catch (error) { observation.statusError = observationError(error, context); }
		try {
			const tailBytes = Math.min(maxBytes, this.defaultCaptureBytes(), budget.remaining - 128);
			if (tailBytes < 256) throw new Error("The observation byte budget has no room for a bounded tail.");
			observation.capture = await this.observationField(() => this.capture(target, context, tailBytes), budget, context, tailBytes + 128);
		} catch (error) { observation.captureError = observationError(error, context); }
		return observation;
	}

	private async observationField<T>(read: () => Promise<T>, budget: ObservationBudget, context: RexCallContext, fieldLimit = 16384): Promise<T> {
		context.signal?.throwIfAborted();
		if (budget.remaining <= 0) throw new Error("The observation byte budget is exhausted.");
		const value = await read();
		const bytes = jsonBytes(value);
		if (bytes > Math.min(fieldLimit, budget.remaining)) throw new Error("The observation field exceeds the remaining byte budget; its data is unavailable in this page.");
		budget.remaining -= bytes;
		return value;
	}

	private async manage(
		request: Extract<RexRequest, { op: "reconcile" | "cleanup" }>,
		context: RexCallContext,
	): Promise<RexResult> {
		if (request.op === "cleanup" && !boundedText(request.recordId, 1024)) throw new Error("Cleanup requires one exact retained record ID; it never selects another claim.");
		const state = validateOwnershipState(await this.options.store.read(context.ownerId), this.maxRecords);
		const selected = state.records.filter(
			(record) => record.ownerId === context.ownerId && (!request.recordId || record.callId === request.recordId),
		);
		const first = selected[0];
		if (!first) throw new Error("No Rex record belongs to this owner and record ID.");
		if (request.op === "cleanup") {
			if (request.forget) return this.forgetRecord(first, context);
			const server = await this.recordServer(first, context);
			return this.cleanupRecord(request, first, server, context);
		}
		if (request.release && request.recover) throw new Error("Select recovery or bookkeeping release, not both.");
		if (request.release) return this.releaseRecord(request, first, context);
		if (request.recover && !request.recordId) throw new Error("Recovery requires one exact record ID.");
		return this.reconcilePage(request, selected, context);
	}

	private async reconcilePage(
		request: Extract<RexRequest, { op: "reconcile" }>,
		selected: OwnershipRecord[],
		context: RexCallContext,
	): Promise<RexResult> {
		const page = recordPage(selected, request);
		context.budget?.check("observe");
		const signal = context.signal ?? new AbortController().signal;
		const scoped = context;
		const reports: ReconciliationReport[] = [];
			for (const record of page.records) {
				if (signal.aborted) break;
				const report = await this.observeRecord(record, scoped);
				reports.push(report);
				if (reportError(report)) break;
			}
			if (request.recover) return await this.recoverRecord(page.records[0], reports[0], scoped);
		const complete =
			reports.length === page.records.length && reports.every((report) => report.conclusive) && !signal.aborted;
		return {
			...result(
				complete,
				complete ? "reconciled" : context.budget?.stopReason() ?? (signal.aborted ? "cancelled" : "reconciliation_incomplete"),
				undefined,
				{ reports, operation: "reconcile", phase: "observe" },
				reports.map(reportError).find((error) => error !== undefined),
			),
			records: recordRefs(page.records),
			coverage: pageCoverage(page, reports.length),
		};
	}

	private async observeRecord(record: OwnershipRecord, context: RexCallContext): Promise<ReconciliationReport> {
		try {
			return await this.reconcileRecord(record, await this.recordServer(record, context), context);
		} catch (error) {
			return {
				recordId: record.callId,
				phase: record.phase,
				conclusive: false,
				observations: [],
				error: errorText(error),
			};
		}
	}

	private async recoverRecord(
		record: OwnershipRecord | undefined,
		report: ReconciliationReport | undefined,
		context: RexCallContext,
	): Promise<RexResult> {
		if (!record || !report)
			return result(false, "recovery_interrupted", undefined, undefined, "No current resource observations completed.");
		if (record.phase === "released") return { ...result(false, "claim_released", undefined, report, "An explicit release is final for this retained claim. Recovery does not revive it."), records: recordRefs([record]) };
		if (record.pendingCleanupCallId && this.options.isCallActive?.(context.ownerId, record.pendingCleanupCallId) !== false) {
			return { ...result(false, "cleanup_still_active_or_unknown", undefined, report, "The cleanup producer is active or its live state is unavailable. Do not recover or repeat its effects."), records: recordRefs([record]) };
		}
		if (!report.conclusive || record.resources.length === 0 || context.signal?.aborted) {
			return {
				...result(
					false,
					"recovery_unknown",
					undefined,
					report,
					"Recovery needs conclusive current presence or absence for every retained full resource ID. Unknown raw effects require explicit release with a note.",
				),
				records: recordRefs([record]),
			};
		}
		await this.recordServer(record, context);
		const present = report.observations
			.filter((observation) => observation.presence === "present")
			.map((observation) => observation.resource);
		const phase = present.length ? "confirmed" : "closed";
		await this.options.store.update(context.ownerId, (current) => {
			context.signal?.throwIfAborted();
			const entry = current.records.find((item) => item.callId === record.callId && item.ownerId === context.ownerId);
			if (!entry || requestDigest(entry) !== requestDigest(record))
				throw new Error("Rex record changed during recovery. Inspect it again.");
			if (entry.pendingCleanupCallId && this.options.isCallActive?.(context.ownerId, entry.pendingCleanupCallId) !== false) throw new Error("The cleanup producer is active or unknown at recovery admission.");
			return changeOwnership(
				current,
				record.callId,
				{
					phase,
					resources: present,
					pendingCleanupCallId: undefined,
					note: "Explicit recovery used current exact-ID presence or absence. No previous native effect was replayed.",
				},
				this.maxRecords,
			);
		}, "work");
		return {
			...result(
				true,
				"claim_recovered",
				{ server: record.server, source: "explicit" },
				{
					report,
					phase,
					note: "Present blocks permit a new explicit cleanup call. Absent blocks close the claim. Application success remains separate.",
				},
			),
			records: recordRefs([record]),
		};
	}

	private async releaseRecord(
		request: Extract<RexRequest, { op: "reconcile" }>,
		record: OwnershipRecord,
		context: RexCallContext,
	): Promise<RexResult> {
		if (!request.recordId || !boundedText(request.note, 2048))
			throw new Error("Release requires one record ID and an explicit note about the remaining native effects.");
		let observation: unknown;
		try {
			observation = await this.reconcileRecord(record, await this.recordServer(record, context), context);
		} catch (error) {
			observation = {
				outcome: "unavailable",
				error: errorText(error),
				note: "The native outcome remains unknown. Release changes only your retained claim.",
			};
		}
		await this.options.store.update(context.ownerId, (current) => {
			context.signal?.throwIfAborted();
			const entry = current.records.find((item) => item.callId === record.callId && item.ownerId === context.ownerId);
			if (!entry || requestDigest(entry) !== requestDigest(record))
				throw new Error("Rex record changed before release. Reconcile it again.");
			return changeOwnership(current, record.callId, { phase: "released", note: request.note }, this.maxRecords);
		}, "work");
		return result(
			true,
			"claim_released",
			{ server: record.server, source: "explicit" },
			{
				recordId: record.callId,
				observation,
				note: "You explicitly released this bookkeeping claim. Native resources and unknown effects were not undone, proven absent, accepted as successful or replayed. The released record permits explicit forgetting.",
			},
		);
	}

	private async recordServer(record: OwnershipRecord, context: RexCallContext): Promise<ServerRef> {
		const server = await this.selectServer({ server: record.server.endpoint }, context);
		if (!sameServer(record.server, server))
			throw new Error("The Rex server identity changed. Retained IDs do not authorise cleanup on this instance.");
		return server;
	}

	private async forgetRecord(record: OwnershipRecord, context: RexCallContext): Promise<RexResult> {
		const allowed = (entry: OwnershipRecord) =>
			entry.phase === "released" ||
			entry.phase === "closed" ||
			(entry.phase === "confirmed" && entry.resources.length === 0);
		if (!allowed(record))
			throw new Error("Unknown effects and live resource claims need reconciliation or closure before forgetting.");
		await this.options.store.update(context.ownerId, (current) => {
			context.signal?.throwIfAborted();
			const next = validateOwnershipState(current, this.maxRecords);
			const entry = next.records.find((item) => item.callId === record.callId && item.ownerId === context.ownerId);
			if (!entry || !allowed(entry)) throw new Error("Rex record changed before forgetting.");
			next.records = next.records.filter((item) => item !== entry);
			return next;
		}, "work");
		return result(true, "forgotten", undefined, {
			recordId: record.callId,
			note: "Only the retained claim was removed. No native resource was closed.",
		});
	}

	private async reconcileRecord(
		record: OwnershipRecord,
		server: ServerRef,
		context: RexCallContext,
	): Promise<ReconciliationReport> {
		const observations: ResourceObservation[] = [];
		for (const resource of record.resources) {
			if (context.signal?.aborted) break;
			const observation = await this.observeResource(resource, server, context);
			observations.push(observation);
			if (observation.error) break;
		}
		return {
			recordId: record.callId,
			phase: record.phase === "pending" ? "unknown" : record.phase,
			observations,
			conclusive:
				record.resources.length > 0 &&
				observations.length === record.resources.length &&
				observations.every((entry) => entry.presence !== "unknown"),
			note:
				record.resources.length === 0
					? "No acknowledged resource IDs. Discover native state; do not infer no effect or replay the call."
					: "Current exact-ID presence is separate from application success and missed history.",
		};
	}

	private async observeResource(
		resource: ResourceRef,
		server: ServerRef,
		context: RexCallContext,
	): Promise<ResourceObservation> {
		try {
			if (resource.kind !== "block" || !resource.blockId) throw new Error("This record has no exact owned block ID.");
			const response = object(
				await this.api(
					"target.resolve",
					{ kinds: ["block"], queries: [resource.blockId], scope: { session: resource.sessionId } },
					server,
					context,
				),
			);
			const entry = object(Array.isArray(response.results) ? response.results[0] : undefined);
			if (entry.status === "not_found") return { resource, presence: "absent" };
			const found = object(entry.target);
			if (entry.status !== "resolved" || found.block_id !== resource.blockId || found.session_id !== resource.sessionId)
				throw new Error("The exact resource identity did not resolve conclusively.");
			const present: ResourceRef = { kind: "block", sessionId: resource.sessionId, blockId: resource.blockId };
			if (fullId(found.window_id, "window")) present.windowId = found.window_id;
			return { resource: present, presence: "present" };
		} catch (error) {
			return { resource, presence: "unknown", error: errorText(error) };
		}
	}

	private async cleanupRecord(
		request: Extract<RexRequest, { op: "cleanup" }>,
		record: OwnershipRecord,
		server: ServerRef,
		context: RexCallContext,
	): Promise<RexResult> {
		const target: ResolvedTarget = { server, source: "explicit" };
		if (record.phase === "closed") return result(true, "already_closed", target, { recordId: record.callId });
		validateCleanupRecord(record);
		for (const resource of record.resources) {
			const observation = await this.observeResource(resource, server, context);
			if (observation.presence !== "present")
				throw new Error(observation.error ?? "The exact owned block is absent. Reconcile the record before cleanup.");
		}
		const pending = pendingRecord(request, target, context);
		context.budget?.check("effect");
		await this.options.store.update(context.ownerId, (state) => {
			context.budget?.check("effect");
			const current = state.records.find((item) => item.callId === record.callId && item.ownerId === context.ownerId);
			if (!current || requestDigest(current) !== requestDigest(record)) throw new Error("Rex cleanup ownership changed after preflight. Inspect it again.");
			validateCleanupRecord(current);
			return changeOwnership(
				beginOwnership(state, pending, this.maxRecords),
				record.callId,
				{ phase: "unknown", pendingCleanupCallId: context.callId, note: "An owned cleanup call has pending effects." },
				this.maxRecords,
			);
		}, "work");
		const closed: ResourceRef[] = [];
		let dispatched = false;
		let settlementAttempted = false;
		try {
			for (const resource of record.resources) {
				context.budget?.check("effect");
				dispatched = true;
				await this.api("block.close", { session_id: resource.sessionId, block_id: resource.blockId }, server, context);
				closed.push(resource);
			}
			settlementAttempted = true;
			await this.options.store.update(context.ownerId, (current) => {
				context.budget?.check("finalise");
				return closeAcknowledgedClaims(current, record.callId, context.callId, context.ownerId, this.maxRecords);
			}, "finalise");
			return {
				...result(true, "cleanup_report", target, {
					closed,
					retainedParents: record.resources.map((resource) => ({
						sessionId: resource.sessionId,
						windowId: resource.windowId,
					})),
				}),
				effects: {
					state: "confirmed",
					recordId: context.callId,
					resources: closed,
					note: "Only owned blocks were closed. Empty parent resources remain; no parent closure raced unrelated work.",
				},
			};
		} catch (error) {
			return this.failedCleanup(error, target, context, { closed, resources: record.resources, dispatched, settlementAttempted });
		}
	}

	private async failedCleanup(error: unknown, target: ResolvedTarget, context: RexCallContext, progress: { closed: ResourceRef[]; resources: ResourceRef[]; dispatched: boolean; settlementAttempted: boolean }): Promise<RexResult> {
		const { closed, resources, dispatched, settlementAttempted } = progress;
		if (!dispatched) return {
			...result(false, context.budget?.stopReason() ?? "cancelled", target, { closed }, errorText(error)),
			effects: { state: "none", recordId: context.callId, note: "Cleanup intent remains retained; no close was requested." },
		};
		try {
			if (!settlementAttempted) await this.settleEffect(context, "unknown", [], "Cleanup outcome is unknown. Inspect the retained IDs before another close.");
		} catch {
			/* Pending and original unknown claims still prohibit replay. */
		}
		return {
			...result(false, "cleanup_unknown", target, { closed }, errorText(error)),
			effects: { state: "unknown", recordId: context.callId, resources },
		};
	}
}

interface ObservationBudget { remaining: number }
interface WorkObservation extends ResourceObservation {
	observedAt: string;
	childState: "running" | "exited" | "unknown" | "unavailable";
	processError?: string;
	status?: unknown;
	statusError?: string;
	capture?: Capture;
	captureError?: string;
}
interface WorkReport {
	recordId: string;
	phase: OwnershipRecord["phase"];
	observedAt: string;
	complete: boolean;
	observations: WorkObservation[];
	error?: string;
}
function observationError(error: unknown, context: RexCallContext): string {
	return boundedDiagnosticText(context.signal?.aborted ? "The observation stopped before this read completed." : errorText(error), 512);
}
function unavailableWork(resource: ResourceRef, error: string): WorkObservation {
	return { resource, presence: "unknown", observedAt: new Date().toISOString(), childState: "unavailable", error };
}
function selectRecords(records: OwnershipRecord[], request: { recordId?: string; phase?: OwnershipRecord["phase"] }): OwnershipRecord[] {
	if (request.recordId !== undefined && !boundedText(request.recordId, 1024)) throw new Error("Select a complete retained record ID.");
	if (request.phase !== undefined && !["pending", "confirmed", "unknown", "closed", "released"].includes(request.phase)) throw new Error("Select a stored ownership phase.");
	return records.filter((record) => (request.recordId === undefined || record.callId === request.recordId) && (request.phase === undefined || record.phase === request.phase));
}
interface ResourceObservation {
	resource: ResourceRef;
	presence: "present" | "absent" | "unknown";
	process?: unknown;
	error?: string;
}
interface ReconciliationReport {
	recordId: string;
	phase: OwnershipRecord["phase"];
	conclusive: boolean;
	observations: ResourceObservation[];
	error?: string;
	note?: string;
}
interface RecordPage {
	records: OwnershipRecord[];
	total: number;
	offset: number;
}
function reportError(report: ReconciliationReport): string | undefined {
	return report.error ?? report.observations.find((observation) => observation.error)?.error;
}
function recordPage(records: OwnershipRecord[], request: { offset?: number; limit?: number }): RecordPage {
	const offset = boundedInteger(request.offset ?? 0, 0, 256, "record offset");
	const limit = boundedInteger(request.limit ?? 4, 1, 4, "record page size");
	return { records: records.slice(offset, offset + limit), total: records.length, offset };
}
function recordRefs(records: OwnershipRecord[]): NonNullable<RexResult["records"]> {
	return records.map((record) => ({ recordId: record.callId, server: record.server, resources: record.resources }));
}
function pageCoverage(page: RecordPage, returned: number): RexResult["coverage"] {
	const next = page.offset + returned;
	return {
		bounded: true,
		pageOffset: page.offset,
		totalRecords: page.total,
		returnedRecords: returned,
		omittedRecords: page.total - returned,
		...(next < page.total ? { nextOffset: next } : {}),
		truncated: returned < page.total,
		note: "Use offset/limit or a specific recordId for omitted records. Records before this page are included in omittedRecords.",
	};
}
const RESULT_BOUND_NOTE = "Result details were reduced to fit the JSON budget. CLI acknowledgement does not establish an inner application outcome. Exact IDs and effect state are unchanged. Retrieve omitted references by recordId, or use nextOffset with limit 1.";
const DIAGNOSTIC_LIMITS = { error: 4096, "effects.note": 1024, "coverage.note": 1024 } as const;

/** The supported budget follows resultByteLimit and the validated domain identity bounds. */
export function boundResult(value: RexResult, maxBytes: number): RexResult {
	if (jsonBytes(value) <= maxBytes) return value;
	let next: RexResult = {
		...value,
		...(value.data === undefined ? {} : { data: { omitted: true, reason: "The complete Rex result exceeded its byte limit. Select a smaller view, limit or exact recordId." } }),
		coverage: { ...value.coverage, truncated: true, dataOmitted: value.coverage.dataOmitted || value.data !== undefined, note: `${RESULT_BOUND_NOTE} ${value.coverage.note ?? ""}`.trim() },
	};
	if (jsonBytes(next) <= maxBytes) return next;
	for (const field of ["error", "effects.note", "coverage.note"] as const) {
		next = boundDiagnostic(next, field);
		if (jsonBytes(next) <= maxBytes) return next;
	}
	next = omitRecordReferences(next, maxBytes);
	if (jsonBytes(next) <= maxBytes) return next;
	// Worst-case JSON bytes for defined identities after all page references are omitted:
	// server 50,746 + resource refs 8,192 + effect ID 6,146 + four omitted IDs 24,584
	// + diagnostics 6,144 + framing/outcome/coverage 2,052 = 97,864. The validated
	// limits are 4,096/128 UTF-16 units for server fields, 1,024 for call IDs,
	// UUID resource IDs, 32 resources and four page references. Six escaped bytes
	// per UTF-16 unit cover lone surrogates too. Minimum resultByteLimit is 102,400.
	// Additional or out-of-contract mandatory metadata has no lossless representation.
	throw new ResultIdentityBoundaryError(`Rex identity metadata exceeds the supported result boundary. Native effects may already exist: outcome=${value.outcome}; effectState=${value.effects.state}; recordId=${JSON.stringify(value.effects.recordId ?? null)}. Do not replay the call.`);
}

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function boundedDiagnosticText(value: string, maxBytes: number): string {
	if (jsonBytes(value) <= maxBytes) return value;
	const marker = "[truncated]";
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (jsonBytes(unicodePrefix(value, middle) + marker) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return unicodePrefix(value, low) + marker;
}

/** An EOF reply fixes the raw range; each replaced leading continuation byte adds two decoded bytes. */
function completeUtf8Suffix(text: string, rawBytes: number): string {
	const replaced = (Buffer.byteLength(text) - rawBytes) / 2;
	if (!Number.isInteger(replaced) || replaced < 0 || replaced > 3 || !text.startsWith("\ufffd".repeat(replaced)))
		throw new Error("Rex capture text does not match its raw EOF range.");
	return text.slice(replaced);
}

/** The end of `text` whose JSON encoding fits `maxBytes`, starting at a line boundary when one exists. */
function tailText(text: string, maxBytes: number, partialStart = false): string {
	let start = text.length;
	let bytes = 2; // JSON string quotes.
	while (start > 0) {
		let previous = start - 1;
		const unit = text.charCodeAt(previous);
		if (unit >= 0xdc00 && unit <= 0xdfff && previous > 0) {
			const lead = text.charCodeAt(previous - 1);
			if (lead >= 0xd800 && lead <= 0xdbff) previous--;
		}
		const cost = jsonBytes(text.slice(previous, start)) - 2;
		if (bytes + cost > maxBytes) break;
		bytes += cost;
		start = previous;
	}
	const value = text.slice(start);
	const newline = value.indexOf("\n");
	return (start > 0 || partialStart) && newline >= 0 && value.slice(newline + 1).trim().length > 0 ? value.slice(newline + 1) : value;
}
function verifyCaptureEnd(first: Record<string, unknown>): void {
	if (first.eof === false && typeof first.id !== "number") throw new Error("Rex capture has an unverified end without a continuation ID.");
}
function captureTruncated(capture: Capture): boolean {
	return capture.start > 0 || capture.end < capture.total;
}
function unicodePrefix(value: string, end: number): string {
	const previous = value.charCodeAt(end - 1);
	const next = value.charCodeAt(end);
	if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return value.slice(0, end - 1);
	return value.slice(0, end);
}

function boundDiagnostic(value: RexResult, field: keyof typeof DIAGNOSTIC_LIMITS): RexResult {
	const source = field === "error" ? value.error : field === "effects.note" ? value.effects.note : value.coverage.note;
	if (source === undefined) return value;
	const text = boundedDiagnosticText(source, DIAGNOSTIC_LIMITS[field]);
	if (text === source) return value;
	const truncatedFields = [...new Set([...(value.coverage.truncatedFields ?? []), field])];
	const next = { ...value, effects: { ...value.effects }, coverage: { ...value.coverage, truncated: true as const, truncatedFields } };
	if (field === "error") next.error = text;
	else if (field === "effects.note") next.effects.note = text;
	else next.coverage.note = text;
	return next;
}

function omitRecordReferences(value: RexResult, maxBytes: number): RexResult {
	const records = [...(value.records ?? [])];
	const omittedRecordIds = [...(value.coverage.omittedRecordIds ?? [])];
	const nextPageOffset = value.coverage.omittedRecordRefs === undefined ? value.coverage.nextOffset : value.coverage.nextPageOffset;
	let next = value;
	while (records.length > 0 && jsonBytes(next) > maxBytes) {
		const removed = records.pop();
		if (!removed) break;
		omittedRecordIds.unshift(removed.recordId);
		const coverage = { ...next.coverage, emittedRecordRefs: records.length, omittedRecordRefs: omittedRecordIds.length, omittedRecordIds: [...omittedRecordIds] };
		if (coverage.pageOffset !== undefined) {
			coverage.nextPageOffset = nextPageOffset;
			const firstOmittedReference = coverage.pageOffset + records.length;
			coverage.nextOffset = nextPageOffset === undefined ? firstOmittedReference : Math.min(nextPageOffset, firstOmittedReference);
		}
		next = { ...next, records: [...records], coverage };
	}
	return next;
}

type TargetKind = "session" | "window" | "block" | "client";
function targetKey(kind: TargetKind): "sessionId" | "windowId" | "blockId" | "clientId" {
	return { session: "sessionId", window: "windowId", block: "blockId", client: "clientId" }[kind] as
		| "sessionId"
		| "windowId"
		| "blockId"
		| "clientId";
}
function targetNeed(request: RexRequest): TargetKind | undefined {
	if (request.op === "create") {
		if (request.kind === "session") return undefined;
		return request.kind === "split" || request.kind === "float" ? "block" : "session";
	}
	if (request.op === "native") return undefined;
	if (request.op === "inspect" && request.view === "structure") return "session";
	return "block";
}
function targetSource(intent: TargetIntent | undefined, query?: string): "explicit" | "inherited" | "focus" {
	if (intent?.source === "focus" && !intent.block && query === undefined) return "focus";
	if (hasResources(intent) || query !== undefined || intent?.source === "explicit") return "explicit";
	return "inherited";
}
function selectors(
	intent: TargetIntent | undefined,
	env: Readonly<Record<string, string | undefined>>,
): [TargetKind, string | undefined][] {
	return [
		["session", intent?.session ?? env.REX_SESSION],
		["window", intent?.window],
		["block", intent?.block ?? env.REX_BLOCK],
		["client", intent?.client ?? env.REX_CLIENT],
	];
}
function validateDefaultTarget(source: string, kind: TargetKind): void {
	if (source === "inherited")
		throw new Error(`No inherited Rex ${kind} exists. Select a resource explicitly; focus is not a substitute.`);
	if (source === "explicit" && kind === "block")
		throw new Error(
			"Select an explicit block, or request source focus. An explicit session does not authorise its focused block.",
		);
}
function mergeResolvedTarget(base: ResolvedTarget, kind: TargetKind, found: Record<string, unknown>): void {
	if (found.kind !== kind || !fullId(found[`${kind}_id`], kind)) throw new Error("Rex resolved an invalid target ID.");
	validateRelationship(base.sessionId, found.session_id, "session");
	validateRelationship(base.windowId, found.window_id, "window");
	if (typeof found.session_id === "string") base.sessionId = found.session_id;
	if (typeof found.window_id === "string") base.windowId = found.window_id;
	if (kind === "block") base.blockId = found.block_id as string;
	if (kind === "client") base.clientId = found.client_id as string;
}
function validateRelationship(expected: string | undefined, found: unknown, kind: string): void {
	if (found === undefined) return;
	if (!fullId(found, kind)) throw new Error(`Rex resolved an invalid ${kind} ID.`);
	if (expected && expected !== found) throw new Error(`Rex returned a resource outside the explicit ${kind}.`);
}

type CreateRequest = Extract<RexRequest, { op: "create" }>;
/**
 * Rex keeps a terminal open after a failure that ends within this many milliseconds. The largest
 * accepted value keeps every failure open, so a pane that closes on success still shows any error.
 */
const FAILURE_STAYS_OPEN_MS = 4294967295;
/** By default a pane keeps completed output; `keepOpen: false` closes it when its program succeeds. */
function exitOptions(keepOpen: boolean | undefined): Record<string, unknown> {
	return keepOpen === false ? { on_completion: true, quick_exit_threshold_ms: FAILURE_STAYS_OPEN_MS } : { on_completion: false };
}
function createLayout(request: CreateRequest): Record<string, unknown> {
	if (!boundedText(request.label, 128)) throw new Error("Use a Rex label of 1 to 128 characters.");
	if (request.command !== undefined) validateCommand(request.command);
	if (request.cwd !== undefined && (!boundedText(request.cwd, 4096) || !request.cwd.startsWith("/")))
		throw new Error("Use an absolute cwd on the selected server.");
	if (request.shell !== undefined && !boundedText(request.shell, 4096)) throw new Error("Rex shell is invalid.");
	if (request.kind === "session" && request.focus !== undefined)
		throw new Error("focus applies to window, split and float creation. Display a new session through a client action.");
	if (request.bounds !== undefined && request.kind !== "float") throw new Error("bounds apply only to float creation.");
	return {
		block: {
			flavor: "com.superlogical.terminal.shell",
			label: request.label,
			options: {
				...(request.command ? { command: ["/usr/bin/env", `PI_PANE_STACKING=${JSON.stringify([process.execPath, fileURLToPath(new URL("./pane-stacking.mts", import.meta.url))])}`, ...request.command] } : {}),
				...(request.cwd ? { cwd: request.cwd } : {}),
				...(request.shell ? { shell: request.shell } : {}),
				...(request.shell === "none" ? { login: false } : {}),
				exit: exitOptions(request.keepOpen),
			},
		},
	};
}
function validateCommand(command: string[]): void {
	if (!Array.isArray(command) || command.length < 1 || command.length > 64)
		throw new Error("Rex command arguments are invalid.");
	if (command.some((word) => typeof word !== "string" || word.length > 16384 || word.includes("\0")))
		throw new Error("Rex command arguments are invalid.");
}
function creationCall(
	request: CreateRequest,
	target: ResolvedTarget,
): { method: string; args: Record<string, unknown> } {
	const layout = createLayout(request);
	if (request.kind === "session")
		return {
			method: "session.create",
			args: { label: request.label, initial_windows: [{ window_label: request.label, layout }] },
		};
	requireSession(target);
	if (request.kind === "window")
		return {
			method: "session.new_window",
			args: { session_id: target.sessionId, window_label: request.label, layout, focus: request.focus ?? false },
		};
	requireBlock(target);
	if (request.kind === "float") {
		if (!fullId(target.windowId, "window")) throw new Error("Rex did not resolve the anchor block's window.");
		return {
			method: "session.new_layer",
			args: { session_id: target.sessionId, window_id: target.windowId, bounds: floatBounds(request.bounds), layout, focus: request.focus ?? false },
		};
	}
	const direction = request.direction ?? "right";
	const ratio = boundedInteger(request.ratio ?? 50, 1, 99, "split ratio") / 100;
	const before = direction === "left" || direction === "above";
	return {
		method: "session.new_split",
		args: {
			session_id: target.sessionId,
			anchor_id: target.blockId,
			direction: direction === "left" || direction === "right" ? "horizontal" : "vertical",
			side: before ? "before" : "after",
			ratio: before ? ratio : 1 - ratio,
			layout,
			focus: request.focus ?? false,
		},
	};
}
/** A centred pane that leaves the surrounding layout visible. */
const FLOAT_BOUNDS = [0.1, 0.06, 0.8, 0.88];
/** Floating pane rectangle as [x, y, width, height] fractions of its window, inside the window. */
function floatBounds(bounds: number[] | undefined): number[] {
	if (bounds === undefined) return FLOAT_BOUNDS;
	const [x, y, width, height] = bounds;
	if (
		bounds.length !== 4 ||
		!bounds.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) ||
		x === undefined || y === undefined || width === undefined || height === undefined ||
		width <= 0 || height <= 0 || x + width > 1 || y + height > 1
	)
		throw new Error("Use float bounds [x, y, width, height] as fractions of the window, with a positive size inside it.");
	return bounds;
}
function createdResources(kind: CreateRequest["kind"], target: ResolvedTarget, raw: unknown): ResourceRef[] {
	const data = object(raw);
	const sessionId = kind === "session" ? data.session_id : target.sessionId;
	const window =
		kind === "session" ? object(Array.isArray(data.initial_windows) ? data.initial_windows[0] : undefined) : data;
	const windowId = kind === "split" || kind === "float" ? target.windowId : window.window_id;
	const blockIds = Array.isArray(window.block_ids) ? window.block_ids : [];
	if (
		!fullId(sessionId, "session") ||
		blockIds.length !== 1 ||
		!fullId(blockIds[0], "block") ||
		!fullId(windowId, "window")
	)
		throw new Error("Rex created work but did not return its complete resource IDs. Reconcile before retry.");
	return [{ kind: "block", sessionId, windowId, blockId: blockIds[0] }];
}
function validateInput(request: Extract<RexRequest, { op: "input" }>): void {
	if (request.text === undefined && !request.keys?.length) throw new Error("Provide Rex input text or keys.");
	if (
		request.text !== undefined &&
		(typeof request.text !== "string" || Buffer.byteLength(request.text) > 32768 || request.text.includes("\0"))
	)
		throw new Error("Rex text exceeds its input limit.");
	if (request.keys !== undefined && (!Array.isArray(request.keys) || request.keys.length > 16))
		throw new Error("Rex key count exceeds its limit.");
	if (request.keys?.some((key) => !boundedText(key, 64) || key.startsWith("-")))
		throw new Error("Rex key name is invalid.");
}

type NativeRequest = Extract<RexRequest, { op: "native" }>;
/**
 * Exact API methods whose installed contracts only return current server, session,
 * client, terminal, filesystem or onboarding state. `api describe` exposes no
 * read-only annotation, so the list is maintained here. Generic invokers, snapshot
 * or blob producers, retained clipboard reads, focus, label and input methods stay
 * effects.
 */
const VERIFIED_READ_METHODS: ReadonlySet<string> = new Set([
	"block_creator.list",
	"help.all",
	"session.help",
	"session.list",
	"session.view",
	"session.list_blocks",
	"session.describe_block",
	"session.list_clients",
	"target.resolve",
	"target.complete",
	"client.list",
	"client.inspect",
	"server.version",
	"server.whoami",
	"server.status",
	"hosts.list",
	"com.superlogical.terminal.process",
	"com.superlogical.terminal.program_status",
	"com.superlogical.terminal.modes",
	"com.superlogical.terminal.input_mode",
	"com.superlogical.terminal.size",
	"com.superlogical.terminal.title",
	"com.superlogical.terminal.pwd",
	"com.superlogical.terminal.list_dir",
	"com.superlogical.onboarding.state",
]);
function validateNativeTarget(request: NativeRequest, target: ResolvedTarget): void {
	const args = request.args ?? {};
	if (!args || typeof args !== "object" || Array.isArray(args))
		throw new Error("Native Rex arguments require a JSON object.");
	if (request.kind !== "api") return;
	for (const [key, id] of [
		["session_id", target.sessionId],
		["window_id", target.windowId],
		["block_id", target.blockId],
		["client_id", target.clientId],
	] as const) {
		if (id && args[key] !== undefined && args[key] !== id)
			throw new Error(`Native ${key} conflicts with the resolved target.`);
	}
}
function nativeCommand(request: NativeRequest, target: ResolvedTarget): string[] {
	const args = JSON.stringify(request.args ?? {});
	if (request.kind === "api") {
		if (!boundedText(request.method, 256) || request.method.startsWith("-"))
			throw new Error("Select an exact Rex API method.");
		return ["api", "call", request.method, args];
	}
	let cli: string[];
	if (request.kind === "lua") {
		if (
			typeof request.code !== "string" ||
			request.code.length === 0 ||
			Buffer.byteLength(request.code) > 65536 ||
			request.code.includes("\0")
		)
			throw new Error("Rex Lua source is empty or exceeds its limit.");
		cli = ["do", "-e", request.code, "--args", args, "--json", "--fail-fast"];
	} else {
		validateAction(request.action);
		cli = ["do", request.action, ...(request.args === undefined ? [] : ["--args", args]), "--json"];
	}
	if (target.sessionId) cli.push("-s", target.sessionId);
	if (target.blockId) cli.push("-b", target.blockId);
	if (target.clientId) cli.unshift("--client", target.clientId);
	return cli;
}
function validateAction(action: unknown): asserts action is string {
	if (!boundedText(action, 256) || /[\\/]/.test(action) || action.endsWith(".lua") || action.startsWith("-"))
		throw new Error("Use an existing action name, not a script path.");
}
function nativeResponse(raw: CliResult, kind: string): unknown {
	let value: unknown;
	try {
		value = raw.stdout.trim() ? JSON.parse(raw.stdout) : null;
	} catch {
		value = { stdout: raw.stdout, completeJson: false };
	}
	return {
		value,
		stderr: raw.stderr,
		locality:
			kind === "lua"
				? "Lua helpers execute on the CLI host; API helpers address their selected servers. Explicit detached local exec work may survive CLI cancellation."
				: "The native method or action owns execution semantics.",
		meaning:
			"Outer CLI success only. Lua nil/error pairs, returned failure tables and child exit codes remain application data. Native partial effects are not rolled back or replayed.",
	};
}

function closeAcknowledgedClaims(state: OwnershipState, originalId: string, cleanupId: string, ownerId: string, maxRecords: number): OwnershipState {
	let next = validateOwnershipState(state, maxRecords);
	for (const callId of [originalId, cleanupId]) {
		const record = next.records.find((entry) => entry.callId === callId && entry.ownerId === ownerId);
		if (!record) throw new Error("A Rex cleanup claim disappeared before acknowledgement retention.");
		if (record.phase === "released") continue;
		next = changeOwnership(next, callId, { phase: "closed", pendingCleanupCallId: undefined, ...(callId === cleanupId ? { resources: [] } : {}), note: "Owned blocks closed. Empty parent resources were not closed." }, maxRecords);
	}
	return next;
}

function pendingRecord(request: RexRequest, target: ResolvedTarget, context: RexCallContext): OwnershipRecord {
	const now = new Date().toISOString();
	return {
		callId: context.callId,
		requestDigest: requestDigest(request),
		ownerId: context.ownerId,
		server: target.server,
		operation: request.op === "native" ? `native:${request.kind}` : request.op,
		phase: "pending",
		resources: [],
		createdAt: now,
		updatedAt: now,
	};
}
function validateCleanupRecord(record: OwnershipRecord): void {
	if (record.phase !== "confirmed" || record.resources.length === 0)
		throw new Error(
			"Unknown or untracked Rex effects do not authorise automatic cleanup. Inspect exact native state first.",
		);
	if (record.resources.some((resource) => resource.kind !== "block" || !resource.blockId))
		throw new Error("Rex cleanup requires an explicitly owned block record.");
}
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type WaitRequest = Extract<RexRequest, { op: "wait" }>;
interface ConditionObservation {
	snapshot: unknown;
	snapshots: number;
	matched: boolean;
	deadline: number;
	observerEnded: boolean;
}
function validateCondition(request: WaitRequest): void {
	if (request.condition === "text" && !boundedText(request.text, 2048))
		throw new Error("Text readiness needs a nonempty literal of at most 2048 characters.");
	if (request.condition === "status" && !["idle", "working", "done", "blocked", "error"].includes(request.state ?? ""))
		throw new Error("Status readiness needs an exact program state.");
}
function conditionMatches(request: WaitRequest, snapshot: unknown): boolean {
	const value = object(snapshot);
	if (request.condition === "text")
		return typeof value.content === "string" && value.content.includes(request.text ?? "");
	if (!Array.isArray(value.records)) return false;
	return value.records.some((item: unknown) => {
		const record = object(item);
		return record.state === request.state && (request.statusId === undefined || record.id === request.statusId);
	});
}
function conditionOutcome(context: RexCallContext, observation: ConditionObservation): string {
	if (observation.matched) return "condition_observed";
	if (context.budget?.stopReason()) return context.budget.stopReason() ?? "timeout";
	if (context.signal?.aborted) return "cancelled";
	if (!context.budget && performance.now() >= observation.deadline) return "timeout";
	if (observation.observerEnded) return "observer_ended";
	return "snapshot_limit";
}
function conditionResult(
	request: WaitRequest,
	target: ResolvedTarget,
	context: RexCallContext,
	observation: ConditionObservation,
	observer: EventObserver,
	raw: CliResult,
): RexResult {
	return {
		...result(observation.matched, !observation.matched && observer.failure ? "observation_failed" : conditionOutcome(context, observation), target, {
			...(observer.failure ? { cause: observer.failure } : {}),
			condition: request.condition,
			operation: "wait", phase: "observe",
			snapshot: observation.snapshot,
			snapshots: observation.snapshots,
			events: observer.events,
			eventCount: observer.eventCount,
			observer: raw.outcome,
			meaning:
				"A literal or reported status matched. The agent decides whether that establishes application readiness.",
		}),
		coverage: {
			bounded: true,
			truncated:
				(request.condition === "text" && observation.snapshot !== undefined && captureTruncated(observation.snapshot as Capture)) ||
				observer.eventCount > observer.events.length,
			note: "Live events have no replay guarantee. Current snapshots cover missed events, not lost history. The terminal remains independent of this observer.",
		},
	};
}

class EventObserver {
	readonly events: unknown[] = [];
	eventCount = 0;
	generation = 0;
	ended = false;
	failure?: CliResult;
	private wake?: () => void;
	private readonly controller = new AbortController();
	private readonly outcome: Promise<CliResult>;
	private readonly relay = () => this.controller.abort();
	private readonly context: RexCallContext;
	private readonly blockId?: string;
	constructor(
		transport: RexTransport,
		args: string[],
		context: RexCallContext,
		timeoutMs: number,
		maxOutputBytes: number,
		blockId?: string,
	) {
		this.context = context;
		this.blockId = blockId;
		context.signal?.addEventListener("abort", this.relay, { once: true });
		if (context.signal?.aborted) this.controller.abort();
		this.outcome = transport
			.run(args, {
				cwd: context.cwd,
				signal: this.controller.signal,
				timeoutMs,
				maxOutputBytes,
				finaliseSignal: context.budget?.finaliseSignal,
				onLine: (line) => this.line(line),
			})
			.then((value) => {
				// The transport retains its first stop cause even when close follows work cancellation.
				const sourceStopped = value.outcome === "output_limit" || value.outcome === "spawn_error";
				if (sourceStopped || (!this.controller.signal.aborted && !context.budget?.stopReason() && (value.outcome !== "exited" || value.exitCode !== 0))) this.failure = value;
				this.ended = true;
				this.generation++;
				this.wake?.();
				return value;
			});
	}
	private line(line: string): void {
		this.eventCount++;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return;
		}
		const payload = object(object(object(value).payload).event);
		const block = object(payload.payload).block_id;
		if (typeof block === "string" && block !== this.blockId) return;
		if (this.events.length < 16) this.events.push(value);
		this.generation++;
		this.wake?.();
	}
	wait(seen: number, signal?: AbortSignal, refreshMs?: number): Promise<void> {
		if (this.generation !== seen || signal?.aborted || this.ended) return Promise.resolve();
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const done = () => {
				if (timer !== undefined) clearTimeout(timer);
				this.wake = undefined;
				signal?.removeEventListener("abort", done);
				resolve();
			};
			this.wake = done;
			signal?.addEventListener("abort", done, { once: true });
			if (refreshMs !== undefined) timer = setTimeout(done, refreshMs);
			if (signal?.aborted || this.generation !== seen) done();
		});
	}
	async stop(): Promise<CliResult> {
		this.controller.abort();
		this.context.signal?.removeEventListener("abort", this.relay);
		return this.outcome;
	}
}

class ResultIdentityBoundaryError extends Error {}

class NativeFailure extends Error {
	readonly result: RexResult;
	constructor(result: RexResult) {
		super(result.error ?? result.outcome);
		this.result = result;
	}
}
function executionFailure(error: unknown, budget: RexBudget | undefined): RexResult {
	if (error instanceof ResultIdentityBoundaryError) throw error;
	if (error instanceof NativeFailure) return error.result;
	const reason = error instanceof RexStopped ? error.reason : budget?.stopReason();
	return result(false, reason ?? "invalid_or_unavailable", undefined, undefined, errorText(error));
}
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function requireSession(target: ResolvedTarget): asserts target is ResolvedTarget & { sessionId: string } {
	if (!fullId(target.sessionId, "session")) throw new Error("Select an exact Rex session.");
}
function requireBlock(
	target: ResolvedTarget,
): asserts target is ResolvedTarget & { sessionId: string; blockId: string } {
	requireSession(target);
	if (!fullId(target.blockId, "block")) throw new Error("Select an exact Rex block.");
}
function hasResources(target?: TargetIntent): boolean {
	return !!(target?.session || target?.window || target?.block || target?.client);
}
function boundedInteger(value: number, min: number, max: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw new Error(`Rex ${name} must be an integer from ${min} to ${max}.`);
	return value;
}
function result(ok: boolean, outcome: string, target?: ResolvedTarget, data?: unknown, error?: string): RexResult {
	return {
		ok,
		outcome,
		...(target ? { target } : {}),
		...(data === undefined ? {} : { data }),
		...(error ? { error } : {}),
		effects: { state: "none" },
		coverage: { bounded: true },
	};
}
function cliResult(response: CliResult): RexResult {
	return {
		...result(
			response.outcome === "exited" && response.exitCode === 0,
			response.outcome === "exited" ? (response.exitCode === 0 ? "cli_success" : "cli_failure") : response.outcome,
			undefined,
			{
				stdout: response.stdout,
				stderr: response.stderr,
				exitCode: response.exitCode,
				signal: response.signal,
				started: response.started,
			},
			response.stderr || undefined,
		),
		coverage: { bounded: true, truncated: response.truncated },
	};
}
function childObservationOutcome(observer: CliResult, deadline: number): string {
	if (observer.outcome === "cancelled") return "cancelled";
	if (observer.outcome === "timeout" || Date.now() >= deadline) return "timeout";
	if (observer.outcome !== "exited" || observer.exitCode !== 0) return "observation_failed";
	return "completion_unknown";
}
function childResult(
	target: ResolvedTarget,
	process: Record<string, unknown>,
	evidence: string,
	output: { capture: Capture } | { captureError: string },
): RexResult {
	const exit = object(process.last_exit);
	return {
		...result(exit.exit_code === 0, exit.exit_code === 0 ? "child_completed" : "child_failed", target, {
			process,
			operation: "wait", phase: "observe",
			...output,
			evidence,
			meaning: "The terminal's direct child exited. This says nothing about an inner shell command or service readiness.",
		}),
		coverage: {
			bounded: true,
			truncated: "capture" in output && captureTruncated(output.capture),
			note: "The capture is the most recent bounded output after exit, not a complete transcript.",
		},
	};
}
