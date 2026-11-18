import { mkdirSync, opendirSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	backingName, ensurePublishParent, entry, hasCode, inspectPlaybookRoot, playbookName,
	playbookText, readPlaybookFile, requirePrivateDirectory, safeLabel, sameEntry, sameRoot,
	syncPlaybookDirectory, writeNewPlaybookFile, type PlaybookRoot,
} from "./playbook-files.ts";
import { readSettings } from "./settings.ts";

export type Playbook = { readonly name: string; readonly summary: string; readonly body: string };
export type PlaybookCatalog = {
	readonly dir: string;
	readonly state: "ready" | "missing" | "unavailable" | "incomplete";
	readonly entries: readonly Playbook[];
	readonly diagnostics: readonly string[];
	readonly backingDir?: string;
};
const starters = ["architect", "maker", "orchestrator"] as const;
const MAX_VISITED = 512;
const MAX_CANDIDATES = 128;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS = 64;
export const IMPORT_PREFIX = ".playbook-import-";
export const IMPORT_LOCK_PREFIX = ".playbook-lock-";

function parsePlaybook(name: string, text: string): Playbook {
	const [heading, firstBlank, summary, secondBlank, ...bodyLines] = text.replace(/\r\n/gu, "\n").split("\n");
	if (heading !== `# ${name}`) throw new Error(`line 1: expected # ${name}`);
	if (firstBlank !== "" || secondBlank !== "") throw new Error("expected blank lines on lines 2 and 4");
	if (!summary?.trim() || summary.includes("\t") || Array.from(summary).length > 160) throw new Error("line 3: expected one summary of at most 160 characters, without tabs");
	const body = bodyLines.join("\n").trim();
	if (!body) throw new Error("line 5: expected a nonempty body");
	return { name, summary: summary.trim(), body };
}

export function readBundledPlaybook(name: string) {
	if (!starters.some((starter) => starter === name)) throw new Error("Choose the exact name of a bundled starter.");
	const source = readPlaybookFile(fileURLToPath(new URL(`./playbooks/${name}.md`, import.meta.url)));
	const text = playbookText(source.bytes);
	return { ...source, text, playbook: parsePlaybook(name, text) };
}

export function bundledPlaybooks(): readonly Playbook[] {
	return starters.flatMap((name) => {
		try { return [readBundledPlaybook(name).playbook]; }
		catch { return []; } // A damaged installation cannot seed but its intact starters remain inspectable.
	});
}

export function playbookLocation(agentDir: string) {
	const { values, records, source, diagnostics } = readSettings({ agentDir });
	const record = records.find(({ key }) => key === "playbooksDir");
	const invalid = record?.status === "invalid" || (record?.origin !== "env" && (source.status === "invalid" || source.status === "unavailable" || diagnostics.some(({ field, code }) => field === "agent" && code === "invalid")));
	return { dir: values.playbooksDir, invalid, binding: `${source.path}\0${record?.origin ?? "default"}`, presets: values.presets };
}

function publishSeed(dir: string): string | undefined {
	const files = starters.map((name) => ({ name: `${name}.md`, source: readBundledPlaybook(name) }));
	const parent = ensurePublishParent(dirname(dir));
	const actual = join(parent, basename(dir));
	if (entry(actual)) return undefined;
	const parentStat = requirePrivateDirectory(parent);
	const backing = join(parent, backingName(dir));
	try { mkdirSync(backing, { mode: 0o700 }); }
	catch (error) {
		if (!hasCode(error, "EEXIST")) throw error;
		if (entry(actual)) return undefined;
		return `Data directory ${safeLabel(backing)} is already present without a catalog link. A seed may be in progress or interrupted; inspect the directory and retry. It was not changed.`;
	}
	const backingStat = requirePrivateDirectory(backing);
	const written = new Map<string, ReturnType<typeof readPlaybookFile>>();
	let published = false;
	try {
		for (const { name, source } of files) {
			writeNewPlaybookFile(join(backing, name), source.bytes);
			const verified = readPlaybookFile(join(backing, name));
			if (verified.digest !== source.digest) throw new Error("staged file differs from its starter");
			written.set(name, verified);
		}
		syncPlaybookDirectory(backing);
		if (!sameEntry(parentStat, requirePrivateDirectory(parent)) || !sameEntry(parentStat, statSync(dirname(dir), { bigint: true })) || !sameEntry(backingStat, entry(backing)))
			throw new Error("seed directory identity changed");
		symlinkSync(backingName(dir), actual);
		published = true;
		try { syncPlaybookDirectory(parent); }
		catch { return "The catalog link was published, but syncing its parent failed. Inspect the link before retrying."; }
		return undefined;
	} catch (error) {
		const winner = entry(actual);
		const raced = hasCode(error, "EEXIST") && winner !== undefined;
		// Do not clean backing bytes if another entry may already reference them.
		if (winner?.isSymbolicLink()) {
			try { if (readlinkSync(actual) === backingName(dir)) return undefined; }
			catch { return `Inspect unpublished data at ${safeLabel(backing)}; it was not removed.`; }
		}
		// Clean only files this operation wrote and verified. Never follow or remove a winning catalog.
		if (!published && sameEntry(backingStat, entry(backing))) {
			try {
				for (const [name, expected] of written) {
					const path = join(backing, name);
					const current = readPlaybookFile(path);
					if (sameEntry(expected.stat, current.stat) && current.digest === expected.digest) unlinkSync(path);
				}
				rmdirSync(backing);
			} catch { return `Seed was not applied. Inspect unpublished data at ${safeLabel(backing)}; it was retained for recovery.`; }
		}
		if (raced) return undefined;
		return `Seed was not applied. Inspect the catalog location and data directory ${safeLabel(backing)}.`;
	}
}

