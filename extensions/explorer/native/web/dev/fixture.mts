import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	chmodSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
const editLimit = 2 * 1024 * 1024;
export const devDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const devEditText = (text: unknown): text is string =>
	typeof text === "string" &&
	!text.includes("\0") &&
	Buffer.byteLength(text) <= editLimit &&
	text.split(/\r\n|\r|\n/, 20_001).length <= 20_000;
const problem = (code: string, message: string) => Object.assign(new Error(message), { bridgeCode: code });
type FixtureFile = ExplorerFile & { bytes?: Buffer };
export const validFixturePath = (path: unknown): path is string =>
	typeof path === "string" &&
	Buffer.byteLength(path) <= 4096 &&
	!path.includes("\0") &&
	path.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");

type Index = ExplorerRequests["files.list"][1];
type IndexFolder = { directory: string; path: string; repo?: ExplorerRepository };
type IndexEntry = { kind: "file"; path: string } | ({ kind: "folder" } & IndexFolder);
type IndexState = {
	queue: IndexFolder[];
	paths: Set<string>;
	repositories: Index["repositories"];
	repositoriesTruncated: boolean;
	bytes: number;
	deadline: number;
};
type FolderEntry = ExplorerRequests["files.folder"][1]["entries"][number];
const folderLimit = 10_000;
const collator = new Intl.Collator("en", { numeric: true });

function inside(root: string, target: string) {
	const path = relative(root, target);
	return !path || validFixturePath(path);
}

