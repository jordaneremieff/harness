import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, basename } from "node:path";

/** The open-request contract and the `--frames` protocol version that this client requires in build.json. */
export const FRAME_BUILD = { contract: 1, frames: 1 } as const;
export interface Frame {
	id: number; ok: true; path: string; width: number; height: number; scrollY: number; documentHeight: number;
	scale: number; revision: number; digest: string; milliseconds: number;
}
export interface FrameReady { event: "ready"; scale: number; directory: string; pid: number; activationPolicy: string; visibleWindows: number }
export interface Viewport { width: number; height: number; scale: number; appearance: "dark" | "light"; textSize: number; background?: string }
export type FrameCommand = ({ op: "open"; root: string; document: string; revision: number; digest: string } & Viewport)
	| ({ op: "viewport" } & Viewport) | { op: "revision"; revision: number; digest: string }
	| { op: "scroll"; to?: number; by?: number; edge?: "start" | "end" } | { op: "frame" };

export async function frameAppStatus(app: string, platform = process.platform): Promise<string | undefined> {
	if (platform !== "darwin") return "Text view: the reader requires macOS.";
	try {
		const path = join(app, "Contents/Resources/build.json");
		const info = await lstat(path);
		if (!info.isFile() || info.size > 16384) return "Text view: the reader build is incompatible.";
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!value || typeof value !== "object" || !("contract" in value) || value.contract !== FRAME_BUILD.contract)
			return "Text view: the reader build is incompatible.";
		if (!("frames" in value) || value.frames !== FRAME_BUILD.frames)
			return "Text view: this reader build cannot render pages.";
		if (!(await lstat(join(app, "Contents/MacOS/MarkdownReader"))).isFile()) return "Text view: the reader is unavailable.";
		return undefined;
	} catch { return "Text view: the reader is unavailable."; }
}

export function validFrame(value: unknown, id: number, directory: string): value is Frame {
	if (!value || typeof value !== "object") return false;
	const frame = value as Frame;
	return frame.id === id && frame.ok === true && typeof frame.path === "string" && isAbsolute(frame.path)
		&& dirname(frame.path) === directory && basename(frame.path).includes("tty-graphics-protocol")
		&& Number.isInteger(frame.width) && frame.width > 0 && frame.width <= 8192
		&& Number.isInteger(frame.height) && frame.height > 0 && frame.height <= 8192 && frame.width * frame.height <= 16777216
		&& Number.isFinite(frame.scrollY) && frame.scrollY >= 0 && Number.isFinite(frame.documentHeight) && frame.documentHeight >= 0
		&& Number.isFinite(frame.scale) && frame.scale >= 1 && frame.scale <= 4
		&& Number.isSafeInteger(frame.revision) && frame.revision > 0 && /^sha256:[a-f0-9]{64}$/u.test(frame.digest)
		&& Number.isFinite(frame.milliseconds) && frame.milliseconds >= 0;
}

/** One serial pipe protocol. The next request releases the previous frame file. */
export class FrameClient {
	readonly ready: Promise<FrameReady>;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly exited: Promise<void>;
	private directory?: string;
	private sequence = 0;
	private buffer = "";
	private stopped = false;
	private closePromise?: Promise<void>;
	private failed?: Error;
	private waiting?: { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
	constructor(app: string, child = spawn(join(app, "Contents/MacOS/MarkdownReader"), ["--frames"], { stdio: ["pipe", "pipe", "pipe"] })) {
		this.child = child;
		this.exited = new Promise((resolve) => child.once("close", () => { this.fail(new Error("The frame service closed.")); resolve(); }));
		this.ready = this.receive().then((value) => {
			const ready = value as FrameReady;
			if (ready?.event !== "ready" || !Number.isFinite(ready.scale) || ready.scale < 1 || ready.scale > 4
				|| typeof ready.directory !== "string" || !isAbsolute(ready.directory) || !basename(ready.directory).startsWith("markdown-frames-")
				|| !["prohibited", "accessory"].includes(ready.activationPolicy) || ready.visibleWindows !== 0)
				throw new Error("The frame service greeting is invalid.");
			this.directory = ready.directory;
			return ready;
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.read(chunk));
		child.stderr.resume();
		child.stdin.on("error", (error) => this.fail(error));
		child.on("error", (error) => this.fail(error));
	}
	private fail(error: Error): void {
		this.failed = error;
		this.buffer = "";
		if (this.waiting) { clearTimeout(this.waiting.timer); this.waiting.reject(error); this.waiting = undefined; }
	}
	private receive(): Promise<unknown> {
		if (this.failed) return Promise.reject(this.failed);
		if (this.waiting) return Promise.reject(new Error("A frame request is already active."));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => this.fail(new Error("The frame service timed out.")), 10000);
			this.waiting = { resolve, reject, timer };
		});
	}
	private read(chunk: string): void {
		if (this.failed) return;
		this.buffer += chunk;
		if (Buffer.byteLength(this.buffer) > 16384) { this.fail(new Error("The frame service reply exceeds its limit.")); return; }
		const end = this.buffer.indexOf("\n");
		if (end < 0) return;
		const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
		const pending = this.waiting;
		if (!pending || this.buffer.length > 0) { this.fail(new Error("The frame service sent an unexpected reply.")); return; }
		clearTimeout(pending.timer); this.waiting = undefined;
		try { pending.resolve(JSON.parse(line)); } catch { pending.reject(new Error("The frame service reply is invalid.")); }
	}
	async request(command: FrameCommand): Promise<Frame> {
		await this.ready;
		if (this.stopped) throw new Error("The frame service is closed.");
		const id = ++this.sequence;
		const response = this.receive();
		this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		const value = await response;
		if (!validFrame(value, id, this.directory ?? "")) throw new Error("The frame service could not render the document.");
		const info = await lstat(value.path);
		if (!info.isFile() || info.size !== value.width * value.height * 4) throw new Error("The frame file is invalid.");
		return value;
	}
	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.stopped = true;
		this.fail(new Error("The frame service is closed."));
		this.child.stdin.end();
		this.closePromise = this.finishClose();
		return this.closePromise;
	}
	private async finishClose(): Promise<void> {
		const timer = setTimeout(() => this.child.kill("SIGKILL"), 1500);
		await this.exited;
		clearTimeout(timer);
		if (this.directory) await rm(this.directory, { recursive: true, force: true });
	}
}
