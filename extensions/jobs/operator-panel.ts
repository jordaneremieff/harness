import type { JsonValue } from "@earendil-works/chord/json";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	SelectList,
	truncateToWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	panelText,
	readPanelSnapshot,
	type PanelJob,
	type PanelRequest,
	type PanelSnapshot,
} from "./panel-protocol.ts";

type ViewTheme = Pick<Theme, "bold" | "fg">;

interface ViewHost {
	readonly theme: ViewTheme;
	readonly signal: AbortSignal;
	requestRender(): void;
	push(open: (host: ViewHost) => View): void;
}

interface PanelHost extends ViewHost {
	request(data: JsonValue, signal?: AbortSignal): Promise<{ text: string; data?: JsonValue }>;
}

type Action = {
	id: string;
	label: string;
	key: string;
	primary: boolean;
	disabled?: string;
	run(): void;
};

type View = {
	title: string;
	render(width: number, height: number): string[];
	handleInput(data: string): boolean;
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	actions?(): readonly Action[];
	keys?(): readonly { keys: readonly string[]; label: string; priority?: number }[];
	dispose?(): void;
};

function resizeRows(lines: string[], width: number, height: number): string[] {
	return Array.from({ length: height }, (_, i) => truncateToWidth(lines[i] ?? "", width));
}

