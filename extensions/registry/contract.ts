/**
 * Model-facing tool contract shared by the ordinary Pi entrypoint and the Pi
 * Durable contribution.
 *
 * The schema, description, and usage guidance are one definition so both
 * entrypoints expose the same parameters and the same words to the model. The
 * durable contribution renders the guidance as a prompt section because the
 * Durable tool registry carries no per-tool prompt guidelines.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONTAINS_MAX,
	CONTAINS_MIN,
	CURSOR_MAX_BYTES,
	LIMIT_DEFAULT,
	LIMIT_MAX,
	LIMIT_MIN,
	NAME_MAX,
	NAME_MIN,
	QUERY_KINDS,
} from "./query.ts";

export const RegistryParams = Type.Object(
	{
		name: Type.Optional(
			Type.String({
				minLength: NAME_MIN,
				maxLength: NAME_MAX,
				description: "Exact case-sensitive resource name. A skill also answers to its skill:<name> invocation form.",
			}),
		),
		match: Type.Optional(
			StringEnum(["exact", "substring"] as const, {
				description: "Name comparison mode; exact is the default. Both are case-sensitive.",
			}),
		),
		kind: Type.Optional(
			StringEnum(QUERY_KINDS, { description: "Resource kind. model queries chat models only, not classifiers or image models; context_file returns prior observed paths only." }),
		),
		search: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX,
			description: "Literal case-insensitive search over names, descriptions, and tool usage guidelines, not file contents." })),
		detail: Type.Optional(Type.Boolean({ description: "Return parameters and promptGuidelines for kind tool and one exact name; no search or contains." })),
		provider: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX, description: "Exact provider ID; requires kind model." })),
		available: Type.Optional(Type.Boolean({ description: "Filter cached availability; requires kind model. Not remote health." })),
		health: Type.Optional(Type.Boolean({ description: "With kind model, true returns flagged local catalog records with reasons and checked boundaries. Offline only; false is an ordinary model query." })),
		contains: Type.Optional(
			Type.String({
				minLength: CONTAINS_MIN,
				maxLength: CONTAINS_MAX,
				description:
					"Literal, case-insensitive content query against one uniquely resolved file-backed skill or prompt.",
			}),
		),
		limit: Type.Optional(
			Type.Integer({
				minimum: LIMIT_MIN,
				maximum: LIMIT_MAX,
				description: `Records per page; default ${LIMIT_DEFAULT}.`,
			}),
		),
		cursor: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: CURSOR_MAX_BYTES,
				description: "Opaque continuation from a previous page. Pass it as the only argument.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const REGISTRY_DESCRIPTION =
	"Look up session tools, commands, skills, prompt templates, chat model catalog, and prior observed context-file paths. Use search for purpose discovery across names, descriptions, and tool usage guidelines, kind model with canonical provider/id name for model selection facts, health true with kind model for an offline catalog review, and detail true with kind tool and an exact name for its parameters and guidelines. With no arguments it returns current model, thinking level, live context-usage estimate, host facts, and observation boundaries. Context usage is not a safe remaining budget; unknown remains unknown after compaction. name is case-sensitive; a skill also answers to its skill:<name> invocation form and results keep both names. contains runs one literal, case-insensitive content search over a single uniquely resolved file-backed skill or prompt and returns matching lines with context. Lists are compact; exact name queries return full model metadata or resource provenance, and detail true adds tool schemas/guidelines. Structured records retain every sourceInfo field. Results state observation time and evidence type; tool records separate configured presence from active status. Complete results are bounded to 50 KiB and 2000 lines; scans read at most 256 KiB. Read-only: it accepts no file path, crawls no directory, and mutates nothing.";

export const REGISTRY_PROMPT_SNIPPET = "Discover session resources, chat models, tool schemas, and observed context paths";

export const REGISTRY_PROMPT_GUIDELINES = [
	"Use an already-visible tool directly when its purpose and arguments fit the task. Use registry when the needed resource, model capability, tool arguments, or instruction source is uncertain. Use search with a short task phrase when the name is unknown.",
	"Use exact name + kind for full metadata/provenance, and detail true with kind tool for parameters and guidelines; registry presence does not activate a tool. Model availability is a cached local snapshot, not credential validity or remote health.",
	"Use registry with no arguments for current context usage and model facts. Read the observation time; unknown or unavailable context usage is not zero or a safe remaining budget.",
	"Use registry with contains to quote a line from one named skill or prompt file rather than reading the file by path.",
	"Treat a registry partial, unavailable, or not_yet_observed result as incomplete evidence, not absence. Search is literal: no matching phrase does not prove no relevant capability exists. Try another short term or inspect a bounded kind list.",
] as const;
