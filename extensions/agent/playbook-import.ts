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

interface ImportAttempt {
	slot?: string;
	moved: boolean;
	published: boolean;
}

function claimImport(root: PlaybookRoot, name: string) {
	if (!sameEntry(root.parentStat, requirePrivateDirectory(root.parent)) || !sameEntry(root.physicalStat, requirePrivateDirectory(root.physical)) || !stillOwnRoot(root))
		throw new Error("Catalog changed or is not in an operator-controlled directory.");
	const lock = join(root.physical, `${IMPORT_LOCK_PREFIX}${name}`);
	try { mkdirSync(lock, { mode: 0o700 }); }
	catch (error) {
		if (hasCode(error, "EEXIST")) throw new Error(`An import is active or interrupted. Inspect ${safeLabel(lock)} and its recovery data before retrying.`);
		throw new Error("Could not claim the import lock, so no playbook was changed.");
	}
	const lockStat = requirePrivateDirectory(lock);
	return () => {
		try { if (stillOwnRoot(root) && sameEntry(lockStat, entry(lock))) rmdirSync(lock); }
		catch { /* A retained lock is visible as an interrupted import on the next catalog read. */ }
	};
}

function stageImport(slot: string, name: string, review: Review): void {
	writeNewPlaybookFile(join(slot, "starter"), review.starter.bytes);
	writeNewPlaybookFile(join(slot, "intent.json"), Buffer.from(JSON.stringify({ target: `${name}.md`, reviewed: review.current?.digest ?? null, starter: review.starter.digest })));
	syncPlaybookDirectory(slot);
	syncPlaybookDirectory(review.root.physical);
}

function publishImport(review: Review, target: string, slot: string, attempt: ImportAttempt): void {
	if (review.current) {
		// The capture is the actual inode a concurrent editor left at the live name.
		const capture = join(slot, "previous");
		renameSync(target, capture);
		attempt.moved = true;
		const displaced = readPlaybookFile(capture);
		if (!sameEntry(review.current.stat, displaced.stat) || review.current.digest !== displaced.digest)
			throw new Error("The file changed at the import boundary.");
		syncPlaybookDirectory(slot);
	}
	if (!stillOwnRoot(review.root)) throw new Error("Catalog directory changed during import.");
	const staged = join(slot, "starter");
	const stagedFile = readPlaybookFile(staged);
	if (stagedFile.digest !== review.starter.digest) throw new Error("Staged starter changed during import.");
	// Linking, not renaming, preserves a competing editor's new entry at the target.
	linkSync(staged, target);
	attempt.published = true;
	syncPlaybookDirectory(review.root.physical);
	const installed = readPlaybookFile(target);
	if (!stillOwnRoot(review.root) || !sameEntry(stagedFile.stat, installed.stat) || installed.digest !== review.starter.digest)
		throw new Error("The live file changed after publication.");
	unlinkSync(staged);
	if (!attempt.moved) { unlinkSync(join(slot, "intent.json")); rmdirSync(slot); }
}

function restoreDisplaced(root: PlaybookRoot, target: string, attempt: ImportAttempt): boolean {
	if (attempt.published || !attempt.moved || !attempt.slot || !stillOwnRoot(root)) return false;
	const capture = join(attempt.slot, "previous");
	try {
		if (!entry(capture)?.isFile()) return false;
		linkSync(capture, target);
	} catch { return false; } // An occupied or inaccessible live name is left alone.
	try { syncPlaybookDirectory(root.physical); } catch { /* The no-replace link succeeded. */ }
	return true;
}

function importFailure(root: PlaybookRoot, target: string, attempt: ImportAttempt, error: unknown): Error {
	const restored = restoreDisplaced(root, target, attempt);
	const reason = hasCode(error, "EEXIST") ? "Another entry occupies the live name." : error instanceof Error && !("code" in error) ? error.message : "A filesystem operation failed.";
	const recovery = attempt.slot ? ` Recovery data: ${safeLabel(attempt.slot)}.` : "";
	return new Error(`${attempt.published ? "The starter was published but final verification failed." : "Import did not publish the starter."} ${reason}${restored ? " The displaced file was restored without overwriting another entry." : ""}${recovery} Inspect ${safeLabel(target)} before retrying.`);
}

export function applyPlaybookImport(agentDir: string, preview: PlaybookImportPreview): string {
	const review = reviews.get(preview);
	if (!review) throw new Error("Make and review a fresh import preview first.");
	validateReview(agentDir, preview.name, review);
	if (preview.action === "unchanged") return `Playbook ${preview.name} already matches its bundled starter. No file changed.`;
	const { root } = review;
	const target = join(root.physical, `${preview.name}.md`);
	const release = claimImport(root, preview.name);
	const attempt: ImportAttempt = { moved: false, published: false };
	try {
		validateReview(agentDir, preview.name, review);
		const slot = mkdtempSync(join(root.physical, `${IMPORT_PREFIX}${preview.name}-`));
		attempt.slot = slot;
		stageImport(slot, preview.name, review);
		validateReview(agentDir, preview.name, review);
		publishImport(review, target, slot, attempt);
		return attempt.moved ? `Replaced ${preview.name}. Previous file retained at ${safeLabel(join(slot, "previous"))}.` : `Added ${preview.name}.`;
	} catch (error) {
		throw importFailure(root, target, attempt, error);
	} finally { release(); }
}
