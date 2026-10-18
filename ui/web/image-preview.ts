import type { ImageView } from '../shared/api.ts';
import { button, element, setText } from './dom.ts';
import { imageCaption } from './image.ts';

/** The dialog surface the preview needs; the application's modal provides it. */
export type ImagePreviewHost = {
  open(title: string, cancel?: () => void, closed?: () => void, variant?: 'image'): HTMLElement;
  restoreFocus(node: HTMLElement): void;
  close(): void;
  readonly token: number;
  owns(token: number): boolean;
};
type Mode = 'fit' | 'actual';

/**
 * Shows one supplied image from its already validated URL in the dialog, fitted to the view or
 * at natural pixel size. At most one preview exists; its image element is removed and its source
 * cleared when the dialog closes or another dialog replaces it. The returned function closes this
 * preview only while it still owns the dialog.
 */
export function openImagePreview(host: ImagePreviewHost, part: ImageView, url: string, invoker: HTMLElement): () => void {
  let image: HTMLImageElement | undefined, disposed = false;
  const body = host.open('Image preview', undefined, () => dispose(), 'image');
  const token = host.token;
  host.restoreFocus(invoker);
  const root = element('div', 'image-preview image-preview-fit');
  const info = element('p', 'image-preview-info', imageCaption(part));
  const sizes = element('div', 'image-preview-sizes'); sizes.setAttribute('role', 'group'); sizes.setAttribute('aria-label', 'Image size');
  const fit = button('Fit', () => choose('fit')), actual = button('Actual size', () => choose('actual'));
  sizes.append(fit, actual);
  const status = element('p', 'image-preview-status'); status.setAttribute('role', 'status');
  const viewport = element('div', 'image-preview-viewport'); viewport.tabIndex = 0; viewport.setAttribute('role', 'region'); viewport.setAttribute('aria-label', 'Image preview');
  const reload = button('Reload image', () => load()); reload.hidden = true;
  const controls = element('div', 'image-preview-controls'); controls.append(info, sizes);
  root.append(controls, status, reload, viewport);
  body.append(root);
  function choose(mode: Mode): void {
    root.className = `image-preview image-preview-${mode}`;
    fit.setAttribute('aria-pressed', String(mode === 'fit')); actual.setAttribute('aria-pressed', String(mode === 'actual'));
  }
  function clear(): void {
    const previous = image; image = undefined;
    if (previous) { previous.removeAttribute('src'); previous.remove(); }
  }
  function load(): void {
    clear(); reload.hidden = true; setText(status, 'Loading image…');
    const attempt = element('img', 'image-preview-content'); image = attempt;
    attempt.alt = part.alt; attempt.decoding = 'async'; attempt.referrerPolicy = 'no-referrer';
    attempt.addEventListener('load', () => {
      if (disposed || image !== attempt) return;
      const differs = attempt.naturalWidth > 0 && (attempt.naturalWidth !== part.width || attempt.naturalHeight !== part.height);
      setText(status, ''); setText(info, differs ? `${imageCaption(part)} · loaded ${attempt.naturalWidth} × ${attempt.naturalHeight}` : imageCaption(part));
    });
    attempt.addEventListener('error', () => {
      if (disposed || image !== attempt) return;
      clear(); setText(status, 'The image could not be loaded.'); reload.hidden = false;
    });
    viewport.append(attempt); attempt.src = url;
  }
  function dispose(): void {
    if (disposed) return;
    disposed = true; clear();
  }
  choose('fit'); load();
  return () => { if (!disposed && host.owns(token)) host.close(); };
}
