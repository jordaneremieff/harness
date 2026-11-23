import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createIdCommand } from "./id-command.ts";

const id = "example-session-id";
type Notice = Parameters<ExtensionContext["ui"]["notify"]>;

async function invoke(args = "", mode: ExtensionContext["mode"] = "tui", copyFails = false) {
	const copies: string[] = [];
	const notices: Notice[] = [];
	const command = createIdCommand(async (text) => {
		copies.push(text);
		if (copyFails) throw new Error("Clipboard unavailable");
	});
	await command.handler(args, {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		sessionManager: { getSessionId: () => id },
		ui: {
			notify: (...notice: Notice) => {
				notices.push(notice);
			},
		},
	} as ExtensionContext);
	return { copies, notices };
}

test("/id copies the bare ID and shows it in the confirmation", async () => {
	assert.deepEqual(await invoke(), { copies: [id], notices: [[`Session ID ${id} copied.`, "info"]] });
});

test("/id still shows the ID when the clipboard is unavailable", async () => {
	assert.deepEqual(await invoke("", "tui", true), {
		copies: [id],
		notices: [[`Session ID ${id} was not copied: Clipboard unavailable`, "warning"]],
	});
});

test("/id rejects arguments without changing the clipboard", async () => {
	assert.deepEqual(await invoke("other"), {
		copies: [],
		notices: [["Use /id without arguments to show the session ID.", "warning"]],
	});
});

test("/id does nothing without a UI", async () => {
	assert.deepEqual(await invoke("", "print"), { copies: [], notices: [] });
});

test("/id shows the ID in RPC without writing terminal escape sequences", async () => {
	assert.deepEqual(await invoke("", "rpc"), { copies: [], notices: [[`Session ID ${id}`, "info"]] });
});
