(() => {
	type Folder = {
		entries?: ExplorerTreeEntry[];
		truncated?: boolean;
		pending?: Promise<void>;
		loading?: boolean;
		stale: boolean;
		error?: string;
	};
	const parent = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

	function fileTree(
		list: (path: string) => Promise<ExplorerRequests["files.folder"][1]>,
		changed: () => void,
	): ExplorerTree {
		const folders = new Map<string, Folder>();
		const expanded = new Set([""]);
		let cachedRows: ExplorerTreeRow[] | undefined;
		let generation = 0;
		const update = () => {
			cachedRows = undefined;
			changed();
		};
		function visible(path: string) {
			for (let at = path; at; at = parent(at)) if (!expanded.has(at)) return false;
			return true;
		}
		function prune(previous: ExplorerTreeEntry[], next: ExplorerTreeEntry[]) {
			const retained = new Set(next.filter((entry) => entry.kind === "folder").map((entry) => entry.path));
			const removed = new Set(
				previous.filter((entry) => entry.kind === "folder" && !retained.has(entry.path)).map((entry) => entry.path),
			);
			if (!removed.size) return;
			for (const key of [...folders.keys()]) {
				let at = key;
				while (at && !removed.has(at)) at = parent(at);
				if (!at) continue;
				folders.delete(key);
				expanded.delete(key);
			}
		}
		function load(path: string): Promise<void> {
			let state = folders.get(path);
			if (!state) {
				state = { stale: true };
				folders.set(path, state);
			}
			if (state.pending) return state.pending;
			if (!state.stale && !state.error) return Promise.resolve();
			const folder = state;
			const current = () => folders.get(path) === folder;
			folder.stale = false;
			folder.error = undefined;
			const timer = setTimeout(() => {
				if (!current() || folder.entries) return;
				folder.loading = true;
				if (visible(path)) update();
			}, 200);
			folder.pending = Promise.resolve()
				.then(() => (current() ? list(path) : undefined))
				.then((data) => {
					if (!current() || !data) return;
					const entries = data.entries.map((entry) => {
						const key = path ? `${path}/${entry.name}` : entry.name;
						return { ...entry, path: key, lower: key.toLowerCase() };
					});
					if (folder.entries && !data.truncated) prune(folder.entries, entries);
					folder.entries = entries;
					folder.truncated = data.truncated;
				})
				.catch((error: unknown) => {
					if (current()) folder.error = error instanceof Error ? error.message : "The folder could not be listed.";
				})
				.finally(() => {
					clearTimeout(timer);
					folder.loading = false;
					folder.pending = undefined;
					if (current()) update();
				})
				.then(() => {
					if (current() && folder.stale && visible(path)) return load(path);
				});
			return folder.pending;
		}
		function refreshExpandedDescendants(path: string) {
			const prefix = `${path}/`;
			for (const [key, folder] of folders) {
				if (folder.stale && key.startsWith(prefix) && visible(key)) void load(key);
			}
		}
		function setExpanded(path: string, expand: boolean) {
			if (expand) {
				const added = !expanded.has(path);
				expanded.add(path);
				const pending = load(path);
				if (added) {
					update();
					refreshExpandedDescendants(path);
				}
				return pending;
			}
			if (path && expanded.delete(path)) update();
			return Promise.resolve();
		}
		function childFolder(path: string, child: string) {
			return folders.get(path)?.entries?.some((entry) => entry.path === child && entry.kind === "folder");
		}
		// A folder created after its parent was listed, such as one made by New file, appears after one fresh read.
		async function listedChild(at: string, next: string) {
			if (childFolder(at, next)) return true;
			const folder = folders.get(at);
			if (!folder) return false;
			folder.stale = true;
			await load(at);
			return !!childFolder(at, next);
		}
		async function reveal(path: string) {
			const stamp = generation;
			await load("");
			let at = "";
			for (const part of path.split("/")) {
				const next = at ? `${at}/${part}` : part;
				if (stamp !== generation || !(await listedChild(at, next)) || stamp !== generation) return;
				await setExpanded(next, true);
				at = next;
			}
		}
		function invalidate(structural: Iterable<string> | null) {
			const keys = structural ? new Set(Array.from(structural, parent)) : folders.keys();
			for (const key of keys) {
				const folder = folders.get(key);
				if (!folder) continue;
				folder.stale = true;
				if (visible(key)) void load(key);
			}
		}
		function* entries() {
			for (const folder of folders.values()) yield* folder.entries ?? [];
		}
		function folderMessage(state: Folder) {
			if (state.truncated) return "The host listed only the first entries.";
			if (state.loading) return "Loading…";
			if (state.entries?.length === 0) return "Empty folder";
			return "";
		}
		function addFolderStatus(result: ExplorerTreeRow[], folder: string, depth: number, state?: Folder) {
			if (!state) return;
			const message = state.error || folderMessage(state);
			if (message) result.push({ kind: "status", folder, depth, message, retry: state.error ? true : undefined });
		}
		function frame(path: string) {
			return { path, index: 0, state: folders.get(path) };
		}
		function flatten() {
			const result: ExplorerTreeRow[] = [];
			// One frame per expanded ancestor, not per sibling or per call-stack level.
			const stack = [frame("")];
			while (stack.length) {
				const depth = stack.length - 1;
				const current = stack[depth];
				const entry = current.state?.entries?.[current.index++];
				if (entry) {
					result.push({ kind: "entry", entry, depth });
					if (entry.kind === "folder" && expanded.has(entry.path)) stack.push(frame(entry.path));
					continue;
				}
				stack.pop();
				addFolderStatus(result, current.path, depth, current.state);
			}
			return result;
		}
		function rows() {
			cachedRows ??= flatten();
			return cachedRows;
		}
		return {
			reset() {
				generation++;
				folders.clear();
				expanded.clear();
				expanded.add("");
				cachedRows = undefined;
			},
			load,
			isExpanded: (path) => expanded.has(path),
			setExpanded,
			reveal,
			invalidate,
			entries,
			rows,
		};
	}
	window.explorer.fileTree = fileTree;
})();
