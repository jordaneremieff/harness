import { type Fixture, validFixturePath } from "./fixture.mts";

const statuses: Record<string, ExplorerChange["status"] | undefined> = {
	A: "added",
	M: "modified",
	D: "deleted",
	T: "typechange",
};
export const uncommitted: ExplorerScope = { kind: "uncommitted" };
export const lines = (text?: string) => (text ? text.replace(/\n$/, "").split(/\r?\n/) : []);

export function createReview(repo: Fixture) {
	type State = ExplorerRequests["review.state"][1];
	const finished = new Map<string, string>();
	const states = new Map<string, State>();
	const resolve = (scope: ExplorerScope): ExplorerResolved => {
		const current = repo.head();
		let head = current;
		let base: string | null;
		let label: string;
		switch (scope?.kind) {
			case "uncommitted":
				return { scope, head: "worktree", base: current, key: `worktree@${current}`, label: "Uncommitted changes" };
			case "commit":
				head = repo.rev(scope.commit);
				base = repo.parent(head);
				label = `Commit ${head.slice(0, 7)}`;
				break;
			case "range":
				head = repo.rev(scope.head);
				base = repo.rev(scope.base);
				label = "Commit range";
				break;
			case "branch": {
				const branch = scope.base ?? "main";
				base = repo.output(["merge-base", repo.rev(branch), head]).trim();
				label = `Branch against ${branch}`;
				break;
			}
			case "since-review":
				base = finished.get(repo.branch()) ?? repo.parent(head);
				label = "Since your last review";
				break;
			default:
				throw new Error("Unknown review scope.");
		}
		return { scope, head, base, label, key: `${base ?? "empty"}..${head}` };
	};
	const diffArgs = ({ base, head }: ExplorerResolved) => [
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--no-renames",
		base ?? repo.empty,
		...(head === "worktree" ? [] : [head]),
	];
	function scopes() {
		const choices: ExplorerScope[] = [
			uncommitted,
			{ kind: "commit", commit: "HEAD" },
			{ kind: "range", base: "main", head: "HEAD" },
			{ kind: "branch" },
			{ kind: "since-review" },
		];
		return {
			defaultId: "uncommitted",
			scopes: choices.map((scope) => ({ scope, id: scope.kind, label: resolve(scope).label, available: true })),
		};
	}
	function trackedChanges(args: string[]) {
		const nums = new Map(
			repo
				.output([...args, "--numstat", "-z", "--"])
				.split("\0")
				.filter(Boolean)
				.map((row) => {
					const [, add, del, path] = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(row) ?? [];
					return [path, { additions: Number(add) || 0, deletions: Number(del) || 0, binary: add === "-" }];
				}),
		);
		const names = repo.output([...args, "--name-status", "-z", "--"]).split("\0");
		const changes: ExplorerChange[] = [];
		for (let i = 0; i + 1 < names.length; i += 2) {
			const [code, path] = [names[i], names[i + 1]];
			const status = statuses[code];
			const stat = nums.get(path);
			if (status && stat) changes.push({ path, status, ...stat });
		}
		return changes;
	}
	function files(scope: ExplorerScope): ExplorerReview {
		const resolved = resolve(scope);
		const changes = trackedChanges(diffArgs(resolved));
		if (resolved.head === "worktree") {
			for (const path of repo
				.output(["ls-files", "--others", "--exclude-standard", "-z"])
				.split("\0")
				.filter(validFixturePath)) {
				const file = repo.read(path);
				changes.push({
					path,
					status: "added",
					additions: lines(file.text).length,
					deletions: 0,
					binary: file.kind !== "text",
				});
			}
		}
		changes.sort((a, b) => a.path.localeCompare(b.path));
		const commits =
			resolved.head === "worktree" ? [] : repo.log([`${resolved.base ? `${resolved.base}..` : ""}${resolved.head}`]);
		return { resolved, commits, files: changes };
	}
	function diff(scope: ExplorerScope, path: string): ExplorerDiff {
		const { resolved, files: changes } = files(scope);
		const item = changes.find((file) => file.path === path);
		if (!item) throw new Error("File is not in this review.");
		const base = item.status === "added" ? null : repo.read(path, resolved.base);
		const head =
			item.status === "deleted" ? null : repo.read(path, resolved.head === "worktree" ? undefined : resolved.head);
		const binary = item.binary || [base, head].some((file) => file && file.kind !== "text");
		const hunks = binary ? [] : readHunks(resolved, item, head?.text);
		return {
			path,
			status: item.status,
			binary,
			hunks,
			base: base?.text ?? null,
			head: head?.text ?? null,
			truncated: Boolean(base?.truncated || head?.truncated),
		};
	}
	function readHunks(resolved: ExplorerResolved, item: ExplorerChange, text?: string): ExplorerHunk[] {
		if (item.status === "added" && resolved.head === "worktree") {
			const headCount = lines(text).length;
			return headCount ? [{ baseStart: 0, baseCount: 0, headStart: 1, headCount }] : [];
		}
		const patch = repo.output([...diffArgs(resolved), "--unified=0", "--", item.path]);
		return Array.from(
			patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm),
			([, bs, bc = "1", hs, hc = "1"]) => ({
				baseStart: Number(bs),
				baseCount: Number(bc),
				headStart: Number(hs),
				headCount: Number(hc),
			}),
		);
	}
	function state({ op, key, viewed, finished: finish }: ExplorerRequests["review.state"][0]): State {
		if (typeof key !== "string" || !["get", "set"].includes(op)) throw new Error("Invalid review state.");
		const stored: State = states.get(key) ?? { viewed: [] };
		if (op === "get") return stored;
		if (Array.isArray(viewed)) stored.viewed = [...new Set(viewed)];
		if (finish) {
			const head = key.startsWith("worktree@") ? repo.head() : repo.rev(key.split("..").at(-1));
			stored.finished = { head, at: new Date().toISOString() };
			finished.set(repo.branch(), head);
		}
		states.set(key, stored);
		return stored;
	}
	return { scopes, files, diff, state };
}
