import type { JsonDisplay, PartView } from '../shared/api.ts';

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
