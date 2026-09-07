import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { access } from "./access.ts";
import {
	BODY_BYTES,
	corpusRoot,
	defaultCorpusRoot,
	loadCatalog,
	readBody,
	resourceById,
	resourceByPath,
} from "./catalog.ts";

async function corpus() {
	const root = await mkdtemp(join(process.cwd(), ".pillars-catalog-test-"));
	const corpusDir = join(root, "pillars");
	await mkdir(corpusDir);
	await writeFile(join(corpusDir, "README.md"), "# Inventory\n[Example](principle-example.md)\n[Governance](GOVERNANCE.md)\n");
	await writeFile(join(corpusDir, "GOVERNANCE.md"), "# Consultation\nRead the matching entry.\n");
	await writeFile(join(corpusDir, "principle-example.md"), "# Example\nSynthetic source.\n");
	return {
		root,
		corpusDir,
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

function withCorpus(path: string | undefined): () => void {
	const previous = process.env.PI_PILLARS_CORPUS;
	if (path === undefined) delete process.env.PI_PILLARS_CORPUS;
	else process.env.PI_PILLARS_CORPUS = path;
	return () => {
		if (previous === undefined) delete process.env.PI_PILLARS_CORPUS;
		else process.env.PI_PILLARS_CORPUS = previous;
	};
}

test("corpus root defaults to the package sibling and honors PI_PILLARS_CORPUS", () => {
	const restore = withCorpus(undefined);
	try {
		assert.equal(corpusRoot(), defaultCorpusRoot());
		assert.ok(defaultCorpusRoot().startsWith("/"));
		assert.ok(defaultCorpusRoot().endsWith("/pillars"));
		const restoreEmpty = withCorpus("");
		assert.equal(corpusRoot(), defaultCorpusRoot(), "empty override falls back to the default");
		restoreEmpty();
		const override = "/synthetic/corpus";
		const restoreOverride = withCorpus(override);
		assert.equal(corpusRoot(), override);
		restoreOverride();
		const restorePadded = withCorpus(`  ${override}  `);
		assert.equal(corpusRoot(), override, "surrounding whitespace never reaches the filesystem");
		restorePadded();
		const restoreRelative = withCorpus("pillars");
		assert.throws(() => corpusRoot(), /source_unavailable/, "a relative override never resolves against the session directory");
		restoreRelative();
		assert.equal(corpusRoot(), defaultCorpusRoot());
	} finally {
		restore();
	}
});

test("default resolution loads the shipped worktree corpus without a skill resource", async () => {
	const restore = withCorpus(undefined);
	try {
		const catalog = await loadCatalog();
		const ids = catalog.resources.map((resource) => resource.resourceId);
		assert.ok(ids.includes("inventory"));
		assert.ok(ids.includes("governance"));
		assert.ok(catalog.resources.some((resource) => resource.resourceClass === "entry"));
		assert.ok(!ids.includes("skill"));
	} finally {
		restore();
	}
});

test("env override follows canonical inventory targets and resolves resource paths", async () => {
	await using f = await corpus();
	const restore = withCorpus(f.corpusDir);
	try {
		const catalog = await loadCatalog();
		assert.deepEqual(
			catalog.resources.map((resource) => resource.resourceId),
			["inventory", "governance", "principle-example"],
		);
		assert.equal(
			(await resourceByPath(catalog, "@pillars/principle-example.md", f.root))?.resourceId,
			"principle-example",
		);
		assert.equal(await resourceByPath(catalog, "unrelated/pillars/principle-example.md", f.root), undefined);
		assert.equal(resourceById(catalog, "other"), undefined);
		assert.equal(resourceById(catalog, "skill"), undefined);
	} finally {
		restore();
	}
});

test("catalog fails closed without README.md or GOVERNANCE.md under the corpus root", async () => {
	await using f = await corpus();
	const restore = withCorpus(f.corpusDir);
	try {
		await rm(join(f.corpusDir, "README.md"));
		await assert.rejects(loadCatalog());
		await writeFile(join(f.corpusDir, "README.md"), "# Inventory\n[Example](principle-example.md)\n");
		await rm(join(f.corpusDir, "GOVERNANCE.md"));
		await assert.rejects(loadCatalog());
		const restoreMissing = withCorpus(join(f.root, "missing"));
		await assert.rejects(loadCatalog());
		restoreMissing();
	} finally {
		restore();
	}
});

test("catalog refuses invalid targets, aliases, duplicate identities, and excess intake", async () => {
	await using f = await corpus();
	const restore = withCorpus(f.corpusDir);
	try {
		for (const inventory of [
			"[Bad](../outside.md)",
			"[A](principle-example.md)\n[B](principle-example.md)",
			"[Bad](https://example.com)",
			"[Only](GOVERNANCE.md)",
		]) {
			await writeFile(join(f.corpusDir, "README.md"), inventory);
			await assert.rejects(loadCatalog());
		}
		await writeFile(join(f.corpusDir, "README.md"), "x".repeat(BODY_BYTES + 1));
		await assert.rejects(loadCatalog());
		await assert.rejects(readBody(f.corpusDir));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(readBody(join(f.corpusDir, "GOVERNANCE.md"), controller.signal), { name: "AbortError" });
	} finally {
		restore();
	}
});

test("source access returns actual text and portable ids without absolute locators", async () => {
	await using f = await corpus();
	const restore = withCorpus(f.corpusDir);
	try {
		const catalog = await loadCatalog();
		const page = await access(catalog);
		assert.equal(page.schema, "pillars-source");
		if (page.schema !== "pillars-source") return;
		assert.equal(page.text, await readFile(join(f.corpusDir, "README.md"), "utf8"));
		assert.equal(page.offset, 0);
		assert.equal(page.endOffset, page.bodyBytes);
		assert.ok(page.resources?.includes("governance"));
		assert.ok(!page.resources?.includes("skill"));
		assert.ok(!JSON.stringify(page).includes(f.root));
		assert.deepEqual(await access(undefined), { schema: "pillars-source-error", code: "source_unavailable" });
		for (const input of [
			{ unknown: 1 },
			{ offset: 1 },
			{ resource: "../source" },
			{ offset: -1 },
			{ resource: "x", referenceBodyDigest: "bad" },
		]) {
			assert.deepEqual(await access(catalog, input), { schema: "pillars-source-error", code: "invalid_input" });
		}
	} finally {
		restore();
	}
});

test("source continuation retains exact UTF-8 boundaries and rejects changed references", async () => {
	await using f = await corpus();
	const restore = withCorpus(f.corpusDir);
	try {
		const path = join(f.corpusDir, "principle-example.md");
		const text = `\uFEFF${"x".repeat(23997)}\uFEFF${'😀\u0001"\\\n'.repeat(12000)}`;
		await writeFile(path, text);
		const catalog = await loadCatalog();
		let page = await access(catalog, { resource: "principle-example" });
		assert.equal(page.schema, "pillars-source");
		if (page.schema !== "pillars-source") return;
		const referenceBodyDigest = page.referenceBodyDigest;
		const parts: string[] = [];
		for (let count = 0; count < 256; count++) {
			assert.equal(page.schema, "pillars-source");
			if (page.schema !== "pillars-source") break;
			assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32768);
			parts.push(page.text);
			if (page.nextOffset === undefined) break;
			page = await access(catalog, { resource: "principle-example", offset: page.nextOffset, referenceBodyDigest });
		}
		assert.equal(parts.join(""), text);
		assert.deepEqual(await access(catalog, { resource: "principle-example", offset: 1, referenceBodyDigest }), {
			schema: "pillars-source-error",
			code: "invalid_input",
		});
		await writeFile(path, "Changed.");
		assert.deepEqual(await access(catalog, { resource: "principle-example", offset: 24000, referenceBodyDigest }), {
			schema: "pillars-source-error",
			code: "source_changed",
		});
	} finally {
		restore();
	}
});
