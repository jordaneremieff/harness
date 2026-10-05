import { execFile } from "node:child_process";

export type AgentBranchReader = (cwd: string, signal: AbortSignal) => Promise<string | undefined>;
export const readAgentBranch: AgentBranchReader = (cwd, signal) => new Promise((resolve) => {
	const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
	env.LC_ALL = "C";
	env.GIT_OPTIONAL_LOCKS = "0";
	if (signal.aborted) { resolve(undefined); return; }
	const child = execFile("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd, env, timeout: 1000, maxBuffer: 4096, encoding: "utf8" }, (error, stdout) => {
		signal.removeEventListener("abort", stop);
		resolve(error || signal.aborted ? undefined : stdout.trim() || undefined);
	});
	// A failed spawn has no PID; do not signal an unstarted process handle.
	const stop = () => { if (child.pid) child.kill("SIGTERM"); };
	signal.addEventListener("abort", stop, { once: true });
});
interface BranchEntry {
	event: string;
	value?: string;
	pending?: AbortController;
}
/** Overlay-owned cache; only selection, cwd and committed-entry events request a refresh. */
export class AgentBranchCache {
	private readonly entries = new Map<string, BranchEntry>();
	private closed = false;
	private readonly read?: AgentBranchReader;
	private readonly redraw: () => void;
	constructor(read: AgentBranchReader | undefined, redraw: () => void) { this.read = read; this.redraw = redraw; }
	get(cwd: string): string | undefined { return this.entries.get(cwd)?.value; }
	refresh(cwd: string, event: string): void {
		if (this.closed || !this.read || !cwd) return;
		let entry = this.entries.get(cwd);
		if (entry?.event === event) return;
		if (!entry) {
			if (this.entries.size >= 32) {
				const oldest = this.entries.keys().next().value as string;
				this.entries.get(oldest)?.pending?.abort();
				this.entries.delete(oldest);
			}
			entry = { event };
			this.entries.set(cwd, entry);
		} else entry.event = event;
		if (!entry.pending) this.load(cwd, entry);
	}
	private load(cwd: string, entry: BranchEntry): void {
		const event = entry.event;
		const controller = new AbortController();
		entry.pending = controller;
		void this.read?.(cwd, controller.signal).catch(() => undefined).then((branch) => {
			if (this.closed || controller.signal.aborted || this.entries.get(cwd) !== entry) return;
			entry.pending = undefined;
			entry.value = branch;
			this.redraw();
			if (entry.event !== event) this.load(cwd, entry);
		});
	}
	dispose(): void {
		this.closed = true;
		for (const entry of this.entries.values()) entry.pending?.abort();
		this.entries.clear();
	}
}
