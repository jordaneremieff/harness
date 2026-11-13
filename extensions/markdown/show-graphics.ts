import { ProcessTerminal, TuiAltScreen, truncateToWidth, type TerminalColors } from "@earendil-works/pi-tui";
import { FrameClient, type Frame, type Viewport } from "./frame-client.ts";
import { documentHeading, keyAction, SHOW_KEYS, watchDocument } from "./show-screen.ts";
import { openStored } from "./reveal.ts";
import type { MarkdownStore, StoredDocument } from "./store.ts";

const IMAGE_ID = 2147483000;
const QUERY_ID = IMAGE_ID + 1;
export const kitty = (control: string, payload = "") => `\x1b_G${control}${payload ? `;${payload}` : ""}\x1b\\`;
export const deleteFrame = () => kitty(`a=d,d=I,i=${IMAGE_ID},q=2`);
export interface Cell { width: number; height: number }
export function cellReply(data: string): Cell | undefined {
	const match = /^\x1b\[6;(\d+);(\d+)t$/u.exec(data);
	if (!match) return undefined;
	const width = Number(match[2]); const height = Number(match[1]);
	return width > 0 && height > 0 && width <= 512 && height <= 512 ? { width, height } : undefined;
}
export function graphicsReply(data: string): { id: number; message: string } | undefined {
	const match = /^\x1b_Gi=(\d+)(?:,[^;]*)?;([^\x1b]*)\x1b\\$/u.exec(data);
	return match ? { id: Number(match[1]), message: match[2] ?? "" } : undefined;
}
export function graphicsFallback(supported: boolean, cell?: Cell): string | undefined {
	return !supported ? "Text view: terminal graphics are unavailable." : !cell ? "Text view: terminal pixel size is unavailable." : undefined;
}
export function frameFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("Terminal")) return "Text view: terminal graphics failed.";
	if (message.includes("timed out")) return "Text view: the frame service timed out.";
	return "Text view: the frame service failed.";
}
export function frameSequence(frame: Frame, columns: number, rows: number): string {
	return deleteFrame() + kitty(`a=t,f=32,s=${frame.width},v=${frame.height},t=t,i=${IMAGE_ID},q=0`, Buffer.from(frame.path).toString("base64"))
		+ "\x1b[3;1H" + kitty(`a=p,i=${IMAGE_ID},p=1,c=${columns},r=${rows},C=1,q=0`);
}

/** Queries use the same terminal parser and colour query as the text view. */
export async function probeGraphics(): Promise<{ cell?: Cell; colors: TerminalColors; reason?: string; closed: boolean }> {
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	let cell: Cell | undefined; let supported = false; let closed = false;
	let finish!: () => void;
	const replies = new Promise<void>((resolve) => { finish = resolve; });
	const remove = tui.addInputListener((data) => {
		cell = cellReply(data) ?? cell;
		const reply = graphicsReply(data);
		if (reply?.id === QUERY_ID) supported = reply.message === "OK";
		if (keyAction(data) === "close") { closed = true; finish(); }
		if (supported && cell) finish();
		return { consume: true };
	});
	const timer = setTimeout(() => finish(), 700);
	try {
		tui.start();
		const colors = tui.queryTerminalColors({ timeoutMs: 500 });
		terminal.write(`${kitty(`a=q,f=32,s=1,v=1,t=d,i=${QUERY_ID}`, "AAAAAA==")}\x1b[16t`);
		await replies;
		return { ...(cell ? { cell } : {}), colors: await colors, reason: graphicsFallback(supported, cell), closed };
	} finally { clearTimeout(timer); remove(); tui.stop(); }
}

