import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const [uiRootArg, destinationArg] = process.argv.slice(2);
if (!uiRootArg || !destinationArg)
	throw new Error("usage: node stage-product.mts <UI web directory> <output directory>");
const uiRoot = resolve(uiRootArg),
	destination = resolve(destinationArg),
	coreRoot = fileURLToPath(new URL("../", import.meta.url));
let visited = 0,
	bytes = 0;
function stage(root: string, file: string) {
	const input = readFileSync(join(root, file));
	bytes += input.byteLength;
	if (input.byteLength > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024)
		throw new Error("Product fixtures exceed their byte bound.");
	const output = join(destination, file.replace(/\.ts$/, ".js"));
	mkdirSync(dirname(output), { recursive: true });
	const content = file.endsWith(".ts") ? stripTypeScriptTypes(input.toString("utf8"), { mode: "strip" }) : input;
	writeFileSync(output, content);
}
function walk(directory: string, depth = 0) {
	if (depth > 6) throw new Error("Product fixtures exceed their depth bound.");
	const entries = readdirSync(join(uiRoot, directory), { withFileTypes: true });
	if (entries.length > 256) throw new Error("Product fixtures exceed their directory bound.");
	for (const entry of entries) {
		if (++visited > 2048) throw new Error("Product fixtures exceed their visit bound.");
		if (entry.name.startsWith(".") || /\.test\.|\.d\.ts$|\.mts$/.test(entry.name)) continue;
		const file = join(directory, entry.name);
		if (entry.isDirectory()) walk(file, depth + 1);
		else if (entry.isFile()) stage(uiRoot, file);
	}
}
for (const directory of ["app/ui", "styles"]) walk(directory);
for (const file of ["app/main.ts"]) stage(uiRoot, file);
for (const file of [
	"app/host/native.ts",
	"app/core/exact.ts",
	"app/core/source-model.ts",
	"app/core/controller.ts",
	"app/core/render-html.ts",
	"app/editor/block-editor.ts",
	"test/host-memory.ts",
	"test/fixtures.ts",
	"test/defer-boot.ts",
	"test/product-host.ts",
])
	stage(coreRoot, file);
let shell = readFileSync(join(uiRoot, "index.html"), "utf8");
if (!shell.includes("</head>")) throw new Error("The product shell has no head.");
shell = shell.replace("<script", '<script src="test/defer-boot.js"></script>\n<script');
shell = shell.replace(
	"</head>",
	'<script defer src="test/host-memory.js"></script>\n<script defer src="test/fixtures.js"></script>\n<script defer src="test/product-host.js"></script>\n</head>',
);
writeFileSync(join(destination, "index.html"), shell);
console.log(JSON.stringify({ page: join(destination, "index.html") }));