export function readPlaybookCatalog(agentDir: string, options: { initialize?: boolean } = {}): PlaybookCatalog {
	const { dir, invalid, presets } = playbookLocation(agentDir);
	const diagnostics: string[] = [];
	let omitted = 0;
	const note = (text: string) => { if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(text); else omitted++; };
	const finish = (state: PlaybookCatalog["state"], entries: Playbook[] = [], root?: PlaybookRoot): PlaybookCatalog => ({
		dir, state, entries, diagnostics: omitted ? [...diagnostics, `${omitted} additional diagnostics omitted.`] : diagnostics,
		...(root && root.physical !== join(root.parent, basename(dir)) ? { backingDir: root.physical } : {}),
	});
	if (invalid) note("The playbooksDir setting or its source is invalid or unavailable. Check configuration before writing the catalog.");
	try {
		let root = inspectPlaybookRoot(dir);
		if (!root && options.initialize && !invalid) {
			const issue = publishSeed(dir);
			if (issue) note(issue);
			root = inspectPlaybookRoot(dir);
			if (!root && issue) return finish("unavailable");
		}
		if (!root) {
			if (entry(join(dirname(dir), backingName(dir)))) note(`Sibling data directory ${safeLabel(backingName(dir))} exists without the catalog link. Inspect it before seeding.`);
			return finish(invalid ? "unavailable" : "missing");
		}
		const names: string[] = [];
		const listing = opendirSync(root.physical);
		try {
			for (let visited = 0;; visited++) {
				const item = listing.readSync();
				if (!item) break;
				if (visited >= MAX_VISITED) { note("Catalog inventory exceeds 512 directory entries."); return finish("incomplete", [], root); }
				if (item.name.startsWith(IMPORT_LOCK_PREFIX)) note(`${safeLabel(item.name)}: an import is active or interrupted. Inspect its recovery data before removing the lock.`);
				if (item.name.startsWith(IMPORT_PREFIX)) note(`${safeLabel(item.name)}: retained import recovery data in the catalog directory.`);
				if (item.name.startsWith(".") || !/\.md$/iu.test(item.name)) continue;
				if (names.length === MAX_CANDIDATES) { note("Catalog inventory exceeds 128 Markdown candidates."); return finish("incomplete", [], root); }
				names.push(item.name);
			}
		} finally { listing.closeSync(); }
		const entries: Playbook[] = [];
		let bytes = 0;
		for (const filename of names.sort()) {
			const name = filename.slice(0, -3);
			if (!filename.endsWith(".md") || !playbookName(name)) { note(`${safeLabel(filename)}: invalid or reserved playbook name; use a lowercase slug and .md.`); continue; }
			try {
				const file = readPlaybookFile(join(root.physical, filename));
				bytes += file.bytes.length;
				if (bytes > MAX_TOTAL_BYTES) { note("Catalog content exceeds 2 MiB."); return finish("incomplete", [], root); }
				entries.push(parsePlaybook(name, playbookText(file.bytes)));
				if (Object.hasOwn(presets, name)) note(`${safeLabel(filename)}: name also used by an execution preset; the playbook remains available.`);
			} catch (error) {
				const reason = error instanceof Error && !("code" in error) ? error.message : "file could not be read";
				note(`${safeLabel(filename)}: ${reason}.`);
			}
		}
		if (!sameRoot(root, inspectPlaybookRoot(dir))) { note("Catalog directory changed during the read."); return finish("unavailable"); }
		return finish("ready", entries, root);
	} catch (error) {
		const reason = error instanceof Error && !("code" in error) ? error.message : "directory could not be accessed";
		note(`Catalog unavailable: ${reason}.`);
		return finish("unavailable");
	}
}
