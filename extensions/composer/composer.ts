import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { ComposerBridge, type ComposerConfig, type ComposerState, type DetachReason, type JsonObject, draft, integer, object, oneLine, string } from "./composer-bridge.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { ComposerCompletion } from "./composer-completion.ts";
import { ComposerEditor } from "./composer-editor.ts";
import { ComposerApp } from "./app-update.ts";
import { readSettings } from "./settings.ts";

type Message = import("@earendil-works/pi-coding-agent").MessageEndEvent["message"];
type Factory = Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
type SubmitResult = { outcome: "accepted" } | { outcome: "refused"; message: string };
interface RetainedComposer {
	id: string;
	pid: number;
	receipt?: unknown;
	mirror: string;
	submissions: Map<string, { digest: string; result: SubmitResult }>;
}
const retained = Symbol.for("harness.composer");
const processState = globalThis as typeof globalThis & { [retained]?: RetainedComposer };
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const PATHS = new Set(["/draft", "/submit", "/abort", "/close", "/visibility", "/complete", "/applyCompletion", "/models", "/setModel", "/setThinking", "/dequeue", "/resize"]);
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const HISTORY_BYTES = 256 * 1024;
const PRESENCE_EVENT = "harness:composer:presence";
const PRESENCE_REQUEST = "harness:composer:presence-request";
function assistantCost(message: Message): number {
	if (message.role !== "assistant") return 0;
	const total = message.usage?.cost?.total;
	return Number.isFinite(total) ? total : 0;
}
function historyPush(history: string[], text: string): boolean {
	const bytes = Buffer.byteLength(text);
	if (!text.trim() || /\p{Cs}/u.test(text) || bytes > HISTORY_BYTES || history.at(-1) === text) return false;
	history.push(text);
	let total = history.reduce((sum, entry) => sum + Buffer.byteLength(entry), 0);
	while (total > HISTORY_BYTES || history.length > 100) total -= Buffer.byteLength(history.shift() ?? "");
	return true;
}
function userText(message: { role: string; content?: unknown }): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	return message.content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}

/**
 * Node's compile cache keeps the transformed TypeScript of the Rex adapters between runs, so a
 * pane resize does not pay for the TypeScript transform at each start. The location is Node's own
 * default, unless the environment names one.
 */
const adapterEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || join(tmpdir(), "node-compile-cache") });
function adapter(file: string, operation: string, timeout: number, signal: AbortSignal, input?: string): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const child = execFile(process.execPath, [join(ROOT, "extensions", "rex", file), operation], { timeout, signal, maxBuffer: 32768, killSignal: "SIGKILL", env: adapterEnvironment() }, (error, out) => {
			if (error) { reject(error); return; }
			try { resolve(JSON.parse(out)); } catch (error) { reject(error); }
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(input);
	});
}
type LaunchOrigin = { version: 1; terminal: "Rex"; application: { bundleId: "com.superlogical.rex" }; exact: JsonObject };
export function readLaunchOrigin(value: unknown): LaunchOrigin | null {
	try {
		const origin = object(value);
		if (origin.version !== 1 || origin.terminal !== "Rex" || object(origin.application).bundleId !== "com.superlogical.rex") return null;
		return { version: 1, terminal: "Rex", application: { bundleId: "com.superlogical.rex" }, exact: object(origin.exact) };
	} catch { return null; }
}
const INITIAL_SHARE = 0.2;
const validShare = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0.1 && value <= 0.4;
type LaunchResult = { receipt?: unknown; uncertain?: string };
type ResizeResult = { applied: boolean; message?: string };
const refused = (message: string): ResizeResult => ({ applied: false, message });
export interface ComposerEnvironment {
	agentDir: string;
	launch(file: () => Promise<string>, cwd: string, signal: AbortSignal): Promise<LaunchResult | undefined>;
	resize?(receipt: unknown, share: number, signal: AbortSignal): Promise<ResizeResult>;
	checkApp?(notify: (message: string, error?: boolean) => void, explicit?: boolean): Promise<string | undefined>;
	alive(pid: number): boolean;
	helloMs?: number;
	gapMs?: number;
	auto?(): boolean;
}
/** Pi's working directory as Pi's footer shows it: home-relative with "~" when inside the home directory. */
export function folderLabel(cwd: string, home = homedir()): string {
	const root = home.replace(/\/+$/, "");
	if (!root) return cwd;
	if (cwd === root) return "~";
	return cwd.startsWith(`${root}/`) ? `~${cwd.slice(root.length)}` : cwd;
}

