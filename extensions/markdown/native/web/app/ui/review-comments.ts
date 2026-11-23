(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	api.reviewMarkRange = (sessions, owner, row) => {
		const sourceAnchor = row.passageAnchor ?? (row.sourceAnchor ? { text: row.sourceAnchor, contexts: [] } : undefined);
		if (!sourceAnchor) return;
		const range = row.start !== undefined && row.end !== undefined ? { start: row.start, end: row.end } : undefined;
		// Closed comments still follow edits. Reopening changes only the visibility of the tracked passage.
		const mark = sessions.trackReview(owner, row.commentId, {
			text: row.text,
			quote: row.quote,
			sourceAnchor,
			anchorDigest: row.anchorDigest,
			range,
		});
		return row.commentState === "open" ? mark.range : undefined;
	};
	type Sheet = { available: boolean; comments: ReaderReviewComment[] };
	class Collection implements ReaderReviewCollection {
		readonly rows = new Map<string, ReaderReviewComment>();
		privateOnly: boolean;
		readState: ReaderReviewReadState = "ready";
		private scope: string | null = null;
		private generation = 0;
		private request = 0;
		private disposed = false;
		private host: ReaderCoreHost;
		private key: () => string | null;
		private changed: () => void;
		private warn: (text: string) => void;
		constructor(host: ReaderCoreHost, key: () => string | null, changed: () => void, warn: (text: string) => void) {
			this.host = host;
			this.key = key;
			this.changed = changed;
			this.warn = warn;
			this.privateOnly = !key();
		}
		private beginRead(key: string | null) {
			const next = key ? "pending" : "ready";
			if (this.scope === key && this.readState === next) return;
			if (this.scope !== key) {
				this.scope = key;
				this.generation++;
				this.rows.clear();
				this.privateOnly = !key;
			}
			this.readState = next;
			this.changed();
		}
		private current(key: string, generation: number) {
			return !this.disposed && this.key() === key && generation === this.generation;
		}
		private load(result: Sheet) {
			this.rows.clear();
			this.privateOnly = !result.available;
			this.readState = "ready";
			if (result.available) for (const row of result.comments) this.rows.set(row.commentId, row);
			this.changed();
		}
		async refresh() {
			if (this.disposed) return;
			const documentKey = this.key(),
				n = ++this.request;
			this.beginRead(documentKey);
			if (!documentKey) return;
			const current = () => !this.disposed && n === this.request && this.key() === documentKey;
			try {
				const result = (await this.host.request("query", { kind: "reviewComments", documentKey })) as
					| Sheet
					| { pending: true };
				// The confirmed presentation triggers reviewChanged; an installation receipt contains no sheet.
				if (current() && !("pending" in result)) this.load(result);
			} catch {
				if (!current()) return;
				this.privateOnly = false;
				this.readState = "failed";
				this.changed();
			}
		}
		async set(row: ReaderReviewComment, commentState: ReaderCommentState) {
			const documentKey = this.scope,
				epoch = this.generation;
			if (
				!documentKey ||
				this.readState !== "ready" ||
				this.rows.get(row.commentId) !== row ||
				!this.current(documentKey, epoch)
			)
				return;
			try {
				const result = (await this.host.request("command", {
					name: "setReviewComment",
					args: { documentKey, commentId: row.commentId, commentState, expectedVersion: row.version },
				})) as { status: string; message?: string };
				if (!this.current(documentKey, epoch)) return;
				if (result.status !== "commentSet") this.warn(result.message || "The reader did not change the saved comment.");
				if (["commentSet", "stale"].includes(result.status)) await this.refresh();
			} catch {
				if (this.current(documentKey, epoch)) this.warn("The reader did not confirm the comment change.");
			}
		}
		dispose() {
			this.disposed = true;
			this.rows.clear();
		}
	}
	api.createReviewCollection = (host, key, changed, warn) => new Collection(host, key, changed, warn);
})();
