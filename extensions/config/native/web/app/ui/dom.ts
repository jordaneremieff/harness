export function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text?: string,
	cls?: string,
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	if (cls) node.className = cls;
	return node;
}
export function button(label: string, run: () => void, cls?: string): HTMLButtonElement {
	const node = el("button", label, cls);
	node.type = "button";
	node.addEventListener("click", run);
	return node;
}
export function id<T extends HTMLElement>(name: string): T {
	const node = document.getElementById(name);
	if (!node) throw new Error(`Missing page element: ${name}`);
	return node as T;
}
export function option(value: string, label: string): HTMLOptionElement {
	const node = el("option", label);
	node.value = value;
	return node;
}
export function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
