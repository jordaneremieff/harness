(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	type Passage = ReaderThread | ReaderComment;
	const utf8 = new TextEncoder();
	function empty(documentKey: string): ReaderAskDocument {
		return { documentKey, threads: [], comments: [], overall: "", current: null, visible: false, heldThread: null };
	}
	function* pending(owner: ReaderAskDocument) {
		yield* owner.comments;
		for (const parked of owner.parked ?? []) if (parked.comment) yield parked.comment;
	}
	function* passages(owner: ReaderAskDocument) {
		yield* pending(owner);
		for (const thread of owner.threads) {
			if (thread.comments) yield* thread.comments;
			else yield thread;
		}
	}
	// Project a damaged interval onto the new source, including only the replacements that hit it.
	function boundary(position: number, right: boolean, edits: ReaderEdit[]) {
		let delta = 0;
		for (const edit of edits) {
			if (edit.end < position || (edit.end === position && (!right || edit.start !== edit.end)))
				delta += edit.text.length - (edit.end - edit.start);
			else if (edit.start < position) return edit.start + delta + (right ? edit.text.length : 0);
			else break;
		}
		return position + delta;
	}
	function annotation(item: { text: string; quote?: string; range?: ReaderRange; authoredRevision?: number }) {
		return {
			text: item.text,
			...(item.authoredRevision === undefined ? {} : { authoredRevision: item.authoredRevision }),
			...(item.quote ? { quote: item.quote } : {}),
			...(item.range ? { quoteRange: { ...item.range } } : {}),
		};
	}
	function packetFor(thread: ReaderThread, message: ReaderAskMessage, version: ReaderPromptVersion) {
		const ids = { ...version, requestId: message.requestId, threadId: thread.threadId };
		const single = {
			text: message.text,
			authoredRevision: message.authoredRevision,
			quote: thread.quote,
			range: thread.range,
		};
		if (!thread.comments || thread.messages[0] !== message) {
			const packet = { ...ids, ...annotation(single) };
			if (thread.messages[0] === message) attachProofs(packet, [packet], [thread]);
			return packet;
		}
		const annotations = thread.comments.map(annotation);
		const overall = thread.overall
			? {
					overall: thread.overall,
					...(message.authoredRevision === undefined ? {} : { authoredRevision: message.authoredRevision }),
				}
			: {};
		const packet = { ...ids, annotations, ...overall };
		attachProofs(packet, annotations, thread.comments);
		return packet;
	}
	// Private evidence is optional. It must never crowd the operator's own words out of a prompt.
	function attachProofs(packet: object, annotations: Record<string, unknown>[], items: Passage[]) {
		let budget = 256 * 1024 - 128 - utf8.encode(JSON.stringify(packet)).length;
		for (const [index, item] of items.entries()) {
			const anchor = item.sourceAnchor;
			if (!item.range || !anchor || utf8.encode(anchor.text).length > 16384) continue;
			const size = utf8.encode(JSON.stringify({ passageAnchor: anchor })).length;
			if (size > budget) continue;
			annotations[index].passageAnchor = anchor;
			budget -= size;
		}
	}
	api.createAskSessions = () => {
		const documents = new Map<string, ReaderAskDocument>();
		const requests = new Map<string, ReaderAskDelivery>();
		const packets = new WeakMap<ReaderAskMessage, Record<string, unknown>>();
		const damaged = new WeakMap<Passage, { anchor: ReaderPassageAnchor; within: ReaderRange }>();
		const reviewMarks = new WeakMap<ReaderAskDocument, Map<string, ReaderComment>>();
		function* locations(owner: ReaderAskDocument) {
			yield* passages(owner);
			const marks = reviewMarks.get(owner);
			if (marks) yield* marks.values();
		}
		let shown = empty(""),
			source = "",
			view: ReaderPassageView | undefined,
			edited = false;
		function mapPassage(item: Passage, edits: ReaderEdit[]) {
			const damage = damaged.get(item);
			const range = damage?.within ?? item.range,
				anchor = damage?.anchor ?? item.sourceAnchor;
			if (!range || !anchor) return;
			if (!damage && !edits.some((edit) => api.exact.overlaps(range, edit))) {
				const [mapped] = api.exact.mapEdits([{ ...range, expected: anchor.text, text: anchor.text }], edits);
				item.range = { start: mapped.start, end: mapped.end };
				return;
			}
			// Withhold the anchor from prompts and recovery until fresh native blocks prove the passage
			// inside this interval. A deleted quote must never attach to its surviving twin on refresh.
			item.range = undefined;
			item.sourceAnchor = undefined;
			damaged.set(item, {
				anchor,
				within: { start: boundary(range.start, false, edits), end: boundary(range.end, true, edits) },
			});
		}
		function locate(item: Passage, fresh: ReaderPassageView) {
			const damage = damaged.get(item);
			if (item.range && item.sourceAnchor) {
				if (source.slice(item.range.start, item.range.end) !== item.sourceAnchor.text) item.range = undefined;
				else if (!damage && item.sourceAnchor.headings) return;
			}
			if (damage) {
				item.range = api.uiLogic.reanchorPassage(source, damage.anchor, fresh, damage.within);
				damaged.delete(item);
			} else if (!item.range) item.range = api.uiLogic.reanchorPassage(source, item.sourceAnchor, fresh);
			if (item.range) item.sourceAnchor = api.uiLogic.capturePassage(source, item.range, fresh, item.quote);
		}
		function restoreRange(owner: ReaderAskDocument, item: ReaderComment) {
			const verified =
				owner.digest &&
				owner.digest === item.anchorDigest &&
				!!item.sourceAnchor &&
				!!item.range &&
				(owner !== shown || source.slice(item.range.start, item.range.end) === item.sourceAnchor.text);
			if (!verified) item.range = undefined;
			if (owner === shown && view) locate(item, view);
		}
		return {
			get shown() {
				return shown;
			},
			show(key, text, digest) {
				const next = documents.get(key) ?? empty(key);
				const unchanged = (next === shown && text === source) || (digest !== undefined && next.digest === digest);
				if (!unchanged)
					for (const item of locations(next)) {
						item.range = undefined;
						damaged.delete(item);
					}
				documents.set(key, next);
				next.digest = digest;
				shown = next;
				source = text;
				view = undefined;
				edited = false;
				return next;
			},
			change(edits, text) {
				for (const item of locations(shown)) mapPassage(item, edits);
				source = text;
				view = undefined;
				edited = true;
				shown.digest = undefined;
			},
			render(fresh) {
				view = fresh;
				for (const item of locations(shown)) locate(item, fresh);
			},
			captureAnchors() {
				if (!edited || !view) return;
				for (const item of locations(shown))
					if (item.range) item.sourceAnchor = api.uiLogic.capturePassage(source, item.range, view, item.quote);
				edited = false;
			},
			restoreRanges(owner) {
				for (const item of pending(owner)) restoreRange(owner, item);
			},
			trackReview(owner, id, seed) {
				const marks = reviewMarks.get(owner) ?? new Map<string, ReaderComment>();
				const existing = marks.get(id);
				if (existing) return existing;
				const mark = structuredClone(seed);
				restoreRange(owner, mark);
				marks.set(id, mark);
				reviewMarks.set(owner, marks);
				return mark;
			},
			register(owner, thread, message) {
				requests.set(message.requestId, { owner, thread, message });
			},
			delivery(requestId, threadId) {
				const delivery = requests.get(requestId);
				return delivery?.thread.threadId === threadId ? delivery : undefined;
			},
			packet(thread, message, version) {
				const original = packets.get(message);
				if (original) return original;
				const packet = packetFor(thread, message, version);
				packets.set(message, packet);
				return packet;
			},
			releasePacket(message) {
				packets.delete(message);
			},
			forget(message) {
				requests.delete(message.requestId);
				packets.delete(message);
			},
		};
	};
})();
