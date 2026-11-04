import type { ProgramStatus } from "@earendil-works/pi-tui";

export interface TerminalActivity {
	target?: string;
	revision: number;
	live: boolean;
	busy?: boolean;
	interaction: boolean;
}

/** Projects only the attached terminal's observed activity and local questions. */
export class TerminalProgramStatus {
	private previous = "";
	private target?: string;
	private revision = -1;
	private disposed = false;
	private readonly publish: (status: ProgramStatus) => void;
	constructor(publish: (status: ProgramStatus) => void) { this.publish = publish; }
	private send(status: ProgramStatus): void {
		const key = JSON.stringify(status);
		if (key === this.previous) return;
		this.previous = key;
		this.publish(status);
	}
	update(activity: TerminalActivity): void {
		if (this.disposed) return;
		if (this.target !== activity.target || this.revision !== activity.revision) {
			this.send({ state: "clear" });
			this.target = activity.target;
			this.revision = activity.revision;
		}
		if (activity.interaction) this.send({ state: "blocked", app: "pi-agent", kind: "question", message: "Answer the terminal dialog" });
		else if (!activity.target || !activity.live || activity.busy === undefined) this.send({ state: "clear" });
		else this.send({ state: activity.busy ? "working" : "idle", app: "pi-agent" });
	}
	dispose(): void {
		if (this.disposed) return;
		this.send({ state: "clear" });
		this.disposed = true;
	}
}
