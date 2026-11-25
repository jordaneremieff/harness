import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import {
	RECIPIENT_HINT_PAGE,
	RecipientHintWriter,
	readRecipientHint,
	readRecipientHints,
	recipientHintPath,
	recipientHintsRoot,
} from "./recipient-hints.ts";

function root(t: TestContext): string {
	const directory = mkdtempSync(join(tmpdir(), "recipient-hints-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function sourceList(sessionsRoot: string, source: string): string[] | undefined {
	const path = join(recipientHintsRoot(sessionsRoot), ".sources", `${source}.json`);
	if (!existsSync(path)) return undefined;
	return (JSON.parse(readFileSync(path, "utf8")) as { recipients: string[] }).recipients;
}

it("publishes one private hint per recipient storage and reads only that recipient's directory", (t) => {
	const sessionsRoot = root(t);
	const source = randomUUID(),
		owner = randomUUID(),
		other = randomUUID();
	const writer = new RecipientHintWriter(sessionsRoot, source);
	assert.deepEqual(
		[
			...writer.publish(
				new Map([
					[owner, true],
					[other, false],
					[source, true],
				]),
			),
		].sort(),
		[owner, other].sort(),
	);
	assert.deepEqual(readRecipientHints(sessionsRoot, owner).hints, [{ source, execution: true }]);
	assert.deepEqual(readRecipientHints(sessionsRoot, other).hints, [{ source, execution: false }]);
	assert.equal(readRecipientHint(sessionsRoot, source, source), undefined, "a source holds no hint for itself");
	assert.deepEqual(readRecipientHints(sessionsRoot, randomUUID()), { hints: [], invalid: [] });
	assert.equal(statSync(recipientHintPath(sessionsRoot, owner, source)).mode & 0o777, 0o600);
	assert.equal(statSync(join(recipientHintsRoot(sessionsRoot), owner)).mode & 0o777, 0o700);
	assert.deepEqual(sourceList(sessionsRoot, source), [owner, other].sort());
});

it("withdraws hints that a later publication omits, also from a new writer of the same source", (t) => {
	const sessionsRoot = root(t);
	const source = randomUUID(),
		owner = randomUUID(),
		other = randomUUID();
	new RecipientHintWriter(sessionsRoot, source).publish(
		new Map([
			[owner, true],
			[other, false],
		]),
	);
	const next = new RecipientHintWriter(sessionsRoot, source);
	assert.deepEqual(next.publish(new Map([[owner, false]])), [owner, other]);
	assert.deepEqual(readRecipientHints(sessionsRoot, owner).hints, [{ source, execution: false }]);
	assert.equal(existsSync(recipientHintPath(sessionsRoot, other, source)), false);
	assert.deepEqual(sourceList(sessionsRoot, source), [owner]);
	assert.deepEqual(next.publish(new Map()), [owner]);
	assert.equal(sourceList(sessionsRoot, source), undefined);
	assert.deepEqual(next.publish(new Map()), [], "an unchanged publication writes nothing");
});

it("stages demand without lowering execution, and lists the recipient before its hint exists", (t) => {
	const sessionsRoot = root(t);
	const source = randomUUID(),
		owner = randomUUID();
	const writer = new RecipientHintWriter(sessionsRoot, source);
	assert.deepEqual(writer.stage(new Map([[owner, true]])), [owner]);
	assert.deepEqual(writer.stage(new Map([[owner, false]])), [], "staging never lowers execution demand");
	assert.equal(readRecipientHint(sessionsRoot, owner, source)?.execution, true);
	assert.deepEqual(sourceList(sessionsRoot, source), [owner]);
	// A source list that names a recipient without its file is the state a crash before the file write leaves.
	const late = randomUUID();
	const listed = new RecipientHintWriter(sessionsRoot, source);
	writeFileSync(
		join(recipientHintsRoot(sessionsRoot), ".sources", `${source}.json`),
		`${JSON.stringify({ format: "agent.recipient-hint-sources/1", recipients: [late, owner] })}\n`,
		{ mode: 0o600 },
	);
	assert.deepEqual(listed.publish(new Map([[owner, true]])), []);
	assert.deepEqual(sourceList(sessionsRoot, source), [owner]);
});

it("refuses to publish a hint when its directory cannot be written, so the admission that needs it fails", (t) => {
	const sessionsRoot = root(t);
	const source = randomUUID(),
		owner = randomUUID();
	mkdirSync(recipientHintsRoot(sessionsRoot), { recursive: true, mode: 0o700 });
	chmodSync(recipientHintsRoot(sessionsRoot), 0o500);
	try {
		assert.throws(() => new RecipientHintWriter(sessionsRoot, source).stage(new Map([[owner, true]])), /EACCES/u);
		assert.equal(readRecipientHint(sessionsRoot, owner, source), undefined);
	} finally {
		chmodSync(recipientHintsRoot(sessionsRoot), 0o700);
	}
});

it("reports a malformed or linked hint as invalid and grants nothing from it", (t) => {
	const sessionsRoot = root(t);
	const owner = randomUUID(),
		good = randomUUID(),
		bad = randomUUID(),
		linked = randomUUID(),
		mismatched = randomUUID();
	new RecipientHintWriter(sessionsRoot, good).publish(new Map([[owner, false]]));
	const directory = join(recipientHintsRoot(sessionsRoot), owner);
	writeFileSync(join(directory, `${bad}.json`), "{not json", { mode: 0o600 });
	writeFileSync(join(directory, "elsewhere.json"), readFileSync(recipientHintPath(sessionsRoot, owner, good)));
	symlinkSync(join(directory, "elsewhere.json"), join(directory, `${linked}.json`));
	writeFileSync(
		join(directory, `${mismatched}.json`),
		`${JSON.stringify({ format: "agent.recipient-hint/1", source: good, execution: true })}\n`,
		{ mode: 0o600 },
	);
	writeFileSync(join(directory, "notes.txt"), "ignored");
	const page = readRecipientHints(sessionsRoot, owner);
	assert.deepEqual(page.hints, [{ source: good, execution: false }]);
	assert.deepEqual(
		page.invalid.map((item) => item.path).sort(),
		[bad, linked, mismatched].map((id) => join(directory, `${id}.json`)).sort(),
	);
});

it("rejects identities that are not exact storage identities before they become path parts", (t) => {
	const sessionsRoot = root(t);
	assert.throws(() => new RecipientHintWriter(sessionsRoot, "../escape"), /Invalid Durable agent identity/u);
	assert.throws(() => readRecipientHints(sessionsRoot, `${randomUUID()}:4`), /exact storage identity/u);
	assert.throws(() => recipientHintPath(sessionsRoot, randomUUID(), "x/y"), /Invalid Durable agent identity/u);
});

it("pages a recipient directory in name order", (t) => {
	const sessionsRoot = root(t);
	const owner = randomUUID();
	const sources = Array.from({ length: RECIPIENT_HINT_PAGE + 3 }, () => randomUUID()).sort();
	for (const source of sources) new RecipientHintWriter(sessionsRoot, source).publish(new Map([[owner, false]]));
	const first = readRecipientHints(sessionsRoot, owner);
	assert.equal(first.hints.length, RECIPIENT_HINT_PAGE);
	assert.ok(first.next);
	const second = readRecipientHints(sessionsRoot, owner, { after: first.next });
	assert.equal(second.next, undefined);
	assert.deepEqual(
		[...first.hints, ...second.hints].map((hint) => hint.source),
		sources,
	);
});
