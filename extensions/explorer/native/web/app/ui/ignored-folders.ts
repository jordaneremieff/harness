(() => {
	type FolderReply = ExplorerRequests["files.folder"][1];
	type Folder = {
		data?: FolderReply;
		error?: string;
		pending: boolean;
		stale: boolean;
	};
	function ignoredFolders(list: (path: string) => Promise<FolderReply>, changed: () => void) {
		let roots = new Set<string>();
		const folders = new Map<string, Folder>();
		function contains(path: string, includeSelf = true) {
			if (includeSelf && roots.has(path)) return true;
			for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
				if (roots.has(path.slice(0, i))) return true;
			}
			return false;
		}
		function replace(paths: string[]) {
			roots = new Set(paths.filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1)));
			for (const path of folders.keys()) if (!contains(path)) folders.delete(path);
		}
		function invalidate(paths: string[]) {
			const affected = new Set(paths);
			const parents = new Set(paths.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/")))));
			const stale: string[] = [];
			for (const [folder, state] of folders) {
				let target = folder;
				while (target && !affected.has(target)) target = target.slice(0, Math.max(0, target.lastIndexOf("/")));
				if (!paths.length || target || parents.has(folder)) {
					state.stale = true;
					stale.push(folder);
				}
			}
			return stale;
		}
		function pruneMissingChildren(path: string, entries: FolderReply["entries"]) {
			const children = new Set(entries.filter((child) => child.kind === "folder").map((child) => child.name));
			const prefix = `${path}/`;
			for (const key of folders.keys()) {
				if (key.startsWith(prefix) && !children.has(key.slice(prefix.length).split("/", 1)[0])) folders.delete(key);
			}
		}
		function orderEntries(a: FolderReply["entries"][number], b: FolderReply["entries"][number]) {
			if (a.kind === b.kind) return a.name.localeCompare(b.name);
			return a.kind === "folder" ? -1 : 1;
		}
		function get(path: string) {
			let state = folders.get(path);
			if (!state) {
				state = { pending: false, stale: true };
				folders.set(path, state);
			}
			if (state.stale && !state.pending) {
				const entry = state;
				entry.stale = false;
				entry.pending = true;
				entry.error = undefined;
				void list(path)
					.then((data) => {
						if (folders.get(path) !== entry) return;
						if (entry.data && !data.truncated) pruneMissingChildren(path, data.entries);
						entry.data = { ...data, entries: [...data.entries].sort(orderEntries) };
					})
					.catch((error: unknown) => {
						entry.error = error instanceof Error ? error.message : "The folder could not be listed.";
					})
					.finally(() => {
						entry.pending = false;
						if (folders.get(path) === entry) changed();
					});
			}
			return state;
		}
		function retryOnOpen(path: string) {
			const state = folders.get(path);
			if (state?.error) state.stale = true;
		}
		function loaded() {
			return [...folders].flatMap(([path, state]) =>
				(state.data?.entries ?? []).map(({ name, kind }) => `${path}/${name}${kind === "folder" ? "/" : ""}`),
			);
		}
		return { replace, contains, invalidate, get, retryOnOpen, loaded };
	}
	window.explorer.ignoredFolders = ignoredFolders;
})();
