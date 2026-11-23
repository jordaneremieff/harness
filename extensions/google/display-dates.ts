import { field } from "./display-data.ts";

const localDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const localClock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
const wireDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const wallClock = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
	hour12: true,
	timeZone: "UTC",
});
const datePart = /^\d{4}-\d{2}-\d{2}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const wallTime = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?$/i;

export function displayDate(value: unknown): string {
	const source = field(value);
	const day = source.slice(0, 10);
	if (!datePart.test(day) || (source !== day && !instant.test(source))) return source;
	const date = new Date(`${day}T00:00:00Z`);
	return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day ? wireDay.format(date) : source;
}

export function displayInstant(value: unknown, now = new Date()): string {
	const source = field(value);
	if (!instant.test(source)) return datePart.test(source) ? displayDate(source) : source;
	const date = new Date(source);
	if (!Number.isFinite(date.valueOf())) return source;
	const clock = localClock.format(date);
	return date.toDateString() === now.toDateString() ? clock : `${localDay.format(date)} ${clock}`;
}

export function displayCalendarDateTime(value: unknown, timeZone: unknown): string {
	const source = field(value);
	if (!wallTime.test(source)) return displayInstant(source);
	const zone = field(timeZone) || "zone not supplied";
	// Use UTC only to format the supplied wall-clock fields without a zone conversion.
	const date = new Date(`${source}Z`);
	if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== source.slice(0, 10)) {
		return `${source} (${zone})`;
	}
	return `${wireDay.format(date)} ${wallClock.format(date)} (${zone})`;
}
