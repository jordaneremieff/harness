(() => {
	const app = window.explorer;
	const { el, button } = app.dom;
	const { editing, request } = app;

	function surface(value: string, path: string, unit: string, changed: (text: string) => boolean) {
		const frame = el("div", "edit-surface");
		const mirror = el("div", "edit-mirror");
		mirror.setAttribute("aria-hidden", "true");
		const input = el("textarea", "edit-input");
		input.setAttribute("aria-label", `Edit ${path}`);
		input.spellcheck = false;
		input.autocomplete = "off";
		input.setAttribute("autocorrect", "off");
		input.value = value;
		frame.append(mirror, input);
		const language = app.model.language(path).id;
		let lines: string[] = [],
			rows: HTMLElement[] = [],
			painted = new WeakMap<HTMLElement, number>(),
			version = 0,
			renderFrame = 0,
			syntaxTimer = 0,
			wrap = false,
			rowHeight = 24,
			visibleKey = "",
			paintedText: string | undefined,
			at = (line: number) => app.syntax(lines[line] ?? "", language),
			accepted = value;

		function paint(text: HTMLElement, line: string, spans: ExplorerSpan[]) {
			const tokens = document.createDocumentFragment();
			let index = 0;
			for (const { start, end, role } of spans) {
				if (start > index) tokens.append(line.slice(index, start));
				tokens.append(el("span", `syn-${role}`, line.slice(start, end)));
				index = end;
			}
			if (index < line.length || !line) tokens.append(line.slice(index) || "\u200b");
			text.replaceChildren(tokens);
		}
		function firstVisible(start: number) {
			let lo = 0,
				hi = rows.length;
			while (lo < hi) {
				const middle = (lo + hi) >>> 1;
				const row = rows[middle];
				if (row.offsetTop + row.offsetHeight < start) lo = middle + 1;
				else hi = middle;
			}
			return lo;
		}
		function makeRow(index: number, line: string) {
			const row = el("div", "edit-row");
			const cell = el("div", "edit-cell");
			const text = el("span", "edit-text", line || "\u200b");
			cell.append(text);
			row.append(el("span", "edit-number", String(index + 1)), cell);
			return { row, text };
		}
		function paintWrapped(start: number, end: number) {
			mirror.style.setProperty("--edit-virtual-top", "0px");
			for (let i = firstVisible(start); i < rows.length && rows[i].offsetTop <= end; i++) {
				const row = rows[i];
				if (painted.get(row) === version) continue;
				const text = row.lastElementChild?.firstElementChild as HTMLElement;
				paint(text, lines[i], at(i));
				painted.set(row, version);
			}
		}
		function paintWindow(start: number, end: number) {
			const first = Math.min(lines.length - 1, Math.floor(start / rowHeight));
			const last = Math.min(lines.length, Math.ceil(end / rowHeight) + 1);
			const key = `${version}/${first}/${last}`;
			if (key === visibleKey) return;
			visibleKey = key;
			mirror.style.setProperty("--edit-virtual-top", `${first * rowHeight}px`);
			const fragment = document.createDocumentFragment();
			for (let i = first; i < last; i++) {
				const { row, text } = makeRow(i, lines[i]);
				paint(text, lines[i], at(i));
				fragment.append(row);
			}
			mirror.replaceChildren(fragment);
		}
		function visible() {
			renderFrame = 0;
			if (!frame.isConnected) return;
			mirror.style.setProperty("--edit-offset-x", `${-input.scrollLeft}px`);
			mirror.style.setProperty("--edit-offset-y", `${-input.scrollTop}px`);
			mirror.style.setProperty("--edit-text-width", `${input.clientWidth}px`);
			sync();
			const start = Math.max(0, input.scrollTop - 200),
				end = input.scrollTop + input.clientHeight + 200;
			if (wrap) paintWrapped(start, end);
			else paintWindow(start, end);
		}
		function schedule() {
			if (!renderFrame) renderFrame = requestAnimationFrame(visible);
		}
		function changedLines(next: string[]) {
			let start = 0,
				tail = 0;
			while (start < lines.length && start < next.length && lines[start] === next[start]) start++;
			while (
				tail < lines.length - start &&
				tail < next.length - start &&
				lines[lines.length - 1 - tail] === next[next.length - 1 - tail]
			)
				tail++;
			return { start, tail };
		}
		function replaceRows(next: string[]) {
			const { start, tail } = changedLines(next);
			const end = next.length - tail;
			const fragment = document.createDocumentFragment();
			const inserted: HTMLElement[] = [];
			for (let i = start; i < end; i++) {
				const { row } = makeRow(i, next[i]);
				inserted.push(row);
				fragment.append(row);
			}
			for (let i = start; i < rows.length - tail; i++) rows[i].remove();
			mirror.insertBefore(fragment, rows[rows.length - tail] ?? null);
			rows = rows.slice(0, start).concat(inserted, rows.slice(rows.length - tail));
			if (next.length !== lines.length) renumber(end);
		}
		function renumber(from: number) {
			for (let i = from; i < rows.length; i++) {
				const number = rows[i].firstElementChild;
				if (number) number.textContent = String(i + 1);
			}
		}
		function sync() {
			if (paintedText === accepted) return;
			const full = paintedText === undefined;
			paintedText = accepted;
			const next = accepted.split("\n");
			if (wrap) replaceRows(next);
			lines = next;
			version++;
			at = full ? app.syntaxFile(lines, language) : (line) => app.syntax(lines[line], language);
			clearTimeout(syntaxTimer);
			if (!full)
				syntaxTimer = window.setTimeout(() => {
					at = app.syntaxFile(lines, language);
					version++;
					schedule();
				}, 140);
		}
		function applyInput() {
			if (input.value === accepted) return;
			if (!changed(input.value)) {
				const cursor = Math.min(input.selectionStart, accepted.length);
				input.value = accepted;
				input.setSelectionRange(cursor, cursor);
				return;
			}
			accepted = input.value;
			schedule();
		}
		input.addEventListener("input", applyInput);
		input.addEventListener("scroll", schedule);
		function insert(text: string) {
			// The platform text command puts the edit in WebKit's native undo history.
			document.execCommand("insertText", false, text);
			applyInput();
		}
		function indentSelected(outdent: boolean) {
			const direction = input.selectionDirection;
			const patch = editing.indentLines(input.value, input.selectionStart, input.selectionEnd, unit, outdent);
			if (input.value.slice(patch.from, patch.to) === patch.value) return;
			input.setSelectionRange(patch.from, patch.to);
			insert(patch.value);
			input.setSelectionRange(patch.start, patch.end, direction);
		}
		input.addEventListener("keydown", (event) => {
			if (event.isComposing || input.readOnly || event.metaKey || event.altKey || event.ctrlKey) return;
			if (event.key === "Tab") {
				event.preventDefault();
				indentSelected(event.shiftKey);
			} else if (event.key === "Enter") {
				const indent = editing.nextIndent(input.value, input.selectionStart);
				if (!indent) return;
				event.preventDefault();
				insert(`\n${indent}`);
			}
		});
		const observer = new ResizeObserver(schedule);
		observer.observe(input);
		return {
			frame,
			input,
			layout({ wrap: nextWrap, textSize }: ExplorerSettings) {
				if (wrap !== nextWrap) {
					wrap = nextWrap;
					paintedText = undefined;
					rows = [];
					lines = [];
					mirror.replaceChildren();
				}
				frame.classList.toggle("wrap", wrap);
				input.wrap = wrap ? "soft" : "off";
				rowHeight = textSize * 1.5;
				visibleKey = "";
				frame.style.setProperty("--edit-size", `${textSize}px`);
				schedule();
			},
			jump(line: number) {
				const source = accepted.split("\n");
				const row = Math.min(Math.max(0, line - 1), source.length - 1);
				const start = source.slice(0, row).reduce((count, text) => count + text.length + 1, 0);
				input.setSelectionRange(start, start);
				requestAnimationFrame(() => {
					input.scrollTop = wrap ? (rows[row]?.offsetTop ?? 0) : row * rowHeight;
				});
			},
			close() {
				observer.disconnect();
				clearTimeout(syntaxTimer);
				cancelAnimationFrame(renderFrame);
				frame.remove();
			},
		};
	}

	function editor(body: HTMLElement, toolbar: HTMLElement, context: ExplorerEditorContext): ExplorerEditor {
		type DocumentEdit = ExplorerEditDraft & {
			identity: ExplorerEditPath;
			baseline?: string;
			disk?: ExplorerFile | null;
			confirm: boolean;
			checking: boolean;
			check: number;
			error: string;
			draftError: string;
			view: ReturnType<typeof surface>;
		};
		let current: DocumentEdit | undefined;
		let timer = 0;
		let writes: Promise<void> = Promise.resolve();
		let saving: Promise<void> | undefined;
		const dirty = (edit: DocumentEdit) => edit.text !== edit.baseline;
		const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
		const copy = (edit: DocumentEdit) => {
			void request("clipboard.write", { text: editing.restore(edit.text, edit.ending) }).then(
				() => context.notice("Edited text copied"),
				(error) => context.notice(describe(error)),
			);
		};
		function queue(edit: DocumentEdit, draft: ExplorerEditDraft | null) {
			writes = writes.then(async () => {
				try {
					await request("edit.draft", { ...edit.identity, draft });
					if (edit.draftError) {
						edit.draftError = "";
						draw();
					}
				} catch (error) {
					edit.draftError = `Draft not saved privately: ${describe(error)}`;
					if (current === edit) draw();
					else context.notice(edit.draftError);
				}
			});
			return writes;
		}
		function flushPending() {
			if (!current || !timer) return;
			clearTimeout(timer);
			timer = 0;
			const { text, base, ending } = current;
			void queue(current, dirty(current) ? { text, base, ending } : null);
		}
		async function flush() {
			flushPending();
			await saving;
			await writes;
		}
		function detach() {
			flushPending();
			current?.view.close();
			current = undefined;
			draw();
		}
		function close(edit: DocumentEdit, clear: boolean) {
			if (current !== edit) return;
			clearTimeout(timer);
			timer = 0;
			if (clear) void queue(edit, null);
			context.change(edit.identity, false);
			detach();
			context.closed(edit.identity);
		}
		function acceptDisk(edit: DocumentEdit) {
			if (!edit.disk?.editBase) return;
			edit.base = edit.disk.editBase;
			edit.baseline = editing.normalise(edit.disk.text ?? "");
			edit.disk = undefined;
			edit.confirm = false;
			edit.error = "";
			clearTimeout(timer);
			timer = window.setTimeout(flushPending, 0);
			context.change(edit.identity, dirty(edit));
			draw();
			edit.view.input.focus();
		}
		function diskMessage(edit: DocumentEdit) {
			if (edit.checking) return "Checking the disk version…";
			return edit.disk?.editBase ? "This file changed on disk." : "The file on disk is no longer editable.";
		}
		function editMessage(edit: DocumentEdit) {
			if (edit.disk !== undefined) return diskMessage(edit);
			if (saving) return "Saving…";
			if (edit.confirm) return "Save changes before you leave edit mode?";
			return dirty(edit) ? "Unsaved changes" : "Editing";
		}
		function conflictControls(edit: DocumentEdit) {
			const reload = button("Reload disk version", () => close(edit, true), "secondary");
			const overwrite = button("Keep editing and overwrite on save", () => acceptDisk(edit), "secondary");
			overwrite.disabled = !edit.disk?.editBase || edit.checking || !!saving;
			reload.disabled = !!saving;
			return [reload, overwrite, button("Copy edited text", () => copy(edit), "quiet")];
		}
		function editControls(edit: DocumentEdit) {
			const commit = button(
				"Save",
				() => {
					void save();
				},
				"primary",
			);
			const discard = button("Discard", () => close(edit, true), "quiet");
			commit.disabled = edit.checking || !!saving;
			discard.disabled = !!saving;
			const controls = [commit, discard];
			if (edit.confirm)
				controls.push(
					button(
						"Keep editing",
						() => {
							edit.confirm = false;
							draw();
							edit.view.input.focus();
						},
						"secondary",
					),
				);
			else if (edit.draftError) controls.push(button("Copy edited text", () => copy(edit), "quiet"));
			return controls;
		}
		function draw() {
			const edit = current;
			toolbar.hidden = !edit;
			if (!edit) {
				toolbar.replaceChildren();
				return;
			}
			const state = el("span", "edit-state", edit.error || edit.draftError || editMessage(edit));
			state.classList.toggle("edit-alert", edit.disk !== undefined || !!edit.error || !!edit.draftError);
			state.setAttribute("role", "status");
			const controls = el("div", "edit-controls");
			if (edit.disk !== undefined) controls.append(...conflictControls(edit));
			else if (dirty(edit)) controls.append(...editControls(edit));
			toolbar.replaceChildren(state, controls);
		}
		async function checkDisk(force = false) {
			const edit = current;
			if (!edit || (saving && !force)) return;
			const stamp = ++edit.check;
			edit.checking = true;
			if (force) edit.disk = null;
			draw();
			const file = await request("file.read", { path: edit.identity.path }).catch(() => null);
			if (current !== edit || stamp !== edit.check) return;
			edit.disk = file?.editBase === edit.base ? undefined : file;
			edit.checking = false;
			draw();
		}
		async function write(edit: DocumentEdit) {
			const text = editing.restore(edit.text, edit.ending);
			try {
				const result = await request("file.write", { ...edit.identity, text, base: edit.base });
				edit.base = result.base;
				edit.baseline = edit.text;
				await queue(edit, null);
				context.change(edit.identity, false);
				context.saved(edit.identity, text, result.base);
				if (edit.confirm) close(edit, false);
			} catch (error) {
				if (current !== edit) return;
				if ((error as { code?: string })?.code === "conflict") await checkDisk(true);
				else edit.error = describe(error);
			}
		}
		async function save() {
			const edit = current;
			if (!edit || !dirty(edit) || edit.disk !== undefined || edit.checking || saving) return;
			flushPending();
			edit.view.input.readOnly = true;
			edit.error = "";
			saving = write(edit);
			draw();
			try {
				await saving;
			} finally {
				saving = undefined;
				edit.view.input.readOnly = false;
				draw();
				if (current === edit) {
					edit.view.input.focus({ preventScroll: true });
					if (edit.disk === undefined) void checkDisk();
				}
			}
		}
		function open(identity: ExplorerEditPath, file: ExplorerFile | null, draft?: ExplorerEditDraft) {
			if (!draft && !file?.editBase) return;
			const raw = file?.text ?? "";
			const model = draft ?? {
				text: editing.normalise(raw),
				base: file?.editBase ?? "",
				ending: editing.lineEnding(raw),
			};
			const diskChanged = file?.editBase !== model.base;
			const edit: DocumentEdit = {
				...model,
				identity,
				baseline: diskChanged ? undefined : editing.normalise(raw),
				disk: diskChanged ? file : undefined,
				confirm: false,
				checking: false,
				check: 0,
				error: "",
				draftError: "",
				view: surface(model.text, identity.path, editing.indentUnit(model.text), input),
			};
			function input(text: string) {
				return updateText(edit, text);
			}
			current = edit;
			context.change(identity, dirty(edit));
			draw();
		}
		function updateText(edit: DocumentEdit, text: string) {
			const tooLarge =
				text.length * 3 > editing.limit && editing.byteLength(editing.restore(text, edit.ending)) > editing.limit;
			if (tooLarge || text.includes("\0") || text.split("\n", 20_001).length > 20_000) {
				context.notice("Edit text is limited to 2 MiB and 20,000 lines and must not contain NUL bytes.");
				return false;
			}
			const previous = dirty(edit);
			edit.text = text;
			const recheck = previous !== dirty(edit) || !!edit.error;
			edit.error = "";
			clearTimeout(timer);
			timer = window.setTimeout(flushPending, 350);
			if (previous !== dirty(edit)) context.change(edit.identity, dirty(edit));
			if (recheck) draw();
			return true;
		}
		return {
			active: () => !!current,
			open,
			mount(settings, line) {
				if (!current) return;
				const { view } = current;
				if (!view.frame.isConnected) {
					body.replaceChildren(view.frame);
					view.layout(settings);
					view.jump(line ?? 1);
				} else view.layout(settings);
			},
			checkDisk,
			toggle() {
				if (!current || saving) return;
				if (!dirty(current) && current.disk === undefined) close(current, false);
				else {
					current.confirm = !current.confirm;
					draw();
				}
			},
			save,
			flush,
			detach,
			focus: () => current?.view.input.focus({ preventScroll: true }),
		};
	}
	app.editor = editor;
})();
