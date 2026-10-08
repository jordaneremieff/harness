/**
 * Native Pi Durable form of the clipboard tools.
 *
 * The ordinary factory emits this contribution on the `durable:contribution`
 * channel. A Durable session host builds the extension from it, so Durable
 * agents keep the clipboard capability without ordinary session APIs. The
 * archive stays the external store the ordinary tools use; this contribution
 * adds no Durable documents.
 *
 * Replay classification: paste, list, and get only read the clipboard or the
 * archive, so a rerun after process loss repeats no external effect. Copy and
 * restore write the clipboard and append an archive record, so a rerun would
 * overwrite newer clipboard content and duplicate a record.
 *
 * The ordinary tools expose presentation details but no structured content, so
 * the native tools return the same result text and details object.
 */

import type * as Durable from "@earendil-works/pi-durable";
import { publishSettings, type SettingsBus } from "./settings.ts";
import {
	clipboardCopy,
	clipboardGet,
	clipboardList,
	clipboardPaste,
	clipboardRestore,
	CLIPBOARD_GUIDANCE,
	COPY_DESCRIPTION,
	CopyParams,
	GET_DESCRIPTION,
	GetParams,
	LIST_DESCRIPTION,
	ListParams,
	PASTE_DESCRIPTION,
	PasteParams,
	RESTORE_DESCRIPTION,
	RestoreParams,
} from "./operations.ts";
import { resolveClipboardDir } from "./store.ts";

/** Durable extension name; unique across contributions. */
export interface DurableContribution {
	readonly name: string;
	/** Absolute path of the emitting extension's entrypoint. */
	readonly source: string;
	/** Build the native extension for one session host; called once per host. */
	create(host: DurableContributionHost): Durable.Extension | Promise<Durable.Extension>;
}

/** The host members this contribution uses. */
export interface DurableContributionHost {
	/** The host's pi-durable module. Take every pi-durable runtime value from it. */
	readonly durable: typeof Durable;
	readonly agentDir: string;
	onClose(dispose: () => void | Promise<void>): void;
}

/** The ordinary entrypoint this contribution speaks for, as its factory resolves it. */
export function clipboardContribution(
	source: string,
	bus: SettingsBus,
	stopFactoryPublisher: () => void,
): DurableContribution {
	return {
		name: "clipboard",
		source,
		create(host) {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const durable = host.durable;
			const storeDir = () => resolveClipboardDir(process.env, host.agentDir);
			return durable.defineExtension({
				name: "clipboard",
				tools: [
					durable.defineTool({
						name: "clipboard_copy",
						description: COPY_DESCRIPTION,
						parameters: CopyParams,
						replay: "unsafe",
						execute: (args, _api, context) => clipboardCopy(storeDir(), args, context.abortSignal),
					}),
					durable.defineTool({
						name: "clipboard_paste",
						description: PASTE_DESCRIPTION,
						parameters: PasteParams,
						replay: "safe",
						execute: (args, _api, context) => clipboardPaste(args, context.abortSignal),
					}),
					durable.defineTool({
						name: "clipboard_list",
						description: LIST_DESCRIPTION,
						parameters: ListParams,
						replay: "safe",
						execute: (args, _api, context) => clipboardList(storeDir(), args, context.abortSignal),
					}),
					durable.defineTool({
						name: "clipboard_get",
						description: GET_DESCRIPTION,
						parameters: GetParams,
						replay: "safe",
						execute: (args, _api, context) => clipboardGet(storeDir(), args, context.abortSignal),
					}),
					durable.defineTool({
						name: "clipboard_restore",
						description: RESTORE_DESCRIPTION,
						parameters: RestoreParams,
						replay: "unsafe",
						execute: (args, _api, context) => clipboardRestore(storeDir(), args, context.abortSignal),
					}),
				],
				sections: [durable.section("clipboard", () => CLIPBOARD_GUIDANCE)],
			});
		},
	};
}
