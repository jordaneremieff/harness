import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { googleCommand, USAGE } from "./command.ts";
import { ACCOUNT, createFake } from "./fake-gws.test-support.mts";
import { GWS_RELEASE } from "./release.ts";
import { googleTuiCommand } from "./report-view.ts";
import { managedExecutable } from "./settings.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function operator(onRender?: (rows: readonly string[]) => void) {
	let active: Component | undefined;
	const opened = deferred<void>();
	const notices: Array<[string, string | undefined]> = [];
	const theme = { fg: (_colour: string, text: string) => text, bold: (text: string) => text };
	const tui = {
		terminal: { rows: 12 },
		requestRender: () => {
			if (active) onRender?.(active.render(76));
		},
	};
	const ui: Pick<ExtensionUIContext, "notify" | "custom"> = {
		notify: (text, level) => notices.push([text, level]),
		async custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> {
			const closed = deferred<T>();
			const view = await factory(tui as never, theme as never, undefined as never, (result) => {
				active = undefined;
				closed.resolve(result as T);
			});
			active = view;
			opened.resolve(undefined);
			tui.requestRender();
			return closed.promise.finally(() => view.dispose?.());
		},
	};
	return {
		ui,
		notices,
		opened: opened.promise,
		get active() {
			return active;
		},
	};
}

function mustOpen(view: ReturnType<typeof operator>, operation: Promise<boolean>) {
	return Promise.race([
		view.opened,
		operation.then(() => assert.fail("Command settled without opening an operator report")),
	]);
}

test("status stays a JSON report in the CLI and opens a bounded local view in Pi", async () => {
	const fake = await createFake({ scopes: ["sample-scope"] });
	try {
		const printed: Array<[string, string | undefined]> = [];
		const print = (text: string, level?: string) => printed.push([text, level]);
		assert.equal(await googleCommand("status", fake.agentDir, fake.env, print), true);
		assert.equal(printed.length, 1);
		assert.equal(printed[0][1], undefined);
		const status = JSON.parse(printed[0][0]);
		assert.equal(status.ready, true);
		assert.deepEqual(status.grantedScopes, ["sample-scope"]);
		assert.equal(status.observedAccount, ACCOUNT);

		const view = operator();
		const operation = googleTuiCommand("status", fake.agentDir, fake.env, view.ui);
		await mustOpen(view, operation);
		const panel = view.active;
		assert.ok(panel);
		const first = panel.render(26);
		assert.equal(first[0], "Google status");
		assert.ok(first.length <= 7 && first.every((row) => visibleWidth(row) <= 26));
		assert.match(first.at(-1) ?? "", /esc close$/);
		panel.handleInput?.("\x1b[6~");
		assert.notDeepEqual(panel.render(26).slice(1, -1), first.slice(1, -1));
		panel.handleInput?.("\x1b");
		assert.equal(await operation, true);
		assert.deepEqual(view.notices, []);

		await rm(join(fake.configDir, "credentials.enc"));
		assert.equal(await googleCommand("status", fake.agentDir, fake.env, print), true);
		assert.equal(JSON.parse(printed[1][0]).ready, false);
		assert.equal(printed[1][1], undefined);
		const notReady = operator();
		const inspect = googleTuiCommand("status", fake.agentDir, fake.env, notReady.ui);
		await mustOpen(notReady, inspect);
		assert.equal(notReady.active?.render(76)[0], "Google status: Not ready");
		notReady.active?.handleInput?.("\x1b");
		assert.equal(await inspect, true);
		assert.deepEqual(notReady.notices, []);
	} finally {
		await fake.cleanup();
	}
});

