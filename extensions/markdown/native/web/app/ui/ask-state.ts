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
	function precedes(position: number, right: boolean, edit: ReaderEdit) {
		return edit.end < position || (edit.end === position && (!right || edit.start !== edit.end));
	}
	function boundary(position: number, right: boolean, edits: ReaderEdit[]) {
		let delta = 0;
		for (const edit of edits) {
			if (precedes(position, right, edit)) delta += edit.text.length - (edit.end - edit.start);
			else if (edit.start < position) return edit.start + delta + (right ? edit.text.length : 0);
			else break;
		}
		return position + delta;
	}
	function proof(item: Passage) {
		const anchor = item.sourceAnchor;
		if (!item.quote || !anchor?.text || utf8.encode(anchor.text).length > 16384) return undefined;
		if (item.range && anchor.text.length !== item.range.end - item.range.start) return undefined;
		return anchor;
	}
	function savedComment(owner: ReaderAskDocument, item: ReaderComment): ReaderComment {
		const copy: ReaderComment = { text: item.text };
		if (item.quote) copy.quote = item.quote;
		if (item.authoredRevision !== undefined) copy.authoredRevision = item.authoredRevision;
		const anchor = proof(item);
		if (!anchor) return copy;
		copy.sourceAnchor = structuredClone(anchor);
		if (item.range && owner.digest && /^sha256:[0-9a-f]{64}$/u.test(owner.digest)) {
			copy.range = { ...item.range };
			copy.anchorDigest = owner.digest;
		}
		return copy;
	}
	function snapshot(owner: ReaderAskDocument, parkedOnly = false): ReaderReviewDraft | undefined {
		const draft: ReaderReviewDraft = { comments: [], overall: "" };
		if (!parkedOnly) {
			draft.comments = owner.comments.map((item) => savedComment(owner, item));
			draft.overall = owner.overall;
			if (owner.overallRevision !== undefined) draft.overallRevision = owner.overallRevision;
		}
		if (owner.parked?.length)
			draft.parked = owner.parked.map((item) =>
				item.comment
					? { index: item.index, text: item.comment.text, comment: savedComment(owner, item.comment) }
					: { ...item },
			);
		return draft.comments.length || draft.overall || draft.parked ? draft : undefined;
	}
	function sameProof(left?: ReaderPassageAnchor, right?: ReaderPassageAnchor) {
		return left === right || JSON.stringify(left) === JSON.stringify(right);
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
			const anchor = proof(item);
			if (!item.range || !anchor) continue;
			const size = utf8.encode(JSON.stringify({ passageAnchor: anchor })).length;
			if (size > budget) continue;
			annotations[index].passageAnchor = structuredClone(anchor);
			budget -= size;
		}
	}
	function moveBatch(previous: ReaderAskDocument, next: ReaderAskDocument) {
		const offset = next.comments.length;
		next.comments.push(...previous.comments.splice(0));
		for (const item of previous.parked ?? []) {
			if (item.comment) item.index += offset;
			next.parked ??= [];
			next.parked.push(item);
		}
		previous.parked = undefined;
		if (previous.overall) {
			if (next.overall) {
				next.parked ??= [];
				next.parked.push({ text: previous.overall, index: -1, authoredRevision: previous.overallRevision });
			} else {
				next.overall = previous.overall;
				next.overallRevision = previous.overallRevision;
			}
		}
		previous.overall = "";
		previous.overallRevision = undefined;
	}
	function detachDraft(thread: ReaderThread): ReaderThread | null {
		if (!thread.draft) return null;
		const draft: ReaderThread = {
			threadId: "",
			messages: [],
			draft: thread.draft,
			draftRevision: thread.draftRevision,
			quote: thread.quote,
			sourceAnchor: thread.sourceAnchor,
			range: thread.range,
		};
		thread.draft = "";
		thread.draftRevision = undefined;
		return draft;
	}
	function moveCards(previous: ReaderAskDocument, next: ReaderAskDocument) {
		let current: ReaderThread | null = null;
		const retained: ReaderThread[] = [];
		for (const thread of previous.threads) {
			const sent = thread.messages.length > 0 || thread === previous.heldThread;
			if (sent) retained.push(thread);
			const moved = sent ? detachDraft(thread) : thread;
			if (!moved) continue;
			next.threads.push(moved);
			if (previous.current === thread) current = moved;
		}
		previous.threads = retained;
		return current;
	}
	// Save As keeps the exact buffer. Only text that nobody has tried to send changes owner.
	function moveUnsent(previous: ReaderAskDocument, next: ReaderAskDocument) {
		if (previous === next) return;
		moveBatch(previous, next);
		const current = moveCards(previous, next) ?? (previous.current?.pendingComment ? previous.current : null);
		if (!current) return;
		if (previous.visible && !(next.visible && next.current)) {
			next.current = current;
			next.visible = true;
		}
		if (current === previous.current) {
			previous.current = null;
			previous.visible = false;
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
		function verifiedRange(item: Passage) {
			if (item.range && source.slice(item.range.start, item.range.end) === item.sourceAnchor?.text) return item.range;
			return undefined;
		}
		function locate(item: Passage, fresh: ReaderPassageView) {
			const damage = damaged.get(item),
				old = verifiedRange(item),
				before = item.range,
				proof = item.sourceAnchor;
			if (old && !edited && item.sourceAnchor?.headings) return false;
			const range =
				old ?? api.uiLogic.reanchorPassage(source, damage?.anchor ?? item.sourceAnchor, fresh, damage?.within);
			damaged.delete(item);
			item.range = range;
			if (range) item.sourceAnchor = api.uiLogic.capturePassage(source, range, fresh, item.quote);
			return before?.start !== range?.start || before?.end !== range?.end || !sameProof(proof, item.sourceAnchor);
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
			moveUnsent,
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
				const tracked = new Set<Passage>(pending(shown));
				let pendingChanged = false;
				for (const item of locations(shown)) if (locate(item, fresh) && tracked.has(item)) pendingChanged = true;
				edited = false;
				return pendingChanged;
			},
			snapshot,
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
