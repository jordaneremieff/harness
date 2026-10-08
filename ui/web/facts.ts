import { details, setText } from './dom.ts';
/** Keyed reported facts keep disclosure state and focus through observation updates. */
export function renderFacts(root: HTMLElement, facts: readonly {key: string; label: string; text: string}[]): void {
  const present = new Set(facts.map(fact => fact.key));
  for (const child of [...root.children]) if (!present.has((child as HTMLElement).dataset.key ?? '')) child.remove();
  for (const fact of facts) {
    let node = [...root.children].find(child => (child as HTMLElement).dataset.key === fact.key) as HTMLDetailsElement | undefined;
    if (!node) {node = details(fact.label, fact.text); node.dataset.key = fact.key; root.append(node);}
    const summary = node.querySelector('summary'); const body = node.querySelector('pre');
    if (summary) setText(summary, fact.label); if (body) setText(body, fact.text);
  }
}
