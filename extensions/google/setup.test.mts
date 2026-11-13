import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACCOUNT, createFake, errorCode, methodCalls } from "./fake-gws.test-support.mts";
import { sha256 } from "./files.ts";
import { GoogleRuntime, SCOPES } from "./gws.ts";
import { importClient, installGws, parseSetupArgs, type SetupDeps, scopesFor, setup } from "./setup.ts";

const DESKTOP_CLIENT = {
	installed: {
		client_id: "id.apps.googleusercontent.com",
		client_secret: "secret",
		redirect_uris: ["http://localhost"],
	},
};

function deps(overrides: Partial<SetupDeps> = {}): SetupDeps {
	return {
		fetch: async () => new Response("unused", { status: 404 }),
		platformKey: "test",
		release: { version: "0.22.5", assets: {} },
		log: () => undefined,
		openUrl: () => undefined,
		...overrides,
	};
}

test("scopesFor gives one scope set per service and access level", () => {
	assert.deepEqual(scopesFor(["gmail", "drive"], "read"), [SCOPES.gmailRead, SCOPES.driveRead]);
	assert.deepEqual(scopesFor(["gmail", "sheets", "calendar"], "write"), [
		SCOPES.gmailModify,
		SCOPES.sheets,
		SCOPES.calendar,
	]);
	assert.deepEqual(scopesFor(["docs", "slides", "tasks"], "read"), [
		SCOPES.docsRead,
		SCOPES.slidesRead,
		SCOPES.tasksRead,
	]);
	assert.deepEqual(scopesFor(["docs", "slides", "tasks"], "write"), [SCOPES.docs, SCOPES.slidesRead, SCOPES.tasks]);
	assert.deepEqual(parseSetupArgs([]), {
		client: undefined,
		account: undefined,
		services: ["gmail", "drive", "sheets", "calendar", "docs", "slides", "tasks"],
		access: "read",
	});
	assert.deepEqual(parseSetupArgs(["--services", "docs,tasks", "--access", "write"]).services, ["docs", "tasks"]);
	assert.throws(() => parseSetupArgs(["--services", "gmail,keep"]), /keep/);
	assert.throws(() => parseSetupArgs(["--access", "admin"]), /read or write/);
});

test("installGws installs a verified archive once and refuses a digest mismatch", async () => {
	const root = await mkdtemp(join(tmpdir(), "google-install-"));
	try {
		const source = join(root, "source");
		await mkdir(source);
		await writeFile(join(source, "gws"), `#!/bin/sh\necho "gws 0.22.5"\n`, { mode: 0o755 });
		const archivePath = join(root, "gws.tar.gz");
		assert.equal(spawnSync("/usr/bin/tar", ["-czf", archivePath, "-C", source, "./gws"]).status, 0);
		const archive = await readFile(archivePath);
		const release = { version: "0.22.5", assets: { test: { name: "gws.tar.gz", sha256: sha256(archive) } } };
		let downloads = 0;
		const fetch = (async () => {
			downloads += 1;
			return new Response(archive);
		}) as typeof globalThis.fetch;
		const executable = join(root, "bin", "0.22.5", "gws");
		assert.deepEqual(await installGws(executable, deps({ fetch, release })), { installed: true });
		assert.equal((await stat(executable)).mode & 0o111, 0o111);
		assert.deepEqual(await installGws(executable, deps({ fetch, release })), { installed: false });
		assert.equal(downloads, 1);
		const wrong = { version: "0.22.5", assets: { test: { name: "gws.tar.gz", sha256: "0".repeat(64) } } };
		const other = join(root, "other", "gws");
		await assert.rejects(
			installGws(other, deps({ fetch, release: wrong })),
			(error: { code?: string }) => error.code === "CHECKSUM_MISMATCH",
		);
		await assert.rejects(stat(other));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("importClient accepts only a Desktop app client and stores it privately", async () => {
	const root = await mkdtemp(join(tmpdir(), "google-client-"));
	try {
		const web = join(root, "web.json");
		await writeFile(web, JSON.stringify({ web: { client_id: "x", client_secret: "y" } }));
		await assert.rejects(importClient(join(root, "config"), web), /Desktop app/);
		const desktop = join(root, "desktop.json");
		await writeFile(desktop, JSON.stringify(DESKTOP_CLIENT));
		await importClient(join(root, "config"), desktop);
		const stored = join(root, "config", "client_secret.json");
		assert.deepEqual(JSON.parse(await readFile(stored, "utf8")), DESKTOP_CLIENT);
		assert.equal((await stat(stored)).mode & 0o777, 0o600);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("setup signs in with the chosen scopes and records the account for later operations", async () => {
	const fake = await createFake({ responses: { "gmail users labels list": { stdout: { labels: [] } } } });
	try {
		const env: Record<string, string> = { ...fake.env };
		delete env.PI_GOOGLE_EXPECTED_ACCOUNT;
		const before = await new GoogleRuntime(fake.agentDir, env).run({}, undefined, async () => ({
			schemaVersion: 1,
			status: "ok",
		}));
		assert.equal(before.error?.code, "SETUP_REQUIRED");
		const clientFile = join(fake.root, "client.json");
		await writeFile(clientFile, JSON.stringify(DESKTOP_CLIENT));
		const report = await setup(
			{
				agentDir: fake.agentDir,
				env,
				client: clientFile,
				account: ACCOUNT,
				services: ["gmail", "calendar"],
				access: "read",
			},
			deps(),
		);
		assert.equal(report.account, ACCOUNT);
		assert.equal(report.installed, false);
		const [login] = methodCalls(await fake.calls(), "auth login");
		assert.deepEqual(login.args.slice(2), ["--scopes", scopesFor(["gmail", "calendar"], "read").join(",")]);
		const runtime = new GoogleRuntime(fake.agentDir, env);
		const result = await runtime.run({}, undefined, async ({ auth }) => ({
			schemaVersion: 1,
			status: "ok",
			data: auth.account,
		}));
		assert.equal(result.data, ACCOUNT);
		await assert.rejects(
			setup(
				{ agentDir: fake.agentDir, env, account: "someone@example.org", services: ["gmail"], access: "read" },
				deps(),
			),
			(error: { code?: string }) => error.code === "WRONG_ACCOUNT",
		);
	} finally {
		await fake.cleanup();
	}
});

test("tools report SETUP_REQUIRED before setup", async () => {
	const fake = await createFake();
	try {
		await rm(fake.configDir, { recursive: true, force: true });
		assert.equal(errorCode(await fake.tool("gmail_search", { query: "x" })), "SETUP_REQUIRED");
	} finally {
		await fake.cleanup();
	}
});
