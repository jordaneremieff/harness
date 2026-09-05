import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

import { getSubjectAdapter } from "../evals/adapters.mts";
import { loadSuite } from "../evals/core.mts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

it("maintained prompt behavior suites satisfy the evaluation and adapter contracts", async () => {
	for (const name of ["drift", "wtf"]) {
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
		assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["drift", "wtf"]);
		for (const prompt of prompts) {
			assert.equal(prompt.filePath, join(repositoryRoot, "prompts", `${prompt.name}.md`));
			assert.ok(prompt.description.trim());
			assert.ok(prompt.content.trim());
			assert.ok(!prompt.content.startsWith("---"));
		}
		assert.equal(prompts.find((prompt) => prompt.name === "wtf")?.argumentHint, "[your account of the problem]");
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
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
