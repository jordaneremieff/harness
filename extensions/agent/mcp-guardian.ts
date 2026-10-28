import { spawn, type ChildProcess } from "node:child_process";
import type { StdioTransport } from "@earendil-works/pi-mcp";

const PROGRAM = `
groups=''
while IFS=' ' read -r action pid; do
  case "$pid" in ''|*[!0-9]*) continue ;; esac
  case "$action" in
    add) groups="$groups $pid" ;;
    remove) kept=''; for group in $groups; do if [ "$group" != "$pid" ]; then kept="$kept $group"; fi; done; groups="$kept" ;;
  esac
done
[ -n "$groups" ] || exit 0
for pid in $groups; do kill -KILL -- "-$pid" 2>/dev/null || :; done
`;

/** Owns the lifeline for process groups created by MCP stdio transports. */
export class McpGuardian {
	private child: ChildProcess | undefined;
	private readonly report: (message: string) => void;
	private started = false;
	private closed = false;

	constructor(report: (message: string) => void) { this.report = report; }

	private start(): void {
		if (this.started || this.closed || process.platform === "win32") return;
		this.started = true;
		try {
			this.child = spawn("/bin/sh", ["-c", PROGRAM], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
			this.child.on("error", (error) => this.report(`MCP guardian failed: ${error.message}`));
			this.child.stdin?.on("error", (error) => this.report(`MCP guardian lifeline failed: ${error.message}`));
			this.child.unref();
		} catch (error) { this.report(`MCP guardian failed: ${error instanceof Error ? error.message : String(error)}`); }
	}

	get processId(): number | undefined { return this.child?.pid; }

	private send(action: string, pid: number): void {
		if (this.closed || !this.child?.stdin || !Number.isSafeInteger(pid) || pid <= 0) return;
		try {
			if (!this.child.stdin.write(`${action} ${pid}\n`) || this.child.stdin.writableLength !== 0) this.report(`MCP guardian registration did not flush for process group ${pid}`);
		} catch (error) { this.report(`MCP guardian lifeline failed: ${error instanceof Error ? error.message : String(error)}`); }
	}
	register(pid: number): void {
		if (!Number.isSafeInteger(pid) || pid <= 0) return;
		this.start();
		this.send("add", pid);
	}
	unregister(pid: number): void { this.send("remove", pid); }
	close(): void { this.closed = true; this.child?.stdin?.end(); }
}

/** Register the process as soon as the transport creates it. */
export function guardStdio(transport: StdioTransport, guardian: McpGuardian): void {
	const start = transport.start.bind(transport);
	transport.start = () => {
		const started = start();
		const pid = transport.pid;
		if (pid !== undefined) {
			guardian.register(pid);
			transport.onClose(() => guardian.unregister(pid));
		}
		return started;
	};
}
