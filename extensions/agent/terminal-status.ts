import type { ProgramStatus } from "@earendil-works/pi-tui";
import { basename } from "node:path";

export interface TerminalActivity {
	target?: string;
	revision: number;
	live: boolean;
	busy?: boolean;
	interaction: boolean;
	/** Observed name of the attached conversation; the title and status message name it. */
	name?: string;
	/** Working directory of the attached conversation; the title shows its last path segment. */
	cwd?: string;
	/** Title of the open terminal dialog when known. */
	dialog?: string;
}

/** Printable single-line text for a title or status message. Control characters would end the sequence. */
function plainLine(value: string, limit: number): string {
	const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
	return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/**
 * Projects only the attached terminal's observed activity and local questions: the window title names the
 * attached conversation and its folder, the program status carries the conversation name, and a dialog
 * blocks with its title. Detaching, disposal and an unavailable connection clear both.
 */
export class TerminalProgramStatus {
	private previous = "";
	private previousTitle?: string;
	private target?: string;
	private revision = -1;
	private disposed = false;
	private readonly publish: (status: ProgramStatus) => void;
	private readonly publishTitle?: (title: string) => void;
	constructor(publish: (status: ProgramStatus) => void, publishTitle?: (title: string) => void) {
		this.publish = publish;
		this.publishTitle = publishTitle;
	}
	private send(status: ProgramStatus): void {
		const key = JSON.stringify(status);
		if (key === this.previous) return;
		this.previous = key;
		this.publish(status);
	}
	private title(title: string): void {
		if (this.previousTitle === title) return;
		this.previousTitle = title;
		this.publishTitle?.(title);
	}
	update(activity: TerminalActivity): void {
		if (this.disposed) return;
		if (this.target !== activity.target || this.revision !== activity.revision) {
			this.send({ state: "clear" });
			this.target = activity.target;
			this.revision = activity.revision;
		}
		const attached = Boolean(activity.target) && activity.live && activity.busy !== undefined;
		const name = activity.name ? plainLine(activity.name, 80) : "";
		const folder = activity.cwd ? plainLine(basename(activity.cwd), 48) : "";
		this.title(attached ? [name, folder].filter(Boolean).join(" · ") : "");
		this.send(this.status(activity, attached, name));
	}
	private status(activity: TerminalActivity, attached: boolean, name: string): ProgramStatus {
		if (activity.interaction) {
			const dialog = activity.dialog ? plainLine(activity.dialog, 80) : "";
			return { state: "blocked", app: "pi-agent", kind: "question", message: dialog ? `Answer: ${dialog}` : "Answer the terminal dialog" };
		}
		if (!attached) return { state: "clear" };
		return { state: activity.busy ? "working" : "idle", app: "pi-agent", ...(name ? { message: name } : {}) };
	}
	dispose(): void {
		if (this.disposed) return;
		this.send({ state: "clear" });
		this.title("");
		this.disposed = true;
	}
}