/** Only the latest requested position renders after an in-flight frame completes. */
export async function runGraphics(root: string, store: MarkdownStore, initial: StoredDocument, app: string, initialCell: Cell, colors: TerminalColors): Promise<string | undefined> {
	const terminal = new ProcessTerminal();
	if (terminal.rows < 4) return "Text view: the terminal is too small.";
	const service = new FrameClient(app);
	const closing = new AbortController();
	let cell = initialCell; let stored = initial; let shown: Frame | undefined;
	let target = 0; let positionPending = false; let resizePending = false; let revisionPending = false;
	let running = true; let status = ""; let failure: string | undefined;
	let cellTimer: ReturnType<typeof setTimeout> | undefined;
	let ack: { remaining: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
	const close = () => {
		closing.abort();
		if (ack) { clearTimeout(ack.timer); ack.reject(new Error("Closed")); ack = undefined; }
		void service.close().catch(() => {});
	};
	const closed = new Promise<void>((resolve) => closing.signal.addEventListener("abort", () => resolve(), { once: true }));
	const background = colors.background;
	const appearance = background && background.r * 0.2126 + background.g * 0.7152 + background.b * 0.0722 > 128 ? "light" : "dark";
	const backgroundHex = background ? `#${[background.r, background.g, background.b].map((n) => n.toString(16).padStart(2, "0")).join("")}` : undefined;
	let scale = 1;
	const viewport = (): Viewport => ({ width: terminal.columns * cell.width, height: Math.max(1, terminal.rows - 3) * cell.height, scale, appearance, textSize: 4, ...(backgroundHex ? { background: backgroundHex } : {}) });
	const chrome = () => {
		const heading = documentHeading(stored);
		const percentage = shown ? `${Math.round(100 * shown.scrollY / Math.max(1, shown.documentHeight - shown.height))}%` : "";
		return `\x1b[H\x1b[2K\x1b[1m${truncateToWidth(heading.title, terminal.columns)}\x1b[22m\r\n\x1b[2K\x1b[2m${truncateToWidth(`${heading.detail} · ${percentage}`, terminal.columns)}\x1b[22m`
			+ `\x1b[${terminal.rows};1H\x1b[2K\x1b[2m${truncateToWidth(status || SHOW_KEYS, terminal.columns)}\x1b[22m`;
	};
	const draw = async (frame: Frame) => {
		if (closing.signal.aborted) return;
		shown = frame;
		const accepted = new Promise<void>((resolve, reject) => {
			ack = { remaining: 2, resolve, reject, timer: setTimeout(() => { ack = undefined; reject(new Error("Terminal graphics timed out")); }, 1000) };
		});
		terminal.write(`\x1b[?2026h${chrome()}${frameSequence(frame, terminal.columns, Math.max(1, terminal.rows - 3))}\x1b[?2026l`);
		await accepted;
	};
	const fail = (error: unknown) => { if (!closing.signal.aborted) { failure = frameFailure(error); close(); } };
	const nextFrame = async (): Promise<Frame | undefined> => {
		if (revisionPending) {
			revisionPending = false;
			const next = await store.get(stored.document.id);
			if (next.revision.digest === stored.revision.digest && next.revision.revision === stored.revision.revision) return;
			const frame = await service.request({ op: "revision", revision: next.revision.revision, digest: next.revision.digest });
			stored = next;
			return frame;
		}
		if (resizePending) { resizePending = false; return service.request({ op: "viewport", ...viewport() }); }
		positionPending = false;
		return service.request({ op: "scroll", to: target });
	};
	const hasWork = () => resizePending || revisionPending || positionPending;
	const pump = async () => {
		if (running || closing.signal.aborted) return;
		running = true;
		try {
			while (!closing.signal.aborted && hasWork()) {
				const frame = await nextFrame();
				if (!frame) continue;
				if (!positionPending) target = frame.scrollY;
				await draw(frame);
			}
		} catch (error) { fail(error); } finally { running = false; }
	};
	const move = (next: number) => { target = Math.max(0, Math.min(next, Math.max(0, (shown?.documentHeight ?? 0) - viewport().height))); positionPending = true; void pump(); };
	const accept = (reply: { id: number; message: string }) => {
		if (reply.id !== IMAGE_ID || !ack) return;
		if (reply.message !== "OK") { const current = ack; clearTimeout(current.timer); ack = undefined; current.reject(new Error("Terminal refused frame")); }
		else if (--ack.remaining === 0) { const current = ack; clearTimeout(current.timer); ack = undefined; current.resolve(); }
	};
	const open = () => {
		void openStored(root, stored.document.id, closing.signal, { gui: true, pin: { revision: stored.revision.revision, digest: stored.revision.digest } })
			.then((message) => { status = message; if (!closing.signal.aborted) terminal.write(chrome()); })
			.catch(() => { status = "The native reader did not open."; if (!closing.signal.aborted) terminal.write(chrome()); });
	};
	const page = () => Math.max(cell.height, viewport().height - 2 * cell.height);
	const actions = {
		close, down: () => move(target + cell.height), up: () => move(target - cell.height),
		"page-down": () => move(target + page()), "page-up": () => move(target - page()),
		start: () => move(0), end: () => move(shown?.documentHeight ?? 0),
		reload: () => { revisionPending = true; void pump(); }, open,
	};
	const input = (data: string) => {
		const reply = graphicsReply(data);
		if (reply) { accept(reply); return; }
		const size = cellReply(data);
		if (size) { cell = size; clearTimeout(cellTimer); cellTimer = undefined; resizePending = true; void pump(); return; }
		const wheel = /^\x1b\[<(64|65);\d+;\d+M$/u.exec(data);
		if (wheel) { move(target + (wheel[1] === "64" ? -3 : 3) * cell.height); return; }
		const action = keyAction(data);
		if (action) actions[action]();
	};
	const resize = () => {
		if (terminal.rows < 4) { failure = "Text view: the terminal is too small."; close(); return; }
		terminal.write(`${deleteFrame()}\x1b[2J\x1b[16t`);
		clearTimeout(cellTimer);
		cellTimer = setTimeout(() => { failure = "Text view: terminal pixel size is unavailable."; close(); }, 700);
	};
	let started = false;
	const watcher = watchDocument(root, stored, () => { revisionPending = true; void pump(); });
	process.once("SIGTERM", close); process.once("SIGHUP", close);
	try {
		terminal.start(input, resize); started = true;
		terminal.write("\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[2J");
		terminal.setTitle(`${documentHeading(stored).title} · Markdown`);
		if (!watcher) status = "Press r to load new revisions.";
		const ready = await service.ready;
		scale = ready.scale;
		// Small unattached terminals report unscaled cells; retain normal point-sized text there.
		if (cell.height < 24) scale = 1;
		running = true;
		const first = await service.request({ op: "open", root, document: stored.document.id, revision: stored.revision.revision, digest: stored.revision.digest, ...viewport() });
		await draw(first); running = false;
		void pump();
		await closed;
	} catch (error) { fail(error); } finally {
		close(); clearTimeout(cellTimer); watcher?.close();
		process.off("SIGTERM", close); process.off("SIGHUP", close);
		await service.close();
		if (started) {
			terminal.write(`${deleteFrame()}\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[?25h\x1b[?1049l`);
			terminal.stop();
		}
	}
	return failure;
}
