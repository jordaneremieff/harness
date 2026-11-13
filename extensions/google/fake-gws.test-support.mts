import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarTools } from "./calendar.ts";
import { docsTools } from "./docs.ts";
import { driveTools } from "./drive.ts";
import { gmailTools } from "./gmail.ts";
import { GoogleRuntime, SCOPES } from "./gws.ts";
import { sheetsTools } from "./sheets.ts";
import { slidesTools } from "./slides.ts";
import { tasksTools } from "./tasks.ts";
import { invoke } from "./tools.ts";

export const ACCOUNT = "person@example.com";

/** A canned gws reply. `sentCopy` answers with the Sent copy of the last uploaded message. */
export type FakeResponse = {
	stdout?: unknown;
	stderr?: string;
	exit?: number;
	sleepMs?: number;
	output?: string;
	sentCopy?: boolean;
};

export type Scenario = {
	version?: string;
	user?: string;
	scopes?: string[];
	auth?: Record<string, unknown>;
	responses?: Record<string, FakeResponse | FakeResponse[]>;
};

export type FakeCall = {
	args: string[];
	cwd: string;
	env: Record<string, string>;
	upload?: string;
};

const FAKE_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
const args = process.argv.slice(2);
if (!dir) {
	process.stdout.write(args[0] === "--version" ? "gws 0.22.5\n" : "");
	process.exit(args[0] === "--version" ? 0 : 5);
}
const scenario = JSON.parse(fs.readFileSync(path.join(dir, "fake-scenario.json"), "utf8"));
const env = {};
for (const key of ["GOOGLE_WORKSPACE_CLI_CONFIG_DIR", "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND", "GOOGLE_APPLICATION_CREDENTIALS", "PI_TEST_MARKER", "PATH", "HOME"]) {
	if (process.env[key] !== undefined) env[key] = process.env[key];
}
const call = { args, cwd: process.cwd(), env };
const uploadAt = args.indexOf("--upload");
if (uploadAt >= 0) {
	call.upload = fs.readFileSync(args[uploadAt + 1], "utf8");
	const id = /^Message-ID: (.+)$/m.exec(call.upload);
	if (id) fs.writeFileSync(path.join(dir, "fake-sent-message-id"), id[1].trim());
}
fs.appendFileSync(path.join(dir, "fake-calls.jsonl"), JSON.stringify(call) + "\n");
if (args[0] === "--version") {
	process.stdout.write(scenario.version ?? "gws 0.22.5\n");
	process.exit(0);
}
const paramsAt = args.indexOf("--params");
const key = args[0] === "auth" ? "auth " + args[1] : args.slice(0, paramsAt).join(" ");
if (key === "auth status" && args.length > 2) {
	process.stdout.write(JSON.stringify({ error: { code: 400, message: "unexpected argument", reason: "validationError" } }));
	process.exit(3);
}
const params = paramsAt >= 0 ? JSON.parse(args[paramsAt + 1]) : {};
const responses = scenario.responses || {};
let response = responses[key + " " + (params.id || params.fileId || "")] || responses[key];
if (Array.isArray(response)) {
	const counterFile = path.join(dir, "fake-counter-" + key.replaceAll(" ", "_"));
	const index = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) : 0;
	fs.writeFileSync(counterFile, String(index + 1));
	response = response[Math.min(index, response.length - 1)];
}
if (!response && key === "auth status") {
	response = { stdout: Object.assign({
		storage: "encrypted", keyring_backend: "keyring", encrypted_credentials_exists: true, encryption_valid: true,
		has_refresh_token: true, token_valid: true, user: scenario.user || "person@example.com", scopes: scenario.scopes || [],
	}, scenario.auth || {}) };
}
if (!response && (key === "auth login" || key === "auth logout")) response = { stdout: "done" };
if (!response && key === "gmail users getProfile") response = { stdout: { emailAddress: scenario.user || "person@example.com" } };
if (!response) {
	process.stderr.write("no fake response for " + key);
	process.exit(5);
}
if (response.sentCopy) {
	const id = fs.readFileSync(path.join(dir, "fake-sent-message-id"), "utf8");
	response = { stdout: { id: "sent-1", threadId: "thread-1", labelIds: ["SENT"], payload: { headers: [{ name: "Message-ID", value: id }] } } };
}
const outputAt = args.indexOf("--output");
if (outputAt >= 0 && response.output !== undefined) fs.writeFileSync(args[outputAt + 1], response.output);
const finish = () => {
	if (response.stdout !== undefined) process.stdout.write(typeof response.stdout === "string" ? response.stdout : JSON.stringify(response.stdout));
	if (response.stderr) process.stderr.write(response.stderr);
	process.exit(response.exit ?? 0);
};
if (response.sleepMs) setTimeout(finish, response.sleepMs);
else finish();
`;

export type Fake = {
	root: string;
	agentDir: string;
	configDir: string;
	executable: string;
	env: Record<string, string>;
	runtime: GoogleRuntime;
	scenario(value: Scenario): Promise<void>;
	calls(): Promise<FakeCall[]>;
	tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
	cleanup(): Promise<void>;
};

export const ALL_SCOPES = Object.values(SCOPES);
const TOOLS = [
	...gmailTools,
	...driveTools,
	...sheetsTools,
	...calendarTools,
	...docsTools,
	...slidesTools,
	...tasksTools,
];

export async function createFake(scenario: Scenario = {}, extraEnv: Record<string, string> = {}): Promise<Fake> {
	const root = await mkdtemp(join(tmpdir(), "google-fake-"));
	const agentDir = join(root, "agent");
	const configDir = join(root, "gws-config");
	const home = join(root, "home");
	await Promise.all([mkdir(agentDir), mkdir(configDir), mkdir(home)]);
	await writeFile(join(configDir, "credentials.enc"), "encrypted");
	const executable = join(root, "gws");
	await writeFile(executable, `#!${process.execPath}\n${FAKE_SOURCE}`, { mode: 0o755 });
	const env = {
		HOME: home,
		PI_GOOGLE_EXECUTABLE: executable,
		PI_GOOGLE_CONFIG_DIR: configDir,
		PI_GOOGLE_EXPECTED_ACCOUNT: ACCOUNT,
		PI_HARNESS_FILE: join(root, "missing-harness.json"),
		PI_TEST_MARKER: "parent-only",
		...extraEnv,
	};
	const runtime = new GoogleRuntime(agentDir, env);
	const fake: Fake = {
		root,
		agentDir,
		configDir,
		executable,
		env,
		runtime,
		async scenario(value) {
			await writeFile(join(configDir, "fake-scenario.json"), JSON.stringify({ scopes: ALL_SCOPES, ...value }));
		},
		async calls() {
			const text = await readFile(join(configDir, "fake-calls.jsonl"), "utf8").catch(() => "");
			return text
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as FakeCall);
		},
		async tool(name, args) {
			const tool = TOOLS.find((item) => item.name === name);
			if (!tool) throw new Error(`Unknown tool ${name}`);
			const result = await invoke(tool, args, runtime);
			const first = result.content[0];
			if (first?.type !== "text") throw new Error("Expected text content");
			return JSON.parse(first.text) as Record<string, unknown>;
		},
		async cleanup() {
			await rm(root, { recursive: true, force: true });
		},
	};
	await fake.scenario(scenario);
	return fake;
}

export function methodCalls(calls: FakeCall[], method: string): FakeCall[] {
	const words = method.split(" ");
	return calls.filter((call) => words.every((word, index) => call.args[index] === word));
}

export function base64url(text: string): string {
	return Buffer.from(text, "utf8").toString("base64url");
}

export function errorCode(result: Record<string, unknown>): string | undefined {
	const error = result.error as { code?: string } | undefined;
	return error?.code;
}
