import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	REDACTED,
	redactionNotice,
	redactPayload,
	redactPayloadWithReport,
	redactSecrets,
	redactSecretsWithReport,
} from "./redact.ts";

describe("redactSecrets", () => {
	it("preserves nonsecret UUID coordinates in bare inline weak-label references", () => {
		const id = "12345678-1234-5678-9abc-123456789abc";
		const reference = `Use the saved reference {sessionId: ${id}, revision: 13, source: example}.`;
		const result = redactSecretsWithReport(reference);
		assert.equal(result.text, reference);
		assert.equal(result.report.count, 0);
		for (const key of ["token", "cookie", "sessionId", "session_id", "session-id"]) {
			for (const suffix of ["", ")", "}", ".", "!", "?"]) {
				const prose = `Use ${key}: ${id}${suffix}`;
				assert.equal(redactSecrets(prose), prose);
			}
		}
	});

	it("protects weak UUID credentials inside quoted fragments", () => {
		const id = "12345678-1234-5678-9abc-123456789abc";
		for (const quote of ["'", '"']) {
			for (const key of ["Cookie", "token", "sessionId"]) {
				for (const suffix of ["", "   ", "; Path=/"]) {
					const result = redactSecretsWithReport(`curl -H ${quote}${key}: ${id}${suffix}${quote} https://example.com`);
					assert.equal(result.report.count, 1);
					assert.ok(!result.text.includes(id));
					assert.ok(!redactionNotice(result.report).includes(id));
				}
			}
			const prose = `Use ${quote}saved${quote} reference {sessionId: ${id}, revision: 13}.`;
			assert.equal(redactSecrets(prose), prose);
		}
	});

	it("protects UUID credential assignments and non-UUID inline tokens", () => {
		const id = "12345678-1234-5678-9abc-123456789abc";
		for (const key of ["token", "cookie", "sessionId"]) {
			for (const input of [
				`${key}: ${id}`,
				`${key}=${id}`,
				`export APP_${key}=${id}`,
				`Use ${key}=${id}`,
				`Use ${key}: ${id}tail`,
				`Use ${key}: ${id}.tail`,
			]) {
				const result = redactSecretsWithReport(input);
				assert.ok(!result.text.includes(id));
				assert.equal(result.report.count, 1);
				assert.ok(!redactionNotice(result.report).includes(id));
			}
		}
		for (const input of [`Use secret: ${id}`, `password: ${id}`, `{"secret": "${id}"}`]) {
			assert.equal(redactSecretsWithReport(input).report.count, 1);
			assert.ok(!redactSecrets(input).includes(id));
		}
		assert.equal(redactSecrets("Used token: 1234567890abcdef1234567890abcdef"), `Used token: ${REDACTED}`);
	});

	it("retains prior redactions in preserved assignment suffixes and URL prefixes", () => {
		const token = "sk-abcdefgh" + "ijklmnop";
		const inline = redactSecretsWithReport(`Use password: abc12345 and key ${token}`);
		assert.equal(inline.text, `Use password: ${REDACTED} and key ${REDACTED}`);
		assert.equal(inline.report.count, 2);
		assert.deepEqual(inline.report.classes, { "labeled credential": 1, "provider token": 1 });
		const url = redactSecretsWithReport(`https://${token}:p4ssw0rd@example.test`);
		assert.equal(url.text, `https://${REDACTED}:${REDACTED}@example.test`);
		assert.equal(url.report.count, 2);
		assert.deepEqual(url.report.classes, { "provider token": 1, "URL password": 1 });
		assert.ok(!JSON.stringify([inline, url]).includes(token));
	});
	it("preserves inline task prose after sensitive labels", () => {
		for (const prose of [
			"On authorization: send @project-owner a task contract to build the step-0 trial at /workspace/project (TypeScript, macOS only...)",
			"The secret: keep the source intact.",
			"The password: use the documented sign-in process.",
			'The private key: "keep the source intact" is prose.',
			"password:\nKeep the source intact.",
		])
			assert.equal(redactSecrets(prose), prose);
	});

	it("protects explicit passphrases and inline tokens without consuming prose", () => {
		assert.equal(
			redactSecrets("  export DB_PASSWORD=correct horse battery staple"),
			`  export DB_PASSWORD=${REDACTED}`,
		);
		assert.equal(redactSecrets('  {"secret": "correct horse battery staple"}'), `  {"secret": "${REDACTED}"}`);
		assert.equal(
			redactSecrets("Use api_key: 0123456789abcdef0123456789abcdef for the request."),
			`Use api_key: ${REDACTED} for the request.`,
		);
		assert.equal(
			redactSecrets("The secret: IdentifierName remains visible."),
			"The secret: IdentifierName remains visible.",
		);
	});

	it("preserves next-line prose but protects token-only wrapped continuations", () => {
		const prefix = "sk-abcdefgh" + "ijklmnop1234";
		const jwt = "eyJabcdefghijk.abcdefghijk.abcdefghijk";
		for (const token of [prefix, jwt]) {
			assert.equal(
				redactSecrets(`${token}\nNext action: preserve context.`),
				`${REDACTED}\nNext action: preserve context.`,
			);
		}
		assert.equal(redactSecrets("sk-abc\ndefghijklmnop"), REDACTED);
		assert.equal(redactSecrets("Bearer\nKeep the source intact."), "Bearer\nKeep the source intact.");
	});

	it("counts removed spans once and excludes preexisting markers", () => {
		assert.equal(redactSecretsWithReport(REDACTED).report.count, 0);
		const existing = redactSecretsWithReport(`password = 'hunter2hunter2 ${REDACTED}'`);
		assert.equal(existing.text, `password = '${REDACTED}'`);
		assert.equal(existing.report.count, 1);
		const nested = redactSecretsWithReport('secret: "two words sk-abcdefghijklmnop1234"');
		assert.equal(nested.text, `secret: "${REDACTED}"`);
		assert.equal(nested.report.count, 1);
		assert.deepEqual(nested.report.classes, { "labeled credential": 1 });
		assert.ok(!redactionNotice(nested.report).includes("two words"));
		assert.equal(redactSecretsWithReport(nested.text).report.count, 0);
		const bare = redactSecretsWithReport("secret: two words sk-abcdefghijklmnop1234");
		assert.equal(bare.text, `secret: ${REDACTED}`);
		assert.equal(bare.report.count, 1);
		assert.ok(!redactionNotice(bare.report).includes("two words"));
		assert.equal(
			redactSecrets("password: correct horse battery staple\r\nNext action: preserve context."),
			`password: ${REDACTED}\r\nNext action: preserve context.`,
		);
	});

	it("sanitizes all recognized secrets before any notice excerpt", () => {
		const token = "sk-abcdefgh" + "ijklmnop1234";
		const password = "fakepassword";
		const input = `${token}\u001b near https://u:${password}@host/path ${REDACTED}`;
		const result = redactSecretsWithReport(input);
		assert.equal(result.report.count, 2);
		assert.deepEqual(result.report.classes, { "provider token": 1, "URL password": 1 });
		const notice = redactionNotice(result.report);
		assert.ok(!notice.includes(token));
		assert.ok(!notice.includes(password));
		assert.ok(!notice.includes("\u001b"));
		assert.ok(notice.includes("\\x1b near https://u:"));
		assert.equal(redactionNotice(redactSecretsWithReport("plain prose").report), "");
	});

	it("redacts embedded URL userinfo after scheme-character prefixes", () => {
		for (const prefix of ["", "123", "+.-", "1+2.-", "abc", "ABC123"]) {
			assert.equal(
				redactSecrets(`${prefix}https://user:fake-value@host/path`),
				`${prefix}https://user:${REDACTED}@host/path`,
			);
			assert.equal(redactSecrets(`${prefix}https://host/path`), `${prefix}https://host/path`);
		}
	});

	it("finishes supported-size non-URL runs without quadratic scheme retries", () => {
		const source = `import assert from "node:assert/strict";
import { redactSecrets } from ${JSON.stringify(new URL("./redact.ts", import.meta.url).href)};
for (const value of ["x".repeat(262144), "1".repeat(262144), "x".repeat(250000) + "://host/path"]) assert.equal(redactSecrets(value), value);
const prefix = "1".repeat(200000);
assert.equal(redactSecrets(prefix + "https://user:fake-value@host"), prefix + "https://user:[REDACTED]@host");`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 8192,
		});
		assert.equal(result.error, undefined);
		assert.equal(result.status, 0, result.stderr);
	});

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
		assert.equal(redactSecrets("password: hunter2 # keep the comment"), `password: ${REDACTED} # keep the comment`);
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
	it("reports payload and metadata fields without exposing removed values", () => {
		const token = "sk-abcdefgh" + "ijklmnop1234";
		const result = redactPayloadWithReport({
			title: "Title",
			summary: "Summary",
			project: `/workspace/${token}`,
			branch: token,
			sessionId: token,
			tags: [token],
			files: [token],
		});
		assert.equal(result.report.count, 5);
		assert.equal(result.payload.project, `/workspace/${REDACTED}`);
		assert.ok(result.report.contexts.some((context) => context.startsWith("project:")));
		assert.ok(!JSON.stringify(result).includes(token));
	});

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
