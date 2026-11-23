(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	function empty(documentKey: string): ReaderAskDocument {
		return { documentKey, threads: [], comments: [], overall: "", current: null, visible: false, heldThread: null };
	}
	function* passages(state: ReaderAskDocument) {
		yield* state.comments;
		for (const thread of state.threads) {
			if (thread.comments) yield* thread.comments;
			else yield thread;
		}
	}
	function mapPassage(item: ReaderThread | ReaderComment, edits: ReaderEdit[], source: string) {
		const anchor = item.sourceAnchor;
		if (!anchor) return;
		if (item.range) {
			try {
				const [range] = api.exact.mapEdits([{ ...item.range, expected: anchor.text, text: anchor.text }], edits);
				item.range = { start: range.start, end: range.end };
				return;
			} catch {
				// An overlapping edit can move the passage within the replacement.
			}
		}
		item.range = api.uiLogic.reanchorPassage(source, anchor);
	}
	function annotation(item: { text: string; quote?: string; range?: ReaderRange; authoredRevision?: number }) {
		return {
			text: item.text,
			...(item.authoredRevision === undefined ? {} : { authoredRevision: item.authoredRevision }),
			...(item.quote ? { quote: item.quote } : {}),
			...(item.range ? { quoteRange: { ...item.range } } : {}),
		};
	}
	api.createAskSessions = () => {
		const documents = new Map<string, ReaderAskDocument>();
		const requests = new Map<string, ReaderAskDelivery>();
		const packets = new WeakMap<ReaderAskMessage, Record<string, unknown>>();
		let shown = empty(""),
			source = "",
			edited = false;
		function savePassages() {
			if (!edited) return;
			for (const item of passages(shown)) {
				if (item.range) item.sourceAnchor = api.uiLogic.capturePassage(source, item.range);
			}
			edited = false;
		}
		return {
			get shown() {
				return shown;
			},
			show(key, text, digest) {
				savePassages();
				const next = documents.get(key) ?? empty(key);
				const unchanged = (next === shown && text === source) || (digest !== undefined && next.digest === digest);
				if (!unchanged) {
					for (const item of passages(next)) {
						item.range = api.uiLogic.reanchorPassage(text, item.sourceAnchor);
						if (item.range) item.sourceAnchor = api.uiLogic.capturePassage(text, item.range);
					}
				}
				documents.set(key, next);
				next.digest = digest;
				shown = next;
				source = text;
				return next;
			},
			change(edits, text) {
				for (const item of passages(shown)) mapPassage(item, edits, text);
				source = text;
				edited = true;
				shown.digest = undefined;
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
				const firstBatch = thread.comments && thread.messages[0] === message;
				const packet = {
					...version,
					requestId: message.requestId,
					threadId: thread.threadId,
					...(firstBatch
						? {
								annotations: thread.comments?.map(annotation),
								...(thread.overall
									? {
											overall: thread.overall,
											...(message.authoredRevision === undefined ? {} : { authoredRevision: message.authoredRevision }),
										}
									: {}),
							}
						: annotation({
								text: message.text,
								quote: thread.quote,
								range: thread.range,
								authoredRevision: message.authoredRevision,
							})),
				};
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
