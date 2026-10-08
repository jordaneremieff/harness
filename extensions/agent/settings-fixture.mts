export function machineConfig(section: { presets: unknown; preferences?: unknown }) {
	return {
		version: 1,
		agent: {
			presets: section.presets,
			...(section.preferences === undefined ? {} : { preferences: section.preferences }),
		},
	};
}
