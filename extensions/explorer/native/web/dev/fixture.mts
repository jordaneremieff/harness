import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

export const defaultPath = "src/router.ts";
const imageTypes = new Map([
	["svg", "image/svg+xml"],
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
]);
const textLimit = 4 * 1024 * 1024;
type FixtureFile = ExplorerFile & { bytes?: Buffer };
const validPath = (path: unknown): path is string =>
	typeof path === "string" &&
	!path.includes("\\") &&
	!path.includes("\0") &&
	path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

function router(delay: number, fallback: string) {
	return `import { Queue } from './queue.js';

export interface Route {
  path: string;
  method: 'GET' | 'POST';
  priority: number;
}

const retryDelay = ${delay};
const fallbackRoute = '${fallback}';
const routes = new Map<string, Route>();

export function register(route: Route): void {
  if (routes.has(route.path)) {
    throw new Error(\`Route already registered: \${route.path}\`);
  }
  routes.set(route.path, route);
}

export function resolveRoute(path: string): Route | undefined {
  return routes.get(path) ?? routes.get(fallbackRoute);
}

export function schedule(path: string, queue: Queue): boolean {
  const route = resolveRoute(path);
  if (!route) return false;

  queue.add(route.path, retryDelay * Math.max(1, route.priority));
  return true;
}

export function listRoutes(): Route[] {
  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function clearRoutes(): void {
  routes.clear();
}

register({ path: '/health', method: 'GET', priority: 1 });
register({ path: fallbackRoute, method: 'GET', priority: 2 });
`;
}

export function createFixture(directory: string) {
	const root = realpathSync(directory);
	const git = (args: string[], accepted: number[] = [0]): Buffer => {
		try {
			return execFileSync("git", ["--no-pager", "--literal-pathspecs", ...args], {
				cwd: root,
				timeout: 3000,
				maxBuffer: 32 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					HOME: root,
					XDG_CONFIG_HOME: root,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_OPTIONAL_LOCKS: "0",
					LC_ALL: "C",
				},
			});
		} catch (error) {
			const gitError = error as { status?: number; stdout?: Buffer };
			if (gitError.status !== undefined && accepted.includes(gitError.status) && gitError.stdout)
				return gitError.stdout;
			throw error;
		}
	};
	const write = (path: string, text: string) => {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	};
	git(["init", "-q", "-b", "main", "--template="]);
	git(["config", "user.name", "Fixture Author"]);
	git(["config", "user.email", "fixture@example.invalid"]);
	const commit = (subject: string) => {
		git(["add", "--all"]);
		git(["commit", "-qm", subject]);
	};
	write(defaultPath, router(100, "/home"));
	write("README.md", "# Waypoint\n\nWaypoint routes jobs to local workers.\n");
	write("src/queue.ts", "export interface Queue {\n  add(path: string, delayMs: number): void;\n}\n");
	write("config/legacy.json", '{ "legacy": true }\n');
	write("config/routes.json", '{\n  "maxAttempts": 2,\n  "region": "local"\n}\n');
	write(
		"docs/route-map.svg",
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 180"><rect width="400" height="180" rx="20" fill="#24324a"/><path d="M88 122Q196 10 312 122" fill="none" stroke="#a6e3a1" stroke-width="8" stroke-linecap="round"/><circle cx="88" cy="122" r="13" fill="#89b4fa"/><circle cx="312" cy="122" r="13" fill="#f9e2af"/></svg>\n',
	);
	write(
		"src/generated/route-index.ts",
		Array.from({ length: 10_000 }, (_, i) => `export const route${i + 1} = '/route/${i + 1}';\n`).join(""),
	);
	commit("Set up the route registry");
	git(["checkout", "-qb", "feature/retry"]);
	write(defaultPath, router(150, "/status"));
	commit("Tune retry delay and status fallback");
	write(defaultPath, router(250, "/healthz"));
	write("config/routes.json", '{\n  "maxAttempts": 4,\n  "region": "local"\n}\n');
	write("docs/retry.md", "# Retry policy\n\nThe router delays retries according to priority.\n");
	unlinkSync(join(root, "config/legacy.json"));

	const output = (args: string[], accepted?: number[]) => git(args, accepted).toString("utf8");
	const head = () => output(["rev-parse", "HEAD"]).trim();
	const branch = () => output(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
	const rev = (value: unknown) => {
		if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9/_^~.-]{0,127}$/.test(value))
			throw new Error("Invalid revision.");
		return output(["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`]).trim();
	};
	const parent = (value: string) => output(["rev-list", "--parents", "-n1", value]).trim().split(" ")[1] ?? null;
	// Hash the empty tree locally so root commits use the same diff path as other commits.
	const empty = output(["hash-object", "-w", "-t", "tree", "--stdin"]).trim();
	const paths = () =>
		[
			...new Set(
				output(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split("\0").filter(validPath),
			),
		].sort();
	const absent = (path: string, kind: FixtureFile["kind"]): FixtureFile => ({ path, kind, size: 0 });
	function committed(path: string, at: string) {
		const oid = rev(at);
		const entry = output(["ls-tree", oid, "--", path]);
		if (!entry) return absent(path, "missing");
		if (entry.startsWith("040000 ")) return absent(path, "directory");
		if (!entry.startsWith("100")) return absent(path, "binary");
		return git(["show", `${oid}:${path}`]);
	}
	function working(path: string) {
		const target = join(root, path);
		try {
			const stat = lstatSync(target);
			if (!realpathSync(target).startsWith(`${root}${sep}`) || stat.isSymbolicLink())
				throw new Error("Symlinks are not served.");
			if (stat.isDirectory()) return absent(path, "directory");
			if (!stat.isFile()) throw new Error("Not a regular file.");
			return readFileSync(target);
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return absent(path, "missing");
			throw error;
		}
	}
	function read(path: string, at?: string | null): FixtureFile {
		if (!validPath(path)) throw new Error("Invalid file path.");
		const bytes = at == null ? working(path) : committed(path, at);
		if (!Buffer.isBuffer(bytes)) return bytes;
		const size = bytes.length;
		const mediaType = imageTypes.get(path.split(".").pop()?.toLowerCase() ?? "");
		if (mediaType) return { path, kind: "image", size, mediaType, bytes };
		const truncated = size > textLimit;
		try {
			const preview = bytes.subarray(0, textLimit);
			if (!preview.includes(0))
				return {
					path,
					kind: "text",
					size,
					text: new TextDecoder("utf-8", { fatal: true }).decode(preview, { stream: truncated }),
					truncated,
				};
		} catch {
			// Non-UTF-8 input is binary.
		}
		return { path, kind: "binary", size };
	}
	function log(args: string[]): ExplorerCommit[] {
		return output(["log", "-n30", "--format=%H%x00%h%x00%s%x00%an%x00%aI", ...args])
			.trimEnd()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [commit, short, subject, author, date] = line.split("\0");
				return { commit, short, subject, author, date };
			});
	}
	return { root, head, branch, rev, parent, empty, paths, read, log, output };
}

export type Fixture = ReturnType<typeof createFixture>;
