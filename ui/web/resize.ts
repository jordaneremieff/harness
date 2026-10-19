export type ResizerOptions = {
  handle: HTMLElement;
  axis: 'x' | 'y';
  min: number;
  max: number;
  defaultValue: number;
  /** Negative for a pane whose handle is on its top or left edge. */
  direction?: 1 | -1;
  label?: string;
  /** Leave an automatically sized pane unchanged until user input. */
  applyInitial?: boolean;
  /** Pointer movement in pixels before a press counts as a drag; a press and release below it changes and commits nothing. Default 0. */
  dragThreshold?: number;
  /** Override numeric reset, for example to restore automatic editor growth. */
  onReset?: () => void;
  read: () => number;
  /** Write only the pane's CSS custom property here, without layout reads. */
  write: (value: number) => void;
  onCommit: (value: number) => void;
};
export type Resizer = {
  readonly value: number;
  /** Apply an external value, except while the user drags the handle. */
  refresh: () => void;
  destroy: () => void;
};

const activeDrags = new WeakMap<HTMLElement, number>();

/** Pointer and keyboard resizing with one visual write per animation frame. */
export function createResizer(options: ResizerOptions): Resizer {
  const {handle, axis, min, max, defaultValue, read, write, onCommit} = options;
  if (![min, max, defaultValue].every(Number.isSafeInteger) || min > max) throw new RangeError('Invalid resize bounds');
  const view = handle.ownerDocument.defaultView;
  if (!view) throw new Error('The resize handle requires a window');
  const root = handle.ownerDocument.documentElement;
  const dragging = (active: boolean): void => {
    const count = (activeDrags.get(root) ?? 0) + (active ? 1 : -1);
    activeDrags.set(root, count);
    root.classList.toggle('resizing', count > 0);
    if (active) handle.setAttribute('data-dragging', 'true');
    else handle.removeAttribute('data-dragging');
  };
  const direction = options.direction ?? 1;
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(Number.isFinite(next) ? next : defaultValue)));
  const initialSize = read();
  let value = clamp(initialSize);
  let frame: number | undefined;
  let resetFrame: number | undefined;
  let painted: number | undefined;
  let destroyed = false;
  let drag: {id: number; origin: number; value: number; engaged: boolean} | undefined;
  const threshold = Math.max(0, options.dragThreshold ?? 0);
  const coordinate = (event: PointerEvent): number => axis === 'x' ? event.clientX : event.clientY;
  const aria = (measured?: number): void => {
    handle.setAttribute('aria-valuenow', String(value));
    if (measured !== undefined && Number.isFinite(measured) && measured >= 0) handle.setAttribute('aria-valuetext', `${Math.round(measured)} pixels`);
    else handle.removeAttribute('aria-valuetext');
  };
  const cancelReset = (): void => {
    if (resetFrame !== undefined) view.cancelAnimationFrame(resetFrame);
    resetFrame = undefined;
  };
  const schedule = (next: number): void => {
    cancelReset(); value = clamp(next); aria();
    if (frame !== undefined || value === painted) return;
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (value !== painted) { write(value); painted = value; }
    });
  };
  handle.tabIndex = 0;
  handle.setAttribute('data-axis', axis);
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
  handle.setAttribute('aria-label', options.label ?? handle.getAttribute('aria-label') ?? 'Resize pane');
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  const previousTouchAction = handle.style.touchAction;
  handle.style.touchAction = 'none';
  if (options.applyInitial !== false) schedule(value);
  else aria(initialSize);

  const down = (event: PointerEvent): void => {
    if (drag || !event.isPrimary || event.button !== 0) return;
    cancelReset(); handle.setPointerCapture(event.pointerId);
    event.preventDefault(); handle.focus({preventScroll: true});
    value = clamp(read()); aria();
    drag = {id: event.pointerId, origin: coordinate(event), value, engaged: threshold === 0};
    dragging(true);
  };
  const move = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return;
    event.preventDefault();
    const travelled = coordinate(event) - drag.origin;
    if (!drag.engaged && Math.abs(travelled) >= threshold) drag.engaged = true;
    if (drag.engaged) schedule(drag.value + direction * travelled);
  };
  const finish = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.id) return;
    if (event.type === 'pointerup') move(event);
    const id = drag.id, moved = drag.engaged; drag = undefined;
    dragging(false);
    if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
    if (moved) onCommit(value);
  };
  const reset = (event: Event): void => {
    if (drag || destroyed) return;
    event.preventDefault(); cancelReset();
    if (options.onReset) {
      if (frame !== undefined) view.cancelAnimationFrame(frame); frame = undefined;
      painted = undefined; options.onReset();
      resetFrame = view.requestAnimationFrame(() => {
        resetFrame = undefined;
        const measured = read(); value = clamp(measured); aria(measured);
      });
    } else { schedule(defaultValue); onCommit(value); }
  };
  const resetKey = (event: KeyboardEvent): boolean => {
    if (event.key !== 'Enter' && event.key !== ' ') return false;
    if (event.shiftKey) return true;
    event.preventDefault(); if (!event.repeat) reset(event);
    return true;
  };
  const decreaseKey = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
  const increaseKey = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
  const key = (event: KeyboardEvent): void => {
    if (drag || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    if (resetKey(event)) return;
    if (![decreaseKey, increaseKey, 'Home', 'End'].includes(event.key)) return;
    if (frame === undefined) { value = clamp(read()); aria(); }
    const step = event.shiftKey ? 64 : 16;
    const values: Record<string, number> = {Home: min, End: max, [decreaseKey]: value - direction * step, [increaseKey]: value + direction * step};
    event.preventDefault();
    const next = values[event.key];
    if (next === undefined || clamp(next) === value) return;
    schedule(next); onCommit(value);
  };
  handle.addEventListener('pointerdown', down);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);
  handle.addEventListener('lostpointercapture', finish);
  handle.addEventListener('keydown', key);
  handle.addEventListener('dblclick', reset);
  return {
    get value() { return value; },
    refresh() { if (!destroyed && !drag) schedule(read()); },
    destroy() {
      if (destroyed) return; destroyed = true;
      if (frame !== undefined) view.cancelAnimationFrame(frame); frame = undefined;
      cancelReset();
      const id = drag?.id; drag = undefined;
      if (id !== undefined && handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
      if (id !== undefined) dragging(false);
      handle.style.touchAction = previousTouchAction;
      handle.removeEventListener('pointerdown', down);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      handle.removeEventListener('lostpointercapture', finish);
      handle.removeEventListener('keydown', key);
      handle.removeEventListener('dblclick', reset);
    },
  };
}