test("setup shows the complete split sign-in URL while the child waits, and settles without a dismissal", {
	timeout: 6000,
}, async () => {
	const fake = await createFake();
	try {
		const client = join(fake.root, "test-client.json");
		await writeFile(client, JSON.stringify({ installed: { client_id: "fake", client_secret: "fake" } }));
		const backend = `${fake.executable}-backend`;
		await rename(fake.executable, backend);
		const gate = join(fake.root, "gate");
		await mkdir(gate);
		const marker = join(gate, "continue");
		const url = "https://accounts.google.com/test?challenge=fake";
		await writeFile(
			fake.executable,
			`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.join(' ').startsWith('auth login ')) {
 const watcher = fs.watch(${JSON.stringify(gate)}, () => {
  watcher.close();
  process.stderr.write('google.com/test?challenge=fake\\nFollow the prompts.\\n');
 });
 setTimeout(() => process.exit(8), 2500).unref();
 process.stderr.write('https://accounts.');
} else {
 const result = require('node:child_process').spawnSync(${JSON.stringify(backend)}, args, { stdio: 'inherit' });
 process.exitCode = result.status ?? 9;
}
`,
			{ mode: 0o755 },
		);
		let released = false;
		const screens: Array<readonly string[]> = [];
		const view = operator((rows) => {
			screens.push(rows);
			if (!released && rows.includes("https://accounts.")) {
				released = true;
				writeFileSync(marker, "continue");
			}
		});
		assert.equal(
			await googleTuiCommand(`setup --client ${client}`, fake.agentDir, fake.env, view.ui, {
				openUrl: () => assert.fail("Fake split URL must not open a browser"),
			}),
			true,
		);
		assert.ok(released);
		const instructions = screens.find((rows) => rows.includes(url));
		assert.ok(instructions?.includes("Opening Google sign-in. Approve access in the browser."));
		assert.ok(instructions?.includes("Follow the prompts."));
		assert.equal(view.active, undefined);
		assert.equal(view.notices.length, 1);
		assert.match(view.notices[0][0], /^Signed in as person@example\.com\./);
		assert.equal(view.notices[0][1], "info");
	} finally {
		await fake.cleanup();
	}
});

test("usage, refusal, progress, completion and failure use distinct command emissions", async () => {
	const fake = await createFake();
	try {
		const view = operator();
		const run = (input: string) => googleTuiCommand(input, fake.agentDir, fake.env, view.ui);
		assert.equal(await run("other"), false);
		assert.deepEqual(view.notices.pop(), [`Usage: ${USAGE}`, "warning"]);
		const printed: Array<[string, string | undefined]> = [];
		assert.equal(
			await googleCommand("other", fake.agentDir, fake.env, (text, level) => printed.push([text, level])),
			false,
		);
		assert.deepEqual(printed, [[`Usage: ${USAGE}`, "error"]]);
		assert.equal(await run("setup --access unknown"), false);
		assert.deepEqual(view.notices.pop(), ["INVALID_ARGUMENT: --access takes read or write.", "warning"]);
		assert.equal(await run("update"), false);
		assert.match(view.notices.at(-1)?.[0] ?? "", /^CONFIG_ERROR: /);
		assert.equal(view.notices.pop()?.[1], "warning");

		const managed = managedExecutable(fake.agentDir);
		const managedEnv = { ...fake.env };
		delete managedEnv.PI_GOOGLE_EXECUTABLE;
		const update = (
			fetch: typeof globalThis.fetch,
			release: NonNullable<Parameters<typeof googleTuiCommand>[4]>["release"],
		) => googleTuiCommand("update", fake.agentDir, managedEnv, view.ui, { fetch, release });
		assert.equal(
			await update(async () => new Response("unused", { status: 503 }), {
				version: GWS_RELEASE.version,
				assets: { [`${process.platform}-${process.arch}`]: { name: "fake.tar.gz", sha256: "0".repeat(64) } },
			}),
			false,
		);
		assert.deepEqual(view.notices.splice(0), [
			[`Downloading gws ${GWS_RELEASE.version} (fake.tar.gz).`, "info"],
			["DOWNLOAD_FAILED: The gws download returned HTTP 503.", "error"],
		]);
		await mkdir(dirname(managed), { recursive: true });
		await writeFile(managed, `#!/bin/sh\necho 'gws ${GWS_RELEASE.version}'\n`, { mode: 0o755 });
		assert.equal(await update(async () => Response.json({ tag_name: "v99.0.0" }), GWS_RELEASE), true);
		assert.match(view.notices.at(-1)?.[0] ?? "", /is already installed.*Upstream release 99\.0\.0 exists/);
		assert.equal(view.notices.pop()?.[1], "info");

		assert.equal(await run("logout"), true);
		assert.match(view.notices.at(-1)?.[0] ?? "", /^Signed out locally\./);
		assert.equal(view.notices.pop()?.[1], "info");
		await fake.scenario({
			responses: { "auth logout": { exit: 1, stderr: "Refused by fake backend.\nDiagnostic detail." } },
		});
		const failure = run("logout");
		await mustOpen(view, failure);
		assert.deepEqual(view.active?.render(76).slice(0, 3), [
			"Google command failed",
			"BACKEND_ERROR: gws auth logout failed: Refused by fake backend.",
			"Diagnostic detail.",
		]);
		view.active?.handleInput?.("\x1b");
		assert.equal(await failure, false);
		assert.deepEqual(view.notices, []);
	} finally {
		await fake.cleanup();
	}
});
