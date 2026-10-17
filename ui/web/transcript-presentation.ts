import type { JsonDisplay, PartView, PresentationView } from '../shared/api.ts';

/** Revision zero has no deliberate disclosure choice. */
export function thinkingExpanded(presentation?: PresentationView): boolean {
  return !presentation || presentation.revision === 0 || presentation.showThinking;
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
