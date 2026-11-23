import {
	type CardResult,
	count,
	type Data,
	field,
	list,
	object,
	pick,
	type Presenter,
	text,
	type ResultContext,
} from "./display-data.ts";
import { displayCalendarDateTime, displayDate, displayInstant } from "./display-dates.ts";

function calendarId(args: Data): string {
	return field(args.calendarId) || "primary calendar";
}

function time(value: unknown): string {
	const stamp = object(value);
	return displayCalendarDateTime(stamp.dateTime, stamp.timeZone) || displayDate(stamp.date);
}

function eventFacts(event: Data): string[] {
	const start = time(event.start);
	const end = time(event.end);
	return [field(event.eventId), field(event.status), start && `Starts ${start}`, end && `Ends ${end}`].filter(Boolean);
}

function eventReceipt(ctx: ResultContext, outcome: string, includeTitle: boolean): CardResult | undefined {
	if (ctx.isError || !field(ctx.data.eventId)) return;
	const body = eventFacts(ctx.data);
	if (!includeTitle) return { outcome, body };
	const external = object(ctx.data.externalData);
	const description = text(external.description).trim();
	return {
		outcome,
		body: [field(external.summary), ...body, field(external.location), description].filter(Boolean),
		details: eventReadDetails(ctx.data, external),
	};
}

function eventReadDetails(event: Data, external: Data): string[] {
	const link = field(event.htmlLink);
	const attendees = Array.isArray(external.attendees) ? count(external.attendees.length, "attendee") : "";
	return [link, attendees, external.truncated === true ? "The service truncated event text." : ""].filter(Boolean);
}

function eventCall(args: Data) {
	return { subject: field(args.eventId) || "Calendar event", facts: [calendarId(args)] };
}

function eventChange(args: Data) {
	const changed = object(args.event);
	const fields = Object.keys(changed);
	const subject = field(args.eventId) || calendarId(args);
	const extras = pick(args, "sendUpdates");
	if (fields.length) extras.event = count(fields.length, "field");
	return { subject, facts: field(args.eventId) ? [calendarId(args)] : [], args: extras };
}

function page(fieldName: string, singular: string, keys: string[], row: (raw: Data) => string): Presenter["result"] {
	return ({ data, args, isError }) => {
		if (isError || !Array.isArray(data[fieldName])) return undefined;
		const items = list(data[fieldName]);
		const cursor = data.nextCursor;
		const next = typeof cursor === "string" && cursor.length ? { args: { ...pick(args, ...keys), cursor } } : undefined;
		return {
			outcome: `This page contains ${count(items.length, singular)}.${next ? " Another page is available." : ""}`,
			body: items.map((item) => row(object(item))).filter(Boolean),
			next,
		};
	};
}

export const calendarPresenters: Record<string, Presenter> = {
	calendar_calendars_list: {
		call: (args) => ({ subject: "Visible calendars", args: pick(args, "limit", "cursor", "showHidden") }),
		result: page("calendars", "calendar", ["limit", "showHidden"], (row) =>
			[field(object(row.externalData).summary), field(row.calendarId), field(row.accessRole)]
				.filter(Boolean)
				.join(" · "),
		),
	},
	calendar_events_list: {
		call: (args) => ({
			subject: calendarId(args),
			facts: [displayInstant(args.timeMin), displayInstant(args.timeMax)].filter(Boolean),
			args: pick(args, "timeMin", "timeMax", "query", "limit", "cursor", "orderBy"),
		}),
		result: page("events", "event", ["calendarId", "timeMin", "timeMax", "query", "limit", "orderBy"], (row) =>
			[time(row.start), field(object(row.externalData).summary), field(row.eventId)].filter(Boolean).join(" · "),
		),
	},
	calendar_event_get: {
		call: eventCall,
		result: (ctx) => eventReceipt(ctx, "Event details returned.", true),
	},
	calendar_event_create: {
		call: eventChange,
		result: (ctx) => eventReceipt(ctx, "Event created.", false),
	},
	calendar_event_update: {
		call: eventChange,
		result: (ctx) => eventReceipt(ctx, "Event updated.", false),
	},
	calendar_event_cancel: {
		call: (args) => ({ ...eventCall(args), args: pick(args, "sendUpdates") }),
		result: ({ data, isError }) =>
			!isError && data.cancelled === true
				? { outcome: "Event cancelled.", body: [field(data.eventId), field(data.calendarId)].filter(Boolean) }
				: undefined,
	},
	calendar_acl_list: {
		call: (args) => ({ subject: calendarId(args), args: pick(args, "limit", "cursor") }),
		result: page("rules", "access rule", ["calendarId", "limit"], (row) =>
			[field(row.ruleId), field(row.role), field(object(object(row.externalData).scope).type)]
				.filter(Boolean)
				.join(" · "),
		),
	},
	calendar_share: {
		call: (args) => {
			const scope = field(args.scopeType);
			return {
				subject: scope === "default" ? "Default access" : field(args.scopeValue),
				facts: [field(args.role), scope === "default" ? "default scope" : scope, calendarId(args)].filter(Boolean),
				args: pick(args, "sendNotifications"),
			};
		},
		result: ({ data, isError }) =>
			!isError && field(data.ruleId)
				? {
						outcome: "Calendar access rule created.",
						body: [field(data.ruleId), field(data.calendarId)].filter(Boolean),
					}
				: undefined,
	},
	calendar_unshare: {
		call: (args) => ({ subject: field(args.ruleId) || "Calendar access rule", facts: [calendarId(args)] }),
		result: ({ data, isError }) =>
			!isError && data.deleted === true
				? {
						outcome: "Calendar access rule removed.",
						body: [field(data.ruleId), field(data.calendarId)].filter(Boolean),
					}
				: undefined,
	},
};
