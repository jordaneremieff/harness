import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { access } from "./access.ts";
import { BODY_BYTES, loadCatalog, readBody, resourceById, resourceByPath } from "./catalog.ts";

async function fixture() {
	const root = await mkdtemp(join(process.cwd(), ".pillars-catalog-test-"));
	await mkdir(join(root, "skills", "pillars"), { recursive: true });
	await mkdir(join(root, "pillars"));
	const skill = join(root, "skills", "pillars", "SKILL.md");
	await writeFile(
		skill,
		"---\nname: pillars\ndescription: Consult synthetic doctrine.\ncompatibility: Requires ../../pillars\n---\nRead ../../pillars/README.md.\n",
	);
	await writeFile(
		join(root, "pillars", "README.md"),
		"# Inventory\n[Example](principle-example.md)\n[Governance](GOVERNANCE.md)\n",
	);
	await writeFile(join(root, "pillars", "GOVERNANCE.md"), "# Consultation\nRead the matching entry.\n");
	await writeFile(join(root, "pillars", "principle-example.md"), "# Example\nSynthetic source.\n");
	return {
		root,
		skill,
		skills: [{ name: "pillars", filePath: skill }],
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

test("catalog follows the actual loaded skill relation and canonical inventory targets", async () => {
	await using f = await fixture();
	const catalog = await loadCatalog(f.skills);
	assert.deepEqual(
		catalog.resources.map((resource) => resource.resourceId),
		["skill", "inventory", "governance", "principle-example"],
	);
	assert.equal(
		(await resourceByPath(catalog, "@pillars/principle-example.md", f.root))?.resourceId,
		"principle-example",
	);
	assert.equal(await resourceByPath(catalog, "unrelated/pillars/principle-example.md", f.root), undefined);
	assert.equal(resourceById(catalog, "other"), undefined);
	await assert.rejects(loadCatalog([]));
	await assert.rejects(loadCatalog([...f.skills, ...f.skills]));
	await writeFile(f.skill, "name: pillars\nNo corpus relation.");
	await assert.rejects(loadCatalog(f.skills));
});

test("catalog refuses invalid targets, aliases, duplicate identities, and excess intake", async () => {
	await using f = await fixture();
	for (const inventory of [
		"[Bad](../outside.md)",
		"[A](principle-example.md)\n[B](principle-example.md)",
		"[Bad](https://example.com)",
		"[Only](GOVERNANCE.md)",
	]) {
		await writeFile(join(f.root, "pillars", "README.md"), inventory);
		await assert.rejects(loadCatalog(f.skills));
	}
	await writeFile(join(f.root, "pillars", "README.md"), "x".repeat(BODY_BYTES + 1));
	await assert.rejects(loadCatalog(f.skills));
	await assert.rejects(readBody(join(f.root, "pillars")));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(readBody(f.skill, controller.signal), { name: "AbortError" });
});

test("source access returns actual text and portable ids without absolute locators", async () => {
	await using f = await fixture();
	const catalog = await loadCatalog(f.skills);
	const page = await access(catalog);
	assert.equal(page.schema, "pillars-source");
	if (page.schema !== "pillars-source") return;
	assert.equal(page.text, await readFile(join(f.root, "pillars", "README.md"), "utf8"));
	assert.equal(page.offset, 0);
	assert.equal(page.endOffset, page.bodyBytes);
	assert.ok(page.resources?.includes("governance"));
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
});

test("source continuation retains exact UTF-8 boundaries and rejects changed references", async () => {
	await using f = await fixture();
	const path = join(f.root, "pillars", "principle-example.md");
	const text = `\uFEFF${"x".repeat(23997)}\uFEFF${'😀\u0001"\\\n'.repeat(12000)}`;
	await writeFile(path, text);
	const catalog = await loadCatalog(f.skills);
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
});
