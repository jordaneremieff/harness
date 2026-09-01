import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactCommand } from "./redact.ts";

const REDACTED = "[redacted]";

describe("redactCommand", () => {
	it("keeps ordinary commands and similarly named values unchanged", () => {
		const commands = [
			"rg -n 'pattern' src/ | head -20",
			"COUNT=5 node run.mjs",
			"COMPASS=north tool",
			"PASSPORT=123 tool",
			"SECRETARY=jane tool",
			"AUTHORS=alice tool",
			"TOKENIZER=x tool",
			"tool --keyboard-layout us",
			"git log 2a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
		];
		for (const command of commands) assert.equal(redactCommand(command), command);
	});

	it("redacts sensitive assignments without swallowing later query fields or quotes", () => {
		assert.equal(
			redactCommand("API_TOKEN=fake-value curl https://host/x"),
			`API_TOKEN=${REDACTED} curl https://host/x`,
		);
		assert.equal(redactCommand("curl 'https://x?a=1&token=fake-value'"), `curl 'https://x?a=1&token=${REDACTED}'`);
		assert.equal(
			redactCommand("curl -d 'a=1&api_key=fake-value' https://x"),
			`curl -d 'a=1&api_key=${REDACTED}' https://x`,
		);
	});

	it("redacts sensitive JSON and colon-delimited fields", () => {
		assert.equal(
			redactCommand(`curl -d '{"api_key":"fake-value","secret":"fake-secret"}' https://x`),
			`curl -d '{"api_key":${REDACTED},"secret":${REDACTED}}' https://x`,
		);
		assert.equal(
			redactCommand("password: fake-value\napi_key: fake-value"),
			`password: ${REDACTED}\napi_key: ${REDACTED}`,
		);
	});

	it("redacts sensitive long and tool-specific short flags", () => {
		const cases = new Map([
			["tool --api-key fake-value --verbose", `tool --api-key ${REDACTED} --verbose`],
			["curl -u alice:fake-pass https://host", `curl -u ${REDACTED} https://host`],
			["sshpass -p fake-pass ssh host", `sshpass -p ${REDACTED} ssh host`],
			["mysql -pFakePass db", `mysql -p${REDACTED} db`],
			["redis-cli -a fake-pass PING", `redis-cli -a ${REDACTED} PING`],
			["docker login -u alice -p fake-pass registry", `docker login -u alice -p ${REDACTED} registry`],
		]);
		for (const [command, expected] of cases) assert.equal(redactCommand(command), expected);
	});

	it("redacts authorization, API-key, and cookie headers", () => {
		assert.equal(
			redactCommand('curl -H "Authorization: Bearer abcdefghijklmnop" https://host'),
			`curl -H "Authorization: ${REDACTED}" https://host`,
		);
		assert.equal(
			redactCommand("curl -H 'X-Api-Key: fake-value' https://host"),
			`curl -H 'X-Api-Key: ${REDACTED}' https://host`,
		);
		assert.equal(
			redactCommand("curl -H 'Cookie: foo=fake-value' https://host"),
			`curl -H 'Cookie: ${REDACTED}' https://host`,
		);
	});

	it("redacts URL credentials and keeps a present user", () => {
		assert.equal(
			redactCommand("git clone https://alice:fake-pass@host/repo.git"),
			`git clone https://alice:${REDACTED}@host/repo.git`,
		);
		assert.equal(redactCommand("curl http://:fake-pass@host/x"), `curl http://:${REDACTED}@host/x`);
	});

	it("redacts private keys, vendor keys, access ids, JWTs, and opaque base64", () => {
		// Key-shaped fixtures are built at runtime so the committed text carries
		// no literal that external secret scanners match; the redactor still
		// receives the full shape.
		const stripeShape = `sk_live_${"51HZxabcdefghijklmnopqrstuvwxyz"}`;
		const slackShape = `xoxc-${"123456789012"}-${"123456789012"}`;
		const githubShape = `ghp_${"ABCDEFGHIJKLMNOPQRST"}`;
		const awsAccessShape = `AKIA${"IOSFODNN7EXAMPLE"}`;
		const joseShape = `eyJ${"abcdefghijk"}.${"abcdefghijkl"}.${"abcdefghijk"}`;
		const awsSecretShape = `wJalrXUtnFEMI/${"K7MDENG/bPxRfiCY"}${"EXAMPLEKEY"}`;
		const commands = [
			"echo '-----BEGIN PRIVATE KEY-----\nfake-body\n-----END PRIVATE KEY-----'",
			`echo ${stripeShape}`,
			`echo ${slackShape}`,
			`export X=${githubShape}`,
			`AWS_ACCESS_KEY_ID=${awsAccessShape}`,
			`echo ${joseShape}`,
			`echo ${awsSecretShape}`,
			`echo AIza${"A".repeat(35)}`,
		];
		for (const command of commands) assert.match(redactCommand(command), /\[redacted\]/);
		const opaqueShape = `YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo6${"MTIzNDU2Nzg5MDo="}`;
		assert.equal(redactCommand(`echo ${opaqueShape}`), `echo ${REDACTED}`);
	});

	it("bounds work and stored text for a long command", () => {
		const result = redactCommand(`echo ${"x".repeat(5000)}`);
		assert.equal(result.length, 4097);
		assert.ok(result.endsWith("…"));
	});
});