export async function splitComposer(argv: string[], origin: LaunchOrigin, cwd: string, signal: AbortSignal, run = adapter): Promise<LaunchResult> {
	let result: JsonObject;
	try { result = object(await run("terminal-pane.ts", "split", 7000, signal, JSON.stringify({ version: 1, origin, argv, cwd, placement: { side: "below", share: INITIAL_SHARE }, label: "Composer" }))); }
	catch { result = {}; }
	if (result.version === 1) {
		if (result.outcome === "created" && result.receipt) return { receipt: result.receipt };
		if (result.outcome === "unavailable" || result.outcome === "stale") throw new Error(`Composer pane: ${oneLine(new Error(string(result.detail)))}`);
	}
	return { uncertain: "Composer pane creation is unconfirmed. Pi did not retry." };
}
async function resizeComposer(receipt: unknown, share: number, signal: AbortSignal): Promise<ResizeResult> {
	try {
		const result = object(await adapter("terminal-pane.ts", "resize", 7000, signal, JSON.stringify({ version: 1, receipt, share })));
		if (result.version === 1 && result.outcome === "resized") return { applied: true };
		if (result.version === 1 && typeof result.detail === "string") return refused(oneLine(new Error(result.detail)));
	} catch { /* No acknowledgement of the resize. */ }
	return refused("Composer pane resize is unconfirmed. Pi did not retry.");
}
function environment(): ComposerEnvironment {
	const agentDir = getAgentDir();
	const app = new ComposerApp();
	const { app: appPath, mode } = readSettings({ agentDir }).values;
	return {
		agentDir,
		auto: () => process.platform === "darwin" && Boolean(process.env.REX_BLOCK) && mode === "auto",
		alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } },
		resize: resizeComposer,
		async checkApp(notify, explicit) {
			if (process.platform !== "darwin") return "The composer requires macOS.";
			return app.check(appPath, notify, explicit);
		},
		async launch(file, cwd, signal) {
			const origin = await adapter("terminal-origin.ts", "capture", 4000, signal).then(readLaunchOrigin, () => null);
			if (!origin) throw new Error("The composer requires an exact Rex pane origin.");
			const launch = await file();
			const argv = [join(appPath, "Contents", "MacOS", "Composer"), "--composer", launch];
			return splitComposer(argv, origin, cwd, signal);
		},
	};
}

