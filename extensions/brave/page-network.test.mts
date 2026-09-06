import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import http, { Agent, IncomingMessage, request as httpRequest, type ClientRequest } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { describe, it } from "node:test";
import type { DetailedPeerCertificate } from "node:tls";
import {
	fetchPublicPage,
	isPublicPageAddress,
	PAGE_NETWORK_LIMITS,
	parsePublicPageUrl,
	pinnedPageRequestOptions,
	type PageNetworkDependencies,
	type PageResolver,
} from "./page-network.ts";

interface Reply {
	status?: number;
	headers?: IncomingMessage["headers"];
	chunks?: Buffer[];
	complete?: boolean;
	stall?: boolean;
	close?: boolean;
	error?: string;
}

function fixture(replies: Reply[] = [{}], answers: string[][] = [["8.8.8.8"], []]) {
	const requests: ClientRequest[] = [];
	const responses: IncomingMessage[] = [];
	const observed: Parameters<PageNetworkDependencies["request"]>[0][] = [];
	const lookups: string[] = [];
	let cancelCount = 0;
	const resolver: PageResolver = {
		async resolve4(hostname) {
			lookups.push(hostname);
			return answers[0];
		},
		async resolve6(hostname) {
			lookups.push(hostname);
			return answers[1];
		},
		cancel() {
			cancelCount++;
		},
	};
	const dependencies: PageNetworkDependencies = {
		createResolver: () => resolver,
		request(options, callback) {
			const index = observed.length;
			observed.push(options);
			const reply = replies[index] ?? {};
			const request = new EventEmitter() as ClientRequest;
			request.destroyed = false;
			request.destroy = () => {
				if (!request.destroyed) {
					request.destroyed = true;
					queueMicrotask(() => request.emit("close"));
				}
				return request;
			};
			request.end = (() => {
				queueMicrotask(() => {
					if (reply.error) {
						request.emit("error", new Error(reply.error));
						return;
					}
					const response = new IncomingMessage(new Socket());
					responses.push(response);
					response.statusCode = reply.status ?? 200;
					response.headers = reply.headers ?? { "content-type": "text/html" };
					response.complete = reply.complete ?? true;
					callback(response);
					if (response.destroyed) return;
					if (reply.close) {
						response.destroy();
						return;
					}
					for (const chunk of reply.chunks ?? [Buffer.from("<p>Page</p>")]) response.push(chunk);
					if (!reply.stall) response.push(null);
				});
				return request;
			}) as ClientRequest["end"];
			requests.push(request);
			return request;
		},
	};
	return { dependencies, resolver, requests, responses, observed, lookups, cancelled: () => cancelCount };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

function assertClean(f: ReturnType<typeof fixture>, signal?: AbortSignal) {
	assert.ok(f.requests.every((request) => request.destroyed));
	assert.ok(f.responses.every((response) => response.destroyed));
	if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
}

describe("public page address policy", () => {
	it("admits ordinary public addresses without accepting noncanonical IPv4", () => {
		for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
			assert.equal(isPublicPageAddress(address), true, address);
		}
		for (const address of ["", "example.com", "127.1", "0x7f000001", "2130706433", "008.008.008.008", "1.1.1.256"]) {
			assert.equal(isPublicPageAddress(address), false, address);
		}
	});

	it("rejects special IPv4 blocks and their range boundaries", () => {
		for (const address of [
			"0.0.0.0",
			"0.255.255.255",
			"10.0.0.1",
			"10.255.255.255",
			"100.64.0.0",
			"100.127.255.255",
			"127.0.0.1",
			"127.255.255.255",
			"169.254.0.0",
			"169.254.169.254",
			"172.16.0.0",
			"172.31.255.255",
			"192.0.0.9",
			"192.0.2.255",
			"192.31.196.1",
			"192.52.193.1",
			"192.88.99.1",
			"192.168.0.1",
			"192.175.48.1",
			"198.18.0.0",
			"198.19.255.255",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.0",
			"239.255.255.255",
			"240.0.0.0",
			"255.255.255.255",
		])
			assert.equal(isPublicPageAddress(address), false, address);
		for (const address of [
			"100.63.255.255",
			"100.128.0.0",
			"172.15.255.255",
			"172.32.0.0",
			"198.17.255.255",
			"198.20.0.0",
		]) {
			assert.equal(isPublicPageAddress(address), true, address);
		}
	});

	it("rejects mapped, translated, tunneled, local, special, and documentation IPv6", () => {
		for (const address of [
			"::",
			"::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"::ffff:8.8.8.8",
			"::808:808",
			"64:ff9b::808:808",
			"64:ff9b:1::808:808",
			"100::1",
			"2001::1",
			"2001:1ff:ffff::1",
			"2001:db8::1",
			"2001:20::1",
			"2002:808:808::1",
			"2620:4f:8000::1",
			"3ffe::1",
			"3fff:fff:ffff::1",
			"fc00::1",
			"fd00:ec2::254",
			"fe80::1",
			"fe80::1%lo0",
			"ff02::1",
			"2001:4860::5efe:7f00:1",
			"2001:4860::200:5efe:808:808",
			"2001:4860::8.8.8.8",
		])
			assert.equal(isPublicPageAddress(address), false, address);
	});

	it("rejects URL ambiguity, credentials, unsafe ports, controls, and oversized URLs", () => {
		for (const input of [
			"file:///etc/passwd",
			"ftp://example.com",
			"https:example.com",
			"https://user:password@example.com",
			"https://@example.com",
			"https://example.com:444/",
			"http://example.com:443/",
			"https://example.com/has space",
			"https://example.com/\npath",
			" https://example.com",
			"https://example.com\\@other.example/",
			"http://0x7f.1/",
			"http://2130706433/",
			"http://0177.0.0.1/",
			"http://[::ffff:7f00:1]/",
			`https://example.com/${"a".repeat(4096)}`,
		])
			assert.throws(() => parsePublicPageUrl(input), /not allowed/, input);
		assert.equal(parsePublicPageUrl("https://example.com:443/path#fragment").href, "https://example.com/path");
		assert.equal(parsePublicPageUrl("http://example.com:80/path").href, "http://example.com/path");
	});
});

