import { randomBytes } from "node:crypto";
import { authorised, json, jsonBody, listen, type Payload } from "./local.ts";

function acknowledgement() {
	let mark!: (value: boolean) => void;
	const event = new Promise<boolean>((resolve) => {
		mark = resolve;
	});
	return {
		mark,
		wait(ms: number) {
			return new Promise<boolean>((resolve) => {
				const timer = setTimeout(resolve, ms, false);
				void event.then((value) => {
					clearTimeout(timer);
					resolve(value);
				});
			});
		},
	};
}

export async function servePane(run: (input: Payload, signal: AbortSignal) => Promise<Payload>) {
	const token = randomBytes(32).toString("hex");
	const loaded = acknowledgement(),
		visible = acknowledgement();
	let stopped!: () => void;
	let problem: string | undefined;
	const ended = new Promise<void>((resolve) => {
		stopped = resolve;
	});
	let closing: Promise<void> | undefined;
	const server = await listen(async (req, res) => {
		if (req.method !== "POST" || req.url !== "/api") return json(res, 404, { error: "No such Editor request." });
		if (req.headers.origin !== undefined || !authorised(req, token)) {
			return json(res, 403, { error: "This request does not belong to the native pane." });
		}
		const input = await jsonBody(req, 16 * 1024 * 1024);
		switch (input.op) {
			case "loaded":
				loaded.mark(true);
				return json(res, 200, { loaded: true });
			case "ready":
				loaded.mark(true);
				visible.mark(true);
				return json(res, 200, { ready: true });
			case "closed":
				if (typeof input.error === "string") problem = input.error.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 400);
				res.once("finish", () => void close());
				return json(res, 200, { closed: true });
		}
		const controller = new AbortController();
		res.once("close", () => controller.abort());
		const output = await run(input, controller.signal);
		if (!res.destroyed) json(res, 200, output);
	});
	function close(): Promise<void> {
		loaded.mark(false);
		visible.mark(false);
		closing ??= server.close().finally(stopped);
		return closing;
	}
	return {
		port: server.port,
		token,
		ended,
		waitForLoad: loaded.wait,
		waitForView: visible.wait,
		get problem() {
			return problem;
		},
		get closed() {
			return closing !== undefined;
		},
		close,
	};
}