class Connection {
	private readonly bridge: ComposerBridge;
	private readonly lifetime = new AbortController();
	private readonly state: ComposerState;
	private readonly record: RetainedComposer;
	private file?: string;
	private editor?: ComposerEditor;
	private factory?: Factory;
	private previous?: Factory;
	private baseline?: string;
	private generation = -1;
	private helloTimer?: NodeJS.Timeout;
	private gapTimer?: NodeJS.Timeout;
	private pidTimer?: NodeJS.Timeout;
	private attached = false;
	private ended = false;
	private present = false;
	private uncertain?: string;
	private split?: Promise<LaunchResult | undefined>;
	private resizing = false;
	private pendingResize?: { apply(): Promise<ResizeResult>; reply(value: ResizeResult): void };
	private readonly completion = new ComposerCompletion();
	private readonly history: string[] = [];
	private visible = false;
	private displayed = false;
	private restoring = false;

	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly env: ComposerEnvironment;
	private readonly gone: () => void;
	private readonly resumed?: RetainedComposer;
	private readonly publishPresence: (present: boolean) => void;
	constructor(pi: ExtensionAPI, ctx: ExtensionContext, env: ComposerEnvironment, gone: () => void, publishPresence: (present: boolean) => void, resumed?: RetainedComposer) {
		this.pi = pi;
		this.ctx = ctx;
		this.env = env;
		this.gone = gone;
		this.publishPresence = publishPresence;
		this.resumed = resumed;
		this.record = resumed ?? { id: randomUUID(), pid: 0, mirror: "", submissions: new Map() };
		const phase = ctx.isIdle() ? "idle" : "working";
		const model = ctx.model;
		this.state = { version: 1, phase, ...(phase !== "idle" ? { since: Date.now() } : {}), queued: [], ...(model && { model: { provider: model.provider, id: model.id, name: model.name } }), thinking: pi.getThinkingLevel(), thinkingLevels: model ? getSupportedThinkingLevels(model) : [...THINKING], cost: 0, cwd: folderLabel(ctx.cwd), session: { id: ctx.sessionManager.getSessionId(), name: pi.getSessionName() } };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			this.state.cost += assistantCost(entry.message);
			const text = userText(entry.message);
			if (text !== undefined) historyPush(this.history, text);
		}
		this.bridge = new ComposerBridge(this.record.id, PATHS, {
			state: () => this.state,
			hello: (body) => this.hello(body),
			request: (path, body, signal) => this.request(path, body, signal),
			poll: (pending) => this.pollActivity(pending),
		});
		this.refreshContext();
	}
	async start(): Promise<void> {
		if (this.resumed) {
			const editor = this.installEditor();
			if (!editor.getExpandedText()) editor.acceptDraft(this.resumed.mirror);
			this.baseline = this.resumed.mirror;
			await this.prepareFile(true);
		} else {
			this.split = this.env.launch(() => this.prepareFile(false), this.ctx.cwd, this.lifetime.signal);
			const outcome = await this.split;
			this.record.receipt = outcome?.receipt;
			this.uncertain = outcome?.uncertain;
		}
	}
	private async prepareFile(reconnect: boolean): Promise<string> {
		this.lifetime.signal.throwIfAborted();
		const config = await this.bridge.start();
		this.lifetime.signal.throwIfAborted();
		const file = join(this.env.agentDir, "composer-live", `${reconnect ? `composer-${this.record.id}` : randomUUID()}.json`);
		await writeConfig(file, { ...config, share: INITIAL_SHARE });
		this.file = file;
		if (this.ended) { await this.removeFile(); this.lifetime.signal.throwIfAborted(); }
		if (!this.attached) this.helloTimer = setTimeout(() => {
			this.ctx.ui.notify(this.uncertain ?? "The composer did not connect within 10 seconds. Use Pi's editor.", "warning");
			void this.finish(undefined);
		}, this.env.helloMs ?? 10_000);
		return file;
	}
	private async removeFile(): Promise<void> {
		const file = this.file;
		this.file = undefined;
		if (file) await unlink(file).catch(() => {});
	}
	private installEditor(): ComposerEditor {
		if (this.editor && this.ctx.ui.getEditorComponent() === this.factory) return this.editor;
		const previous = this.ctx.ui.getEditorComponent();
		this.previous = previous;
		this.factory = (tui, theme, keys) => {
			const editor = new ComposerEditor(tui, theme, keys, event => this.bridge.emit(event), previous?.(tui, theme, keys), text => {
				if (!this.restoring && historyPush(this.history, text) && this.attached) this.bridge.emit({ type: "history", entries: [...this.history] });
			});
			this.restoring = true;
			try { for (const text of this.history) editor.addToHistory(text); }
			finally { this.restoring = false; }
			this.editor = editor;
			return editor;
		};
		this.ctx.ui.setEditorComponent(this.factory);
		if (!this.editor) throw new Error("Pi did not install the composer editor.");
		return this.editor;
	}
	private hello(body: JsonObject): JsonObject {
		if (this.ended) throw new Error("The composer runtime is closing.");
		const pid = integer(body.pid, 1);
		if ((this.record.pid && pid !== this.record.pid) || !this.env.alive(pid)) throw new Error("The composer process is not available.");
		const text = draft(object(body.draft).text);
		const editor = this.installEditor();
		const current = editor.getExpandedText();
		const fromPi = (!text && Boolean(current)) || (this.baseline !== undefined && current !== this.baseline);
		this.record.pid = pid;
		this.generation = -1;
		editor.acceptDraft(fromPi ? current : text);
		if (!this.attached) this.visible = true;
		this.attached = true;
		this.present = true;
		// /hello itself carries the handoff, so the poll does not need to repeat it.
		this.baseline = this.visible ? undefined : editor.getExpandedText();
		this.updateEditorMode(editor);
		clearTimeout(this.helloTimer);
		this.pollActivity(false);
		this.pidTimer ??= setInterval(() => {
			if (!this.env.alive(pid)) void this.finish(undefined);
		}, 1000);
		return { history: [...this.history], ...(fromPi ? { text: current } : {}) };
	}
	private get forwarding(): boolean { return this.present && this.visible; }
	private updateEditorMode(editor: ComposerEditor): void {
		const current = editor.getExpandedText();
		editor.setVisible(this.forwarding);
		if (this.displayed !== this.forwarding) {
			this.displayed = this.forwarding;
			this.ctx.ui.setWorkingVisible(!this.displayed);
			this.publishPresence(this.displayed);
		}
		if (!this.forwarding) this.baseline ??= current;
		else {
			const baseline = this.baseline;
			this.baseline = undefined;
			if (baseline !== undefined && current !== baseline) editor.reportHandoff(current);
		}
	}
	private pollActivity(pending: boolean): void {
		clearTimeout(this.gapTimer);
		if (this.ended || !this.attached) return;
		if (pending) {
			if (this.present) return;
			const editor = this.editorForRequest();
			this.present = true;
			this.updateEditorMode(editor);
		} else this.gapTimer = setTimeout(() => {
			this.present = false;
			if (this.editor) this.updateEditorMode(this.editor);
		}, this.env.gapMs ?? 3000);
	}
	private editorForRequest(): ComposerEditor {
		if (this.ended || !this.editor || this.ctx.ui.getEditorComponent() !== this.factory) throw new Error("Pi's composer editor is not available.");
		return this.editor;
	}
	private invokeSubmission(behavior: "send" | "followUp", text: string): void {
		const editor = this.editorForRequest();
		const handler = behavior === "send" ? editor.onSubmit : editor.actionHandlers.get("app.message.followUp");
		if (!handler) throw new Error("Pi's submission handler is not available.");
		const previous = editor.getExpandedText();
		const busy = !this.ctx.isIdle() || this.state.phase !== "idle";
		try {
			// Reset the report baseline so Pi can put back the exact submitted text.
			editor.acceptDraft("");
			if (behavior === "followUp") editor.setSubmissionText(text);
			const running = behavior === "send" ? handler(text) : (handler as () => void)();
			void Promise.resolve(running).catch(error => { if (!this.ended) this.bridge.emit({ type: "notice", level: "error", text: oneLine(error) }); });
		} catch (error) { editor.acceptDraft(previous); throw error; }
		if (busy) this.trackSubmission(behavior, text.trim());
	}
	private trackSubmission(behavior: "send" | "followUp", text: string): void {
		const command = /^\/([^\s]+)/u.exec(text)?.[1];
		if (command && this.pi.getCommands().some(entry => entry.name === command)) return;
		if (behavior === "send" && /^!{1,2}\s*\S/u.test(text)) return;
		this.update({ queued: [...this.state.queued, { behavior: behavior === "send" ? "steer" : "followUp", text }] });
	}
	private submit(body: JsonObject): SubmitResult {
		const id = string(body.id).toLowerCase();
		if (!UUID.test(id)) throw new Error("Expected a submission UUID.");
		if (body.behavior !== "send" && body.behavior !== "followUp") throw new Error("Unknown submission behavior.");
		const input = string(body.text);
		const digest = createHash("sha256").update(input).digest("hex");
		const cached = this.record.submissions.get(id);
		if (cached) return cached.digest === digest ? cached.result : { outcome: "refused", message: "That submission ID already names different text." };
		let result: SubmitResult;
		try {
			const text = draft(input);
			if (!text.trim()) throw new Error("The submission is empty.");
			this.invokeSubmission(body.behavior, text);
			result = { outcome: "accepted" };
		} catch (error) { result = { outcome: "refused", message: oneLine(error) }; }
		this.record.submissions.set(id, { digest, result });
		if (this.record.submissions.size > 64) {
			const first = this.record.submissions.keys().next();
			if (!first.done) this.record.submissions.delete(first.value);
		}
		return result;
	}
	private acceptDraft(editor: ComposerEditor, body: JsonObject): JsonObject {
		const generation = integer(body.generation);
		const text = draft(body.text);
		if (generation > this.generation) {
			this.generation = generation;
			if (this.forwarding || editor.getExpandedText() === this.baseline) {
				editor.acceptDraft(text);
				if (!this.forwarding) this.baseline = editor.getExpandedText();
			}
		}
		return {};
	}
	private abort(editor: ComposerEditor): JsonObject {
		const handler = editor.onEscape;
		if (this.state.phase === "idle" && this.ctx.isIdle() || !handler) return { stopped: false };
		handler();
		if (this.state.phase !== "compacting") this.update({ queued: [] });
		return { stopped: true };
	}
	private closeFromClient(editor: ComposerEditor, body: JsonObject): JsonObject {
		const text = draft(object(body.draft).text);
		if (this.forwarding || editor.getExpandedText() === this.baseline) editor.acceptDraft(text);
		void this.finish(undefined, 300);
		return {};
	}
	private setVisibility(editor: ComposerEditor, body: JsonObject): JsonObject {
		const visible = body.visible;
		if (typeof visible !== "boolean") throw new Error("Expected a boolean visibility flag.");
		if (visible !== this.visible) {
			this.visible = visible;
			this.updateEditorMode(editor);
		}
		return {};
	}
	private async setModel(body: JsonObject): Promise<JsonObject> {
		const provider = string(body.provider);
		const id = string(body.id);
		const model = this.ctx.modelRegistry.getAvailable().find(model => model.provider === provider && model.id === id);
		if (!model) return { applied: false, message: "That model is not available." };
		const applied = await this.pi.setModel(model);
		if (!applied) return { applied: false, message: "Pi refused the model selection." };
		this.selectModel(model);
		return { applied };
	}
	private setThinking(body: JsonObject): JsonObject {
		const level = THINKING.find(level => level === body.level);
		if (!level) throw new Error("Unknown thinking level.");
		this.pi.setThinkingLevel(level);
		const effective = this.pi.getThinkingLevel();
		this.update({ thinking: effective });
		return { level: effective };
	}
	private dequeue(editor: ComposerEditor): JsonObject {
		const handler = editor.actionHandlers.get("app.message.dequeue");
		if (!handler) throw new Error("Pi's dequeue handler is not available.");
		const restored = this.state.queued.length;
		handler();
		this.update({ queued: [] });
		return { restored };
	}
	private resize(body: JsonObject, signal: AbortSignal): Promise<ResizeResult> {
		const { share } = body;
		if (!validShare(share) || Object.keys(body).some(key => key !== "share" && key !== "composer")) throw new Error("Resize requires a share from 0.1 to 0.4.");
		if (!this.forwarding) return Promise.resolve(refused("The composer is not visible."));
		return new Promise(reply => {
			this.pendingResize?.reply(refused("A newer composer size replaced this request."));
			this.pendingResize = { reply, apply: async () => {
				// The app can attach while the adapter still verifies the new split.
				await this.split?.catch(() => undefined);
				if (signal.aborted || this.ended || !this.forwarding) return refused("The composer is not visible.");
				const receipt = this.record.receipt;
				if (!receipt || !this.env.resize) return refused("No confirmed composer pane receipt is available.");
				return this.env.resize(receipt, share, signal);
			} };
			if (!this.resizing) void this.drainResize();
		});
	}
	private async drainResize(): Promise<void> {
		this.resizing = true;
		while (this.pendingResize) {
			const request = this.pendingResize;
			this.pendingResize = undefined;
			try { request.reply(await request.apply()); }
			catch { request.reply(refused("Composer pane resize is unconfirmed. Pi did not retry.")); }
		}
		this.resizing = false;
	}
	private async request(path: string, body: JsonObject, signal: AbortSignal): Promise<JsonObject> {
		if (path === "/submit") return this.submit(body);
		if (path === "/resize") return this.resize(body, signal);
		const editor = this.editorForRequest();
		switch (path) {
			case "/draft": return this.acceptDraft(editor, body);
			case "/abort": return this.abort(editor);
			case "/close": return this.closeFromClient(editor, body);
			case "/visibility": return this.setVisibility(editor, body);
			case "/complete": return this.completion.suggest(editor.provider, body, signal);
			case "/applyCompletion": return this.completion.apply(editor.provider, body);
			case "/models": return { models: this.ctx.modelRegistry.getAvailable().map(({ provider, id, name, reasoning }) => ({ provider, id, name, reasoning, current: provider === this.state.model?.provider && id === this.state.model?.id })) };
			case "/setModel": return this.setModel(body);
			case "/setThinking": return this.setThinking(body);
			case "/dequeue": return this.dequeue(editor);
			default: throw new Error("Unknown composer request.");
		}
	}
	update(update: Partial<Omit<ComposerState, "version">>): void {
		if (Object.entries(update).every(([key, value]) => JSON.stringify(value) === JSON.stringify(this.state[key as keyof ComposerState]))) return;
		Object.assign(this.state, update, { version: this.state.version + 1 });
		this.bridge.changed();
	}
	refreshCost(ending?: Message): void {
		// Pi emits message_end before appending that message to the branch.
		const cost = this.ctx.sessionManager.getBranch().reduce((sum, entry) => entry.type === "message" ? sum + assistantCost(entry.message) : sum, 0);
		this.update({ cost: cost + (ending ? assistantCost(ending) : 0) });
	}
	refreshContext(): void {
		const usage = this.ctx.getContextUsage();
		this.update({ context: usage && { percent: usage.percent, tokens: usage.tokens, window: usage.contextWindow } });
	}
	selectModel(model: NonNullable<ExtensionContext["model"]>): void {
		this.update({ model: { provider: model.provider, id: model.id, name: model.name }, thinkingLevels: getSupportedThinkingLevels(model), thinking: this.pi.getThinkingLevel() });
		this.refreshContext();
	}
	userMessage(message: { role: string; content?: unknown }): void {
		const text = userText(message)?.trim();
		const index = this.state.queued.findIndex(entry => entry.text === text);
		if (index !== -1) this.update({ queued: this.state.queued.filter((_entry, i) => i !== index) });
	}
	phase(phase: ComposerState["phase"]): void {
		if (this.state.phase !== phase) this.update({ phase, since: phase === "idle" ? undefined : Date.now(), ...(phase === "idle" ? { queued: [] } : {}) });
	}
	focus(): void { if (this.attached) this.bridge.emit({ type: "focus" }); }
	async finish(reason: DetachReason | "quit" | "command" | undefined, grace = reason ? 300 : 0): Promise<void> {
		if (this.ended) return;
		this.ended = true;
		this.lifetime.abort();
		clearTimeout(this.helloTimer);
		clearTimeout(this.gapTimer);
		clearInterval(this.pidTimer);
		this.present = false;
		if (this.editor) this.updateEditorMode(this.editor);
		const detach = reason && reason !== "quit" && reason !== "command";
		if (detach && this.record.pid && this.editor) {
			this.record.mirror = this.editor.getExpandedText();
			processState[retained] = this.record;
			if (this.attached) this.bridge.emit({ type: "detach", reason });
		} else if (reason && this.attached) this.bridge.emit({ type: "close", reason });
		if (this.factory && this.ctx.ui.getEditorComponent() === this.factory && !detach) this.ctx.ui.setEditorComponent(this.previous);
		this.gone();
		await this.removeFile();
		if (grace && this.attached) await delay(grace);
		this.bridge.close();
	}
}

