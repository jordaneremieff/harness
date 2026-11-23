import { field, list, object, type Presenter, text } from "./display-data.ts";
import { calendarPresenters } from "./display-calendar.ts";
import { documentsPresenters } from "./display-documents.ts";
import { drivePresenters } from "./display-drive.ts";
import { gmailPresenters } from "./display-gmail.ts";
import { sheetsPresenters } from "./display-sheets.ts";
import { tasksPresenters } from "./display-tasks.ts";
import { presentTool } from "./tool-presentation.ts";

const status: Presenter = {
	call: () => ({ subject: "Google Workspace access" }),
	result({ data, isError, status }) {
		if (isError || status === "error") return undefined;
		const failure = object(data.error);
		const code = field(failure.code);
		const cancelled = code === "ABORTED";
		const backend = object(data.backend);
		const backendName = field(backend.name);
		const version = field(backend.requiredVersion);
		const observed = field(data.observedAccount);
		const expected = field(data.expectedAccount);
		const ready =
			data.ready === true
				? "Access is ready."
				: data.ready === false
					? "Access is not ready."
					: "Readiness was not established.";
		const scopes = list(data.grantedScopes).map(field).filter(Boolean);
		return {
			outcome: cancelled ? "Cancelled" : ready,
			body: [
				!cancelled && (text(failure.message).trim() || code),
				observed && `Signed in as ${observed}`,
				expected && expected !== observed && `Expected account ${expected}`,
				backendName && version && `Requires ${backendName} ${version}`,
			].filter((row): row is string => !!row),
			details: [
				code && `Status code ${code}`,
				...scopes.map((scope) => `Granted scope: ${scope}`),
				...Object.entries(object(data.capabilities)).flatMap(([capability, granted]) =>
					typeof granted === "boolean" ? [`${field(capability)}: ${granted ? "available" : "not available"}`] : [],
				),
			].filter(Boolean),
		};
	},
};

const presenters = {
	google_status: status,
	...gmailPresenters,
	...drivePresenters,
	...calendarPresenters,
	...documentsPresenters,
	...sheetsPresenters,
	...tasksPresenters,
};

// Mutation failures can echo content deliberately omitted from the card.
const independentReads = new Set([
	"google_status",
	"gmail_search",
	"gmail_message_get",
	"gmail_thread_get",
	"gmail_labels_list",
	"gmail_drafts_list",
	"gmail_draft_get",
	"gmail_operation_status",
	"drive_files_list",
	"drive_file_get",
	"drive_permissions_list",
	"calendar_calendars_list",
	"calendar_events_list",
	"calendar_event_get",
	"calendar_acl_list",
	"docs_get",
	"slides_get",
	"sheets_get",
	"sheets_values_get",
	"tasks_lists_list",
	"tasks_list",
	"tasks_get",
]);

const tools = Object.entries(presenters).map(([name, presenter]) =>
	presentTool(name, presenter, independentReads.has(name)),
);

export function toolDisplay() {
	return { version: 1 as const, tools };
}
