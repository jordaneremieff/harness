import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { isRecord } from "./catalog.ts";
import { readRegular } from "./files.ts";

export const settings = {
	slice: "slop",
	fields: {
		dir: {
			type: "path",
			env: "PI_SLOP_DIR",
			defaultText: "<agentDir>/slop",
			description: "Private store for local entries, entry state and reply flags.",
			apply: "use",
		},
		prompt: {
			type: "enum",
			env: "PI_SLOP_PROMPT",
			choices: ["on", "off"],
			default: "on",
			description: "Include active catalog cues in the system prompt. Off leaves the tools, command and CLI available.",
			apply: "use",
		},
		lexicon: {
			type: "path",
			env: "PI_SLOP_LEXICON",
			description: "File of permitted UTF-8 matches for detectors that use the lexicon.",
			apply: "use",
		},
	},
} as const;

export type ReadOptions = { agentDir: string; env?: Readonly<Record<string, string | undefined>> };
type Values = { dir: string; prompt: "on" | "off"; lexicon?: string };
type Origin = "file" | "env" | "default";
const messages = {
	document: "Configuration document is invalid or unavailable.",
	unknown: "Unknown setting in this section.",
	invalid: "Selected input is invalid; the safe default is in effect.",
	coverage: "Additional diagnostics were omitted at the diagnostic limit.",
};
const validText = (value: unknown): value is string =>
	typeof value === "string" && value.length <= 4096 && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
function validPath(base: string, value: unknown): string | undefined {
	if (!validText(value) || !value) return undefined;
	const path = resolve(base, value);
	return validText(path) ? path : undefined;
}

type Source = {
	path: string;
	status: "loaded" | "missing" | "invalid" | "unavailable";
	digest: string | null;
	observedAt: string;
};
type Diagnostic = { field: string; source: Origin; code: keyof typeof messages; message: string };
type Report = (field: string, origin: Origin, code: keyof typeof messages) => void;

function documentSection(defaultDocument: string, options: Required<ReadOptions>, add: Report) {
	const { agentDir, env } = options;
	const source: Source = {
		path: defaultDocument,
		status: "unavailable",
		digest: null,
		observedAt: new Date().toISOString(),
	};
	const path = env.PI_HARNESS_FILE === undefined ? defaultDocument : validPath(agentDir, env.PI_HARNESS_FILE);
	try {
		if (!path) {
			add("PI_HARNESS_FILE", "env", "document");
			return { source, section: {} };
		}
		source.path = path;
		const bytes = readRegular(path, 131072);
		if (bytes === undefined) {
			source.status = "missing";
			return { source, section: {} };
		}
		source.status = "invalid";
		source.digest = createHash("sha256").update(bytes).digest("hex");
		const doc: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
		if (!isRecord(doc) || doc.version !== 1) throw new Error("Bad document");
		source.status = "loaded";
		if (isRecord(doc.slop)) return { source, section: doc.slop };
		if (Object.hasOwn(doc, "slop")) add("slop", "file", "invalid");
	} catch {
		add("document", "file", "document");
	}
	return { source, section: {} };
}

function fieldRecord(
	key: keyof Values,
	options: Required<ReadOptions>,
	section: Record<string, unknown>,
	values: Values,
	add: Report,
) {
	const field = settings.fields[key];
	let origin: Origin = options.env[field.env] !== undefined ? "env" : Object.hasOwn(section, key) ? "file" : "default";
	const name = `slop.${key}`;
	let status: "invalid" | "unset" | "valid" = values[key] === undefined ? "unset" : "valid";
	if (origin !== "default") {
		const raw = origin === "env" ? options.env[field.env] : section[key];
		if (applyValue(key, raw, options.agentDir, values)) status = "valid";
		else {
			status = "invalid";
			add(name, origin, "invalid");
			origin = "default";
		}
	}
	const value = values[key];
	return {
		name,
		key,
		type: field.type,
		description: field.description,
		env: field.env,
		secret: false,
		origin,
		status,
		...(value === undefined ? {} : { value }),
	};
}
function applyValue(key: keyof Values, raw: unknown, agentDir: string, values: Values) {
	if (key === "prompt") {
		if (raw !== "on" && raw !== "off") return false;
		values.prompt = raw;
	} else {
		const value = validPath(agentDir, raw);
		if (value === undefined) return false;
		values[key] = value;
	}
	return true;
}

export function readSettings({ agentDir, env = process.env }: ReadOptions) {
	if (!validText(agentDir) || !isAbsolute(agentDir)) throw new Error("agentDir must be an absolute directory path");
	const defaultDocument = validPath(agentDir, "harness.json");
	const defaultDir = validPath(agentDir, "slop");
	if (!defaultDocument || !defaultDir) throw new Error("Invalid default for slop.dir");
	const diagnostics: Diagnostic[] = [];
	const add: Report = (field, source, code) => {
		if (diagnostics.length < 256) diagnostics.push({ field, source, code, message: messages[code] });
		else if (diagnostics.length === 256)
			diagnostics.push({ field: "coverage", source: "file", code: "coverage", message: messages.coverage });
	};
	const options = { agentDir, env };
	const { source, section } = documentSection(defaultDocument, options, add);
	for (const key of Object.keys(section)) {
		if (Object.hasOwn(settings.fields, key)) continue;
		const suffix = validText(key) ? key.slice(0, 64).replace(/[\ud800-\udbff]$/, "") : "<invalid-key>";
		add(`slop.${suffix}`, "file", "unknown");
	}
	const values: Values = { dir: defaultDir, prompt: settings.fields.prompt.default };
	const records = (Object.keys(settings.fields) as (keyof Values)[]).map((key) =>
		fieldRecord(key, options, section, values, add),
	);
	return { version: 2 as const, slice: "slop", source, values, records, diagnostics };
}

export type SettingsBus = {
	emit(channel: string, value: unknown): void;
	on(channel: string, handler: (value: unknown) => void): () => void;
};
export function publishSettings(bus: SettingsBus, options: ReadOptions): () => void {
	const publish = () => {
		const { values: _, ...snapshot } = readSettings(options);
		bus.emit("harness:settings:publish", { ...snapshot, declaration: structuredClone(settings) });
	};
	const off = bus.on("harness:settings:request", (value) => {
		if (isRecord(value) && value.version === 2) publish();
	});
	try {
		publish();
	} catch (error) {
		off();
		throw error;
	}
	return off;
}
