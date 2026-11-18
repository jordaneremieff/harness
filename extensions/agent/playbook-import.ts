import { linkSync, mkdirSync, mkdtempSync, opendirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { IMPORT_LOCK_PREFIX, IMPORT_PREFIX, playbookLocation, readBundledPlaybook, readPlaybookCatalog } from "./playbook-catalog.ts";
import {
	entry, hasCode, inspectPlaybookRoot, playbookText, readPlaybookFile, requirePrivateDirectory, safeLabel,
	sameEntry, sameRoot, sameVersion, syncPlaybookDirectory, writeNewPlaybookFile, type PlaybookRoot,
} from "./playbook-files.ts";

export type PlaybookImportPreview = Readonly<{
	name: string;
	currentText: string | null;
	starterText: string;
	action: "add" | "replace" | "unchanged";
}>;
type Source = ReturnType<typeof readPlaybookFile>;
type Review = { binding: string; root: PlaybookRoot; current: Source | undefined; starter: ReturnType<typeof readBundledPlaybook> };
// A preview is one in-process review, not a writable token or a second public command.
const reviews = new WeakMap<PlaybookImportPreview, Review>();

function currentFile(root: PlaybookRoot, name: string): Source | undefined {
	const path = join(root.physical, name);
	if (!entry(path)) return undefined;
	const listing = opendirSync(root.physical);
	try {
		for (let visited = 0; visited <= 512; visited++) {
			const item = listing.readSync();
			if (!item) break;
			if (item.name === name) return readPlaybookFile(path);
		}
	} finally { listing.closeSync(); }
	throw new Error("Import target does not have the exact reviewed filename.");
}

function observe(agentDir: string, name: string): Review {
	const starter = readBundledPlaybook(name);
	const location = playbookLocation(agentDir);
	if (location.invalid) throw new Error("Correct the playbooksDir setting before importing.");
	const initial = inspectPlaybookRoot(location.dir);
	const catalog = readPlaybookCatalog(agentDir);
	if (catalog.state !== "ready" || !initial)
		throw new Error(`Import requires a complete catalog. Catalog is ${catalog.state}; use /agent playbook to inspect or initialise it first.`);
	const current = currentFile(initial, `${name}.md`);
	if (!sameRoot(initial, inspectPlaybookRoot(location.dir))) throw new Error("Catalog directory changed. Preview again.");
	return { binding: location.binding, root: initial, current, starter };
}

export function previewPlaybookImport(agentDir: string, name: string): PlaybookImportPreview {
	const review = observe(agentDir, name);
	const currentText = review.current ? playbookText(review.current.bytes) : null;
	const action = !review.current ? "add" : review.current.digest === review.starter.digest ? "unchanged" : "replace";
	const preview = Object.freeze({ name, currentText, starterText: review.starter.text, action });
	reviews.set(preview, review);
	return preview;
}

function validateReview(agentDir: string, name: string, expected: Review): void {
	const actual = observe(agentDir, name);
	if (actual.binding !== expected.binding || !sameRoot(expected.root, actual.root) || actual.starter.digest !== expected.starter.digest
		|| actual.current?.digest !== expected.current?.digest || (expected.current && !sameVersion(expected.current.stat, actual.current?.stat)))
		throw new Error("The reviewed catalog, file or bundled starter changed. Preview again.");
}

function stillOwnRoot(root: PlaybookRoot): boolean {
	try { return sameRoot(root, inspectPlaybookRoot(root.dir)); }
	catch { return false; }
}

export function applyPlaybookImport(agentDir: string, preview: PlaybookImportPreview): string {
	const review = reviews.get(preview);
	if (!review) throw new Error("Make and review a fresh import preview first.");
	validateReview(agentDir, preview.name, review);
	if (preview.action === "unchanged") return `Playbook ${preview.name} already matches its bundled starter. No file changed.`;
	const { root } = review;
	if (!sameEntry(root.parentStat, requirePrivateDirectory(root.parent)) || !sameEntry(root.physicalStat, requirePrivateDirectory(root.physical)) || !stillOwnRoot(root))
		throw new Error("Catalog changed or is not in an operator-controlled directory.");
	const target = join(root.physical, `${preview.name}.md`);
	const lock = join(root.physical, `${IMPORT_LOCK_PREFIX}${preview.name}`);
	try { mkdirSync(lock, { mode: 0o700 }); }
	catch (error) {
		if (hasCode(error, "EEXIST")) throw new Error(`An import is active or interrupted. Inspect ${safeLabel(lock)} and its recovery data before retrying.`);
		throw new Error("Could not claim the import lock, so no playbook was changed.");
	}
	const lockStat = requirePrivateDirectory(lock);
	let slot: string | undefined;
	let capture: string | undefined;
	let moved = false;
	let published = false;
	try {
		validateReview(agentDir, preview.name, review);
		slot = mkdtempSync(join(root.physical, `${IMPORT_PREFIX}${preview.name}-`));
		const staged = join(slot, "starter");
		capture = join(slot, "previous");
		const intent = join(slot, "intent.json");
		writeNewPlaybookFile(staged, review.starter.bytes);
		writeNewPlaybookFile(intent, Buffer.from(JSON.stringify({ target: `${preview.name}.md`, reviewed: review.current?.digest ?? null, starter: review.starter.digest })));
		syncPlaybookDirectory(slot);
		syncPlaybookDirectory(root.physical);
		validateReview(agentDir, preview.name, review);
		if (review.current) {
			// Move away from the live name. The capture is the actual inode a concurrent editor left there.
			renameSync(target, capture);
			moved = true;
			const displaced = readPlaybookFile(capture);
			if (!sameEntry(review.current.stat, displaced.stat) || review.current.digest !== displaced.digest)
				throw new Error("The file changed at the import boundary.");
			syncPlaybookDirectory(slot);
		}
		if (!stillOwnRoot(root)) throw new Error("Catalog directory changed during import.");
		const stagedFile = readPlaybookFile(staged);
		if (stagedFile.digest !== review.starter.digest) throw new Error("Staged starter changed during import.");
		// A competing editor may fill the live name after validation, including after capture.
		linkSync(staged, target);
		published = true;
		syncPlaybookDirectory(root.physical);
		const installed = readPlaybookFile(target);
		if (!stillOwnRoot(root) || !sameEntry(stagedFile.stat, installed.stat) || installed.digest !== review.starter.digest) throw new Error("The live file changed after publication.");
		unlinkSync(staged);
		if (!moved) { unlinkSync(intent); rmdirSync(slot); }
		return moved ? `Replaced ${preview.name}. Previous file retained at ${safeLabel(capture)}.` : `Added ${preview.name}.`;
	} catch (error) {
		let restored = false;
		if (!published && moved && capture && stillOwnRoot(root)) {
			try {
				if (entry(capture)?.isFile()) { linkSync(capture, target); restored = true; syncPlaybookDirectory(root.physical); }
			} catch { /* An occupied or inaccessible live name is left alone. */ }
		}
		const reason = hasCode(error, "EEXIST") ? "Another entry occupies the live name." : error instanceof Error && !("code" in error) ? error.message : "A filesystem operation failed.";
		const recovery = slot ? ` Recovery data: ${safeLabel(slot)}.` : "";
		throw new Error(`${published ? "The starter was published but final verification failed." : "Import did not publish the starter."} ${reason}${restored ? " The displaced file was restored without overwriting another entry." : ""}${recovery} Inspect ${safeLabel(target)} before retrying.`);
	} finally {
		try { if (stillOwnRoot(root) && sameEntry(lockStat, entry(lock))) rmdirSync(lock); }
		catch { /* A retained lock is visible as an interrupted import on the next catalog read. */ }
	}
}
