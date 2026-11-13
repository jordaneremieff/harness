import assert from "node:assert/strict";
import { access, copyFile, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ACCOUNT, createFake, errorCode, methodCalls } from "./fake-gws.test-support.mts";
import { gwsArgv, SCOPES } from "./gws.ts";

test("gwsArgv builds the Discovery argument array without a shell", () => {
	assert.deepEqual(gwsArgv("gmail", ["users", "messages", "list"], { params: { userId: "me", q: "a b" } }), [
		"gmail",
		"users",
		"messages",
		"list",
		"--params",
		'{"userId":"me","q":"a b"}',
		"--format",
		"json",
	]);
	assert.deepEqual(
		gwsArgv("gmail", ["users", "messages", "send"], {
			params: { userId: "me" },
			body: { threadId: "t" },
			upload: "/private/message.eml",
			uploadContentType: "message/rfc822",
		}),
		[
			"gmail",
			"users",
			"messages",
			"send",
			"--params",
			'{"userId":"me"}',
			"--json",
			'{"threadId":"t"}',
			"--upload",
			"/private/message.eml",
			"--upload-content-type",
			"message/rfc822",
			"--format",
			"json",
		],
	);
});

test("the child process receives only the controlled environment and a private working directory", async () => {
	const fake = await createFake({ responses: { "gmail users labels list": { stdout: { labels: [] } } } });
	try {
		const result = await fake.tool("gmail_labels_list", {});
		assert.equal(result.status, "ok");
		const [call] = methodCalls(await fake.calls(), "gmail users labels list");
		assert.ok(call);
		assert.equal(call.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, fake.configDir);
		assert.equal(call.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND, "keyring");
		assert.equal(call.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
		assert.equal(call.env.PI_TEST_MARKER, undefined);
		await assert.rejects(access(call.env.GOOGLE_APPLICATION_CREDENTIALS));
		assert.equal(await readFile(join(call.cwd, ".env"), "utf8"), "");
	} finally {
		await fake.cleanup();
	}
});

test("a local operation does not require the subprocess environment or authentication", async () => {
	const fake = await createFake();
	try {
		delete fake.env.HOME;
		await rm(join(fake.configDir, "credentials.enc"));
		const result = await fake.runtime.run({ local: true }, undefined, async () => ({ schemaVersion: 1, status: "ok" }));
		assert.equal(result.status, "ok");
		assert.deepEqual(await fake.calls(), []);
	} finally {
		await fake.cleanup();
	}
});

test("a different gws version is refused before any Google call", async () => {
	const fake = await createFake({ version: "gws 0.23.0\n" });
	try {
		assert.equal(errorCode(await fake.tool("gmail_labels_list", {})), "BACKEND_VERSION_MISMATCH");
		assert.equal(methodCalls(await fake.calls(), "gmail").length, 0);
	} finally {
		await fake.cleanup();
	}
});

test("credential files gate authentication", async () => {
	const fake = await createFake();
	try {
		await rm(join(fake.configDir, "credentials.enc"));
		assert.equal(errorCode(await fake.tool("gmail_labels_list", {})), "AUTH_REQUIRED");
		await writeFile(join(fake.configDir, "credentials.enc"), "encrypted");
		await writeFile(join(fake.configDir, "credentials.json"), "{}");
		assert.equal(errorCode(await fake.tool("gmail_labels_list", {})), "AUTH_CONFIG_ERROR");
	} finally {
		await fake.cleanup();
	}
});

test("auth status must confirm the expected account, scopes and a valid token", async () => {
	const wrong = await createFake({ user: "other@example.com" });
	try {
		assert.equal(errorCode(await wrong.tool("gmail_labels_list", {})), "WRONG_ACCOUNT");
	} finally {
		await wrong.cleanup();
	}
	const missing = await createFake({ auth: { scopes: null, user: ACCOUNT } });
	try {
		assert.equal(errorCode(await missing.tool("gmail_labels_list", {})), "AUTH_STATUS_UNAVAILABLE");
	} finally {
		await missing.cleanup();
	}
	const invalid = await createFake({ auth: { token_valid: false, token_error: "expired" } });
	try {
		assert.equal(errorCode(await invalid.tool("gmail_labels_list", {})), "AUTH_STATUS_UNAVAILABLE");
	} finally {
		await invalid.cleanup();
	}
});

test("a changed expectedAccount setting is checked again before the next call", async () => {
	const fake = await createFake({ responses: { "gmail users labels list": { stdout: { labels: [] } } } });
	try {
		assert.equal((await fake.tool("gmail_labels_list", {})).status, "ok");
		const authCalls = methodCalls(await fake.calls(), "auth status").length;
		fake.env.PI_GOOGLE_EXPECTED_ACCOUNT = "other@example.com";
		assert.equal(errorCode(await fake.tool("gmail_labels_list", {})), "WRONG_ACCOUNT");
		assert.equal(methodCalls(await fake.calls(), "auth status").length, authCalls + 1);
		assert.equal(methodCalls(await fake.calls(), "gmail users labels list").length, 1);
	} finally {
		await fake.cleanup();
	}
});

test("an unchanged authentication context reuses its observation and profile check", async () => {
	const fake = await createFake({ responses: { "gmail users labels list": { stdout: { labels: [] } } } });
	try {
		for (let index = 0; index < 2; index++) {
			const result = await fake.runtime.run({ profile: true }, undefined, async ({ call }) => {
				await call("gmail", ["users", "labels", "list"]);
				return { schemaVersion: 1, status: "ok" };
			});
			assert.equal(result.status, "ok");
		}
		const calls = await fake.calls();
		assert.equal(methodCalls(calls, "auth status").length, 1);
		assert.equal(methodCalls(calls, "gmail users getProfile").length, 1);
		assert.equal(methodCalls(calls, "gmail users labels list").length, 2);
	} finally {
		await fake.cleanup();
	}
});

test("equal credential size and mtime do not share authentication across configurations", async () => {
	const first = await createFake();
	const second = await createFake({ user: "other@example.com" });
	try {
		const timestamp = new Date("2026-01-01T00:00:00Z");
		for (const fake of [first, second]) {
			await utimes(join(fake.configDir, "credentials.enc"), timestamp, timestamp);
		}
		const firstInfo = await stat(join(first.configDir, "credentials.enc"));
		const secondInfo = await stat(join(second.configDir, "credentials.enc"));
		assert.equal(firstInfo.size, secondInfo.size);
		assert.equal(firstInfo.mtimeMs, secondInfo.mtimeMs);
		let handled = 0;
		const run = () => first.runtime.run({ profile: true }, undefined, async ({ call }) => {
			handled++;
			await call("gmail", ["users", "getProfile"]);
			return { schemaVersion: 1, status: "ok" };
		});
		assert.equal((await run()).status, "ok");
		first.env.PI_GOOGLE_CONFIG_DIR = second.configDir;
		assert.equal(errorCode(await run()), "WRONG_ACCOUNT");
		assert.equal(handled, 1);
		assert.equal(methodCalls(await second.calls(), "auth status").length, 1);
		assert.equal(methodCalls(await second.calls(), "gmail").length, 0);
		first.env.PI_GOOGLE_EXPECTED_ACCOUNT = "other@example.com";
		assert.equal((await run()).status, "ok");
		assert.equal(handled, 2);
		const calls = await second.calls();
		assert.equal(methodCalls(calls, "auth status").length, 2);
		assert.equal(methodCalls(calls, "gmail users getProfile").length, 2);
		assert.ok(calls.every((call) => call.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR === second.configDir));
	} finally {
		await Promise.all([first.cleanup(), second.cleanup()]);
	}
});

test("replacing a credential file with equal size and mtime revalidates authentication", async () => {
	const fake = await createFake();
	try {
		const path = join(fake.configDir, "credentials.enc");
		const timestamp = new Date("2026-01-01T00:00:00Z");
		await utimes(path, timestamp, timestamp);
		assert.equal((await fake.runtime.run({}, undefined, async () => ({ schemaVersion: 1, status: "ok" }))).status, "ok");
		const replacement = join(fake.configDir, "replacement.enc");
		await writeFile(replacement, "encrypted");
		await utimes(replacement, timestamp, timestamp);
		const before = await stat(path);
		await rename(replacement, path);
		const after = await stat(path);
		assert.equal(before.size, after.size);
		assert.equal(before.mtimeMs, after.mtimeMs);
		assert.notEqual(before.ino, after.ino);
		await fake.scenario({ user: "other@example.com" });
		let handled = false;
		const result = await fake.runtime.run({}, undefined, async () => {
			handled = true;
			return { schemaVersion: 1, status: "ok" };
		});
		assert.equal(errorCode(result), "WRONG_ACCOUNT");
		assert.equal(handled, false);
		assert.equal(methodCalls(await fake.calls(), "auth status").length, 2);
	} finally {
		await fake.cleanup();
	}
});

test("executable and Keychain environment changes invalidate authentication and profile reuse", async () => {
	const fake = await createFake();
	try {
		const run = () => fake.runtime.run({ profile: true }, undefined, async () => ({ schemaVersion: 1, status: "ok" }));
		assert.equal((await run()).status, "ok");
		const executable = join(fake.root, "another-gws");
		await copyFile(fake.executable, executable);
		fake.env.PI_GOOGLE_EXECUTABLE = executable;
		assert.equal((await run()).status, "ok");
		let calls = await fake.calls();
		assert.equal(methodCalls(calls, "auth status").length, 2);
		assert.equal(methodCalls(calls, "gmail users getProfile").length, 2);
		fake.env.HOME = fake.root;
		assert.equal((await run()).status, "ok");
		calls = await fake.calls();
		assert.equal(methodCalls(calls, "auth status").length, 3);
		assert.equal(methodCalls(calls, "gmail users getProfile").length, 3);
		assert.equal(calls.at(-1)?.env.HOME, fake.root);
	} finally {
		await fake.cleanup();
	}
});

test("authentication, profile and handler calls use one captured environment", async () => {
	const fake = await createFake();
	try {
		const home = fake.env.HOME;
		let reads = 0;
		Object.defineProperty(fake.env, "HOME", { get: () => reads++ < 2 ? home : fake.root });
		const result = await fake.runtime.run({ profile: true }, undefined, async ({ call, settings }) => {
			fake.env.PI_GOOGLE_CONFIG_DIR = join(fake.root, "unselected-config");
			fake.env.PI_GOOGLE_EXECUTABLE = join(fake.root, "unselected-gws");
			assert.equal(settings.configDir, fake.configDir);
			assert.equal(settings.executable, fake.executable);
			await call("gmail", ["users", "getProfile"]);
			return { schemaVersion: 1, status: "ok" };
		});
		assert.equal(result.status, "ok");
		const calls = await fake.calls();
		assert.equal(methodCalls(calls, "auth status").length, 1);
		assert.equal(methodCalls(calls, "gmail users getProfile").length, 2);
		assert.equal(reads, 1);
		assert.ok(calls.every((call) => call.env.HOME === home));
		assert.ok(calls.every((call) => call.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR === fake.configDir));
	} finally {
		await fake.cleanup();
	}
});

test("a tool without a granted scope returns SCOPE_REQUIRED and makes no API call", async () => {
	const fake = await createFake({ scopes: [SCOPES.gmailRead] });
	try {
		const result = await fake.tool("drive_files_list", {});
		assert.equal(errorCode(result), "SCOPE_REQUIRED");
		const error = result.error as { requiredAnyOf?: string[] };
		assert.ok(error.requiredAnyOf?.includes(SCOPES.drive));
		assert.equal(methodCalls(await fake.calls(), "drive").length, 0);
	} finally {
		await fake.cleanup();
	}
});

test("google_status derives the Docs, Slides and Tasks capabilities from the granted scopes", async () => {
	const fake = await createFake({ scopes: [SCOPES.driveRead, SCOPES.tasks] });
	try {
		const result = await fake.tool("google_status", {});
		const { capabilities } = result.data as { capabilities: Record<string, boolean> };
		assert.equal(capabilities.docsRead, true);
		assert.equal(capabilities.docsWrite, false);
		assert.equal(capabilities.slidesRead, true);
		assert.equal(capabilities.tasksRead, true);
		assert.equal(capabilities.tasksWrite, true);
	} finally {
		await fake.cleanup();
	}
});

test("gws exits map to stable error codes", async () => {
	const cases: [Record<string, unknown>, string, boolean][] = [
		[{ exit: 1, stdout: { error: { code: 403, message: "denied", reason: "forbidden" } } }, "API_ERROR", false],
		[{ exit: 1, stdout: { error: { code: 503, message: "unavailable" } } }, "BACKEND_ERROR", true],
		[{ exit: 2, stderr: "login" }, "AUTH_REQUIRED", false],
		[{ exit: 3, stderr: "bad" }, "INVALID_ARGUMENT", false],
		[{ exit: 4, stderr: "discovery" }, "BACKEND_SCHEMA_ERROR", false],
		[{ exit: 5, stderr: "internal" }, "BACKEND_ERROR", true],
		[{ exit: 0, stdout: "not json" }, "BACKEND_SCHEMA_ERROR", false],
	];
	const fake = await createFake();
	try {
		for (const [response, code, retryable] of cases) {
			await fake.scenario({ responses: { "gmail users labels list": response } });
			const result = await fake.tool("gmail_labels_list", {});
			assert.equal(errorCode(result), code, JSON.stringify(response));
			assert.equal((result.error as { retryable: boolean }).retryable, retryable, JSON.stringify(response));
		}
	} finally {
		await fake.cleanup();
	}
});

test("a call past its deadline is stopped and reported", async () => {
	const fake = await createFake({
		responses: { "gmail users labels list": { stdout: { labels: [] }, sleepMs: 5000 } },
	});
	try {
		const result = await fake.runtime.run({}, undefined, async (operation) => {
			await operation.call("gmail", ["users", "labels", "list"], { params: { userId: "me" }, timeoutMs: 300 });
			return { schemaVersion: 1, status: "ok" };
		});
		assert.equal(result.error?.code, "DEADLINE_EXCEEDED");
	} finally {
		await fake.cleanup();
	}
});
