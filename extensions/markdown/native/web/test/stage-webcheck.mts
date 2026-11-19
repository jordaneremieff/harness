import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, dirname, resolve } from "node:path";
const root = new URL("../", import.meta.url);
const destination = process.argv[2];
if (!destination) throw new Error("usage: node stage-webcheck.mts <output directory>");
const files = [
	"app/host/native.ts",
	"app/core/render-html.ts",
	"app/core/exact.ts",
	"app/core/source-model.ts",
	"app/core/find.ts",
	"app/core/controller.ts",
	"app/editor/block-editor.ts",
	"test/host-memory.ts",
	"test/fixtures.ts",
	"test/editor-page.ts",
	"test/editor.html",
	"test/editor.css",
	"test/editor-steps.json",
];
for (const file of files) {
	const output = join(resolve(destination), file.replace(/\.ts$/, ".js"));
	mkdirSync(dirname(output), { recursive: true });
	const source = readFileSync(new URL(file, root), "utf8");
	writeFileSync(output, file.endsWith(".ts") ? stripTypeScriptTypes(source, { mode: "strip" }) : source);
}
console.log(
	JSON.stringify({
		page: join(resolve(destination), "test/editor.html"),
		steps: join(resolve(destination), "test/editor-steps.json"),
	}),
);
