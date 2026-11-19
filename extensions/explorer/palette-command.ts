import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { isRecord } from "./live-protocol.ts";
import { recentRoots } from "./notes-store.ts";
import { paneLaunch } from "./pane-command.ts";
import { resolveTarget } from "./repository.ts";

export async function paletteStep(args: string[]) {
	const [dir, app, json] = args;
	if (args.length !== 3 || !isAbsolute(dir) || !isAbsolute(app) || json.length > 16384)
		return { error: "The Explorer palette request is invalid." };
	try {
		const request: unknown = JSON.parse(json);
		if (
			!isRecord(request) ||
			request.version !== 1 ||
			request.command !== "explorer.folder" ||
			!isRecord(request.context) ||
			!Array.isArray(request.answers)
		)
			return { error: "The Explorer palette request is invalid." };
		const roots = (await recentRoots(dir))
			.slice(0, 100)
			.map((root) => ({ ...root, id: createHash("sha256").update(root.path).digest("hex").slice(0, 32) }));
		const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ");
		if (request.answers.length === 0) {
			if (!roots.length) return { error: "There are no recent folders. Open a folder with /explorer first." };
			return {
				ask: {
					kind: "pick",
					prompt: {
						title: "Explore a folder",
						items: roots.map(({ id, label, path }) => ({
							id,
							title: Array.from(clean(label)).slice(0, 120).join(""),
							subtitle: Array.from(clean(path)).slice(0, 220).join(""),
						})),
					},
				},
			};
		}
		const [answer] = request.answers;
		const selected = roots.find(({ id }) => answer === id);
		if (!selected || request.answers.length !== 1)
			return { error: "This folder is no longer in Explorer's recent list." };
		const { repo } = await resolveTarget(selected.path, selected.path);
		const pane = await paneLaunch(app, dir, { root: repo.root });
		if ("showUnavailable" in pane) return { error: pane.showUnavailable };
		return {
			show: {
				argv: pane.show,
				label: Array.from(clean(repo.label)).slice(0, 32).join("") || "Explorer",
				cwd: repo.root,
				placement: "right",
			},
		};
	} catch {
		return { error: "The selected folder or Explorer store is unavailable." };
	}
}

if (import.meta.main) process.stdout.write(`${JSON.stringify(await paletteStep(process.argv.slice(2)))}\n`);
