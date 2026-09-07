import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	applyProfile,
	deriveWorkerLabel,
	loadProfile,
	PROFILE_MAX_BYTES,
	profileMessage,
	profileSnapshot,
} from "./profiles.ts";

function fixture(run: (root: string, path: string) => void) {
	const root = mkdtempSync(join(tmpdir(), "profile-test-"));
	try {
		mkdirSync(join(root, "config"));
		run(root, join(root, "config", "check.json"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

describe("explicit dispatch profiles", () => {
	it("resolves source and cwd paths from the selected file, with exact byte identity", () =>
		fixture((root, path) => {
			const raw = JSON.stringify({
				model: "provider/model",
				thinking: "high",
				cwd: "..",
				grounding: [{ name: "Checks", path: "../checks.md" }],
			});
			writeFileSync(path, raw);
			const selected = loadProfile("config/check.json", root);
			assert.equal(selected.path, path);
			assert.equal(selected.cwd, root);
			assert.deepEqual(selected.grounding, [{ name: "Checks", path: join(root, "checks.md") }]);
			assert.equal(selected.sha256, createHash("sha256").update(raw).digest("hex"));
			assert.deepEqual(profileSnapshot(JSON.parse(JSON.stringify(selected))), selected);
			writeFileSync(path, "{}");
			assert.equal(selected.model, "provider/model");
			assert.notEqual(loadProfile(path, root).sha256, selected.sha256);
			rmSync(path);
			assert.deepEqual(profileSnapshot(selected), selected, "stored metadata never reopens the profile");
		}));

	it("keeps task, dispatch, profile and inherited defaults in order without touching tools", () =>
		fixture((root, path) => {
			writeFileSync(path, JSON.stringify({ model: "profile", thinking: "high", cwd: ".." }));
			const profile = loadProfile(path, root);
			assert.deepEqual(applyProfile({ model: "task", tools: [] }, { model: "dispatch", thinking: "low" }, profile), {
				model: "task",
				thinking: "low",
				cwd: root,
				tools: [],
			});
			assert.equal(applyProfile({}, { model: "dispatch" }, profile).model, "dispatch");
			assert.equal(applyProfile({}, {}, profile).model, "profile");
			assert.equal("tools" in applyProfile({}, {}, profile), false);
			assert.deepEqual(applyProfile({}, {}), { model: undefined, thinking: undefined, cwd: undefined });
		}));

	it("rejects unsupported instruction, permission and resource fields", () =>
		fixture((root, path) => {
			for (const value of [
				null,
				[],
				{ tools: [] },
				{ systemPrompt: "role" },
				{ resources: {} },
				{ extends: "base" },
				{ model: 2 },
				{ thinking: "smart" },
				{ cwd: "" },
				{ model: "x\u001b" },
				{ grounding: {} },
				{ grounding: Array(17).fill({ name: "n", path: "p" }) },
				{ grounding: [{ name: "n", path: "p", content: "text" }] },
				{ grounding: [{ name: "", path: "p" }] },
				{ grounding: [{ name: "n", path: "" }] },
			]) {
				writeFileSync(path, JSON.stringify(value));
				assert.throws(() => loadProfile(path, root), /Profile /);
			}
		}));

	it("bounds file reads and errors without exposing parser input", () =>
		fixture((root, path) => {
			writeFileSync(path, "sensitive-invalid-json");
			assert.throws(
				() => loadProfile(path, root),
				(error: Error) =>
					!error.message.includes("sensitive-invalid-json") && error.message.includes("valid UTF-8 JSON"),
			);
			writeFileSync(path, Buffer.from([0xff]));
			assert.throws(() => loadProfile(path, root), /valid UTF-8 JSON/);
			writeFileSync(path, " ".repeat(PROFILE_MAX_BYTES + 1));
			assert.throws(() => loadProfile(path, root), /exceeds/);
			writeFileSync(path, `{${" ".repeat(PROFILE_MAX_BYTES - 2)}}`);
			assert.deepEqual(loadProfile(path, root).grounding, []);
			assert.throws(() => loadProfile(root, root), /regular file/);
			assert.throws(() => loadProfile("missing", root), /ENOENT/);
			assert.throws(() => loadProfile("", root), /non-empty/);
		}));

	it("rejects individual resolved paths that exceed the retained path limit", () =>
		fixture((root, path) => {
			for (const config of [{ grounding: [{ name: "Source", path: "a".repeat(4096) }] }, { cwd: "a".repeat(4096) }]) {
				writeFileSync(path, JSON.stringify(config));
				assert.throws(() => loadProfile(path, root), /at most 4096/);
			}
		}));

	it("bounds the resolved snapshot as well as the input file", () =>
		fixture((root, path) => {
			const grounding = Array.from({ length: 16 }, () => ({ name: "Source", path: "a".repeat(970) }));
			const raw = JSON.stringify({ grounding });
			assert.ok(Buffer.byteLength(raw) < PROFILE_MAX_BYTES);
			writeFileSync(path, raw);
			assert.throws(() => loadProfile(path, root), /Resolved profile exceeds/);
			assert.equal(
				profileSnapshot({ path, sha256: "a".repeat(64), grounding, padding: "x".repeat(PROFILE_MAX_BYTES) }),
				undefined,
			);
		}));

	it("marks pointers as unverified input and rejects corrupt retained metadata", () =>
		fixture((root, path) => {
			writeFileSync(path, JSON.stringify({ grounding: [{ name: "Source", path: "missing.md" }] }));
			const profile = loadProfile(path, root);
			assert.match(profileMessage(profile).content, /not operator authority/);
			assert.match(profileMessage(profile).content, /not loaded or verified/);
			assert.equal(profileSnapshot(undefined), undefined);
			assert.equal(profileSnapshot({ ...profile, sha256: "invalid" }), undefined);
			assert.equal(profileSnapshot({ ...profile, path: "relative" }), undefined);
			assert.equal(profileSnapshot({ ...profile, tools: [] }), undefined);
		}));

	it("accepts a name of one word or a short kebab phrase and stores it on the snapshot only", () =>
		fixture((root, path) => {
			for (const name of ["review", "review-check", "a1-b2", "a".repeat(64)]) {
				writeFileSync(path, JSON.stringify({ name, model: "provider/model" }));
				const profile = loadProfile(path, root);
				assert.equal(profile.name, name);
				assert.deepEqual(profileSnapshot(JSON.parse(JSON.stringify(profile))), profile);
			}
			// The name never leaks into applied defaults.
			writeFileSync(path, JSON.stringify({ name: "review-check", model: "provider/model" }));
			const profile = loadProfile(path, root);
			assert.equal("name" in applyProfile({}, {}, profile), false);
			assert.equal(applyProfile({}, {}, profile).model, "provider/model");
		}));

	it("rejects invalid names without echoing input", () =>
		fixture((root, path) => {
			for (const name of ["", " ", "a_b", "-lead", "trail-", "a--b", "a b", "x\u001b", "a".repeat(65)]) {
				writeFileSync(path, JSON.stringify({ name }));
				assert.throws(() => loadProfile(path, root), (error: Error) => {
					const echoed = name.trim();
					return echoed === "" || !error.message.includes(echoed);
				});
			}
		}));

	it("derives bounded worker labels from task text", () => {
		assert.equal(deriveWorkerLabel("Verify the parser output", 1), "verify-the-parser#1");
		assert.equal(deriveWorkerLabel("  Verify\tParser   Output  ", 2), "verify-parser-output#2");
		assert.equal(deriveWorkerLabel("VERIFY_PARSER!", 3), "verifyparser#3");
		assert.equal(deriveWorkerLabel("a very long task description that exceeds limits", 4), "a-very-long#4");
		assert.equal(deriveWorkerLabel("!!!", 5), "worker#5");
		assert.equal(deriveWorkerLabel("", 6), "worker#6");
		assert.ok(deriveWorkerLabel("x".repeat(100), 7).length <= 40);
		assert.match(deriveWorkerLabel("review checks", 8), /^[a-z0-9-]+#8$/);
	});
});
