import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactPayload, redactSecrets, REDACTED } from "./redact.ts";

describe("redactSecrets", () => {
	it("redacts prefixed provider tokens", () => {
		assert.equal(redactSecrets("key sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwx"), `key ${REDACTED}`);
		assert.equal(redactSecrets("deepseek: sk-047abc" + "1234567890abcdefgh"), `deepseek: ${REDACTED}`);
		assert.equal(redactSecrets("groq gsk_n4ABC" + "DEF1234567890abcdef"), `groq ${REDACTED}`);
		assert.equal(redactSecrets("cerebras csk-nfABC" + "DEF1234567890abcdef"), `cerebras ${REDACTED}`);
		assert.equal(redactSecrets("xai xai-XJabc" + "def1234567890abcdef12"), `xai ${REDACTED}`);
		assert.equal(redactSecrets("google AIzaSyABC" + "DEFGHIJKLMNOPQRSTUVWXYZ1234"), `google ${REDACTED}`);
		assert.equal(redactSecrets("aws AKIAIOSFO" + "DNN7EXAMPLE"), `aws ${REDACTED}`);
		assert.equal(redactSecrets("github ghp_ABCDE" + "FGHIJKLMNOPQRSTUVWXYZ012345"), `github ${REDACTED}`);
		assert.equal(redactSecrets("slack xoxb-1234" + "56789012-abcdefghijklmnopqrstuvwx"), `slack ${REDACTED}`);
		assert.equal(redactSecrets("refresh rt.1.AADh" + "zAcKC_wceZ3tpGtXTNJckvFyXJm9PW2cYh"), `refresh ${REDACTED}`);
	});

	it("redacts JWTs and bearer tokens", () => {
		const jwt =
			"eyJhbGciO" +
			"iJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		assert.equal(redactSecrets(`Authorization: ${jwt}`), `Authorization: ${REDACTED}`);
		assert.equal(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz123456"), REDACTED);
		assert.equal(redactSecrets("Basic dXNlcjpwYXNzd29yZHNlY3JldA=="), REDACTED);
	});

	it("accepts alphabetic and hyphenated bearer tails per RFC 6750", () => {
		assert.equal(redactSecrets("Bearer abcdefghijklmnop"), REDACTED);
		assert.equal(redactSecrets("Bearer abc-defghijklmnopqrstuvwxyz"), REDACTED);
		assert.equal(redactSecrets("Authorization: Bearer abcdefghijklmnop"), `Authorization: ${REDACTED}`);
	});

	it("keeps Basic prose intact while redacting base64 tails", () => {
		assert.equal(redactSecrets("Basic interoperability is the goal"), "Basic interoperability is the goal");
		assert.equal(redactSecrets("Basic responsibilities are shared"), "Basic responsibilities are shared");
		assert.equal(redactSecrets("Basic dXNlcjpwYXNzd29yZHNlY3JldA=="), REDACTED);
	});

	it("accepts case-insensitive authorization schemes and spaced YAML values", () => {
		assert.equal(redactSecrets("Authorization: bearer abcdefghijklmnop"), `Authorization: ${REDACTED}`);
		assert.equal(redactSecrets("authorization: basic dXNlcjpwYXNz"), `authorization: ${REDACTED}`);
		assert.equal(redactSecrets("AWS_ACCESS_KEY_ID=ABCDEFGHIJKLMNOPQRSTUVWX123456"), `AWS_ACCESS_KEY_ID=${REDACTED}`);
		assert.equal(redactSecrets("password: correct horse battery staple"), `password: ${REDACTED}`);
		assert.equal(redactSecrets("password: hunter2 # keep the comment"), `password: ${REDACTED}# keep the comment`);
	});

	it("redacts labeled credentials with compound and spaced keys", () => {
		assert.equal(
			redactSecrets("AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"),
			`AWS_SECRET_ACCESS_KEY=${REDACTED}`,
		);
		assert.equal(
			redactSecrets("STRIPE_SECRET_KEY=sk_live_a" + "bcdefghijklmnopqrstuvwxyz"),
			`STRIPE_SECRET_KEY=${REDACTED}`,
		);
		assert.equal(redactSecrets("API key: 351bf6c8d2e4a0f9b7c3d1e5f6a8b0c2d4e6f8a0b"), `API key: ${REDACTED}`);
		assert.equal(redactSecrets("ZAI_API_KEY=351bf6c8d2e4a0f9b7c3d1e5f6a8b0c2d4e6f8a0b"), `ZAI_API_KEY=${REDACTED}`);
	});

	it("redacts PGP armor and tokens wrapped across lines", () => {
		const pgp =
			"-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: OpenPGP.js v4.10.10\nxcB0BF1\n-----END PGP PRIVATE KEY BLOCK-----";
		assert.equal(redactSecrets(`key:\n${pgp}\nend`), `key:\n${REDACTED}\nend`);
		assert.equal(redactSecrets("wrapped sk-abc123" + "4567890\ndefghijklmnop"), `wrapped ${REDACTED}`);
		const wrappedJwt =
			"eyJhbGciO" + "iJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3\nODkwfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		assert.equal(redactSecrets(wrappedJwt), REDACTED);
	});

	it("keeps weak-label prose and short token values intact", () => {
		assert.equal(
			redactSecrets("The parser token: IdentifierName remains valid"),
			"The parser token: IdentifierName remains valid",
		);
		assert.equal(redactSecrets('token: "abc defghijklmnop"'), 'token: "abc defghijklmnop"');
		assert.equal(redactSecrets("cookie: value123"), `cookie: ${REDACTED}`);
		assert.equal(redactSecrets("token: abc12345"), `token: ${REDACTED}`);
	});

	it("preserves quote style when redacting quoted values", () => {
		assert.equal(redactSecrets('"api_key": "sk-abcdef' + 'ghijklmnopqrstuvwx"'), `"api_key": "${REDACTED}"`);
		assert.equal(redactSecrets("password = 'correct horse battery staple'"), `password = '${REDACTED}'`);
	});

	it("redacts assignment keys glued to identifier prefixes", () => {
		assert.equal(redactSecrets("db_password=abcdefghijklmnopqrstuvwxyz123456"), `db_password=${REDACTED}`);
		assert.equal(redactSecrets("MY_API_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"), `MY_API_KEY=${REDACTED}`);
		assert.equal(redactSecrets("github_token=abcdefghijklmnopqrstuvwxyz123456"), `github_token=${REDACTED}`);
		assert.equal(redactSecrets("auth_secret: abcdefghijklmnopqrstuvwxyz123456"), `auth_secret: ${REDACTED}`);
		assert.equal(redactSecrets("app_secret = abcdefghijklmnopqrstuvwxyz123456"), `app_secret = ${REDACTED}`);
	});

	it("redacts DSN userinfo passwords for any scheme", () => {
		assert.equal(
			redactSecrets("postgres://postgres:password12345@localhost:5432/db"),
			"postgres://postgres:[REDACTED]@localhost:5432/db",
		);
		assert.equal(
			redactSecrets("mongodb://user:p@ssw0rd123@cluster.example.com:27017/db"),
			"mongodb://user:[REDACTED]@cluster.example.com:27017/db",
		);
		assert.equal(redactSecrets("redis://:secret12345@cache:6379/0"), "redis://:[REDACTED]@cache:6379/0");
	});

	it("redacts prefixed tokens glued to non-alphanumeric characters", () => {
		assert.equal(redactSecrets("key_sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwx"), `key_${REDACTED}`);
		assert.equal(redactSecrets("env_gsk_n4ABC" + "DEF1234567890abcdef"), `env_${REDACTED}`);
		assert.equal(redactSecrets("(sk-abc123" + "4567890)"), `(${REDACTED})`);
	});

	it("redacts additional high-precision token prefixes", () => {
		assert.equal(redactSecrets("ya29.a0Af" + "H6SMLabcdefghijklmnopqrstuvwxyz"), REDACTED);
		assert.equal(redactSecrets("whsec_abc" + "defghijklmnopqrstuvwxyz12345678"), REDACTED);
		assert.equal(redactSecrets("SG.abcdef" + "ghijklmnopqrstuvwxyz1234567890abcd"), REDACTED);
		assert.equal(redactSecrets("ASIAIOSFO" + "DNN7EXAMPLE"), REDACTED);
	});

	it("keeps URL values under assignment keys intact", () => {
		assert.equal(
			redactSecrets("token: https://example.com/oauth/callback"),
			"token: https://example.com/oauth/callback",
		);
		assert.equal(redactSecrets('secret: "https://example.com/x?y=1"'), 'secret: "https://example.com/x?y=1"');
	});

	it("redacts assignment values in json, bare, and quoted forms", () => {
		assert.equal(redactSecrets('"api_key": "sk-abcdef' + 'ghijklmnopqrstuvwx"'), `"api_key": "${REDACTED}"`);
		assert.equal(redactSecrets("API_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"), `API_KEY=${REDACTED}`);
		assert.equal(redactSecrets("password: hunter2hunter2hunter2"), `password: ${REDACTED}`);
		assert.equal(redactSecrets("secret = 'correct horse battery staple'"), `secret = '${REDACTED}'`);
		assert.equal(redactSecrets("token: 1234567890abcdef1234567890abcdef"), `token: ${REDACTED}`);
		assert.equal(redactSecrets("client_secret: 0123456789abcdef0123456789abcdef"), `client_secret: ${REDACTED}`);
		assert.equal(
			redactSecrets("refresh_token = eyJhbGciO" + "iJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abc"),
			`refresh_token = ${REDACTED}`,
		);
	});

	it("redacts private key blocks and URL userinfo passwords", () => {
		const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
		assert.equal(redactSecrets(`key material:\n${key}\nend`), `key material:\n${REDACTED}\nend`);
		assert.equal(
			redactSecrets("see https://user:p4ssw0rd@example.com/path"),
			"see https://user:[REDACTED]@example.com/path",
		);
		assert.equal(redactSecrets("see https://user@example.com/path"), "see https://user@example.com/path");
	});

	it("preserves non-secret content", () => {
		assert.equal(redactSecrets("sk-abc"), "sk-abc");
		assert.equal(
			redactSecrets("commit 9fceb02d0ae533e0b443ae44d7f495a0761d3a8e"),
			"commit 9fceb02d0ae533e0b443ae44d7f495a0761d3a8e",
		);
		assert.equal(
			redactSecrets("uuid 9fceb02d-0ae5-33e0-b443-ae44d7f495a0"),
			"uuid 9fceb02d-0ae5-33e0-b443-ae44d7f495a0",
		);
		assert.equal(redactSecrets('state: "open"'), 'state: "open"');
		assert.equal(redactSecrets('title: "Migration pass"'), 'title: "Migration pass"');
		assert.equal(redactSecrets("token: 12345"), "token: 12345");
		assert.equal(
			redactSecrets("mysk-ant-oa" + "t01-abcdefghijklmnopqrstuvwx"),
			"mysk-ant-oa" + "t01-abcdefghijklmnopqrstuvwx",
		);
		assert.equal(
			redactSecrets("the Bearer scheme is documented in rfc6750"),
			"the Bearer scheme is documented in rfc6750",
		);
		assert.equal(redactSecrets("--- a/src/foo.ts\n+++ b/src/foo.ts"), "--- a/src/foo.ts\n+++ b/src/foo.ts");
		assert.equal(redactSecrets("----\nmarkdown rule"), "----\nmarkdown rule");
	});

	it("is idempotent", () => {
		const input = "key sk-ant-oa" + "t01-abcdefghijklmnopqrstuvwx password: hunter2hunter2";
		assert.equal(redactSecrets(redactSecrets(input)), redactSecrets(input));
	});
});

describe("redactPayload", () => {
	it("redacts every string field", () => {
		const payload = {
			title: "Auth setup sk-abcdef" + "ghijklmnop",
			summary: "Used token: 1234567890abcdef1234567890abcdef",
			decisions: ["Keep gsk_n4ABC" + "DEF1234567890abcdef secret"],
			openLoops: ["Where is the key sk-ant-or" + "t01-abcdefghijklmnopqrstuvwx used"],
			nextActions: ["Rotate AKIAIOSFO" + "DNN7EXAMPLE"],
			files: ["/workspace/config.ts"],
			tags: ["auth"],
		};
		const out = redactPayload(payload);
		const all = [
			out.title,
			out.summary,
			...(out.decisions ?? []),
			...(out.openLoops ?? []),
			...(out.nextActions ?? []),
			...(out.files ?? []),
			...(out.tags ?? []),
		].join("\n");
		assert.ok(!all.includes("sk-abcdef" + "ghijklmnop"));
		assert.ok(!all.includes("1234567890abcdef1234567890abcdef"));
		assert.ok(!all.includes("gsk_n4ABC" + "DEF1234567890abcdef"));
		assert.ok(!all.includes("sk-ant-or" + "t01-abcdefghijklmnopqrstuvwx"));
		assert.ok(!all.includes("AKIAIOSFO" + "DNN7EXAMPLE"));
		assert.equal(out.title, `Auth setup ${REDACTED}`);
		assert.equal(out.files?.[0], "/workspace/config.ts");
	});

	it("leaves absent fields absent", () => {
		const out = redactPayload({ title: "T", summary: "S" });
		assert.deepEqual(out.decisions, undefined);
		assert.deepEqual(out.tags, undefined);
	});
});
