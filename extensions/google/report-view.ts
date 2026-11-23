import { StringDecoder } from "node:string_decoder";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type CommandDeps, type EmissionKind, runGoogleCommand } from "./command.ts";
import type { Environment } from "./settings.ts";

const REPORT_UNITS = 16_384;
const REPORT_ROWS = 12;
const LIMIT = "Report text truncated at the display limit.";

type ReportUI = Pick<ExtensionUIContext, "custom" | "notify">;

function plain(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n?/g, "\n")
		.replaceAll("\t", "    ")
		.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, "");
}

function openReport(ui: ReportUI, title: string, content: () => string, tone: "accent" | "warning" | "error") {
	let close: (() => void) | undefined;
	let refresh: (() => void) | undefined;
	let closed = false;
	const done = ui
		.custom<void>((tui, theme: Theme, _keys, finish) => {
			let offset = 0;
			let pageRows = 1;
			close = () => {
				closed = true;
				refresh = undefined;
				finish(undefined);
			};
			refresh = () => tui.requestRender();
			if (closed) close();
			return {
				capturesViewportInput: true,
				invalidate() {},
				dispose() {
					closed = true;
					close = undefined;
					refresh = undefined;
				},
				render(width) {
					if (width < 1) return [];
					pageRows = Math.min(REPORT_ROWS, Math.max(1, tui.terminal.rows - 7));
					const text = plain(content());
					const body = text.length > REPORT_UNITS ? `${text.slice(0, REPORT_UNITS)}\n${LIMIT}` : text;
					const rows = wrapTextWithAnsi(body, width);
					offset = Math.max(0, Math.min(offset, rows.length - pageRows));
					const header = truncateToWidth(theme.bold(theme.fg(tone, title)), width);
					const back = theme.fg("accent", "esc") + theme.fg("muted", " close");
					const move = theme.fg("accent", "↑↓ pgup/pgdn") + theme.fg("muted", " read");
					const keys = `${move}  ${back}`;
					const footer = rows.length > pageRows && visibleWidth(keys) <= width ? keys : back;
					return [
						header,
						...rows.slice(offset, offset + pageRows).map((row) => truncateToWidth(row, width)),
						truncateToWidth(footer, width),
					];
				},
				handleInput(data) {
					if (matchesKey(data, "escape")) return close?.();
					const steps = { pageUp: -pageRows, pageDown: pageRows, up: -1, down: 1 };
					for (const key of ["pageUp", "pageDown", "up", "down"] as const) {
						if (!matchesKey(data, key)) continue;
						offset += steps[key];
						tui.requestRender();
						break;
					}
				},
			};
		})
		.catch(() => ui.notify("The Google report view is unavailable.", "warning"));
	return {
		done,
		refresh: () => refresh?.(),
		close() {
			closed = true;
			close?.();
		},
	};
}

function signInReport(ui: ReportUI, instructions: string) {
	const streams = {
		stdout: { decoder: new StringDecoder("utf8"), text: "", limited: false },
		stderr: { decoder: new StringDecoder("utf8"), text: "", limited: false },
	};
	const view = openReport(
		ui,
		"Google sign-in",
		() => {
			const output = Object.values(streams).map(({ text, limited }) => plain(text) + (limited ? `\n${LIMIT}` : ""));
			// Keep the browser fallback above child diagnostics, even if the URL arrives on stderr.
			const url = output.map((text) => /^\s*(https:\/\/accounts\.google\.com\/\S+)\s*$/m.exec(text)?.[1]).find(Boolean);
			const body = output.map((text) =>
				text
					.split("\n")
					.filter((line) => line.trim() !== url)
					.join("\n"),
			);
			return [instructions, url, ...body].filter(Boolean).join("\n");
		},
		"accent",
	);
	return {
		close: view.close,
		observe: ((chunk, stream) => {
			const capture = streams[stream];
			if (capture.limited) return;
			const next = capture.text + capture.decoder.write(chunk);
			capture.limited = next.length > REPORT_UNITS;
			capture.text = next.slice(0, REPORT_UNITS);
			view.refresh();
		}) satisfies NonNullable<CommandDeps["observeLogin"]>,
	};
}

function presentOutcome(ui: ReportUI, kind: EmissionKind, text: string) {
	const body = plain(text);
	if (kind === "status" || kind === "status-not-ready") {
		const title = kind === "status" ? "Google status" : "Google status: Not ready";
		return openReport(ui, title, () => body, "accent");
	}
	const level = kind === "error" ? "error" : kind === "usage" || kind === "refusal" ? "warning" : "info";
	if (!body.includes("\n")) {
		ui.notify(body, level);
		return;
	}
	const titles = { error: "Google command failed", warning: "Google command refused", info: "Google command report" };
	return openReport(ui, titles[level], () => body, level === "info" ? "accent" : level);
}

export async function googleTuiCommand(
	input: string,
	agentDir: string,
	env: Environment,
	ui: ReportUI,
	deps: Partial<CommandDeps> = {},
): Promise<boolean> {
	let auth: ReturnType<typeof signInReport> | undefined;
	let report: ReturnType<typeof openReport> | undefined;
	try {
		const ok = await runGoogleCommand(
			input,
			agentDir,
			env,
			(kind, text) => {
				if (kind === "sign-in") {
					auth = signInReport(ui, text);
					return;
				}
				if (kind === "sign-in-output") return;
				if (kind !== "progress") auth?.close();
				report = presentOutcome(ui, kind, text);
			},
			{ ...deps, observeLogin: (chunk, stream) => auth?.observe(chunk, stream) },
		);
		await report?.done;
		return ok;
	} finally {
		auth?.close();
	}
}
