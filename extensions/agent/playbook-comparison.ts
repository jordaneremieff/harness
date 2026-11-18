import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { HitMap } from "./view-hits.ts";
import type { View, ViewHost } from "./view-model.ts";
import { Reader, ReaderView } from "./view-reader.ts";
import { fitCells, plainLine } from "./view-text.ts";
import { applyPlaybookImport, previewPlaybookImport } from "./playbook-import.ts";

type Preview = ReturnType<typeof previewPlaybookImport>;

/** A review binds both displayed revisions to the same explicit effect. Resizing keeps both positions. */
export class PlaybookComparison implements View {
	readonly title: string;
	private readonly readers = [new Reader(), new Reader()] as const;
	private readonly hits = new HitMap();
	private active = 0;
	private wide = false;
	private finished = false;
	private readonly host: ViewHost;
	private readonly preview: Preview;
	private readonly apply: () => string;

	constructor(host: ViewHost, preview: Preview, apply: () => string) {
		this.host = host;
		this.preview = preview;
		this.apply = apply;
		this.title = `Review ${preview.name}.md`;
		this.readers[0].setContent(preview.currentText ?? "No installed file.");
		this.readers[1].setContent(preview.starterText);
	}

	render(width: number, height: number): string[] {
		this.wide = width >= 90;
		this.hits.begin(width, height);
		const labels = ["Current file", "Bundled starter"];
		const { theme } = this.host;
		const column = (index: number, columns: number, x: number) => [
			fitCells(theme.fg(index === this.active ? "accent" : "muted", `${this.wide && index === this.active ? "▸ " : ""}${labels[index]}`), columns),
			...this.readers[index].render(columns, height - 1, theme, this.hits, x, 1),
		].slice(0, height);
		if (!this.wide) return column(this.active, width, 0);
		const leftWidth = Math.floor((width - 3) / 2);
		const left = column(0, leftWidth, 0);
		const right = column(1, width - leftWidth - 3, leftWidth + 3);
		return left.map((line, row) => `${line} ${theme.fg("muted", "│")} ${right[row]}`);
	}

	focusEdge(backward: boolean): void { this.active = backward ? 1 : 0; }

	focusNext(backward: boolean): boolean {
		const next = this.active + (backward ? -1 : 1);
		if (next < 0 || next > 1) return false;
		this.active = next;
		return true;
	}

	handleInput(data: string): boolean {
		return this.readers[this.active].handleInput(data);
	}

	handleMouse(event: TuiMouseEvent) {
		return this.hits.handle(event);
	}

	keys() {
		return [{ keys: ["up", "down"], label: "scroll" }, { keys: ["pageUp", "pageDown"], label: "page" }];
	}

	actions() {
		const effect = this.preview.action === "replace" ? "Replace this file" : "Add this file";
		return [
			{ id: "side", label: this.active === 0 ? "Read bundled starter" : "Read current file", key: "s", short: this.active === 0 ? "bundled" : "current", primary: true, run: () => { this.active = 1 - this.active; this.host.requestRender(); } },
			...(this.finished || this.preview.action === "unchanged" ? [] : [{ id: "import", label: effect, key: "a", primary: true, run: () => {
				// After a refusal the reviewed revision is no longer a retry token.
				if (this.finished || this.host.signal.aborted) return;
				this.finished = true;
				let result: string;
				let title: string;
				try {
					result = this.apply();
					title = "Playbook imported";
				} catch (error) {
					result = `${plainLine(error instanceof Error ? error.message : String(error))} Reopen the comparison to review again.`;
					title = "Import refused";
				}
				this.host.push((host) => new ReaderView(title, host, () => result));
			} }]),
		];
	}
}

export function preparePlaybookComparison(agentDir: string, name: string) {
	const preview = previewPlaybookImport(agentDir, name);
	return {
		preview,
		open: (host: ViewHost) => new PlaybookComparison(host, preview, () => applyPlaybookImport(agentDir, preview)),
	};
}
