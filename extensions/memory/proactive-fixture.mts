import fs, { mkdirSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { join } from "node:path";

export function failSelectedReads(t: { after(fn: () => void): void }): { failures: () => number; restore: () => void } {
	const original = fs.readSync;
	let failures = 0;
	const replacement = ((...args: unknown[]) => {
		if (args[3] === 65537) {
			failures++;
			throw Object.assign(new Error("selected source unavailable"), { code: "EIO" });
		}
		return Reflect.apply(original, fs, args);
	}) as typeof fs.readSync;
	const interception = mock.method(fs, "readSync", replacement);
	syncBuiltinESMExports();
	const restore = () => {
		interception.mock.restore();
		syncBuiltinESMExports();
	};
	t.after(restore);
	return { failures: () => failures, restore };
}

export const recallText = "portable amber cobalt quartz violet cedar";
export function proactiveCorpus(root: string): string {
	const corpus = join(root, "corpus");
	mkdirSync(corpus);
	writeFileSync(join(corpus, "README.md"), "# Fixture corpus\n");
	for (let i = 0; i < 64; i++)
		writeFileSync(
			join(corpus, `subject-${i}.md`),
			`---\nstatus: active\nsuperseded_by: null\ntitle: Ordinary subject ${i}\n---\n## Summary\nUnrelated discovery text.\n## Details\nDetails.\n`,
		);
	writeRecall(corpus);
	return corpus;
}
export function writeRecall(corpus: string, details = "Later qualifications belong here."): void {
	writeFileSync(
		join(corpus, "portable-amber-cobalt-quartz-violet-cedar.md"),
		`---\nstatus: active\nsuperseded_by: null\ntitle: Portable amber cobalt quartz violet cedar\nreview_policy: before-use\nreview_after: 2020-01-01\n---\n## Summary\nA discovery excerpt, not the final answer.\n## Details\n${details}\n`,
	);
}