function smallText(path: string) {
	try {
		const fd = openSync(path, "r");
		try {
			const bytes = Buffer.alloc(4096);
			return bytes.subarray(0, readSync(fd, bytes)).toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

function repository(directory: string, base: string): ExplorerRepository | undefined {
	const marker = join(directory, ".git");
	const stat = lstatSync(marker, { throwIfNoEntry: false });
	if (!stat) return undefined;
	const pointer = stat.isFile() ? /^gitdir: *(.*)$/m.exec(smallText(marker))?.[1]?.trim() : undefined;
	const git = stat.isDirectory() ? marker : pointer ? resolve(directory, pointer) : undefined;
	if (!git || !lstatSync(git, { throwIfNoEntry: false })?.isDirectory()) return undefined;
	const canonical = realpathSync(git);
	if (!canonical.startsWith(base + sep)) return undefined;
	const head = smallText(join(canonical, "HEAD")).trim();
	if (!head) return undefined;
	return {
		branch: /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? null,
		head: /^(?:[\da-f]{40}|[\da-f]{64})$/i.test(head) ? head : null,
	};
}

function containingRepository(directory: string, base: string): string | undefined {
	for (let at = directory; ; at = dirname(at)) {
		if (repository(at, base)) return at;
		if (at === base) return undefined;
	}
}

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

function gitAt(root: string, args: string[], accepted: number[] = [0], input?: string): Buffer {
	try {
		const literal = args[0] === "check-ignore" ? [] : ["--literal-pathspecs"];
		return execFileSync("git", ["--no-pager", ...literal, ...args], {
			cwd: root,
			timeout: 3000,
			maxBuffer: 32 * 1024 * 1024,
			stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
			input,
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
		if (gitError.status !== undefined && accepted.includes(gitError.status) && gitError.stdout) return gitError.stdout;
		throw error;
	}
}

export function createFixture(directory: string) {
	const root = realpathSync(directory);
	const git = (args: string[]) => gitAt(root, args);
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
	write(".gitignore", "dist/\n*.local\n/workshop/bulk/\n");
	write("dist/assets/routes.txt", "/health\n");
	write("dist/worker.js", "export const worker = true;\n");
	write("routes.local", "/dev\n");
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
	const catalog = join(root, "workshop/catalog");
	mkdirSync(catalog, { recursive: true });
	gitAt(catalog, ["init", "-q", "-b", "main", "--template="]);
	write("workshop/catalog/.gitignore", "cache/\n");
	write("workshop/catalog/inventory.txt", "Inventory for the workshop.\n");
	write("workshop/catalog/cache/index.log", "Local cache.\n");
	write("workshop/guide.txt", "The workbench has a manual.\n");
	gitAt(catalog, ["add", "--all"]);
	gitAt(catalog, [
		"-c",
		"user.name=Fixture Author",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"Add the workshop catalog",
	]);
	gitAt(catalog, ["checkout", "-qb", "feature/catalog"]);
	for (const bucket of ["part-a", "part-b"]) {
		const target = join(root, "workshop/bulk", bucket);
		mkdirSync(target, { recursive: true });
		for (let i = 0; i < 9000; i++) writeFileSync(join(target, `item-${String(i).padStart(5, "0")}.txt`), "");
	}
	return openFixtureRoot(root, root);
}

export function openFixtureRoot(base: string, path: string) {
	if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Use an absolute fixture folder path.");
	const root = realpathSync(path);
	if (!inside(base, root) || !lstatSync(root).isDirectory()) throw new Error("The folder leaves the fixture.");
	const git = (args: string[], accepted?: number[]) => gitAt(root, args, accepted);
	const info = repository(root, base);
	const rootInfo = (): ExplorerRoot => {
		const branch = info ? output(["rev-parse", "--abbrev-ref", "HEAD"]).trim() : null;
		return {
			path: root,
			name: root === base ? "Waypoint" : basename(root),
			kind: info ? "git" : "folder",
			branch: branch === "HEAD" ? null : branch,
			head: info ? head() : null,
			defaultBranch: info ? "main" : null,
			onDefaultBranch: branch === "main",
		};
	};
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
	const empty = info ? output(["hash-object", "-w", "-t", "tree", "--stdin"]).trim() : "";
	function ignoredIn(gitRoot: string | undefined, paths: string[]) {
		if (!gitRoot || !paths.length) return new Set<string>();
		return new Set(
			gitAt(gitRoot, ["check-ignore", "-z", "--stdin"], [0, 1], `${paths.join("\0")}\0`)
				.toString("utf8")
				.split("\0"),
		);
	}
	function targetKind(path: string) {
		const stat = lstatSync(path, { throwIfNoEntry: false });
		if (stat?.isFile()) return "file";
		if (stat?.isDirectory()) return "folder";
		if (stat?.isSymbolicLink()) {
			try {
				const target = realpathSync(path);
				if (inside(root, target)) return targetKind(target);
			} catch {
				// Broken and out-of-root links are not listed.
			}
		}
	}
	function listedEntry(target: string, child: import("node:fs").Dirent): FolderEntry | undefined {
		const childPath = join(target, child.name);
		const kind = child.isDirectory() ? "folder" : child.isFile() ? "file" : targetKind(childPath);
		if (!kind) return;
		return { name: child.name, kind, repo: kind === "folder" ? repository(childPath, base) : undefined };
	}
	function unorderedFolderEntries(target: string) {
		const entries: FolderEntry[] = [];
		for (const child of readdirSync(target, { withFileTypes: true })) {
			if (!validFixturePath(child.name)) continue;
			const entry = listedEntry(target, child);
			if (entry) entries.push(entry);
		}
		return entries;
	}
	function sortFolder(a: FolderEntry, b: FolderEntry) {
		if (a.kind === b.kind) return collator.compare(a.name, b.name);
		return a.kind === "folder" ? -1 : 1;
	}
	function annotateIgnored(target: string, entries: FolderEntry[]) {
		const gitRoot = containingRepository(target, base);
		if (!gitRoot) return;
		const names = entries.map(({ name }) => relative(gitRoot, join(target, name)));
		const ignored = ignoredIn(gitRoot, names);
		entries.forEach((entry, i) => {
			if (ignored.has(names[i])) entry.ignored = true;
		});
	}
	function folder(path: string) {
		if (path !== "" && !validFixturePath(path)) throw new Error("Invalid folder path.");
		const target = realpathSync(join(root, path));
		if (!inside(root, target)) throw new Error("Invalid folder path.");
		const entries = unorderedFolderEntries(target).sort(sortFolder);
		const selected = entries.slice(0, folderLimit);
		annotateIgnored(target, selected);
		return { entries: selected, truncated: entries.length > selected.length };
	}
	function outside(paths: string[]) {
		if (!info) return undefined;
		const local = paths.filter((path) => containingRepository(dirname(join(root, path)), base) === root);
		const localPaths = new Set(local);
		const ignored = ignoredIn(root, local);
		return paths.filter((path) => ignored.has(path) || !localPaths.has(path));
	}
	function* gitEntries(item: IndexFolder, prefix: string): Iterable<IndexEntry> {
		const names = gitAt(item.directory, [
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
			"--deduplicate",
		])
			.toString("utf8")
			.split("\0");
		for (const name of new Set(names.map((part) => part.replace(/\/$/, "")))) {
			if (!validFixturePath(name)) continue;
			const directory = join(item.directory, name);
			const path = prefix + name;
			const kind = targetKind(directory);
			if (kind === "file") yield { kind, path };
			else if (kind === "folder") {
				const repo = repository(directory, base);
				if (repo) yield { kind, directory, path, repo };
			}
		}
	}
	function* plainEntries(item: IndexFolder, prefix: string): Iterable<IndexEntry> {
		for (const child of readdirSync(item.directory, { withFileTypes: true })) {
			if (!validFixturePath(child.name)) continue;
			const path = prefix + child.name;
			const directory = join(item.directory, child.name);
			if (child.isDirectory()) yield { kind: "folder", directory, path, repo: repository(directory, base) };
			else if (child.isFile() || targetKind(directory) === "file") yield { kind: "file", path };
		}
	}
	function addIndexPath(state: IndexState, path: string) {
		if (state.paths.has(path)) return true;
		state.bytes += Buffer.byteLength(JSON.stringify(path)) + 1;
		if (state.paths.size >= 200_000 || state.bytes > 26 * 1024 * 1024) return false;
		state.paths.add(path);
		return true;
	}
	function collectIndex(state: IndexState, item: IndexFolder) {
		const prefix = item.path ? `${item.path}/` : "";
		const entries = item.repo ? gitEntries(item, prefix) : plainEntries(item, prefix);
		for (const entry of entries) {
			if (Date.now() >= state.deadline) return false;
			if (!addIndexEntry(state, entry)) return false;
		}
		return true;
	}
	function addIndexEntry(state: IndexState, entry: IndexEntry) {
		return entry.kind === "file" ? addIndexPath(state, entry.path) : addIndexFolder(state, entry);
	}
	function addIndexFolder(state: IndexState, item: IndexFolder) {
		if (item.repo) {
			if (state.repositories.length >= 2000) {
				state.repositoriesTruncated = true;
				return false;
			}
			state.repositories.push({ path: item.path, ...item.repo });
		}
		state.queue.push(item);
		return true;
	}
	function index(): Index {
		const state: IndexState = {
			queue: [{ directory: root, path: "", repo: info }],
			paths: new Set(),
			repositories: [],
			repositoriesTruncated: false,
			bytes: 0,
			deadline: Date.now() + 8000,
		};
		let truncated = false;
		for (const item of state.queue) {
			if (Date.now() >= state.deadline || !collectIndex(state, item)) {
				truncated = true;
				break;
			}
		}
		const source = state.repositories.length ? "mixed" : info ? "git" : "scan";
		return {
			paths: [...state.paths],
			truncated,
			source,
			repositories: state.repositories,
			repositoriesTruncated: state.repositoriesTruncated,
		};
	}
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
	function checkEditFolder(folder: string, create: boolean) {
		let info = lstatSync(folder, { throwIfNoEntry: false });
		if (!info && create) {
			mkdirSync(folder);
			info = lstatSync(folder);
		}
		if (!info) throw problem("conflict", "The file changed on disk.");
		const real = realpathSync(folder);
		if (!info.isDirectory() || !real.startsWith(`${root}${sep}`) || !validFixturePath(real.slice(root.length + 1)))
			throw problem("invalid-path", "The path leaves the fixture or enters Git metadata.");
	}
	function editTarget(path: string, create: boolean) {
		if (
			!validFixturePath(path) ||
			imageTypes.has(extname(path).slice(1).toLowerCase()) ||
			(create && /[\x00-\x1f]/.test(path))
		)
			throw problem("invalid-path", "Use a relative text file path inside the fixture.");
		let folder = root;
		const parts = path.split("/");
		const name = parts.pop() ?? "";
		for (const part of parts) {
			folder = join(folder, part);
			checkEditFolder(folder, create);
		}
		return join(folder, name);
	}
	function createFile(path: string) {
		const target = editTarget(path, true);
		try {
			writeFileSync(target, "", { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw problem("exists", "That path already exists.");
			throw error;
		}
	}
	function writeEdit(path: string, text: string, base: string) {
		if (!devEditText(text) || typeof base !== "string" || !/^[0-9a-f]{64}$/.test(base))
			throw problem("invalid", "Invalid edit text or base.");
		const target = editTarget(path, false);
		function check() {
			const info = lstatSync(target, { throwIfNoEntry: false });
			if (!info?.isFile() || info.size > editLimit || read(path).editBase !== base)
				throw problem("conflict", "The file changed on disk.");
			return info.mode & 0o777;
		}
		check();
		const staged = join(dirname(target), `.explorer-${randomUUID()}.tmp`);
		writeFileSync(staged, text, { flag: "wx", mode: 0o600 });
		try {
			editTarget(path, false);
			chmodSync(staged, check());
			renameSync(staged, target);
		} finally {
			if (lstatSync(staged, { throwIfNoEntry: false })) unlinkSync(staged);
		}
		return devDigest(Buffer.from(text));
	}
	function fileEditBase(path: string, bytes: Buffer, text: string, at?: string | null) {
		if (at != null || !devEditText(text)) return undefined;
		try {
			return editTarget(path, false) === realpathSync(join(root, path)) ? devDigest(bytes) : undefined;
		} catch {
			return undefined;
		}
	}
	function readBytes(path: string, bytes: Buffer, at?: string | null): FixtureFile {
		const size = bytes.length;
		const mediaType = imageTypes.get(extname(path).slice(1).toLowerCase());
		if (mediaType) return { path, kind: "image", size, mediaType, bytes };
		const truncated = size > textLimit;
		try {
			const preview = bytes.subarray(0, textLimit);
			if (!preview.includes(0)) {
				const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(preview, { stream: truncated });
				return {
					path,
					kind: "text",
					size,
					text,
					truncated,
					editBase: truncated ? undefined : fileEditBase(path, bytes, text, at),
				};
			}
		} catch {
			// Non-UTF-8 input is binary.
		}
		return { path, kind: "binary", size };
	}
	function read(path: string, at?: string | null): FixtureFile {
		if (!validFixturePath(path)) throw new Error("Invalid file path.");
		const bytes = at == null ? working(path) : committed(path, at);
		return Buffer.isBuffer(bytes) ? readBytes(path, bytes, at) : bytes;
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
	return {
		root,
		head,
		branch,
		rev,
		parent,
		empty,
		rootInfo,
		index,
		outside,
		folder,
		read,
		log,
		output,
		createFile,
		writeEdit,
	};
}

export type Fixture = ReturnType<typeof openFixtureRoot>;
