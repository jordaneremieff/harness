type Slot = {latest?: () => Promise<void>; running?: Promise<void>};
/** View writes serialize by target and coalesce only edits not yet dispatched. */
export class PreferenceQueue {
  private slots = new Map<string, Slot>();
  save(key: string, write: () => Promise<void>): Promise<void> {
    let slot = this.slots.get(key);
    if (!slot) {slot = {}; this.slots.set(key, slot);}
    slot.latest = write;
    if (slot.running) return slot.running;
    const captured = slot;
    captured.running = Promise.resolve().then(async () => {
      try {
        while (captured.latest) {const next = captured.latest; captured.latest = undefined; await next();}
      } finally {this.slots.delete(key);}
    });
    return captured.running;
  }
}
