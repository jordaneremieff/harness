import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "./files.ts";
import { attachableMessage, buildMime, type PreparedAttachment } from "./mime.ts";
import { readSettings } from "./settings.ts";

const ACCOUNT = "person@example.com";

function attachment(name: string, content: string): PreparedAttachment {
	const bytes = Buffer.from(content);
	return {
		path: `/files/${name}`,
		name,
		bytes,
		size: bytes.length,
		sha256: sha256(bytes),
		filename: name,
		mimeType: "text/csv",
	} as PreparedAttachment;
}

test("buildMime writes CRLF headers, encodes a non-ASCII subject and base64 parts", () => {
	const mime = buildMime({ to: ["a@example.org"], subject: "Café plan", text: "line one\nline two" }, ACCOUNT, []);
	const text = mime.bytes.toString("utf8");
	assert.match(text, /^From: person@example\.com\r\nTo: a@example\.org\r\n/);
	assert.match(text, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
	assert.match(text, /\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
	assert.ok(!/[^\r]\n/.test(text));
	assert.equal(mime.rfcMessageId, /^Message-ID: (.+)\r$/m.exec(text)?.[1]);
	const body = text.split("\r\n\r\n")[1].replaceAll("\r\n", "");
	assert.equal(Buffer.from(body, "base64").toString("utf8"), "line one\r\nline two");
});

test("buildMime places attachments in multipart/mixed with encoded file names", () => {
	const mime = buildMime({ to: ["a@example.org"], subject: "Data", text: "see file" }, ACCOUNT, [
		attachment("résumé.csv", "a,b\n1,2"),
	]);
	const text = mime.bytes.toString("utf8");
	const boundary = /boundary="([^"]+)"/.exec(text)?.[1];
	assert.ok(boundary);
	assert.match(text, new RegExp(`\\r\\n--${boundary}--\\r\\n$`));
	assert.match(text, /filename\*=UTF-8''r%C3%A9sum%C3%A9\.csv/);
	assert.match(text, new RegExp(Buffer.from("a,b\n1,2").toString("base64").replace(/[+]/g, "\\+")));
});

test("buildMime rejects header injection and a missing subject", () => {
	assert.throws(
		() => buildMime({ to: ["a@example.org\r\nBcc: x@example.org"], subject: "S", text: "t" }, ACCOUNT, []),
		/CR, LF/,
	);
	assert.throws(() => buildMime({ to: ["a@example.org"], subject: "S\nX-Evil: 1", text: "t" }, ACCOUNT, []), /CR, LF/);
	assert.throws(() => buildMime({ to: ["a@example.org"], text: "t" }, ACCOUNT, []), /subject/);
});

test("settings: environment overrides, the default config directory and absolute executables", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "google-settings-"));
	try {
		const missing = join(agentDir, "missing.json");
		const defaults = readSettings({ agentDir, env: { PI_HARNESS_FILE: missing } });
		assert.equal(defaults.values.configDir, join(agentDir, "google", "gws"));
		const managed = join(agentDir, "google", "bin", "0.22.5", "gws");
		assert.equal(defaults.values.executable, managed);
		const set = readSettings({
			agentDir,
			env: { PI_HARNESS_FILE: missing, PI_GOOGLE_EXECUTABLE: "/opt/gws/gws", PI_GOOGLE_EXPECTED_ACCOUNT: ACCOUNT },
		});
		assert.equal(set.values.executable, "/opt/gws/gws");
		assert.equal(set.values.expectedAccount, ACCOUNT);
		const relative = readSettings({ agentDir, env: { PI_HARNESS_FILE: missing, PI_GOOGLE_EXECUTABLE: "bin/gws" } });
		assert.equal(relative.values.executable, managed);
		assert.ok(relative.diagnostics.some((item) => item.field === "google.executable"));
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("an attached message keeps its bytes unencoded, without Bcc, and refuses what cannot travel unencoded", () => {
	const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]);
	const raw = Buffer.concat([
		Buffer.from("Subject: Note\nBCC: a@example.org,\n\tb@example.org\rTo: c@example.org\n\nBody ", "latin1"),
		latin1,
		Buffer.from("\n", "latin1"),
	]);
	const prepared = attachableMessage(raw);
	assert.deepEqual(
		prepared,
		Buffer.concat([
			Buffer.from("Subject: Note\r\nTo: c@example.org\r\n\r\nBody ", "latin1"),
			latin1,
			Buffer.from("\r\n", "latin1"),
		]),
	);
	const mail = { to: ["friend@example.org"], subject: "Fwd: Note", text: "Attached" };
	const message: PreparedAttachment = {
		bytes: prepared,
		sha256: sha256(prepared),
		size: prepared.length,
		name: "original-message.eml",
		filename: "original-message.eml",
		mimeType: "message/rfc822",
		rfc822: true,
	};
	const built = buildMime(mail, ACCOUNT, [message]).bytes;
	assert.ok(
		built.includes(
			Buffer.concat([
				Buffer.from("Content-Transfer-Encoding: 8bit\r\n"),
				Buffer.from("Content-Disposition: attachment; "),
			]),
		),
	);
	assert.ok(built.includes(prepared), "the attached message bytes are unchanged");
	assert.throws(() => attachableMessage(Buffer.from("Subject: x\n\nNo\0here\n")), /NUL byte/);
	assert.throws(() => attachableMessage(Buffer.from(`Subject: x\n\n${"a".repeat(999)}\n`)), /998 bytes/);
	assert.throws(() => attachableMessage(Buffer.from("Subject: x\n")), /header terminator/);
});
