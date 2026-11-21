import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import { getSubjectAdapter } from "../evals/adapters.mts";
import { loadSuite } from "../evals/core.mts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("the maintained tldr behavior suite satisfies the evaluation and adapter contracts", async () => {
	const { suite, path } = await loadSuite(join(repositoryRoot, "prompts", "tldr.eval.mts"));
	const adapter = getSubjectAdapter(suite.subject.adapter);
	adapter.validate?.({
		suitePath: path,
		subjectKind: suite.subject.kind,
		subjectConfig: suite.subject.config,
		cases: suite.cases,
	});
	assert.equal(suite.adjudication.policy, "human-required");
});

it("the package discovers only maintained prompt commands without other resources", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-discovery-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory({
				packages: [{ source: repositoryRoot, extensions: [], skills: [], themes: [] }],
			}),
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { prompts, diagnostics } = loader.getPrompts();
		assert.deepEqual(diagnostics, []);
		assert.deepEqual(
			prompts.map((prompt) => prompt.name),
			["tldr"],
		);
		for (const prompt of prompts) {
			assert.equal(prompt.filePath, join(repositoryRoot, "prompts", `${prompt.name}.md`));
			assert.ok(prompt.description.trim());
			assert.ok(prompt.content.trim());
			assert.ok(!prompt.content.startsWith("---"));
		}
		assert.equal(prompts.find((prompt) => prompt.name === "tldr")?.argumentHint, "[focus, scope, or length]");
		assert.deepEqual(loader.getExtensions().extensions, []);
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.deepEqual(loader.getSkills().skills, []);
		assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("a tldr candidate expands optional focus, scope, form, and action text through Pi", async () => {
	const root = await mkdtemp(join(tmpdir(), "tldr-candidate-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			additionalPromptTemplatePaths: [join(repositoryRoot, "prompts", "tldr.md")],
			noPromptTemplates: true,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const { prompts, diagnostics } = loader.getPrompts();
		assert.deepEqual(diagnostics, []);
		assert.deepEqual(
			prompts.map((prompt) => prompt.name),
			["tldr"],
		);
		const tldr = prompts[0];
		assert.ok(tldr);
		assert.equal(tldr.filePath, join(repositoryRoot, "prompts", "tldr.md"));
		assert.equal(tldr.description, "Summarize the current discussion in a few plain sentences");
		assert.equal(tldr.argumentHint, "[focus, scope, or length]");
		assert.ok(tldr.content.includes("Optional hint:\n$ARGUMENTS\n"));

		const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const promptTemplatesUrl = pathToFileURL(join(dirname(packageEntry), "core", "prompt-templates.js"));
		const { expandPromptTemplate } = (await import(promptTemplatesUrl.href)) as {
			expandPromptTemplate: (text: string, templates: Array<{ name: string; content: string }>) => string;
		};
		for (const [invocation, hint] of [
			["/tldr", ""],
			["/tldr why did it fail?", "why did it fail?"],
			["/tldr whole session", "whole session"],
			["/tldr since I left", "since I left"],
			["/tldr one line", "one line"],
			['/tldr "more detail" on the result', "more detail on the result"],
			["/tldr the fix, then push it", "the fix, then push it"],
			['/tldr "literal $1 and $ARGUMENTS"', "literal $1 and $ARGUMENTS"],
		]) {
			assert.equal(
				expandPromptTemplate(invocation, prompts),
				tldr.content.replace("$ARGUMENTS", () => hint),
			);
			assert.equal(expandPromptTemplate(invocation, [{ name: "tldr", content: "tldr $ARGUMENTS" }]), `tldr ${hint}`);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
