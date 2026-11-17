(() => {
	const root = globalThis as unknown as { reader: ReaderCoreAPI };
	const api = root.reader ?? ({} as ReaderCoreAPI);
	root.reader = api;
	interface Result {
		source: string;
		edits: ReaderEdit[];
		inverse: ReaderEdit[];
	}
	interface RecordEntry {
		id: string;
		origin: "person" | "agent";
		blockId: string | null;
		group: string;
		at: number;
		boundary?: boolean;
		sealed?: boolean;
		edits: ReaderEdit[];
		inverse: ReaderEdit[];
	}
	interface Redo {
		operationId?: string;
		origin: "person" | "agent";
		blockId: string | null;
		steps: ReaderEdit[][];
		conflict?: string;
	}
	interface Options {
		threadId?: string;
		now?: number;
		blockId?: string | null;
		id?: string;
		groupMs?: number;
		baseGeneration?: number;
	}
	interface ClaimOptions {
		now?: number;
		id?: string;
		expiresAt?: number;
	}
	class DesyncError extends Error {
		constructor(edit: ReaderEdit, found: string) {
			super(`Expected text differs at UTF-16 ${edit.start}: ${found.length} units.`);
			this.name = "DesyncError";
		}
	}
	function applyEdits(source: string, edits: ReaderEdit[]): Result {
		if (!edits.length) throw new RangeError("An exact change needs an edit.");
		let out = "",
			last = 0,
			previousStart = -1,
			delta = 0;
		const inverse: ReaderEdit[] = [];
		for (const e of edits) {
			if (
				!Number.isSafeInteger(e.start) ||
				!Number.isSafeInteger(e.end) ||
				e.start < last ||
				e.start === previousStart ||
				e.end < e.start ||
				e.end > source.length ||
				typeof e.text !== "string" ||
				typeof e.expected !== "string"
			)
				throw new RangeError("Invalid or unordered exact edit.");
			const old = source.slice(e.start, e.end);
			if (old !== e.expected) throw new DesyncError(e, old);
			out += source.slice(last, e.start) + e.text;
			inverse.push({ start: e.start + delta, end: e.start + delta + e.text.length, text: old, expected: e.text });
			delta += e.text.length - (e.end - e.start);
			last = e.end;
			previousStart = e.start;
		}
		return { source: out + source.slice(last), edits: edits.map((e) => ({ ...e })), inverse };
	}
	function overlaps(a: ReaderRange, b: ReaderRange) {
		if (a.start === a.end && b.start === b.end) return a.start === b.start;
		if (a.start === a.end) return a.start > b.start && a.start < b.end;
		if (b.start === b.end) return b.start > a.start && b.start < a.end;
		return a.start < b.end && b.start < a.end;
	}
	function mapEdits(edits: ReaderEdit[], through: ReaderEdit[]): ReaderEdit[] {
		return edits.map((e) => {
			let delta = 0;
			for (const t of through) {
				if (overlaps(e, t)) throw new Error("A later change overlaps this operation.");
				if (t.end <= e.start) delta += t.text.length - (t.end - t.start);
			}
			return { ...e, start: e.start + delta, end: e.end + delta };
		});
	}
	function inverseOf(edits: ReaderEdit[]) {
		let d = 0;
		return edits.map((e) => {
			const r = { start: e.start + d, end: e.start + d + e.text.length, text: e.expected, expected: e.text };
			d += e.text.length - e.expected.length;
			return r;
		});
	}
	function rebaseSequence(steps: ReaderEdit[][], external: ReaderEdit[]) {
		let carry = external;
		const result: ReaderEdit[][] = [];
		for (const step of steps) {
			const next = mapEdits(step, carry);
			carry = mapEdits(carry, step);
			result.push(next);
		}
		return result;
	}
	const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
	const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
	class Doc {
		source: string;
		generation: number;
		nextId = 1;
		records: RecordEntry[] = [];
		redos: Redo[] = [];
		listeners = new Set<(change: ReaderCoreChange) => void>();
		active: ({ blockId: string } & ReaderRange) | null = null;
		composing = false;
		lastPerson = -Infinity;
		personTimes = new Map<string | null, number>();
		caretPresent = false;
		claims = new Map<string, { ranges: ReaderRange[]; expiresAt: number }>();
		constructor(source: string, generation = 0) {
			this.source = source;
			this.generation = generation;
		}
		setActive(blockId: string | null, range: ReaderRange | null) {
			this.lastPerson = this.personTimes.get(blockId) ?? -Infinity;
			this.active = range && blockId !== null ? { blockId, ...range } : null;
			this.caretPresent = !!range;
		}
		heldRange(_now = Date.now()) {
			return this.active ? { start: this.active.start, end: this.active.end } : null;
		}
		claim(ranges: ReaderRange[], options: ClaimOptions = {}) {
			const { now = Date.now(), id = `claim-${this.nextId++}`, expiresAt = now + 90000 } = options;
			if (
				ranges.length > 16 ||
				ranges.some(
					(r) =>
						!Number.isSafeInteger(r.start) ||
						!Number.isSafeInteger(r.end) ||
						r.start < 0 ||
						r.end < r.start ||
						r.end > this.source.length,
				)
			)
				throw new RangeError("Invalid claim range.");
			const held = this.heldRange(now);
			if (held && ranges.some((r) => overlaps(r, held))) return { status: "busy", reason: "held", range: held };
			this.claims.set(id, { ranges: clone(ranges), expiresAt });
			return { status: "ok", id, ranges: clone(ranges) };
		}
		release(id: string) {
			return this.claims.delete(id);
		}
		expireClaims(now = Date.now()) {
			for (const [id, claim] of this.claims) if (claim.expiresAt <= now) this.claims.delete(id);
		}
		shiftActive(edits: ReaderEdit[], origin: "person" | "agent") {
			const active = this.active;
			if (!active) return;
			const start = active.start,
				end = active.end;
			let startDelta = 0,
				endDelta = 0;
			for (const edit of edits) {
				const delta = edit.text.length - (edit.end - edit.start);
				if (edit.end <= start && !(edit.start === start && origin === "person")) {
					startDelta += delta;
					endDelta += delta;
				} else if (edit.start <= end) endDelta += delta;
			}
			active.start = start + startDelta;
			active.end = end + endDelta;
		}
		publish(
			result: Result,
			origin: "person" | "agent",
			id: string,
			historyAction: string | null = null,
			threadId?: string,
		) {
			const baseGeneration = this.generation++;
			this.source = result.source;
			this.shiftActive(result.edits, origin);
			const change: ReaderCoreChange = {
				...(threadId !== undefined ? { threadId } : {}),
				origin: historyAction ? "history" : origin,
				id,
				...(origin === "agent" ? { operationId: id } : {}),
				historyAction,
				baseGeneration,
				generation: this.generation,
				edits: result.edits,
			};
			for (const fn of this.listeners) fn(change);
		}
		inverseAfter(last: RecordEntry | undefined) {
			if (!last) return undefined;
			let inverse = last.inverse;
			try {
				for (let i = this.records.indexOf(last) + 1; i < this.records.length; i++)
					inverse = mapEdits(inverse ?? [], this.records[i].edits);
			} catch {
				return undefined;
			}
			return inverse;
		}
		adjacentTo(last: RecordEntry | undefined, inverse: ReaderEdit[] | undefined, edits: ReaderEdit[]) {
			if (!last || !inverse || last.edits.length !== 1 || edits.length !== 1) return false;
			return edits[0].start === inverse[0].end || edits[0].end === inverse[0].start;
		}
		shouldGroup(
			origin: "person" | "agent",
			last: RecordEntry | undefined,
			blockId: string | null,
			now: number,
			groupMs: number,
			wordBoundary: boolean,
			adjacent: boolean,
		) {
			return (
				origin === "person" &&
				!!last &&
				!last.sealed &&
				last.blockId === blockId &&
				now - last.at < groupMs &&
				!wordBoundary &&
				!last.boundary &&
				adjacent
			);
		}
		refuseApply(edits: ReaderEdit[], origin: "person" | "agent", baseGeneration: number, now: number) {
			if (baseGeneration !== this.generation) return { status: "stale", reason: "generation" };
			if (origin !== "person" && origin !== "agent") throw new Error("Invalid change origin.");
			const held = this.heldRange(now);
			if (origin === "agent" && held && edits.some((e) => overlaps(e, held)))
				return { status: "busy", reason: "held", range: held };
			return null;
		}
		apply(edits: ReaderEdit[], origin: "person" | "agent", options: Options = {}) {
			const now = options.now ?? Date.now();
			const {
				blockId = this.active?.blockId ?? null,
				id = `op-${this.nextId++}`,
				groupMs = 1000,
				baseGeneration = this.generation,
			} = options;
			const refusal = this.refuseApply(edits, origin, baseGeneration, now);
			if (refusal) return refusal;
			const result = applyEdits(this.source, edits);
			if (this.records.some((r) => r.id === id)) throw new Error("Duplicate operation ID.");
			const last = this.records.findLast((r) => r.origin === "person"),
				wordBoundary = edits.some((e) => /\s/.test(e.text + e.expected));
			const inverse = this.inverseAfter(last);
			const adjacent = this.adjacentTo(last, inverse, edits);
			const grouped = this.shouldGroup(origin, last, blockId, now, groupMs, wordBoundary, adjacent);
			const record: RecordEntry = {
				id,
				origin,
				blockId,
				group: grouped && last ? last.group : id,
				at: now,
				boundary: wordBoundary,
				edits: result.edits,
				inverse: result.inverse,
			};
			this.redos = this.redos.filter((g) => !(origin === "person" && g.blockId === blockId));
			this.rebaseRedos(result.edits);
			this.records.push(record);
			if (origin === "person") {
				this.lastPerson = now;
				this.personTimes.set(blockId, now);
			}
			this.publish(result, origin, id, null, options.threadId);
			return { status: "ok", id, ...result };
		}
		rebaseRedos(edits: ReaderEdit[]) {
			this.redos = this.redos.map((g) => {
				try {
					return { ...g, steps: rebaseSequence(g.steps, edits) };
				} catch (e) {
					return { ...g, conflict: reason(e) };
				}
			});
		}
		seal() {
			const r = this.records.findLast((r) => r.origin === "person");
			if (r) r.sealed = true;
		}
		remove(records: RecordEntry[], source: string, index: number) {
			const target = records[index];
			let inverse = clone(target.inverse);
			for (let i = index + 1; i < records.length; i++) {
				const later = records[i],
					original = later.edits;
				const rebased = mapEdits(original, inverse);
				inverse = mapEdits(inverse, original);
				later.edits = rebased;
				later.inverse = inverseOf(rebased);
			}
			const r = applyEdits(source, inverse);
			records.splice(index, 1);
			return r;
		}
		undoIds(ids: string[]) {
			const origin = this.records.find((r) => r.id === ids[0])?.origin ?? "person";
			const records = clone(this.records);
			let source = this.source;
			const events: Result[] = [];
			try {
				for (const id of ids) {
					const i = records.findIndex((r) => r.id === id);
					if (i < 0) throw new Error("Operation is not applied.");
					const r = this.remove(records, source, i);
					source = r.source;
					events.push(r);
				}
			} catch (e) {
				return { status: "refused", reason: reason(e), events: [] };
			}
			this.records = records;
			for (const r of events) {
				this.rebaseRedos(r.edits);
				this.publish(r, origin, ids[0], "undo");
			}
			return { status: "ok", events };
		}
		undo(blockId: string | null = this.active?.blockId ?? null) {
			const target = this.records.findLast((r) => blockId === null || (r.origin === "person" && r.blockId === blockId));
			if (!target) return null;
			const members = this.records.filter((r) => r.group === target.group),
				r = this.undoIds(
					members
						.slice()
						.reverse()
						.map((x) => x.id),
				);
			if (r.status === "ok")
				this.redos.push({
					...(target.origin === "agent" ? { operationId: target.id } : {}),
					origin: target.origin,
					blockId: target.blockId,
					steps: r.events
						.slice()
						.reverse()
						.map((x) => x.inverse),
				});
			return { ...r, origin: target.origin, operations: members.map((x) => x.id) };
		}
		undoAgent(id: string) {
			const r = this.records.find((r) => r.id === id);
			if (r?.origin !== "agent") return { status: "refused", reason: "No applied agent operation has that ID." };
			return this.undoIds([id]);
		}
		redo(blockId: string | null = this.active?.blockId ?? null) {
			const i = this.redos.findLastIndex((g) => blockId === null || (g.origin === "person" && g.blockId === blockId));
			if (i < 0) return null;
			const g = this.redos[i];
			if (g.conflict) return { status: "refused", reason: g.conflict };
			let source = this.source;
			const events: Result[] = [];
			try {
				for (const s of g.steps) {
					const r = applyEdits(source, s);
					events.push(r);
					source = r.source;
				}
			} catch (e) {
				return { status: "refused", reason: reason(e) };
			}
			this.redos.splice(i, 1);
			const group = `redo-${this.nextId++}`;
			for (const r of events) {
				this.rebaseRedos(r.edits);
				const id = g.operationId ?? `op-${this.nextId++}`;
				this.records.push({
					id,
					group,
					origin: g.origin,
					blockId: g.blockId,
					at: 0,
					sealed: true,
					edits: r.edits,
					inverse: r.inverse,
				});
				this.publish(r, g.origin, id, "redo");
			}
			return { status: "ok", origin: g.origin };
		}
	}
	function endingCounts(source: string) {
		let crlf = 0,
			cr = 0,
			lf = 0,
			first: string | null = null;
		for (let i = 0; i < source.length; i++) {
			if (source[i] === "\r") {
				if (source[i + 1] === "\n") {
					crlf++;
					first ??= "\r\n";
					i++;
				} else {
					cr++;
					first ??= "\r";
				}
			} else if (source[i] === "\n") {
				lf++;
				first ??= "\n";
			}
		}
		return { crlf, cr, lf, first };
	}
	function dominantEnding(source: string) {
		const { crlf, cr, lf, first } = endingCounts(source);
		const best = Math.max(crlf, cr, lf);
		if (!best) return "\n";
		const tied = [crlf === best ? "\r\n" : null, cr === best ? "\r" : null, lf === best ? "\n" : null].filter(
			(x): x is string => x !== null,
		);
		return tied.length === 1 ? tied[0] : (first ?? "\n");
	}
	class LineMap {
		source: string;
		ending: string;
		wide: number[] = [];
		display: string;
		constructor(source: string, ending = dominantEnding(source)) {
			this.source = source;
			this.ending = ending;
			let d = 0,
				display = "";
			for (let i = 0; i < source.length; i++) {
				if (source[i] === "\r") {
					if (source[i + 1] === "\n") {
						this.wide.push(d);
						i++;
					}
					display += "\n";
					d++;
				} else {
					display += source[i];
					d++;
				}
			}
			this.display = display;
		}
		toSource(p: number) {
			if (!Number.isInteger(p) || p < 0 || p > this.display.length)
				throw new RangeError("Display offset is out of range.");
			let lo = 0,
				hi = this.wide.length;
			while (lo < hi) {
				const mid = (lo + hi) >> 1;
				if (this.wide[mid] < p) lo = mid + 1;
				else hi = mid;
			}
			return p + lo;
		}
		leadingSeam(a: number, b: number, rep: string) {
			const before = a > 0 ? this.source[a - 1] : "",
				after = b < this.source.length ? this.source[b] : "";
			return before === "\r" && (rep.length > 0 ? rep[0] : after) === "\n";
		}
		trailingSeam(b: number, rep: string) {
			return rep.length > 0 && rep[rep.length - 1] === "\r" && this.source[b] === "\n";
		}
		toSourceEdit({ start, end, text }: { start: number; end: number; text: string }): ReaderEdit {
			const source = this.source;
			let a = this.toSource(start),
				b = this.toSource(end),
				rep = text.replace(/\r\n|\r|\n/g, this.ending);
			if (this.leadingSeam(a, b, rep)) {
				a--;
				rep = (this.ending === "\r" ? "\r\n" : this.ending) + rep;
			}
			if (this.trailingSeam(b, rep)) {
				b++;
				rep += "\r\n";
			}
			return { start: a, end: b, text: rep, expected: source.slice(a, b) };
		}
	}
	function diff(a: string, b: string) {
		let p = 0,
			n = Math.min(a.length, b.length);
		while (p < n && a.charCodeAt(p) === b.charCodeAt(p)) p++;
		if (p > 0 && (a.charCodeAt(p) & 0xfc00) === 0xdc00) p--;
		let s = 0;
		while (s < n - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
		if (s > 0 && (a.charCodeAt(a.length - s - 1) & 0xfc00) === 0xd800) s--;
		return { start: p, end: a.length - s, text: b.slice(p, b.length - s) };
	}
	api.exact = { Doc, LineMap, dominantEnding, diff, overlaps, applyEdits, mapEdits, DesyncError };
})();
