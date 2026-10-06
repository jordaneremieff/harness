/**
 * agent/installation-binding: resolve this extension's Pi package imports from
 * the caller's Pi installation inside a storage host process.
 *
 * In a primary session, Pi's extension loader resolves the extension's imports
 * of the packages Pi supplies to extensions to the running installation. A
 * storage host is a plain Node process, so without this binding the same
 * imports resolve from the extension checkout's own `node_modules`. That copy
 * may be absent, because the repository declares these packages as peers, or
 * it may hold another release than the caller runs.
 *
 * The binding registers one synchronous resolve hook. It sends each import of
 * a peer package, or of one of its subpaths, from a module under `sourceRoot`
 * to ordinary Node resolution from the installation's package root. Package
 * `exports` and the `node_modules` lookup of that installation still apply.
 * Imports from other modules, including installed dependencies, stay
 * unchanged. Register the binding once per process, before the first import
 * of a module that imports a peer package.
 */
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** The packages this repository declares as peers: the Pi installation supplies them, never the checkout. */
export const INSTALLATION_PACKAGES: readonly string[] = Object.freeze([
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
	"typebox",
]);

/** True for a bare specifier that names a peer package or one of its subpaths. */
export function isInstallationImport(specifier: string): boolean {
	return INSTALLATION_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/**
 * Resolve peer package imports from modules under `sourceRoot` against the Pi
 * installation at `packageDir`, the root directory of its coding agent package.
 */
export function bindInstallationPackages(packageDir: string, sourceRoot: URL): void {
	const installation = pathToFileURL(join(packageDir, "package.json")).href;
	const scope = sourceRoot.href.endsWith("/") ? sourceRoot.href : `${sourceRoot.href}/`;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (!isInstallationImport(specifier) || context.parentURL?.startsWith(scope) !== true) return nextResolve(specifier, context);
			return nextResolve(specifier, { ...context, parentURL: installation });
		},
	});
}
