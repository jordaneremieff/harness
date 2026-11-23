import {
	arr,
	bool,
	int,
	lit,
	map,
	nullable,
	obj,
	opt,
	type Static,
	str,
	union,
	unknown,
} from "@earendil-works/pi-schema";
import { type ConfigDisplayDetails, describeConfigEdit } from "./display.ts";
import type { ConfigBackend } from "./operations.ts";
import type { ApplyState, Change, EditRequest, EditResult, Entry } from "./protocol.ts";

const id = str({
	minLength: 3,
	maxLength: 4096,
	description: "Setting id from config_find, such as pi:/compaction/enabled",
});
const scope = union([lit("global"), lit("project"), lit("machine")], {
	description: "Pi settings: global (agent directory) or project. Harness and custom settings: machine or omitted.",
});
const saved = obj({ present: bool(), value: opt(unknown()) }, { description: "The stored value this change replaces" });

export const FindParameters = obj(
	{
		query: opt(
			str({
				maxLength: 200,
				description: "Words that must all appear in the id, name, section, description or environment name",
			}),
		),
		group: opt(union([lit("pi"), lit("harness"), lit("custom")])),
		limit: opt(int({ minimum: 1, maximum: 50 })),
		offset: opt(int({ minimum: 0, maximum: 100000 })),
	},
	{},
);
export const GetParameters = obj({ ids: arr(id, { minItems: 1, maxItems: 10 }) }, {});
export const EditParameters = obj(
	{
		mode: union([lit("preview"), lit("commit")]),
		changes: arr(
			obj(
				{
					id,
					action: union([lit("set"), lit("unset"), lit("create"), lit("delete")]),
					scope: opt(scope),
					value: opt(unknown({ description: "JSON value for set or create" })),
					description: opt(
						str({ maxLength: 1024, description: "Custom settings: one-line description; empty removes it" }),
					),
					type: opt(
						union([
							lit("string"),
							lit("number"),
							lit("integer"),
							lit("boolean"),
							lit("array"),
							lit("object"),
							lit("json"),
						]),
					),
					base: opt(saved),
					schema: opt(str({ maxLength: 128, description: "The entry's schema from config_get" })),
					raw: opt(bool({ description: "Edit an internal, deprecated, unregistered or unmanaged target as raw JSON" })),
				},
				{},
			),
			{ minItems: 1, maxItems: 64 },
		),
		revisions: opt(
			map(nullable(str({ maxLength: 80 })), {
				description: "Document revisions from config_get, keyed by harness, pi-global or pi-project",
			}),
		),
		requestId: opt(
			str({ minLength: 1, maxLength: 128, description: "Reuse the same id to retry the same commit safely" }),
		),
	},
	{},
);
export const ToolsParameters = obj(
	{
		activate: opt(arr(str({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
		deactivate: opt(arr(str({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
	},
	{},
);
export type FindInput = Static<typeof FindParameters>;
export type GetInput = Static<typeof GetParameters>;
export type EditInput = Static<typeof EditParameters>;
export type ToolsInput = Static<typeof ToolsParameters>;

export const DESCRIPTIONS = {
	find: "Search the settings of Pi, of loaded harness extensions, and the operator's custom settings. Returns ids with the current value and its source. Use config_get for detail before an edit.",
	get: "Read settings in full by id: saved value in each scope, the value in force and its source, environment masking, the session's loaded value, defaults, owner state, when a change applies, and document revisions for config_edit.",
	edit: "Preview or commit a batch of setting changes: set, unset (reset to normal resolution), create or delete. Owners validate harness values; Pi values are checked against the installed schema. A commit needs revisions from config_get or each change's base, and reports what was saved and when it applies.",
	tools:
		"Show the configured tools, which are active in this session, and the resolved defaultTools setting; activate or deactivate tools for this session only.",
} as const;
export const GUIDANCE =
	"Config tools: find, then get, then edit. Commit with the revisions that config_get returned, and read the result's apply state before you claim a change is in effect. Change settings only when the operator asks or the task needs it; tool access is not the operator's approval.";

const VALUE_BYTES = 32768;
const OUTPUT_BYTES = 98304;
const outputDiagnostic = `The result exceeds ${OUTPUT_BYTES} bytes; request fewer ids or a smaller page.`;
const omittedValue = { omitted: `The value exceeds ${VALUE_BYTES} bytes; open it in /config.` };
function boundedEntry(entry: Entry & { applyState?: ApplyState }) {
	const copy = structuredClone(entry);
	const trim = <T>(value: T) =>
		value !== undefined && Buffer.byteLength(JSON.stringify(value)) > VALUE_BYTES ? omittedValue : value;
	for (const key of Object.keys(copy.saved) as (keyof typeof copy.saved)[]) {
		const item = copy.saved[key];
		if (item?.present) (item as { value: unknown }).value = trim(item.value);
	}
	if (copy.resolved.value !== undefined) copy.resolved.value = trim(copy.resolved.value);
	if (copy.session?.value !== undefined) copy.session.value = trim(copy.session.value);
	return copy;
}
export async function executeConfigTool<T>(
	name: string,
	run: () => T | Promise<T>,
	describe?: (result: T, limited: boolean) => ConfigDisplayDetails,
) {
	const send = (body: string, facts: ConfigDisplayDetails, isError = false) => ({
		content: [{ type: "text" as const, text: body }],
		details: { summary: name, ...facts },
		...(isError ? { isError: true as const } : {}),
	});
	try {
		const result = await run();
		const serialized = JSON.stringify(result);
		const limited = Buffer.byteLength(serialized) > OUTPUT_BYTES;
		const body = limited ? JSON.stringify({ error: outputDiagnostic }) : serialized;
		return send(
			body,
			{
				...(limited ? ({ diagnostic: outputDiagnostic, outputLimited: true } as const) : {}),
				...describe?.(result, limited),
			},
			limited,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const diagnostic = errorText(message);
		return send(JSON.stringify({ error: diagnostic }), { diagnostic }, true);
	}
}

function errorText(message: string) {
	return Buffer.byteLength(JSON.stringify({ error: message })) > OUTPUT_BYTES ? outputDiagnostic : message;
}

export function editDisplay(result: EditResult, limited: boolean): ConfigDisplayDetails {
	return limited
		? {
				edit: { mode: result.mode, outcome: result.outcome, lines: [] },
				diagnostic: "The edit receipt exceeds 98304 bytes. Read the settings before another edit.",
				outputLimited: true,
			}
		: { edit: describeConfigEdit(result) };
}

export function runFind(backend: ConfigBackend, input: FindInput) {
	const result = backend.find({ text: input.query, group: input.group, limit: input.limit, offset: input.offset });
	return { ...result, coverage: (input.offset ?? 0) === 0 ? result.coverage : undefined };
}
export function runGet(backend: ConfigBackend, input: GetInput) {
	const result = backend.get(input.ids);
	const { documents, agentDir, cwd, projectTrusted, host } = result.context;
	return {
		context: { agentDir, cwd, projectTrusted, host: { kind: host.kind, piVersion: host.piVersion }, documents },
		entries: result.entries.map(boundedEntry),
		missing: result.missing,
		owners: result.owners,
	};
}
export async function runEdit(backend: ConfigBackend, input: EditInput) {
	const request: EditRequest = {
		mode: input.mode,
		changes: input.changes as Change[],
		...(input.revisions ? { revisions: input.revisions as EditRequest["revisions"] } : {}),
		...(input.requestId ? { requestId: input.requestId } : {}),
	};
	return backend.edit(request);
}
export function runTools(backend: ConfigBackend, input: ToolsInput) {
	const change = input.activate?.length || input.deactivate?.length ? backend.applyTools(input) : undefined;
	const view = backend.tools();
	return {
		...(change ? { change } : {}),
		session: view.session,
		...(view.reason ? { reason: view.reason } : {}),
		active: view.active,
		tools: view.tools.map(({ name, exposure, active, source }) => ({ name, exposure, active, source })),
		defaults: view.defaults,
		notes: view.notes,
	};
}
