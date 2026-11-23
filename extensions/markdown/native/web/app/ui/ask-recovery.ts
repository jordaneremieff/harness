(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const version = (value: unknown): value is number =>
		typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
	function reviewResult(raw: unknown) {
		const result = raw as { available: boolean; version: number; draft?: ReaderReviewDraft } | null;
		if (!result || !version(result.version)) throw new Error();
		if (result.available === false && result.version === 0 && result.draft === undefined) return null;
		if (result.available !== true) throw new Error();
		const { draft } = result;
		if (
			draft !== undefined &&
			(!draft ||
				!Array.isArray(draft.comments) ||
				typeof draft.overall !== "string" ||
				(draft.parked !== undefined && !Array.isArray(draft.parked)))
		)
			throw new Error();
		return result;
	}
	api.createAskRecovery = <O extends { documentKey: string }>(
		host: Pick<ReaderCoreHost, "request">,
		callbacks: ReaderAskRecoveryCallbacks<O>,
	): ReaderAskRecovery<O> => {
		let shown: O | undefined,
			view = 0;
		const sessions = new WeakMap<O, ReturnType<typeof session>>();
		const operations = new Set<Promise<unknown>>(),
			unsaved = new Set<string>();
		function track<T>(job: Promise<T>) {
			operations.add(job);
			const done = () => operations.delete(job);
			void job.then(done, done);
			return job;
		}
		function session(owner: O) {
			const { documentKey } = owner;
			let base: number | undefined,
				localOnly = false,
				edits = 0,
				preparing = false;
			let running: Promise<void> | undefined, warning: (() => void) | undefined;
			function clear() {
				if (!warning) return;
				warning = undefined;
				callbacks.clear?.(owner);
			}
			function warn(conflict: boolean) {
				const run = () => {
					if (warning !== run || owner !== shown || running || preparing) return;
					void check(conflict);
				};
				warning = run;
				callbacks.warn(
					owner,
					conflict
						? "The saved batch changed. Copy any local text you want to keep before replacing the local batch."
						: "The reader did not confirm the saved batch. The local batch stays in this pane.",
					{ label: conflict ? "Replace local batch with saved batch" : "Check saved batch", run },
				);
			}
			function conflicting(result: NonNullable<ReturnType<typeof reviewResult>>) {
				return base === undefined ? unsaved.has(documentKey) && result.draft !== undefined : result.version !== base;
			}
			function reconcile(result: NonNullable<ReturnType<typeof reviewResult>>, adopt: boolean, compatible: boolean) {
				const { draft } = result;
				const conflict = adopt ? !compatible : conflicting(result);
				if (conflict) {
					warn(true);
					return;
				}
				if (adopt || (base === undefined && draft !== undefined)) {
					callbacks.apply(owner, draft);
					edits++;
					unsaved.delete(documentKey);
				}
				base = result.version;
				clear();
			}
			function check(adopt: boolean) {
				const before = edits,
					at = view;
				return start(() => read(adopt, () => before === edits && at === view));
			}
			async function read(adopt: boolean, compatible: () => boolean) {
				try {
					const result = reviewResult(await host.request("query", { kind: "reviewDraft", documentKey }));
					if (!result) {
						if (adopt || base !== undefined) throw new Error();
						localOnly = true;
						unsaved.delete(documentKey);
						clear();
						return;
					}
					reconcile(result, adopt, compatible());
				} catch {
					warn(adopt);
				}
			}
			async function store(draft: ReaderReviewDraft | undefined) {
				try {
					const result = (await host.request("command", {
						name: "setReviewDraft",
						args: { documentKey, expectedVersion: base, ...(draft ? { draft } : {}) },
					})) as { status: string; version?: number } | null;
					if (result?.status === "stored" && version(result.version) && base !== undefined && result.version > base) {
						base = result.version;
						return true;
					}
					warn(result?.status === "stale");
				} catch {
					warn(false);
				}
				return false;
			}
			async function consume(remaining: ReaderReviewDraft | undefined) {
				if (localOnly) return true;
				if (base === undefined) return false;
				// Until commit runs, the local batch still needs a save if a consume is refused or cancelled.
				unsaved.add(documentKey);
				return store(remaining);
			}
			function start(job: () => Promise<void>) {
				running = Promise.resolve()
					.then(job)
					.finally(() => {
						running = undefined;
						pump();
					});
				return track(running);
			}
			function pump() {
				if (running || preparing || warning || localOnly || !unsaved.has(documentKey) || base === undefined) return;
				start(async () => {
					if (preparing) return;
					try {
						const draft = callbacks.snapshot(owner);
						unsaved.delete(documentKey);
						if (!(await store(draft))) unsaved.add(documentKey);
					} catch {
						unsaved.add(documentKey);
						warn(false);
					}
				});
			}
			function open() {
				if (!running && !warning && !localOnly && base === undefined) return check(false);
				return running ?? Promise.resolve();
			}
			const available = (current: () => boolean) => !preparing && !warning && shown === owner && current();
			return {
				open,
				changed() {
					edits++;
					if (!localOnly) unsaved.add(documentKey);
					void open();
					pump();
				},
				async prepare(remaining: ReaderReviewDraft | undefined, current: () => boolean, commit: () => void) {
					if (!available(current)) return false;
					const before = edits,
						at = view;
					const valid = () => before === edits && at === view && current();
					preparing = true;
					try {
						await open();
						if (warning || !valid()) return false;
						if (!(await consume(remaining)) || !valid()) return false;
						unsaved.delete(documentKey);
						commit();
						return true;
					} finally {
						preparing = false;
						pump();
					}
				},
			};
		}
		function get(owner: O) {
			const existing = sessions.get(owner);
			if (existing) return existing;
			const next = session(owner);
			sessions.set(owner, next);
			return next;
		}
		return {
			async flush() {
				while (operations.size) await Promise.allSettled(operations);
				return unsaved.size === 0;
			},
			open(owner) {
				if (owner !== shown) {
					shown = owner;
					view++;
				}
				return get(owner).open();
			},
			changed(owner) {
				get(owner).changed();
			},
			prepare(owner, remaining, current, commit) {
				return track(get(owner).prepare(remaining, current, commit));
			},
		};
	};
})();
