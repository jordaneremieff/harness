/** Supported browsers and the machine access levels that gate Apple Events to them. */

export const BROWSER_KEYS = ["chrome", "brave", "chrome-for-testing"] as const;
export type BrowserKey = (typeof BROWSER_KEYS)[number];

export const ACCESS_LEVELS = ["inspect", "interact"] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export interface BrowserSpec {
	readonly key: BrowserKey;
	readonly name: string;
	readonly bundleId: string;
}

/**
 * Each entry is a separate application with its own scripting dictionary, process,
 * profiles, and macOS Automation permission. No entry stands in for another.
 */
export const BROWSERS: Readonly<Record<BrowserKey, BrowserSpec>> = {
	chrome: { key: "chrome", name: "Google Chrome", bundleId: "com.google.Chrome" },
	brave: { key: "brave", name: "Brave Browser", bundleId: "com.brave.Browser" },
	"chrome-for-testing": {
		key: "chrome-for-testing",
		name: "Google Chrome for Testing",
		bundleId: "com.google.chrome.for.testing",
	},
};

export function isBrowserKey(value: unknown): value is BrowserKey {
	return typeof value === "string" && (BROWSER_KEYS as readonly string[]).includes(value);
}

export function isAccessLevel(value: unknown): value is AccessLevel {
	return typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value);
}

export type AccessMap = Partial<Record<BrowserKey, AccessLevel>>;

/** True when the configured level covers the required one. */
export function accessCovers(granted: AccessLevel | undefined, required: AccessLevel): boolean {
	if (!granted) return false;
	return required === "inspect" || granted === "interact";
}