function localTime(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function duration(job: PanelJob, observedAt: number): string | undefined {
	if (job.startedAt === undefined || (job.endedAt === undefined && job.state !== "Running" && job.state !== "Stopping"))
		return undefined;
	const seconds = Math.max(0, Math.floor(((job.endedAt ?? observedAt) - job.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

function detailLines(job: PanelJob, observedAt: number, theme: ViewTheme, width: number): string[] {
	const elapsed = duration(job, observedAt);
	const facts = [job.state, ...(elapsed ? [elapsed] : [])];
	if (job.exitCode !== undefined) facts.push(job.exitCode === null ? "no exit code" : `exit ${job.exitCode}`);
	if (job.timeoutSeconds !== undefined) facts.push(`limit ${job.timeoutSeconds}s`);
	return [
		...wrapTextWithAnsi(theme.bold(`#${job.id} · ${facts.join(" · ")}`), width),
		...(job.error ? wrapTextWithAnsi(theme.fg("error", job.error), width) : []),
		...(job.startedAt === undefined ? [] : [`Started ${new Date(job.startedAt).toLocaleString()}`]),
		...(job.endedAt === undefined ? [] : [`Ended ${new Date(job.endedAt).toLocaleString()}`]),
		"",
		...wrapTextWithAnsi(job.command || theme.fg("muted", "Command unavailable"), width),
		...(job.cwd ? ["", ...wrapTextWithAnsi(theme.fg("muted", job.cwd), width)] : []),
	];
}

function jobDetail(host: ViewHost, read: () => { job: PanelJob; observedAt: number } | undefined): View {
	let offset = 0;
	let maxOffset = 0;
	let pageHeight = 1;
	function move(by: number): void {
		offset = Math.max(0, Math.min(maxOffset, offset + by));
		host.requestRender();
	}
	return {
		title: "Job detail",
		keys: () => (maxOffset > 0 ? [{ keys: ["pageUp", "pageDown"], label: "read" }] : []),
		render(width, height) {
			if (width < 1 || height < 1) return resizeRows([], width, height);
			const current = read();
			const lines = current
				? detailLines(current.job, current.observedAt, host.theme, width)
				: ["This job is no longer on the page."];
			pageHeight = height;
			maxOffset = Math.max(0, lines.length - height);
			offset = Math.min(offset, maxOffset);
			return resizeRows(lines.slice(offset), width, height);
		},
		handleInput(data) {
			if (matchesKey(data, "pageUp")) move(-pageHeight);
			else if (matchesKey(data, "pageDown")) move(pageHeight);
			else return false;
			return true;
		},
	};
}

function pageNotice(snapshot: PanelSnapshot | undefined, older: boolean): string {
	if (!snapshot?.jobs.length)
		return older ? "No more finished jobs. Refresh to return to the latest jobs." : "No managed jobs for this agent.";
	const page = older ? "Older finished jobs" : "Latest jobs";
	return `${page}${snapshot.openIncomplete ? " · Open jobs incomplete" : ""} · ${localTime(snapshot.observedAt)}${snapshot.next ? " · More finished jobs" : ""}`;
}

function selectionOffset(data: string, pageHeight: number): number {
	if (matchesKey(data, "up")) return -1;
	if (matchesKey(data, "down")) return 1;
	if (matchesKey(data, "pageUp")) return -pageHeight;
	if (matchesKey(data, "pageDown")) return pageHeight;
	return 0;
}

function jobsView(host: PanelHost): View {
	let snapshot: PanelSnapshot | undefined;
	let selected: number | undefined;
	let older = false;
	let pending = false;
	let error: string | undefined;
	let disposed = false;
	let list: SelectList | undefined;
	let layout: { width: number; height: number; listWidth: number; listRows: number } | undefined;
	let listPage: PanelSnapshot | undefined;
	let listHeight = 0;
	const inactive = () => disposed || host.signal.aborted;

	function accept(data: JsonValue | undefined, isOlder: boolean): void {
		const next = readPanelSnapshot(data, isOlder);
		if (isOlder || !next.jobs.some(({ id }) => id === selected)) selected = next.jobs[0]?.id;
		snapshot = next;
		older = isOlder;
	}

	function fail(cause: unknown): void {
		if (!inactive()) error = panelText(cause instanceof Error ? cause.message : "The job host did not answer.", 200);
	}

	async function load(request: PanelRequest = { op: "list" }): Promise<void> {
		if (pending || inactive()) return;
		pending = true;
		error = undefined;
		try {
			const answer = await host.request(request, host.signal);
			if (!inactive()) accept(answer.data, request.cursor !== undefined);
		} catch (cause) {
			fail(cause);
		} finally {
			if (!inactive()) {
				pending = false;
				host.requestRender();
			}
		}
	}

	function openDetail(): void {
		const id = selected;
		if (id === undefined) return;
		host.push((detailHost) =>
			jobDetail(detailHost, () => {
				const job = snapshot?.jobs.find((entry) => entry.id === id);
				return job && snapshot ? { job, observedAt: snapshot.observedAt } : undefined;
			}),
		);
	}

	function notice(): string {
		if (error !== undefined)
			return `${snapshot ? `Stale snapshot from ${localTime(snapshot.observedAt)}` : "Jobs unavailable"} · ${error}`;
		if (pending) return snapshot ? "Reading jobs… · Previous snapshot below" : "Reading jobs…";
		return pageNotice(snapshot, older);
	}

	function renderList(page: PanelSnapshot, width: number, height: number): string[] {
		const items = page.jobs;
		const visible = items.length > height && height > 1 ? height - 1 : height;
		if (!list || listPage !== page || listHeight !== visible) {
			list = new SelectList(
				items.map((job) => {
					const elapsed = duration(job, page.observedAt);
					return {
						value: String(job.id),
						label: `${job.state}${elapsed ? ` ${elapsed}` : ""} · ${job.command || "Command unavailable"}`,
					};
				}),
				visible,
				{
					selectedPrefix: (text) => host.theme.fg("accent", text),
					selectedText: (text) => host.theme.bold(text),
					description: (text) => host.theme.fg("muted", text),
					scrollInfo: (text) => host.theme.fg("muted", text),
					noMatch: (text) => host.theme.fg("muted", text),
				},
			);
			list.setSelectedIndex(items.findIndex(({ id }) => id === selected));
			list.onSelectionChange = (item) => {
				selected = Number(item.value);
				host.requestRender();
			};
			listPage = page;
			listHeight = visible;
		}
		return list.render(width).slice(0, height);
	}

	void load();
	return {
		title: "Jobs",
		actions: () => [
			{
				id: "refresh",
				label: older ? "Latest jobs" : "Refresh",
				key: "r",
				primary: true,
				...(pending ? { disabled: "A Jobs read is in progress." } : {}),
				run: () => void load(),
			},
			...(snapshot?.next === undefined
				? []
				: [
						{
							id: "older",
							label: "Older jobs",
							key: "]",
							primary: true,
							...(pending
								? { disabled: "A Jobs read is in progress." }
								: error !== undefined
									? { disabled: "Refresh the stale snapshot first." }
									: {}),
							run: () => {
								if (error === undefined && snapshot?.next !== undefined)
									void load({ op: "list", cursor: snapshot.next });
							},
						},
					]),
		],
		keys: () => {
			const count = snapshot?.jobs.length ?? 0;
			return [
				...(count > 1
					? [
							{ keys: ["up", "down"], label: "select", priority: 0 },
							{ keys: ["pageUp", "pageDown"], label: "page" },
						]
					: []),
				...(count > 0 ? [{ keys: ["enter"], label: "details" }] : []),
			];
		},
		render(width, height) {
			layout = undefined;
			if (width < 1 || height < 1) return resizeRows([], width, height);
			const top = host.theme.fg(error !== undefined ? "warning" : "muted", notice());
			if (!snapshot?.jobs.length || height < 2) return resizeRows([top], width, height);
			const split = width >= 90;
			const listWidth = split ? Math.floor(width * 0.48) : width;
			const rows = renderList(snapshot, listWidth, height - 1);
			layout = { width, height, listWidth, listRows: rows.length };
			if (!split) return resizeRows([top, ...rows], width, height);
			const detailWidth = width - listWidth - 3;
			const job = snapshot.jobs.find(({ id }) => id === selected);
			const details = job ? detailLines(job, snapshot.observedAt, host.theme, detailWidth) : [];
			const side = resizeRows(rows, listWidth, height - 1);
			return resizeRows(
				[
					top,
					...side.map(
						(row, index) =>
							`${row}${" ".repeat(listWidth - visibleWidth(row))}${host.theme.fg("borderMuted", " │ ")}${details[index] ?? ""}`,
					),
				],
				width,
				height,
			);
		},
		handleInput(data) {
			if (!list || !snapshot || listPage !== snapshot) return false;
			if (matchesKey(data, "enter") || matchesKey(data, "right")) {
				openDetail();
				return true;
			}
			const offset = selectionOffset(data, listHeight);
			if (!offset) return false;
			const index = snapshot.jobs.findIndex(({ id }) => id === selected);
			const next = Math.max(0, Math.min(snapshot.jobs.length - 1, index + offset));
			selected = snapshot.jobs[next]?.id;
			list.setSelectedIndex(next);
			host.requestRender();
			return true;
		},
		handleMouse(event) {
			if (
				!list ||
				listPage !== snapshot ||
				!layout ||
				event.shift ||
				event.alt ||
				event.ctrl ||
				event.width !== layout.width ||
				event.height !== layout.height ||
				event.y < 1 ||
				event.y > layout.listRows ||
				event.x >= layout.listWidth
			)
				return undefined;
			if (event.type !== "click" && event.type !== "wheel") return undefined;
			return list.handleMouse({ ...event, y: event.y - 1, width: layout.listWidth, height: layout.listRows });
		},
		dispose() {
			disposed = true;
		},
	};
}

export function operatorPanel() {
	return { version: 2 as const, title: "Jobs", open: jobsView };
}
