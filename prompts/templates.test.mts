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

it("maintained prompt behavior suites satisfy the evaluation and adapter contracts", async () => {
	for (const name of ["drift", "seed", "wtf"]) {
		const { suite, path } = await loadSuite(join(repositoryRoot, "prompts", `${name}.eval.mts`));
		const adapter = getSubjectAdapter(suite.subject.adapter);
		adapter.validate?.({
			suitePath: path,
			subjectKind: suite.subject.kind,
			subjectConfig: suite.subject.config,
			cases: suite.cases,
		});
		assert.equal(suite.adjudication.policy, "human-required");
	}
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
		assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["drift", "seed", "wtf"]);
		for (const prompt of prompts) {
			assert.equal(prompt.filePath, join(repositoryRoot, "prompts", `${prompt.name}.md`));
			assert.ok(prompt.description.trim());
			assert.ok(prompt.content.trim());
			assert.ok(!prompt.content.startsWith("---"));
		}
		assert.equal(prompts.find((prompt) => prompt.name === "wtf")?.argumentHint, "[your account of the problem]");
		assert.equal(prompts.find((prompt) => prompt.name === "seed")?.argumentHint, "[your hint for the brief]");
		assert.deepEqual(loader.getExtensions().extensions, []);
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.deepEqual(loader.getSkills().skills, []);
		assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("an explicit candidate prompt load does not discover global or package copies", async () => {
	const root = await mkdtemp(join(tmpdir(), "prompt-candidate-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			additionalPromptTemplatePaths: [join(repositoryRoot, "prompts", "wtf.md")],
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
			["wtf"],
		);
		assert.equal(prompts[0]?.filePath, join(repositoryRoot, "prompts", "wtf.md"));
		assert.ok(prompts[0]?.content.includes("## Select the target"));
		assert.ok(prompts[0]?.content.includes("## The operator's account\n\n$ARGUMENTS"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it("a seed candidate expands its optional hint through Pi's argument substitution", async () => {
	const root = await mkdtemp(join(tmpdir(), "seed-candidate-"));
	try {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: join(root, "agent"),
			settingsManager: SettingsManager.inMemory(),
			additionalPromptTemplatePaths: [join(repositoryRoot, "prompts", "seed.md")],
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
			["seed"],
		);
		const seed = prompts.find((prompt) => prompt.name === "seed");
		assert.ok(seed);
		assert.ok(seed.content.includes("## Select the work\n\n$ARGUMENTS"));

		const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const promptTemplatesUrl = pathToFileURL(join(dirname(packageEntry), "core", "prompt-templates.js"));
		const { expandPromptTemplate } = (await import(promptTemplatesUrl.href)) as {
			expandPromptTemplate: (text: string, templates: Array<{ name: string; content: string }>) => string;
		};

		const withHint = expandPromptTemplate("/seed reset the parser frame", [seed]);
		assert.ok(withHint.includes("## Select the work\n\nreset the parser frame"));
		assert.ok(!withHint.includes("$ARGUMENTS"));

		const quoted = expandPromptTemplate('/seed "continue the auth work"', [seed]);
		assert.ok(quoted.includes("## Select the work\n\ncontinue the auth work"));

		const withoutHint = expandPromptTemplate("/seed", [seed]);
		assert.ok(withoutHint.includes("## Select the work\n\n"));
		assert.ok(!withoutHint.includes("$ARGUMENTS"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
