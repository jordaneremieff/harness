import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { cleanGitEnvironment } from "../scripts/worktrees.mts";

const execute = promisify(execFile);
const coveragePath = "docs/pi-durable-harness.md";

async function readPublicationBody(body: ReadableStream<Uint8Array>): Promise<unknown> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 64_000) throw new Error("Publication exceeds byte bound.");
			chunks.push(chunk.value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicationVersion(value: unknown): string {
	if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string") {
		throw new Error("Invalid publication version.");
	}
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version))
		throw new Error("Invalid publication version.");
	return value.version;
}

/** Check only the two defining package publications; no install or review marker mutation. */
export async function inspectPublishedUpstream(fetcher: typeof fetch = fetch) {
	const read = async (name: string) => {
		const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`;
		try {
			const response = await fetcher(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
			if (!response.ok || !response.body) throw new Error("Publication unavailable.");
			const value = await readPublicationBody(response.body);
			return { name, url, state: "available" as const, version: publicationVersion(value) };
		} catch {
			return { name, url, state: "unavailable" as const };
		}
	};
	const packages = await Promise.all([read("@earendil-works/pi-coding-agent"), read("@earendil-works/pi-durable")]);
	return { observedAt: new Date().toISOString(), packages };
}

/** Published coverage is evidence, not the version installed in another process. */
export async function inspectUpstream(options: { cwd: string }) {
	const observedAt = new Date().toISOString();
	const host = { version: VERSION, packageDir: getPackageDir() };
	const git = async (args: string[]) =>
		(
			await execute("git", ["-C", options.cwd, ...args], {
				timeout: 5000,
				maxBuffer: 128_000,
				encoding: "utf8",
				env: cleanGitEnvironment(process.env),
			})
		).stdout.trim();
	try {
		const main = await git(["rev-parse", "--verify", "refs/heads/main^{commit}"]);
		const upstream = await git(["rev-parse", "--verify", "main@{upstream}^{commit}"]);
		const commit = await git(["merge-base", main, upstream]);
		if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid coverage commit.");
		const document = await git(["show", `${commit}:${coveragePath}`]);
		const markers = document.split(/\r?\n/).filter((line) => line.includes("pi-release-reviewed-through:"));
		const match =
			markers.length === 1 && /^<!-- pi-release-reviewed-through: (\d+\.\d+\.\d+|unknown) -->$/.exec(markers[0]);
		if (!match || match[1] === "unknown") throw new Error("Published release coverage is unknown.");
		return {
			observedAt,
			host,
			coverage: { state: "declared" as const, reviewedThrough: match[1], commit, path: coveragePath },
			intakeOwner: "extensions/evo/README.md#release-intake",
			latestPublished: "not-queried" as const,
		};
	} catch {
		return {
			observedAt,
			host,
			coverage: {
				state: "unavailable" as const,
				path: coveragePath,
				reason: "Published baseline unavailable; recover it through release intake.",
			},
			intakeOwner: "extensions/evo/README.md#release-intake",
			latestPublished: "not-queried" as const,
		};
	}
}
