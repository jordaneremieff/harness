import { arr, bool, int, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { SCOPES } from "./gws.ts";
import { external, GoogleError, ok, TextBudget } from "./result.ts";
import type { ToolSpec } from "./tools.ts";

const CalendarId = opt(str({ minLength: 1, maxLength: 1024, default: "primary" }));
const EventId = str({ minLength: 1, maxLength: 1024 });
const SendUpdates = opt(oneOf(["none", "externalOnly", "all"]));
const DateTime = obj({
	dateTime: opt(str({ minLength: 1, maxLength: 100 })),
	date: opt(str({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	timeZone: opt(str({ minLength: 1, maxLength: 200 })),
});
const Attendee = obj({
	email: str({ minLength: 3, maxLength: 320 }),
	displayName: opt(str({ maxLength: 1024 })),
	optional: opt(bool()),
	responseStatus: opt(oneOf(["needsAction", "declined", "tentative", "accepted"])),
});
const EventFields = {
	summary: opt(str({ maxLength: 4096 })),
	description: opt(str({ maxLength: 65536 })),
	location: opt(str({ maxLength: 16384 })),
	attendees: opt(arr(Attendee, { maxItems: 50 })),
};
const readEvents = [SCOPES.calendarEventsRead, SCOPES.calendarEvents, SCOPES.calendar];
const writeEvents = [SCOPES.calendarEventsOwned, SCOPES.calendarEvents, SCOPES.calendar];
const readCalendars = [SCOPES.calendarListRead, SCOPES.calendar];
const readAcls = [SCOPES.calendarAclRead, SCOPES.calendarAcls, SCOPES.calendar];
const writeAcls = [SCOPES.calendarAcls, SCOPES.calendar];

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}
function dateTime(value: unknown) {
	if (!object(value)) return undefined;
	return {
		dateTime: text(value.dateTime) || undefined,
		date: text(value.date) || undefined,
		timeZone: text(value.timeZone) || undefined,
	};
}
function eventView(event: Record<string, unknown>, budget: TextBudget) {
	const summary = budget.clip(event.summary, 4096),
		description = budget.clip(event.description, 8192),
		location = budget.clip(event.location, 4096);
	return {
		eventId: text(event.id),
		status: text(event.status),
		htmlLink: text(event.htmlLink) || undefined,
		updated: text(event.updated) || undefined,
		start: dateTime(event.start),
		end: dateTime(event.end),
		externalData: external("calendar", {
			summary: summary.text,
			description: description.text,
			location: location.text,
			attendees: (Array.isArray(event.attendees) ? event.attendees.filter(object) : []).map((attendee) => ({
				email: budget.clip(attendee.email, 320).text,
				displayName: budget.clip(attendee.displayName, 1024).text,
				optional: attendee.optional === true,
				responseStatus: text(attendee.responseStatus) || undefined,
			})),
			truncated: summary.truncated || description.truncated || location.truncated,
		}),
	};
}
function calendarView(calendar: Record<string, unknown>, budget: TextBudget) {
	return {
		calendarId: text(calendar.id),
		primary: calendar.primary === true,
		accessRole: text(calendar.accessRole),
		externalData: external("calendar", {
			summary: budget.clip(calendar.summary, 4096).text,
			description: budget.clip(calendar.description, 4096).text,
			location: budget.clip(calendar.location, 4096).text,
			timeZone: text(calendar.timeZone),
		}),
	};
}
function validEventTime(value: { dateTime?: string; date?: string } | undefined, field: string): void {
	if (!value || (!value.dateTime && !value.date))
		throw new GoogleError("INVALID_ARGUMENT", `${field} requires dateTime or date.`);
}
type EventInput = {
	summary?: string;
	description?: string;
	location?: string;
	attendees?: unknown[];
	start?: { dateTime?: string; date?: string; timeZone?: string };
	end?: { dateTime?: string; date?: string; timeZone?: string };
};

export const calendarTools: ToolSpec[] = [
	{
		name: "calendar_calendars_list",
		label: "Calendar list",
		description: "List calendars visible to the account with bounded metadata.",
		parameters: obj({
			limit: opt(int({ minimum: 1, maximum: 50, default: 20 })),
			cursor: opt(str({ minLength: 1, maxLength: 4096 })),
			showHidden: opt(bool({ default: false })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: readCalendars }, signal, async (operation) => {
				const args = value as { limit?: number; cursor?: string; showHidden?: boolean };
				const response = await operation.call<Record<string, unknown>>("calendar", ["calendarList", "list"], {
					params: {
						maxResults: args.limit ?? 20,
						...(args.cursor ? { pageToken: args.cursor } : {}),
						showHidden: args.showHidden ?? false,
					},
				});
				const budget = new TextBudget();
				return ok({
					calendars: (Array.isArray(response.items) ? response.items.filter(object) : []).map((calendar) =>
						calendarView(calendar, budget),
					),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "calendar_events_list",
		label: "Calendar events",
		description: "List events in one calendar with bounded content and finite pagination.",
		parameters: obj({
			calendarId: CalendarId,
			timeMin: opt(str({ minLength: 1, maxLength: 100 })),
			timeMax: opt(str({ minLength: 1, maxLength: 100 })),
			query: opt(str({ maxLength: 4096 })),
			limit: opt(int({ minimum: 1, maximum: 50, default: 20 })),
			cursor: opt(str({ minLength: 1, maxLength: 4096 })),
			orderBy: opt(oneOf(["startTime", "updated"])),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: readEvents }, signal, async (operation) => {
				const args = value as {
					calendarId?: string;
					timeMin?: string;
					timeMax?: string;
					query?: string;
					limit?: number;
					cursor?: string;
					orderBy?: string;
				};
				const response = await operation.call<Record<string, unknown>>("calendar", ["events", "list"], {
					params: {
						calendarId: args.calendarId ?? "primary",
						singleEvents: true,
						orderBy: args.orderBy ?? "startTime",
						...(args.timeMin ? { timeMin: args.timeMin } : {}),
						...(args.timeMax ? { timeMax: args.timeMax } : {}),
						...(args.query ? { q: args.query } : {}),
						maxResults: args.limit ?? 20,
						...(args.cursor ? { pageToken: args.cursor } : {}),
					},
				});
				const budget = new TextBudget();
				return ok({
					events: (Array.isArray(response.items) ? response.items.filter(object) : []).map((event) =>
						eventView(event, budget),
					),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "calendar_event_get",
		label: "Calendar event",
		description: "Read one Calendar event with bounded external content.",
		parameters: obj({ calendarId: CalendarId, eventId: EventId }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: readEvents }, signal, async (operation) => {
				const args = value as { calendarId?: string; eventId: string };
				return ok(
					eventView(
						await operation.call<Record<string, unknown>>("calendar", ["events", "get"], {
							params: { calendarId: args.calendarId ?? "primary", eventId: args.eventId },
						}),
						new TextBudget(),
					),
				);
			}),
	},
	{
		name: "calendar_event_create",
		label: "Calendar event create",
		description: "Create one Calendar event with sendUpdates defaulting to none.",
		parameters: obj({
			calendarId: CalendarId,
			event: obj({ ...EventFields, summary: str({ maxLength: 4096 }), start: DateTime, end: DateTime }),
			sendUpdates: SendUpdates,
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: writeEvents }, signal, async (operation) => {
				const args = value as { calendarId?: string; event: EventInput; sendUpdates?: string };
				validEventTime(args.event.start, "start");
				validEventTime(args.event.end, "end");
				const response = await operation.call<Record<string, unknown>>("calendar", ["events", "insert"], {
					params: { calendarId: args.calendarId ?? "primary", sendUpdates: args.sendUpdates ?? "none" },
					body: args.event as Record<string, unknown>,
				});
				return ok(eventView(response, new TextBudget()));
			}),
	},
	{
		name: "calendar_event_update",
		label: "Calendar event update",
		description: "Patch one Calendar event with sendUpdates defaulting to none.",
		parameters: obj({
			calendarId: CalendarId,
			eventId: EventId,
			event: obj({ ...EventFields, start: opt(DateTime), end: opt(DateTime) }),
			sendUpdates: SendUpdates,
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: writeEvents }, signal, async (operation) => {
				const args = value as { calendarId?: string; eventId: string; event: EventInput; sendUpdates?: string };
				if (!Object.keys(args.event).length)
					throw new GoogleError("INVALID_ARGUMENT", "An event patch must contain a field.");
				if (args.event.start) validEventTime(args.event.start, "start");
				if (args.event.end) validEventTime(args.event.end, "end");
				const response = await operation.call<Record<string, unknown>>("calendar", ["events", "patch"], {
					params: {
						calendarId: args.calendarId ?? "primary",
						eventId: args.eventId,
						sendUpdates: args.sendUpdates ?? "none",
					},
					body: args.event as Record<string, unknown>,
				});
				return ok(eventView(response, new TextBudget()));
			}),
	},
	{
		name: "calendar_event_cancel",
		label: "Calendar event cancel",
		description: "Cancel one Calendar event with sendUpdates defaulting to none.",
		parameters: obj({ calendarId: CalendarId, eventId: EventId, sendUpdates: SendUpdates }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: writeEvents }, signal, async (operation) => {
				const args = value as { calendarId?: string; eventId: string; sendUpdates?: string };
				await operation.call("calendar", ["events", "delete"], {
					params: {
						calendarId: args.calendarId ?? "primary",
						eventId: args.eventId,
						sendUpdates: args.sendUpdates ?? "none",
					},
					allowEmpty: true,
				});
				return ok({
					calendarId: args.calendarId ?? "primary",
					eventId: args.eventId,
					cancelled: true,
					sendUpdates: args.sendUpdates ?? "none",
				});
			}),
	},
	{
		name: "calendar_acl_list",
		label: "Calendar ACL",
		description: "List access-control rules for one calendar.",
		parameters: obj({
			calendarId: CalendarId,
			limit: opt(int({ minimum: 1, maximum: 50, default: 20 })),
			cursor: opt(str({ minLength: 1, maxLength: 4096 })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: readAcls }, signal, async (operation) => {
				const args = value as { calendarId?: string; limit?: number; cursor?: string };
				const response = await operation.call<Record<string, unknown>>("calendar", ["acl", "list"], {
					params: {
						calendarId: args.calendarId ?? "primary",
						maxResults: args.limit ?? 20,
						...(args.cursor ? { pageToken: args.cursor } : {}),
					},
				});
				const budget = new TextBudget();
				return ok({
					rules: (Array.isArray(response.items) ? response.items.filter(object) : []).map((rule) => ({
						ruleId: text(rule.id),
						role: text(rule.role),
						externalData: external("calendar", {
							scope: object(rule.scope)
								? { type: text(rule.scope.type), value: budget.clip(rule.scope.value, 1024).text }
								: {},
						}),
					})),
					nextCursor: text(response.nextPageToken) || undefined,
				});
			}),
	},
	{
		name: "calendar_share",
		label: "Calendar share",
		description: "Create one calendar access rule with notifications off by default.",
		parameters: obj({
			calendarId: CalendarId,
			role: oneOf(["none", "freeBusyReader", "reader", "writer", "owner"]),
			scopeType: oneOf(["default", "user", "group", "domain"]),
			scopeValue: opt(str({ minLength: 1, maxLength: 1024 })),
			sendNotifications: opt(bool({ default: false })),
		}),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: writeAcls }, signal, async (operation) => {
				const args = value as {
					calendarId?: string;
					role: string;
					scopeType: string;
					scopeValue?: string;
					sendNotifications?: boolean;
				};
				if (args.scopeType !== "default" && !args.scopeValue)
					throw new GoogleError("INVALID_ARGUMENT", "A non-default calendar scope requires scopeValue.");
				const response = await operation.call<Record<string, unknown>>("calendar", ["acl", "insert"], {
					params: { calendarId: args.calendarId ?? "primary", sendNotifications: args.sendNotifications ?? false },
					body: {
						role: args.role,
						scope: { type: args.scopeType, ...(args.scopeValue ? { value: args.scopeValue } : {}) },
					},
				});
				return ok({
					ruleId: text(response.id),
					calendarId: args.calendarId ?? "primary",
					notificationsSent: args.sendNotifications ?? false,
				});
			}),
	},
	{
		name: "calendar_unshare",
		label: "Calendar unshare",
		description: "Remove one access rule from a calendar.",
		parameters: obj({ calendarId: CalendarId, ruleId: str({ minLength: 1, maxLength: 1024 }) }),
		replay: "unsafe",
		execute: async (value, runtime, signal) =>
			runtime.run({ scopes: writeAcls }, signal, async (operation) => {
				const args = value as { calendarId?: string; ruleId: string };
				await operation.call("calendar", ["acl", "delete"], {
					params: { calendarId: args.calendarId ?? "primary", ruleId: args.ruleId },
					allowEmpty: true,
				});
				return ok({ calendarId: args.calendarId ?? "primary", ruleId: args.ruleId, deleted: true });
			}),
	},
];
