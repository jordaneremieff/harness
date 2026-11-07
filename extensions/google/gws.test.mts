import assert from "node:assert/strict";
import { access, readFile, rm, writeFile } from "node:fs/promises";
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
