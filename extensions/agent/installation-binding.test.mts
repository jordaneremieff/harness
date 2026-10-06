import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { fixtureMetadata } from "./host-fixture.mts";
import { HOST_READY_PREFIX, hostPaths } from "./host-protocol.ts";
import { INSTALLATION_PACKAGES, isInstallationImport } from "./installation-binding.ts";

const bindingUrl = new URL("./installation-binding.ts", import.meta.url).href;
const runnerPath = fileURLToPath(new URL("./durable-runner.ts", import.meta.url));

/** A root with no `node_modules` on its path, so a peer package resolves only through the binding. */
function isolatedRoot(t: TestContext): string {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "agent-installation-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

async function runNode(args: readonly string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
	const [code] = await once(child, "close") as [number | null];
	return { code, stdout, stderr };
}

/** Write a probe module that binds peer imports from `sourceRoot` and then imports each specifier. */
function writeProbe(path: string, sourceRoot: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, [
		`import { bindInstallationPackages } from ${JSON.stringify(bindingUrl)};`,
		`bindInstallationPackages(process.argv[2], new URL(${JSON.stringify(`${pathToFileURL(sourceRoot).href}/`)}));`,
		"const resolved = {};",
		"for (const specifier of process.argv.slice(3)) {",
		"\tresolved[specifier] = import.meta.resolve(specifier);",
		"\tawait import(specifier);",
		"}",
		"const pi = await import(\"@earendil-works/pi-coding-agent\");",
		"process.stdout.write(JSON.stringify({ version: pi.VERSION, resolved }));",
	].join("\n"));
}

it("selects the declared peer packages and their subpaths only", () => {
	for (const name of INSTALLATION_PACKAGES) {
		assert.equal(isInstallationImport(name), true);
		assert.equal(isInstallationImport(`${name}/value`), true);
	}
	for (const specifier of ["@earendil-works/pi-durable", "@earendil-works/pi-ai-extra", "typebox-extra", "./typebox", "node:fs"]) assert.equal(isInstallationImport(specifier), false, specifier);
});

it("resolves every peer import of bound source from the caller installation", async (t) => {
	const root = isolatedRoot(t);
	const packageDir = getPackageDir();
	const installationModules = dirname(dirname(packageDir));
	const source = join(root, "source");
	const probe = join(source, "probe.mjs");
	writeProbe(probe, source);
	const specifiers = [...INSTALLATION_PACKAGES, "typebox/value", "@earendil-works/pi-ai/utils/validation"];
	const result = await runNode([probe, packageDir, ...specifiers], root);
	assert.equal(result.code, 0, result.stderr);
	const output = JSON.parse(result.stdout) as { version: string; resolved: Record<string, string> };
	assert.equal(output.version, JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).version);
	assert.deepEqual(Object.keys(output.resolved), specifiers);
	assert.ok(output.resolved["@earendil-works/pi-coding-agent"].startsWith(`${pathToFileURL(packageDir).href}/`), "the coding agent is the installation package itself");
	for (const [specifier, url] of Object.entries(output.resolved)) {
		assert.ok(url.startsWith(`${pathToFileURL(installationModules).href}/`), `${specifier} resolves inside the installation: ${url}`);
	}
});

it("leaves peer imports from modules outside the bound source unchanged", async (t) => {
	const root = isolatedRoot(t);
	const probe = join(root, "outside", "probe.mjs");
	writeProbe(probe, join(root, "source"));
	const result = await runNode([probe, getPackageDir()], root);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /ERR_MODULE_NOT_FOUND/u);
	assert.match(result.stderr, /Cannot find package '@earendil-works\/pi-coding-agent'/u);
});

it("loads host modules against metadata.packageDir before it takes the writer claim", async (t) => {
	const root = isolatedRoot(t);
	const installation = join(root, "installation");
	mkdirSync(installation);
	writeFileSync(join(installation, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.0.0", type: "module", exports: { ".": "./index.js" } }));
	writeFileSync(join(installation, "index.js"), "export const VERSION = \"1.0.0\";\n");
	const metadata = { ...fixtureMetadata(root), packageDir: installation };
	const result = await runNode([runnerPath, JSON.stringify(metadata)], root);
	assert.equal(result.code, 1, result.stderr);
	assert.equal(result.stdout.includes(HOST_READY_PREFIX), false);
	assert.match(result.stderr, /^Durable host failed: .*ERR_MODULE_NOT_FOUND/mu);
	assert.ok(result.stderr.includes(`imported from ${join(installation, "package.json")}`), result.stderr);
	assert.equal(existsSync(hostPaths(metadata).claim), false, "a host whose installation lacks its packages never takes the claim");
});
