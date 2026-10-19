import type { JsonDisplay, PartView, PresentationView } from '../shared/api.ts';

/** Finished thinking is closed to one line until the reader opens it. Only a saved Show thinking choice expands it; a stored showThinking flag without that choice is a copied default, not a decision. */
export function thinkingExpanded(presentation?: PresentationView): boolean {
  return presentation?.thinking === 'shown';
}

export type PresentationContext = {
  bounded(text: string, limit?: number): string;
  rawText(value: unknown): string;
  inspection(title: string, source: () => string): HTMLDetailsElement;
  structured(display: JsonDisplay): HTMLElement;
};
export type ToolPresentationSource = {
  callId: string; name: string; args?: JsonDisplay; result?: PartView[]; status: string;
  argumentText?: string; duration?: number;
};