async function writeConfig(file: string, config: ComposerConfig & { share: number }): Promise<void> {
	const dir = dirname(file);
	await mkdir(dir, { mode: 0o700, recursive: true });
	const stat = await lstat(dir);
	if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new Error("The composer launch directory is not private.");
	const temporary = join(dir, `.${randomUUID()}.json`);
	await writeFile(temporary, JSON.stringify(config), { flag: "wx", mode: 0o600 });
	try { await link(temporary, file); }
	finally { await unlink(temporary); }
}

export function registerComposer(pi: ExtensionAPI, env = environment()): void {
	let connection: Connection | undefined;
	let stopping = false;
	let present = false;
	const reportPresence = () => { pi.events.emit(PRESENCE_EVENT, { version: 1, present }); };
	const stopPresence = pi.events.on(PRESENCE_REQUEST, (payload: unknown) => {
		if (payload && typeof payload === "object" && !Array.isArray(payload) && "version" in payload && payload.version === 1) reportPresence();
	});
	const notifyFor = (ctx: ExtensionContext) => (message: string, error?: boolean) => {
		if (!stopping) ctx.ui.notify(message, error ? "error" : "info");
	};
	const ready = async (ctx: ExtensionContext, automatic: boolean) => {
		const refusal = await env.checkApp?.(notifyFor(ctx));
		if (refusal && !automatic) throw new Error(refusal);
		return !refusal;
	};
	const open = async (ctx: ExtensionContext, resumed?: RetainedComposer, automatic = false): Promise<void> => {
		if (stopping) return;
		if (connection) { connection.focus(); return; }
		const current = new Connection(pi, ctx, env, () => { if (connection === current) connection = undefined; }, (next) => {
			present = next;
			reportPresence();
		}, resumed);
		connection = current;
		try {
			if (!resumed && !await ready(ctx, automatic)) await current.finish(undefined);
			else if (connection === current) await current.start();
		}
		catch (error) {
			const report = connection === current;
			await current.finish(undefined);
			if (report) ctx.ui.notify(oneLine(error), "warning");
		}
	};
	pi.registerCommand("composer", {
		description: "Open, close, or update the native composer",
		getArgumentCompletions: (prefix) => ["close", "update"].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) { ctx.ui.notify("The composer requires an interactive Pi TUI in a Rex pane.", "warning"); return; }
			switch (args.trim()) {
				case "": await open(ctx); break;
				case "close": if (connection) await connection.finish("command"); break;
				case "update": {
					try {
						const announce = notifyFor(ctx);
						let announced = false;
						const refusal = await env.checkApp?.((message, error) => { announced = true; announce(message, error); }, true);
						if (refusal && !announced) ctx.ui.notify(refusal, "warning");
					} catch (error) { ctx.ui.notify(oneLine(error), "warning"); }
					break;
				}
				default: ctx.ui.notify("Use /composer, /composer close, or /composer update.", "warning");
			}
		},
	});
	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (event.reason === "startup") {
			if (env.auto?.()) void open(ctx, undefined, true);
			else if (process.platform === "darwin") void env.checkApp?.(notifyFor(ctx)).catch(error => notifyFor(ctx)(oneLine(error), true));
			return;
		}
		const record = processState[retained];
		delete processState[retained];
		if (record && env.alive(record.pid)) await open(ctx, record);
	});
	pi.on("session_shutdown", async (event) => { stopping = true; stopPresence(); await connection?.finish(event.reason); });
	pi.on("agent_start", () => connection?.phase("working"));
	pi.on("agent_settled", () => connection?.phase("idle"));
	pi.on("session_before_compact", () => connection?.phase("compacting"));
	pi.on("session_compact", ({ reason }) => { connection?.phase(reason === "manual" ? "idle" : "working"); connection?.refreshContext(); });
	pi.on("session_compact_failed", (_event, ctx) => connection?.phase(ctx.isIdle() ? "idle" : "working"));
	pi.on("model_select", ({ model }) => connection?.selectModel(model));
	pi.on("thinking_level_select", ({ level }) => connection?.update({ thinking: level }));
	pi.on("message_start", ({ message }) => connection?.userMessage(message));
	pi.on("message_end", ({ message }) => {
		if (message.role === "assistant") connection?.refreshCost(message);
		connection?.refreshContext();
	});
	pi.on("session_tree", () => connection?.refreshCost());
	pi.on("turn_end", () => connection?.refreshContext());
	pi.on("session_info_changed", ({ name }, ctx) => connection?.update({ session: { id: ctx.sessionManager.getSessionId(), name } }));
	pi.on("ui_prompt_start", ({ kind, title }) => connection?.update({ waiting: { kind, title } }));
	pi.on("ui_prompt_end", () => connection?.update({ waiting: undefined }));
}
