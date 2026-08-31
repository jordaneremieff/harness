import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactCommand } from "./redact.ts";

describe("redactCommand", () => {
	it("keeps an ordinary command unchanged", () => {
		const command = "rg -n 'pattern' src/ | head -20";
		assert.equal(redactCommand(command), command);
	});

	it("redacts a credential-named assignment and keeps a plain one", () => {
		assert.equal(redactCommand("API_TOKEN=abc123 curl https://host/x"), "API_TOKEN=[redacted] curl https://host/x");
		assert.equal(redactCommand("COUNT=5 node run.mjs"), "COUNT=5 node run.mjs");
	});

	it("redacts a credential flag value", () => {
		assert.equal(redactCommand("tool --api-key hunter2 --verbose"), "tool --api-key [redacted] --verbose");
	});

	it("redacts an authorization header and a bearer token", () => {
		assert.equal(
			redactCommand('curl -H "Authorization: Bearer abcdefghijklmnop" https://host'),
			'curl -H "Authorization: [redacted]" https://host',
		);
	});

	it("redacts credentials inside a URL and keeps the user", () => {
		assert.equal(redactCommand("git clone https://alice:s3cr3tpw@host/repo.git"), "git clone https://alice:[redacted]@host/repo.git");
	});

	it("redacts vendor key shapes", () => {
		assert.equal(redactCommand("export X=ghp_ABCDEFGHIJKLMNOPQRST"), "export X=[redacted]");
		assert.match(redactCommand("echo sk-ABCDEFGHIJKLMNOPQRSTUV"), /\[redacted\]/);
	});

	it("redacts a long opaque hex run", () => {
		assert.equal(redactCommand(`echo ${"a1b2c3d4".repeat(6)}`), "echo [redacted]");
	});

	it("bounds a long command", () => {
		const long = `echo ${"x".repeat(5000)}`;
		const result = redactCommand(long);
		assert.equal(result.length, 4097);
		assert.ok(result.endsWith("…"));
	});
});