describe("pinned public page transport", () => {
	it("pins the numeric address and preserves the Host, TLS name, and certificate checks", () => {
		const options = pinnedPageRequestOptions(new URL("https://example.com/path?q=yes"), "8.8.8.8");
		assert.equal(options.hostname, "8.8.8.8");
		assert.equal(options.family, 4);
		assert.equal(options.port, 443);
		assert.equal(options.path, "/path?q=yes");
		assert.equal(options.agent, false);
		assert.equal(options.setHost, false);
		assert.equal(options.servername, "example.com");
		assert.equal(options.rejectUnauthorized, true);
		assert.equal(options.maxHeaderSize, 16 * 1024);
		assert.equal(options.insecureHTTPParser, false);
		assert.deepEqual(options.headers, {
			Host: "example.com",
			Accept: "text/html, application/xhtml+xml, text/plain;q=0.9",
			"Accept-Encoding": "identity",
			Connection: "close",
			"User-Agent": "Pi-Public-Page/1.0",
		});
		const cert = { subject: {}, subjectaltname: "DNS:example.com" } as DetailedPeerCertificate;
		assert.equal(options.checkServerIdentity?.("8.8.8.8", cert), undefined);
		assert.ok(
			options.checkServerIdentity?.("example.com", {
				subject: {},
				subjectaltname: "DNS:wrong.example",
			} as DetailedPeerCertificate),
		);
		const ipOptions = pinnedPageRequestOptions(new URL("https://[2606:4700:4700::1111]/"), "2606:4700:4700::1111");
		assert.equal(ipOptions.servername, "");
		assert.equal(ipOptions.family, 6);
		assert.equal((ipOptions.headers as Record<string, string>).Host, "[2606:4700:4700::1111]");
		assert.equal(
			ipOptions.checkServerIdentity?.("other.example", {
				subject: {},
				subjectaltname: "IP Address:2606:4700:4700:0:0:0:0:1111",
			} as DetailedPeerCertificate),
			undefined,
		);
	});

	it("returns bounded bytes and metadata, then releases the request and caller listener", async () => {
		const f = fixture();
		const controller = new AbortController();
		const result = await fetchPublicPage("https://example.com/#fragment", controller.signal, {
			dependencies: f.dependencies,
		});
		assert.equal(result.requestedUrl, "https://example.com/");
		assert.equal(result.finalUrl, "https://example.com/");
		assert.equal(result.contentType, "text/html");
		assert.equal(result.body.toString(), "<p>Page</p>");
		assert.equal(result.downloadedBytes, result.body.length);
		assert.equal(result.redirectCount, 0);
		assert.equal(new Date(result.retrievedAt).toISOString(), result.retrievedAt);
		assert.deepEqual(f.lookups, ["example.com", "example.com"]);
		assert.ok(f.cancelled() > 0);
		assertClean(f, controller.signal);
	});

	it("validates every DNS answer and rejects mixed public/private or mapped results before a request", async () => {
		for (const answers of [
			[["8.8.8.8", "127.0.0.1"], []],
			[["8.8.8.8"], ["::ffff:7f00:1"]],
			[["8.8.8.8"], ["fd00::1"]],
			[[], []],
		]) {
			const f = fixture([], answers);
			await assert.rejects(
				fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies }),
				/address is not allowed/,
			);
			assert.equal(f.observed.length, 0);
			assert.ok(f.cancelled() > 0);
		}
	});

	it("handles missing AAAA records but fails closed on other DNS errors", async () => {
		for (const code of ["ENODATA", "ENOTFOUND", "ETIMEOUT"]) {
			const f = fixture();
			f.resolver.resolve6 = async () => {
				throw Object.assign(new Error("remote details"), { code });
			};
			const promise = fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies });
			if (code === "ENODATA") await promise;
			else {
				await assert.rejects(promise, /DNS lookup failed/);
				assert.equal(f.observed.length, 0);
			}
		}
	});

	it("prevents rebinding after validation and revalidates the same hostname on a redirect", async () => {
		const f = fixture([{ status: 302, headers: { location: "/next" } }]);
		let resolutions = 0;
		f.resolver.resolve4 = async () => (++resolutions === 1 ? ["8.8.8.8"] : ["127.0.0.1"]);
		await assert.rejects(
			fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies }),
			/address is not allowed/,
		);
		assert.equal(f.observed.length, 1);
		assert.equal(f.observed[0].hostname, "8.8.8.8");
		assert.equal(f.observed[0].lookup, undefined);
		assert.equal(resolutions, 2);
		assertClean(f);
	});

	it("revalidates redirects before any connection to the next target", async () => {
		for (const location of [
			"http://169.254.169.254/",
			"http://[::ffff:7f00:1]/",
			"file:///secret",
			"https://user:pw@example.com/",
			"https://@example.com/",
			"https://example.com:444/",
			"//other.example/\nsecret",
			"x".repeat(4097),
		]) {
			const f = fixture([{ status: 302, headers: { location } }]);
			await assert.rejects(
				fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies }),
				/not allowed/,
			);
			assert.equal(f.observed.length, 1);
			assertClean(f);
		}
	});

	it("allows three redirects, discards their bodies, and rejects a fourth redirect", async () => {
		const replies: Reply[] = [
			{ status: 301, headers: { location: "/two" } },
			{ status: 307, headers: { location: "https://other.example/three" } },
			{ status: 308, headers: { location: "/four" } },
			{},
		];
		const f = fixture(replies);
		const result = await fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies });
		assert.equal(result.redirectCount, 3);
		assert.equal(result.finalUrl, "https://other.example/four");
		assert.equal(f.observed.length, 4);
		assertClean(f);
		const overflow = fixture([...replies.slice(0, 3), { status: 303, headers: { location: "/five" } }]);
		await assert.rejects(
			fetchPublicPage("https://example.com", undefined, { dependencies: overflow.dependencies }),
			/redirect limit/,
		);
		assert.equal(overflow.observed.length, 4);
		assertClean(overflow);
	});

	it("rejects compressed and unsuccessful responses without reading their bodies", async () => {
		for (const reply of [
			{ headers: { "content-encoding": "gzip" } },
			{ headers: { "content-encoding": "br" } },
			{ headers: { "content-encoding": "deflate" } },
			{ status: 404 },
			{ status: 206 },
			{ status: 302, headers: {} },
		]) {
			const f = fixture([reply]);
			await assert.rejects(
				fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies }),
				/Public page/,
			);
			assertClean(f);
		}
	});

	it("enforces both declared and streamed body limits, including the exact boundary", async () => {
		for (const reply of [
			{ headers: { "content-length": String(PAGE_NETWORK_LIMITS.bodyBytes + 1) } },
			{ chunks: [Buffer.alloc(PAGE_NETWORK_LIMITS.bodyBytes), Buffer.alloc(1)] },
		]) {
			const f = fixture([reply]);
			await assert.rejects(
				fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies }),
				/size limit/,
			);
			assertClean(f);
		}
		const f = fixture([
			{
				headers: { "content-length": String(PAGE_NETWORK_LIMITS.bodyBytes) },
				chunks: [Buffer.alloc(PAGE_NETWORK_LIMITS.bodyBytes)],
			},
		]);
		const result = await fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies });
		assert.equal(result.downloadedBytes, PAGE_NETWORK_LIMITS.bodyBytes);
		assertClean(f);
	});

	it("rejects premature response closure, incomplete messages, and length mismatches", async () => {
		for (const reply of [{ close: true }, { complete: false }, { headers: { "content-length": "99" } }]) {
			const f = fixture([reply]);
			await assert.rejects(
				fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies }),
				/request failed/,
			);
			assertClean(f);
		}
	});

	it("sanitizes input, request, DNS, and abort errors", async () => {
		const marker = "sensitive-remote-detail";
		const f = fixture([{ error: marker }]);
		await assert.rejects(
			fetchPublicPage(`https://example.com/${marker}`, undefined, { dependencies: f.dependencies }),
			(error: Error) => {
				assert.equal(error.message, "Public page request failed.");
				assert.equal(error.cause, undefined);
				return true;
			},
		);
		const controller = new AbortController();
		controller.abort(new Error(marker));
		await assert.rejects(fetchPublicPage(marker, controller.signal), { message: "Public page request cancelled." });
		assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	});

	it("cancels outstanding DNS work and removes the caller listener", async () => {
		const f = fixture();
		const pendingDns: Array<(error: Error) => void> = [];
		let cancelled = false;
		f.resolver.resolve4 = () => new Promise((_resolve, reject) => pendingDns.push(reject));
		f.resolver.resolve6 = f.resolver.resolve4;
		f.resolver.cancel = () => {
			cancelled = true;
			for (const reject of pendingDns.splice(0)) reject(new Error("DNS cancelled"));
		};
		const controller = new AbortController();
		const promise = fetchPublicPage("https://example.com", controller.signal, { dependencies: f.dependencies });
		controller.abort();
		await assert.rejects(promise, /cancelled/);
		assert.equal(cancelled, true);
		assert.equal(pendingDns.length, 0);
		assert.equal(f.observed.length, 0);
		assertClean(f, controller.signal);
	});

	it("enforces the total deadline during DNS and cancels both lookups", async () => {
		const f = fixture();
		let cancelCount = 0;
		const pending: Array<(error: Error) => void> = [];
		f.resolver.resolve4 = () => new Promise((_resolve, reject) => pending.push(reject));
		f.resolver.resolve6 = f.resolver.resolve4;
		f.resolver.cancel = () => {
			cancelCount++;
			for (const reject of pending.splice(0)) reject(new Error("cancelled"));
		};
		await assert.rejects(
			fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies, timeoutMs: 5 }),
			/timed out/,
		);
		assert.ok(cancelCount > 0);
		assert.equal(pending.length, 0);
		assert.equal(f.observed.length, 0);
	});

	it("cancels a stalled body and enforces the same deadline after redirects", async () => {
		for (const cancellation of [true, false]) {
			const f = fixture([{ status: 302, headers: { location: "/next" } }, { stall: true }]);
			const controller = new AbortController();
			const promise = fetchPublicPage("https://example.com", controller.signal, {
				dependencies: f.dependencies,
				timeoutMs: cancellation ? 1000 : 10,
			});
			const rejected = assert.rejects(promise, cancellation ? /cancelled/ : /timed out/);
			if (cancellation) {
				await turn();
				controller.abort();
			}
			await rejected;
			assert.equal(f.observed.length, 2);
			assertClean(f, controller.signal);
		}
	});

	it("uses one deadline across DNS, redirects, and the final body", async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		const f = fixture([{ status: 302, headers: { location: "/next" } }, { stall: true }]);
		let releaseDns: (addresses: string[]) => void = () => {};
		let calls = 0;
		f.resolver.resolve4 = () =>
			++calls === 1
				? new Promise((resolve) => {
						releaseDns = resolve;
					})
				: Promise.resolve(["8.8.8.8"]);
		const promise = fetchPublicPage("https://example.com", undefined, { dependencies: f.dependencies, timeoutMs: 20 });
		const rejected = assert.rejects(promise, /timed out/);
		context.mock.timers.tick(12);
		releaseDns(["8.8.8.8"]);
		await turn();
		assert.equal(f.observed.length, 2);
		context.mock.timers.tick(7);
		assert.equal(f.requests[1].destroyed, false);
		context.mock.timers.tick(1);
		await rejected;
		assertClean(f);
	});

	it("cancels a connection before headers and rejects a premature request close", async () => {
		for (const cancel of [true, false]) {
			const f = fixture();
			const createRequest = f.dependencies.request;
			f.dependencies.request = (options, callback) => {
				const request = createRequest(options, callback);
				request.end = (() => request) as ClientRequest["end"];
				return request;
			};
			const controller = new AbortController();
			const promise = fetchPublicPage("https://example.com", controller.signal, { dependencies: f.dependencies });
			const rejected = assert.rejects(promise, cancel ? /cancelled/ : /request failed/);
			await turn();
			if (cancel) controller.abort();
			else f.requests[0].emit("close");
			await rejected;
			assert.equal(f.responses.length, 0);
			assertClean(f, controller.signal);
		}
	});

	it("rejects invalid or extended timeout values", async () => {
		for (const timeoutMs of [0, -1, Number.NaN, Infinity, PAGE_NETWORK_LIMITS.timeoutMs + 1]) {
			await assert.rejects(fetchPublicPage("https://example.com", undefined, { timeoutMs }), /deadline is not allowed/);
		}
	});
});

