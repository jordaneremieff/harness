(() => {
	const root = globalThis as unknown as { reader: ReaderCoreAPI };
	const api = root.reader ?? ({} as ReaderCoreAPI);
	root.reader = api;
	type AgentApply = { operationId: string; threadId?: string; baseGeneration: number; edits: ReaderEdit[] };
	function usableBlocks(source: string, blocks: ReaderMappedBlock[]): ReaderMappedBlock[] {
		if (source !== "" || blocks.length) return blocks;
		return [{ key: "empty-document", start: 0, end: 0, type: "paragraph", html: "<p></p>", map: [[0, 0, 0, 0]] }];
	}
	function precedes(edit: ReaderEdit, position: number, end: boolean) {
		if (edit.end !== position) return edit.end < position;
		return edit.start !== edit.end || !end;
	}
	function mapPoint(position: number, end: boolean, edits: ReaderEdit[]) {
		let delta = 0;
		for (const edit of edits) {
			if (precedes(edit, position, end)) {
				delta += edit.text.length - edit.expected.length;
				continue;
			}
			if (edit.start > position) break;
			if (edit.start === edit.end) break;
			return edit.start + delta + (end ? edit.text.length : 0);
		}
		return position + delta;
	}
	function mappedBlock(block: ReaderMappedBlock, change: ReaderCoreChange, activeKey?: string): ReaderMappedBlock {
		let startDelta = 0,
			endDelta = 0;
		for (const edit of change.edits) {
			const delta = edit.text.length - edit.expected.length;
			const inside = edit.start === block.start && activeKey === block.key && change.origin !== "agent";
			if (edit.end <= block.start && !inside) {
				startDelta += delta;
				endDelta += delta;
			} else if (edit.start <= block.end) endDelta += delta;
		}
		const touched = change.edits.some(
			(edit) => api.exact.overlaps(edit, block) || edit.start === block.start || edit.end === block.end,
		);
		return {
			...block,
			start: block.start + startDelta,
			end: block.end + endDelta,
			map: touched
				? undefined
				: block.map?.map(([r, n, s, m]) => [r, n, s + startDelta, m] as [number, number, number, number]),
		};
	}
	api.createController = (host, options = {}) => {
		const now = options.now ?? Date.now;
		const events = new Map<keyof ReaderControllerEvents, Set<(detail: unknown) => void>>();
		const subscriptions: (() => void)[] = [];
		let disposed = false,
			stateTimer: ReturnType<typeof setTimeout> | undefined,
			claimTimer: ReturnType<typeof setTimeout> | undefined;
		let animationFrame = false,
			fullRender = false,
			renderFailures = 0;
		let frame: ReturnType<typeof setTimeout> | number | undefined,
			rendering = false,
			wanted = false,
			epoch = 0,
			lastState = -Infinity;
		let extra: Record<string, unknown> = {
			canBack: false,
			canForward: false,
			overlay: null,
			hasSelection: false,
			findOpen: false,
			scroll: { blockStart: 0, offsetY: 0 },
		};
		const html = new Map<string, string>();
		const c: ReaderController = {
			host,
			doc: null,
			payload: null,
			blocks: [],
			lock: "reading",
			claims: new Map(),
			agentOperations: new Map(),
			on<K extends keyof ReaderControllerEvents>(type: K, handler: (detail: ReaderControllerEvents[K]) => void) {
				let set = events.get(type);
				if (!set) {
					set = new Set();
					events.set(type, set);
				}
				const wrapped = (detail: unknown) => handler(detail as ReaderControllerEvents[K]);
				set.add(wrapped);
				return () => set.delete(wrapped);
			},
			markRead(id) {
				const operation = c.agentOperations.get(id);
				if (operation) operation.unread = false;
				c.emit("agentOperations", [...c.agentOperations.values()]);
			},
			nextHistory() {
				const doc = c.doc;
				if (!doc) return { undo: null, redo: null };
				const block = doc.active?.blockId ?? null;
				const undo = doc.records.findLast((r) => block === null || (r.origin === "person" && r.blockId === block));
				const redo = doc.redos.findLast((r) => block === null || (r.origin === "person" && r.blockId === block));
				const describe = (origin: "person" | "agent", start: number, id?: string): ReaderHistoryDescription => ({
					origin,
					blockStart: c.blocks.find((b) => b.start <= start && b.end >= start)?.start ?? start,
					...(origin === "agent" && id ? { operationId: id } : {}),
				});
				return {
					undo: undo ? describe(undo.origin, currentHistoryStart(undo), undo.id) : null,
					redo: redo ? describe(redo.origin, redo.steps[0]?.[0]?.start ?? 0, redo.operationId) : null,
				};
			},
			emit(type, detail) {
				for (const fn of events.get(type) ?? []) fn(detail);
			},
			replace(payload) {
				epoch++;
				c.doc?.listeners.delete(changed);
				html.clear();
				c.claims.clear();
				c.agentOperations.clear();
				c.payload = { ...payload, meta: { ...payload.meta }, settings: { ...payload.settings } };
				c.doc = new api.exact.Doc(payload.source, payload.generation);
				c.doc.generation = payload.generation;
				c.lock = payload.meta.capturedSource ? "reading" : payload.settings.lock;
				c.blocks = usableBlocks(payload.source, payload.blocks).map((b) => {
					if (b.html !== undefined) html.set(b.key, b.html);
					return { ...b };
				});
				c.doc.listeners.add(changed);
				extra = {
					canBack: false,
					canForward: false,
					overlay: null,
					hasSelection: false,
					findOpen: false,
					scroll: payload.position ?? { blockStart: 0, offsetY: 0 },
				};
				c.emit("document", c.payload);
				c.emit("blocks", c.blocks);
				c.emit("lock", c.lock);
				c.emit("claims", []);
				c.emit("agentOperations", []);
				clearTimeout(claimTimer);
				c.state();
			},
			setLock(lock) {
				if (c.lock === lock) return;
				if (c.doc?.composing) {
					c.emit("notice", { tone: "warning", text: "Finish the composition before you change the edit lock." });
					return;
				}
				if (lock === "reading") c.activate(null);
				c.lock = lock;
				host.send("lock", { lock, copy: !!c.payload?.meta.capturedSource && lock === "writing" });
				c.emit("lock", lock);
				c.state();
			},
			change(edits, opts = {}) {
				if (c.lock !== "writing" || !c.doc) return { status: "refused", reason: "reading" };
				return c.doc.apply(edits, "person", { ...opts, now: opts.now ?? now() });
			},
			undo() {
				if (c.doc?.composing) return { status: "refused", reason: "composition" };
				const result = c.doc?.undo();
				historyChanged();
				return result;
			},
			redo() {
				if (c.doc?.composing) return { status: "refused", reason: "composition" };
				const result = c.doc?.redo();
				historyChanged();
				return result;
			},
			undoAgent(id) {
				if (c.doc?.composing) return { status: "refused", reason: "composition" };
				const result = c.doc?.undoAgent(id);
				historyChanged();
				return result;
			},
			activate(key) {
				if (!c.doc) return;
				if (key === null) {
					c.doc.seal();
					c.doc.setActive(null, null);
				} else {
					const b = c.blocks.find((b) => b.key === key);
					if (b) c.doc.setActive(key, b);
				}
				c.emit("active", c.doc.active);
				c.state();
			},
			state(patch = {}) {
				extra = { ...extra, ...patch };
				if (disposed) return;
				if (now() - lastState < 100) {
					if (!stateTimer)
						stateTimer = setTimeout(
							() => {
								stateTimer = undefined;
								publishState();
							},
							Math.max(1, 100 - (now() - lastState)),
						);
				} else publishState();
			},
			async pickImage(range) {
				if (!c.doc || c.lock !== "writing" || c.doc.composing) return false;
				const generation = c.doc.generation,
					token = epoch;
				const result = (await host.request("command", { name: "pickImage", args: { generation, range } })) as {
					cancelled?: boolean;
					generation: number;
					edits: ReaderEdit[];
				};
				if (result.cancelled) return false;
				if (!c.doc || token !== epoch || generation !== c.doc.generation || result.generation !== generation) {
					c.emit("notice", { tone: "warning", text: "The document changed. The image was not inserted." });
					return false;
				}
				return c.change(result.edits)?.status === "ok";
			},
			requestRender() {
				wanted = true;
				if (disposed || frame !== undefined || rendering) return;
				const run = () => {
					frame = undefined;
					void render();
				};
				// Check mode runs in windows that receive no animation frames.
				animationFrame =
					typeof requestAnimationFrame === "function" &&
					!globalThis.document?.documentElement?.hasAttribute("data-check-mode");
				frame = animationFrame ? requestAnimationFrame(run) : setTimeout(run, 0);
			},
			dispose() {
				disposed = true;
				epoch++;
				c.doc?.listeners.delete(changed);
				for (const off of subscriptions) off();
				events.clear();
				clearTimeout(stateTimer);
				clearTimeout(claimTimer);
				if (frame !== undefined) {
					if (animationFrame) cancelAnimationFrame(frame as number);
					else clearTimeout(frame as ReturnType<typeof setTimeout>);
				}
			},
		};
		function historyChanged() {
			c.emit("history", c.nextHistory());
			c.state();
		}
		// The bridge refuses a state message with any field outside its contract, so the
		// wire copy carries exactly the contract fields whatever components add locally.
		const wireFlags = ["lock", "overlay", "canUndo", "canRedo", "canBack", "canForward", "hasSelection", "findOpen"];
		const wireObjects: Record<string, string[]> = {
			held: ["start", "end"],
			activeBlock: ["start", "end"],
			scroll: ["blockStart", "offsetY"],
			find: ["query", "count", "index"],
			selection: ["text", "start", "end"],
		};
		function pick(value: Record<string, unknown>, keys: string[]) {
			return Object.fromEntries(keys.map((key) => [key, value[key]]));
		}
		function wireState(state: Record<string, unknown>) {
			const wire = pick(
				state,
				wireFlags.filter((key) => state[key] !== undefined),
			);
			for (const [key, fields] of Object.entries(wireObjects)) {
				const value = state[key];
				if (!value) continue;
				const record = pick(value as Record<string, unknown>, fields);
				// Keep full text in the page. The wire prefix fits even with JSON escaping and
				// remains above the native annotation quote limit when truncated.
				const units = 16_384;
				if (key === "selection" && typeof record.text === "string" && record.text.length > units) {
					const splitsScalar = (record.text.codePointAt(units - 1) ?? 0) > 0xffff;
					record.text = record.text.slice(0, units + Number(splitsScalar));
				}
				wire[key] = record;
			}
			return wire;
		}
		function publishState() {
			clearTimeout(stateTimer);
			stateTimer = undefined;
			if (disposed || !c.doc) return;
			lastState = now();
			const doc = c.doc,
				block = doc.active?.blockId ?? null;
			const held = doc.heldRange(now());
			const canUndo = doc.records.some((r) => block === null || (r.origin === "person" && r.blockId === block));
			const canRedo = doc.redos.some((r) => block === null || (r.origin === "person" && r.blockId === block));
			const state = {
				...extra,
				lock: c.lock,
				canUndo,
				canRedo,
				...(held ? { held } : {}),
				...(doc.active ? { activeBlock: { start: doc.active.start, end: doc.active.end } } : {}),
			};
			host.send("state", wireState(state));
			c.emit("state", state);
			c.emit("hold", held);
			c.emit("history", c.nextHistory());
		}
		function currentHistoryStart(record: ReaderHistoryRecord) {
			const doc = c.doc;
			if (!doc) return 0;
			let edits = record.inverse;
			try {
				for (const later of doc.records.slice(doc.records.indexOf(record) + 1))
					edits = api.exact.mapEdits(edits, later.edits);
			} catch {
				return record.inverse[0]?.start ?? 0;
			}
			return edits[0]?.start ?? 0;
		}
		function mapOperation(operation: ReaderAgentOperation, change: ReaderCoreChange) {
			for (const edit of operation.edits) {
				if (change.edits.some((next) => api.exact.overlaps(next, edit))) operation.conflicted = true;
				const start = mapPoint(edit.start, false, change.edits);
				const end = mapPoint(edit.end, true, change.edits);
				edit.start = Math.min(start, end);
				edit.end = Math.max(start, end);
			}
		}
		function updateOperations(change: ReaderCoreChange) {
			for (const operation of c.agentOperations.values()) mapOperation(operation, change);
			if (change.origin === "agent" && !change.historyAction) {
				let delta = 0;
				const edits = change.edits.map((edit) => {
					const start = edit.start + delta;
					delta += edit.text.length - edit.expected.length;
					return { start, end: start + edit.text.length, oldText: edit.expected, newText: edit.text };
				});
				const operationId = change.operationId ?? change.id;
				c.agentOperations.set(operationId, {
					operationId,
					...(change.threadId !== undefined ? { threadId: change.threadId } : {}),
					unread: true,
					conflicted: false,
					edits,
				});
			}
			c.emit("agentOperations", [...c.agentOperations.values()]);
		}
		function changed(change: ReaderCoreChange) {
			if (!c.payload) return;
			const edits = change.edits,
				presentation = c.payload.presentation;
			c.emit("beforeChange", change);
			c.blocks = c.blocks.map((block) => mappedBlock(block, change, c.doc?.active?.blockId));
			mapClaims(edits);
			updateOperations(change);
			host.send("edits", {
				presentation,
				baseGeneration: change.baseGeneration,
				generation: change.generation,
				origin: change.historyAction ? "history" : change.origin,
				...(change.operationId || change.origin === "agent" ? { operationId: change.operationId ?? change.id } : {}),
				edits,
			});
			c.emit("change", change);
			if (change.origin === "agent" && !change.historyAction) c.emit("agentChange", change);
			c.emit("claims", [...c.claims.values()]);
			c.state();
			c.requestRender();
		}
		function mapClaims(edits: ReaderEdit[]) {
			for (const [id, claim] of c.claims) {
				if (claim.ranges.some((range) => edits.some((edit) => api.exact.overlaps(range, edit)))) c.claims.delete(id);
				else
					claim.ranges = claim.ranges.map((range) => ({
						start: mapPoint(range.start, false, edits),
						end: mapPoint(range.end, true, edits),
					}));
			}
		}
		function mergeHTML(block: ReaderMappedBlock) {
			const body = block.html ?? html.get(block.key);
			if (body === undefined) throw new Error("A render result omitted HTML for an unknown block.");
			html.set(block.key, body);
			return { ...block, html: body };
		}
		function currentEpoch(token: number) {
			return !disposed && token === epoch;
		}
		function acceptRender(
			result: { generation: number; blocks: ReaderMappedBlock[] },
			generation: number,
			token: number,
		) {
			const doc = c.doc;
			if (!doc || !currentEpoch(token)) return;
			if (generation !== doc.generation || result.generation !== generation) {
				wanted = true;
				return;
			}
			const merged = usableBlocks(doc.source, result.blocks).map(mergeHTML);
			c.emit("beforeBlocks", merged);
			c.blocks = merged;
			c.emit("blocks", merged);
		}
		// A newer change makes a render request stale and the next render covers it. Only
		// repeated failures for the current generation reach the person.
		function renderFailed(error: unknown, generation: number, token: number) {
			if (!currentEpoch(token)) return;
			// Native omits HTML for blocks it already sent; a discarded reply can leave the page
			// without one, so the next request asks for every block's HTML.
			if (error instanceof Error && error.message.includes("unknown block")) fullRender = true;
			if (c.doc?.generation !== generation || ++renderFailures < 3) {
				wanted = true;
				return;
			}
			renderFailures = 0;
			c.emit("error", error);
		}
		async function render() {
			if (!c.doc || disposed) return;
			rendering = true;
			wanted = false;
			const generation = c.doc.generation,
				token = epoch;
			try {
				const result = (await host.request("render", fullRender ? { generation, full: true } : { generation })) as {
					generation: number;
					blocks: ReaderMappedBlock[];
				};
				acceptRender(result, generation, token);
				renderFailures = 0;
				fullRender = false;
			} catch (error) {
				renderFailed(error, generation, token);
			} finally {
				rendering = false;
				if (wanted) c.requestRender();
			}
		}
		function claimsChanged() {
			const time = now();
			for (const [id, claim] of c.claims) if (claim.expiresAt <= time) c.claims.delete(id);
			c.emit("claims", [...c.claims.values()]);
			clearTimeout(claimTimer);
			if (c.claims.size)
				claimTimer = setTimeout(
					claimsChanged,
					Math.max(1, Math.min(...[...c.claims.values()].map((x) => x.expiresAt)) - time),
				);
		}
		function heldNotice() {
			c.emit("notice", {
				tone: "agent",
				text: "The agent wants to change this passage.",
				actions: [{ id: "releaseHold", label: "Let it" }],
			});
		}
		function refuseAgent(operationId: string, reason: "held" | "stale", range?: ReaderRange) {
			host.send("agentRefused", { operationId, reason, ...(range ? { range } : {}) });
		}
		function applyAgent(message: AgentApply) {
			const doc = c.doc;
			if (!doc || message.baseGeneration !== doc.generation) {
				refuseAgent(message.operationId, "stale");
				return;
			}
			const held = doc.heldRange(now());
			if (held && message.edits.some((edit) => api.exact.overlaps(edit, held))) {
				refuseAgent(message.operationId, "held", held);
				heldNotice();
				return;
			}
			commitAgent(doc, message);
		}
		function commitAgent(doc: ReaderExactDocument, message: AgentApply) {
			try {
				const result = doc.apply(message.edits, "agent", {
					id: message.operationId,
					...(message.threadId !== undefined ? { threadId: message.threadId } : {}),
					now: now(),
					baseGeneration: message.baseGeneration,
				});
				if (result.status !== "ok")
					refuseAgent(message.operationId, result.reason === "held" ? "held" : "stale", result.range);
			} catch {
				refuseAgent(message.operationId, "stale");
			}
		}
		function toggleLock(message: ReaderPageCommand) {
			const lock = message.args?.lock;
			if (lock === "reading" || lock === "writing") c.setLock(lock);
			else c.setLock(c.lock === "reading" ? "writing" : "reading");
		}
		function command(message: ReaderPageCommand) {
			switch (message.name) {
				case "undo":
					c.undo();
					break;
				case "redo":
					c.redo();
					break;
				case "toggleLock":
					toggleLock(message);
					break;
				case "applySettings":
					if (c.payload) c.payload.settings = { ...c.payload.settings, ...message.args };
					c.emit("settings", message.args ?? {});
					break;
				default:
					c.emit("command", message);
			}
		}
		const receive = <T>(type: string, handler: (message: T) => void) =>
			host.on(type, (message) => handler(message as T));
		subscriptions.push(
			receive<ReaderCoreDocument>("document", (m) => c.replace(m)),
			receive<{
				presentation: string;
				generation: number;
				meta?: { capturedSource: boolean; documentKey?: string; [key: string]: unknown };
				[key: string]: unknown;
			}>("ack", (m) => {
				if (!c.payload || m.presentation !== c.payload.presentation) return;
				if (!c.doc || m.generation > c.doc.generation) {
					c.emit("error", new Error("Unexpected acknowledgement generation."));
					return;
				}
				if (m.meta) c.payload.meta = { ...m.meta, documentKey: m.meta.documentKey ?? c.payload.meta.documentKey };
				c.emit("ack", m);
			}),
			receive<{ presentation: string }>("refused", (m) => {
				if (m.presentation === c.payload?.presentation) c.emit("refused", m);
			}),
			receive<ReaderSaveState>("saveState", (m) => {
				if (!c.payload || c.payload.presentation !== m.presentation) return;
				if (m.revision !== undefined && c.payload.meta.kind === "published") c.payload.meta.revision = m.revision;
				c.emit("saveState", m);
			}),
			receive<ReaderNotice>("notice", (m) => c.emit("notice", m)),
			receive<AgentApply>("agentApply", applyAgent),
			receive<ReaderClaim>("claim", (m) => {
				const held = c.doc?.heldRange(now());
				if (held && m.ranges.some((r: ReaderRange) => api.exact.overlaps(r, held))) {
					heldNotice();
					return;
				}
				c.claims.set(m.claimId, { ...m });
				claimsChanged();
			}),
			receive<{ claimId: string }>("release", (m) => {
				c.claims.delete(m.claimId);
				claimsChanged();
			}),
			receive<ReaderPageCommand>("command", command),
		);
		if (options.document) c.replace(options.document);
		return c;
	};
})();
