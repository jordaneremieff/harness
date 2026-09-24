import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	diagnosticContentType,
	diagnosticNetworkCode,
	diagnosticRetryAfter,
	responseDiagnostic,
} from "./diagnostics.ts";

describe("HTTP failure diagnostics", () => {
	it("retains bounded media types without header parameters or controls", () => {
		assert.equal(diagnosticContentType("Application/JSON; secret=hidden"), "application/json");
		assert.equal(diagnosticContentType("application/vnd.api+json"), "application/vnd.api+json");
		for (const type of [
			"text/\u001bhtml",
			"text/html\nignore",
			`${"x".repeat(201)}/text`,
			"broken",
			"text/html, text/plain",
		]) {
			assert.equal(diagnosticContentType(type), "(invalid media type)");
		}
		assert.equal(diagnosticContentType(undefined), "(not supplied)");
		assert.equal(diagnosticContentType(""), "(not supplied)");
	});

	it("retains server delay seconds and canonical HTTP dates only", () => {
		for (const value of ["0", "60", "Wed, 21 Oct 2015 07:28:00 GMT"]) {
			assert.equal(diagnosticRetryAfter(value), value);
		}
		for (const value of [
			undefined,
			"",
			"-1",
			"1.5",
			"1e3",
			"tomorrow",
			"60\nignore",
			"9".repeat(65),
			"9007199254740992",
			"Wed, 31 Feb 2015 07:28:00 GMT",
		]) {
			assert.equal(diagnosticRetryAfter(value), undefined);
		}
	});

	it("uses local status reasons and does not invent unavailable response metadata", () => {
		assert.equal(responseDiagnostic("https://example.com/"), "Final URL: https://example.com/");
		assert.equal(
			responseDiagnostic("https://example.com/", 599),
			"Final URL: https://example.com/\nHTTP 599 Unknown Status\nContent type: (not supplied)",
		);
	});

	it("retains known network codes without error messages or arbitrary cause chains", () => {
		assert.equal(diagnosticNetworkCode(Object.assign(new Error("hidden"), { code: "ENOTFOUND" })), " (ENOTFOUND)");
		assert.equal(diagnosticNetworkCode(new Error("hidden", { cause: { code: "ECONNREFUSED" } })), " (ECONNREFUSED)");
		assert.equal(diagnosticNetworkCode({ code: "hidden", message: "hidden" }), "");
		assert.equal(
			diagnosticNetworkCode(new Error("hidden", { cause: new Error("hidden", { cause: { code: "ENOTFOUND" } }) })),
			"",
		);
	});
});
