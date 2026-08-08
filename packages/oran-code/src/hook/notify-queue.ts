import type { HookNotice, HookNoticeSink } from "./types.js";

export class HookNoticeQueue implements HookNoticeSink {
  private readonly items: HookNotice[] = [];

  append(notice: HookNotice): void {
    this.items.push(notice);
  }

  drain(): HookNotice[] {
    const snapshot = this.items.splice(0, this.items.length);
    return snapshot;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
  }
}
