/** The gws release this extension is built and tested against, with SHA-256 digests of the published macOS archives. */
export const GWS_VERSION = "0.22.5";

export type ReleaseAsset = { name: string; sha256: string };
export type Release = { version: string; assets: Readonly<Record<string, ReleaseAsset>> };

export const GWS_RELEASE: Release = {
	version: GWS_VERSION,
	assets: {
		"darwin-arm64": {
			name: "google-workspace-cli-aarch64-apple-darwin.tar.gz",
			sha256: "1d2a9ffd5bc9b2c2c4b48630daf082fad13d9e57d741988a2c248eed562f7dac",
		},
		"darwin-x64": {
			name: "google-workspace-cli-x86_64-apple-darwin.tar.gz",
			sha256: "51f9bd731404d4bba26c36e2e30dd68c56dccd1f834c01252cb0b14d6a6544b2",
		},
	},
};

export function releaseUrl(version: string, asset: string): string {
	return `https://github.com/googleworkspace/cli/releases/download/v${version}/${asset}`;
}
