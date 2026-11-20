import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAt, humanize, isObject } from "./json.ts";
import { type Raw, resolveRef, settingShape, unsupportedKeywords } from "./json-schema.ts";
import type { Json, ValueSchema } from "./protocol.ts";

export type DocRow = { section: string; type: string; defaultText: string; description: string };
export type PiLeaf = {
	path: string[];
	schema: Raw;
	value: ValueSchema;
	description: string;
	deprecated: boolean;
	documented: boolean;
	category: string;
	globalOnly: boolean;
	/** Lists that Pi's resource loader combines from both files. */
	combined: boolean;
	default?: { value?: Json; text?: string };
};
export type PiSchema = {
	digest: string;
	path: string;
	docs: { path: string; available: boolean };
	root: Raw;
	leaves: PiLeaf[];
	/** Paths of schema objects whose own keys are known, for unregistered-key discovery. */
	objects: string[][];
	problems: string[];
};

const cache = new Map<string, PiSchema>();

/** Reads the schema and settings reference that belong to the selected Pi installation. */
export function loadPiSchema(packageDir: string): PiSchema {
	const schemaPath = join(packageDir, "schemas", "settings.schema.json");
	const docsPath = join(packageDir, "docs", "settings.md");
	const schemaText = readFileSync(schemaPath, "utf8");
	let docsText = "";
	try {
		docsText = readFileSync(docsPath, "utf8");
	} catch {}
	const digest = createHash("sha256").update(schemaText).update("\0").update(docsText).digest("hex");
	const key = `${schemaPath}\0${digest}`;
	const cached = cache.get(key);
	if (cached) return cached;
	const root: unknown = JSON.parse(schemaText);
	if (!isObject(root) || !isObject(root.properties)) throw new Error(`${schemaPath} is not an object schema.`);
	const rows = parseReference(docsText);
	const problems: string[] = [];
	const leaves: PiLeaf[] = [];
	const objects: string[][] = [[]];
	const visit = (path: string[], raw: Raw, inheritedSection?: string) => {
		const node = resolveRef(root, raw);
		const dotted = path.join(".");
		const row = rows.get(dotted);
		const section = row?.section ?? inheritedSection;
		if (node.type === "object" && isObject(node.properties) && !isObject(node.patternProperties)) {
			objects.push(path);
			for (const [child, value] of Object.entries(node.properties))
				if (isObject(value)) visit([...path, child], value, section ?? humanize(path[0]));
			return;
		}
		const unsupported = unsupportedKeywords(root, node);
		if (unsupported.length)
			problems.push(`${dotted} uses schema keywords ${unsupported.join(", ")} that Config does not check.`);
		leaves.push(leafOf(root, path, raw, node, row, section));
	};
	for (const [key, value] of Object.entries(root.properties)) if (isObject(value)) visit([key], value);
	const result: PiSchema = {
		digest,
		path: schemaPath,
		docs: { path: docsPath, available: rows.size > 0 },
		root,
		leaves,
		objects,
		problems,
	};
	cache.clear();
	cache.set(key, result);
	return result;
}

/** Reads the leaf's default from the schema node or the settings reference's text. */
function leafDefault(node: Raw, row: DocRow | undefined): PiLeaf["default"] {
	if (Object.hasOwn(node, "default")) return { value: node.default as Json };
	if (row?.defaultText && row.defaultText !== "None") return { text: row.defaultText };
}
/** True when the reference marks the setting as readable only from agent-directory settings. */
function globalOnlySetting(description: string, row: DocRow | undefined): boolean {
	return (
		/\bglobal(?: setting)? only\b/i.test(description) ||
		/can only be set in agent-directory settings/i.test(row?.description ?? "")
	);
}
/** Builds one declared leaf from its schema node and its settings-reference row. */
function leafOf(
	root: Raw,
	path: string[],
	raw: Raw,
	node: Raw,
	row: DocRow | undefined,
	section: string | undefined,
): PiLeaf {
	const description = (typeof node.description === "string" ? node.description : "") || row?.description || "";
	return {
		path,
		schema: node,
		value: settingShape(root, node),
		description,
		deprecated: node.deprecated === true || (isObject(raw) && raw.deprecated === true),
		documented: row !== undefined,
		category: section ?? (path.length > 1 ? humanize(path[0]) : "Other"),
		globalOnly: globalOnlySetting(description, row),
		combined: section === "Resources" && node.type === "array",
		default: leafDefault(node, row),
	};
}

/** Reads the installed settings reference: section headings and `| \`key\` | type | default | description |` rows. */
export function parseReference(text: string): Map<string, DocRow> {
	const rows = new Map<string, DocRow>();
	let section = "";
	for (const line of text.split("\n")) {
		const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line);
		if (heading) {
			section = heading[1].trim();
			continue;
		}
		const row = /^\|\s*`([A-Za-z0-9_.$-]+)`\s*\|(.*)\|\s*$/.exec(line);
		if (!row || !section) continue;
		const cells = splitCells(row[2]);
		if (cells.length < 3) continue;
		rows.set(row[1], {
			section,
			type: cleanCell(cells[0]),
			defaultText: cleanCell(cells[1]),
			description: cleanCell(cells.slice(2).join(" | ")),
		});
	}
	return rows;
}
function splitCells(text: string): string[] {
	const cells: string[] = [];
	let current = "";
	let code = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		if (char === "\\" && text[i + 1] === "|") {
			current += "|";
			i++;
		} else if (char === "`") {
			code = !code;
			current += char;
		} else if (char === "|" && !code) {
			cells.push(current);
			current = "";
		} else current += char;
	}
	cells.push(current);
	return cells.map((cell) => cell.trim());
}
function cleanCell(text: string): string {
	return text
		.replace(/\*\*/g, "")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.trim();
}

export function savedAt(document: Record<string, unknown> | undefined, path: readonly string[]) {
	return document ? getAt(document, path) : ({ present: false } as const);
}