/** A socket substitute exercises Node's real HTTP parser without any network. */
function nativeParserFixture(rawResponse: string) {
	const socket = new Duplex({
		read() {},
		write(_chunk, _encoding, callback) {
			callback();
			queueMicrotask(() => socket.push(rawResponse));
		},
	});
	const agent = new Agent();
	agent.createConnection = () => socket as Socket;
	const dependencies: PageNetworkDependencies = {
		createResolver: () => ({ resolve4: async () => ["8.8.8.8"], resolve6: async () => [], cancel() {} }),
		request: (options, callback) => httpRequest({ ...options, agent }, callback),
	};
	return { dependencies, socket, agent };
}

describe("native HTTP parser safety", () => {
	it("creates a fresh agent without the global agent's environment proxy configuration", async (context) => {
		const socket = new Duplex({
			read() {},
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		const originalAgent = http.globalAgent;
		const proxyAgent = new Agent({ proxyEnv: { HTTP_PROXY: "http://proxy.invalid:8080" } } as ConstructorParameters<
			typeof Agent
		>[0]);
		let connections = 0;
		context.mock.method(Agent.prototype, "createConnection", () => {
			connections++;
			return socket;
		});
		http.globalAgent = proxyAgent;
		let request: ClientRequest | undefined;
		try {
			request = httpRequest(pinnedPageRequestOptions(new URL("http://example.com/"), "8.8.8.8"));
			request.on("error", () => {});
			request.end();
			await turn();
			const generatedAgent = (request as ClientRequest & { agent: Agent & { options: Record<string, unknown> } }).agent;
			assert.notEqual(generatedAgent, proxyAgent);
			assert.equal(generatedAgent.options.proxyEnv, undefined);
			assert.equal(connections, 1);
		} finally {
			request?.destroy();
			socket.destroy();
			proxyAgent.destroy();
			http.globalAgent = originalAgent;
		}
	});

	it("enforces the header ceiling in Node rather than trusting parsed headers", async () => {
		const f = nativeParserFixture(
			`HTTP/1.1 200 OK\r\nX-Large: ${"a".repeat(PAGE_NETWORK_LIMITS.headerBytes)}\r\nContent-Length: 0\r\n\r\n`,
		);
		try {
			await assert.rejects(
				fetchPublicPage("http://example.com", undefined, { dependencies: f.dependencies }),
				/request failed/,
			);
			assert.equal(f.socket.destroyed, true);
		} finally {
			f.agent.destroy();
			f.socket.destroy();
		}
	});

	it("destroys the native socket when a chunked body exceeds the ceiling", async () => {
		const size = PAGE_NETWORK_LIMITS.bodyBytes + 1;
		const f = nativeParserFixture(
			`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${size.toString(16)}\r\n${"a".repeat(size)}\r\n0\r\n\r\n`,
		);
		try {
			await assert.rejects(
				fetchPublicPage("http://example.com", undefined, { dependencies: f.dependencies }),
				/size limit/,
			);
			assert.equal(f.socket.destroyed, true);
		} finally {
			f.agent.destroy();
			f.socket.destroy();
		}
	});

	it("reads a native chunked response and destroys its socket after completion", async () => {
		const f = nativeParserFixture(
			"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nTransfer-Encoding: chunked\r\n\r\n4\r\ntext\r\n0\r\n\r\n",
		);
		try {
			const result = await fetchPublicPage("http://example.com", undefined, { dependencies: f.dependencies });
			assert.equal(result.body.toString(), "text");
			assert.equal(result.downloadedBytes, 4);
			assert.equal(f.socket.destroyed, true);
		} finally {
			f.agent.destroy();
			f.socket.destroy();
		}
	});
});
