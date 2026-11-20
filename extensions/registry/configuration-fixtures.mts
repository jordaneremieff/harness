import type { Declaration, SettingsBus, SettingsPublication } from "./configuration-protocol.ts";

export function withDeclaration(input: SettingsPublication, fields: Declaration["fields"]): SettingsPublication {
	const declaration = { slice: input.slice, fields };
	return { ...input, declaration };
}

export function publication(): SettingsPublication {
	const declaration: Declaration = {
		slice: "example",
		fields: {
			count: {
				type: "integer",
				env: "PI_EXAMPLE_COUNT",
				description: "A bounded count.",
				default: 2,
				min: 1,
				max: 20,
				apply: "use",
			},
			token: {
				type: "string",
				env: "PI_EXAMPLE_TOKEN",
				description: "An environment-only secret.",
				secret: true,
				apply: "reload",
			},
		},
	};
	return {
		version: 2,
		slice: "example",
		declaration,
		source: { path: "/fixtures/harness.json", status: "missing", digest: null, observedAt: "2026-01-01T00:00:00.000Z" },
		records: [
			{
				name: "example.count",
				key: "count",
				type: "integer",
				description: "A bounded count.",
				env: "PI_EXAMPLE_COUNT",
				secret: false,
				origin: "default",
				status: "valid",
				value: 2,
			},
			{
				name: "example.token",
				key: "token",
				type: "string",
				description: "An environment-only secret.",
				env: "PI_EXAMPLE_TOKEN",
				secret: true,
				origin: "default",
				status: "unset",
				secretState: "unset",
			},
		],
		diagnostics: [],
	};
}

/** A protocol publisher supplies data only; it owns no settings reader. */
export function fakePublisher(bus: SettingsBus, current: () => SettingsPublication): () => void {
	const emit = () => bus.emit("harness:settings:publish", structuredClone(current()));
	const dispose = bus.on("harness:settings:request", (request) => {
		if (request !== null && typeof request === "object" && "version" in request && request.version === 2) emit();
	});
	emit();
	return dispose;
}
