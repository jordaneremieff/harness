import assert from 'node:assert/strict';
import test from 'node:test';
import { absoluteTime, compactAge, formatDate, isValidTimestamp, localDateTime, previewText, relativeTime, stripControls, timestampDetails } from './format.ts';

test('relative ages use supplied time and fixed units', () => {
  const now = Date.UTC(2026, 9, 8, 12);
  for (const [seconds, label] of [[0, 'now'], [59, 'now'], [60, 'now'], [61, '1m ago'], [900, '15m ago'], [3599, '59m ago'], [3600, '1hr ago'], [10800, '3hr ago'], [86399, '23hr ago'], [86400, '1d ago'], [29 * 86400, '29d ago']] as const) {
    assert.equal(relativeTime(now - seconds * 1000, now), label);
  }
  assert.equal(relativeTime(now + 10000, now), 'now');
  assert.equal(relativeTime('invalid', now), '');
  assert.equal(relativeTime(now, Number.NaN), '');
  assert.equal(relativeTime(new Date(now - 180000), now), '3m ago');
});
test('compact ages share relative units and local day-first cutoffs', () => {
  const now = new Date(2026, 9, 8, 12).getTime();
  for (const [seconds, label] of [[0, 'now'], [60, 'now'], [61, '1m'], [3599, '59m'], [3600, '1h'], [86399, '23h'], [86400, '1d'], [30 * 86400 - 1, '29d']] as const) {
    assert.equal(compactAge(now - seconds * 1000, now), label);
  }
  const date = (value: number) => formatDate(value, {month: 'short', day: 'numeric'});
  assert.equal(compactAge(now + 60000, now), 'now');
  for (const value of [0, now + 60001, now - 30 * 86400000]) assert.equal(compactAge(value, now), date(value));
  for (const value of [Number.NaN, Infinity, -Infinity, 8.64e15 + 1]) assert.equal(compactAge(value, now), '');
  assert.equal(compactAge(now, Number.NaN), '');
});
test('old and future dates use compact local dates with the year', () => {
  const now = new Date(2026, 9, 8, 12).getTime();
  const compact = (value: number) => formatDate(value, {year: 'numeric', month: 'short', day: 'numeric'});
  assert.equal(relativeTime(now - 30 * 86400000 + 1, now), '29d ago');
  assert.equal(relativeTime(now - 30 * 86400000, now), compact(now - 30 * 86400000));
  assert.equal(relativeTime(0, now), compact(0));
  assert.match(relativeTime(0, now), /(?:1969|1970)/);
  for (const delta of [-60000, 60000]) assert.equal(relativeTime(now + delta, now), 'now');
  for (const delta of [60001, 86400000]) assert.equal(relativeTime(now + delta, now), compact(now + delta));
  assert.equal(relativeTime(now - 86400000, now), relativeTime(now - 86400000, now));
});
test('all timestamp formats reject nonfinite and out-of-range dates but accept zero', () => {
  assert.equal(isValidTimestamp(0), true);
  assert.equal(isValidTimestamp('1970-01-01T00:00:00.000Z'), true);
  for (const invalid of ['', 'invalid', Number.NaN, Infinity, -Infinity, 8.64e15 + 1, new Date(Number.NaN)]) {
    assert.equal(isValidTimestamp(invalid), false);
    assert.equal(relativeTime(invalid, Date.UTC(2026, 9, 8)), '');
    assert.equal(absoluteTime(invalid), '');
    assert.deepEqual(timestampDetails(invalid), {exact: '', display: ''});
  }
  assert.equal(relativeTime(0, 8.64e15 + 1), '');
  assert.equal(timestampDetails(0, 'UTC').exact, '1970-01-01T00:00:00.000Z');
});
test('absolute dates include the selected timezone without a timer', () => {
  const value = '2026-10-08T12:01:00.000Z';
  assert.equal(absoluteTime(value, {timeZone: 'UTC'}), '8 Oct 2026, 12:01 PM');
  const details = timestampDetails(value, 'UTC');
  assert.equal(details.exact, value);
  assert.match(details.display, /UTC/);
  assert.equal(absoluteTime('invalid'), '');
  assert.deepEqual(timestampDetails('invalid'), {exact: '', display: ''});
});
test('every date form uses day-first en-AU parts and uppercase day periods in a fixed zone', () => {
  const value = '2026-10-20T06:48:33.000Z', zone = 'Australia/Sydney';
  const at = Date.parse(value), later = at + 31 * 86400000;
  assert.equal(absoluteTime(value, {timeZone: zone}), '20 Oct 2026, 5:48 PM');
  assert.equal(relativeTime(value, later, zone), '20 Oct 2026');
  assert.equal(relativeTime(value, at - 60001, zone), '20 Oct 2026');
  assert.equal(compactAge(at, later, zone), '20 Oct');
  assert.equal(localDateTime(value, zone), '20 Oct, 5:48:33 PM');
  assert.deepEqual(timestampDetails(value, zone), {exact: value, display: '20 Oct 2026, 5:48:33 PM AEDT'});
  assert.equal(absoluteTime('2026-10-20T13:00:00Z', {timeZone: zone}), '21 Oct 2026, 12:00 AM');
  assert.equal(localDateTime('2026-10-20T13:00:00Z', zone), '21 Oct, 12:00:00 AM');
  assert.equal(timestampDetails('2026-10-20T13:00:00Z', zone).display, '21 Oct 2026, 12:00:00 AM AEDT');
  assert.equal(absoluteTime(value, {timeZone: 'UTC'}), '20 Oct 2026, 6:48 AM');
  assert.equal(formatDate('invalid', {day: 'numeric'}, zone), '');
  assert.equal(localDateTime('invalid', zone), '');
});
test('date helpers use the local zone when no zone is supplied', () => {
  const value = '2026-10-20T13:00:00.000Z', zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.parse(value) + 31 * 86400000;
  assert.equal(absoluteTime(value), absoluteTime(value, {timeZone: zone}));
  assert.equal(relativeTime(value, now), relativeTime(value, now, zone));
  assert.equal(compactAge(Date.parse(value), now), compactAge(Date.parse(value), now, zone));
  assert.equal(localDateTime(value), localDateTime(value, zone));
  assert.deepEqual(timestampDetails(value), timestampDetails(value, zone));
});
test('terminal instructions disappear without removing ordinary text', () => {
  assert.equal(stripControls('\x1b[31mred\x1b[0m\x1b]0;title\x07 text\r\nnext\x00'), 'red text\nnext');
  assert.equal(stripControls('\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\'), 'link');
  assert.equal(stripControls('\x1bPprivate\x1b\\hello\x9b2J world'), 'hello world');
  assert.equal(stripControls('a\tβ\n😀\x7f'), 'a\tβ\n😀');
});
test('previews report actual omission and preserve Unicode pairs', () => {
  assert.deepEqual(previewText('one\ntwo\nthree', 2), {text: 'one\ntwo', truncated: true});
  assert.deepEqual(previewText('a😀b', 6, 2), {text: 'a', truncated: true});
  assert.deepEqual(previewText('short', 6, 20), {text: 'short', truncated: false});
  assert.deepEqual(previewText('text', 0), {text: '', truncated: true});
});
