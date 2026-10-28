import { spawn, type ChildProcess } from "node:child_process";

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
for pid in $groups; do kill -TERM -- "-$pid" 2>/dev/null || :; done
sleep 2
for pid in $groups; do kill -KILL -- "-$pid" 2>/dev/null || :; done
`;

/** Owns the lifeline for process groups created by MCP stdio transports. */
export class McpGuardian {
	private readonly child: ChildProcess | undefined;
	private readonly report: (message: string) => void;

	constructor(report: (message: string) => void) {
		this.report = report;
		if (process.platform === "win32") return;
		try {
			this.child = spawn("/bin/sh", ["-c", PROGRAM], { detached: true, stdio: ["pipe", "ignore", "ignore"] });
			this.child.on("error", (error) => report(`MCP guardian failed: ${error.message}`));
			this.child.stdin?.on("error", (error) => report(`MCP guardian lifeline failed: ${error.message}`));
			this.child.unref();
		} catch (error) { report(`MCP guardian failed: ${error instanceof Error ? error.message : String(error)}`); }
	}

	get processId(): number | undefined { return this.child?.pid; }

	private send(action: string, pid: number): void {
		if (!this.child?.stdin || !Number.isSafeInteger(pid) || pid <= 0) return;
		try {
			if (!this.child.stdin.write(`${action} ${pid}\n`) || this.child.stdin.writableLength !== 0) this.report(`MCP guardian registration did not flush for process group ${pid}`);
		} catch (error) { this.report(`MCP guardian lifeline failed: ${error instanceof Error ? error.message : String(error)}`); }
	}
	register(pid: number): void { this.send("add", pid); }
	unregister(pid: number): void { this.send("remove", pid); }
	close(): void { this.child?.stdin?.end(); }
}
