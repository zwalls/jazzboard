export type WebMcpToolActivitySnapshot = {
  active: boolean;
  count: number;
  toolNames: readonly string[];
};

export type WebMcpToolActivityRelease = (immediate?: boolean) => void;

const INACTIVE_SNAPSHOT: WebMcpToolActivitySnapshot = {
  active: false,
  count: 0,
  toolNames: [],
};

/**
 * Tracks real, browser-local WebMCP executions without publishing room presence.
 * A short visual settle keeps fast calls perceptible without delaying their result.
 */
export class LocalWebMcpToolActivityTracker {
  private readonly tokens = new Map<number, string>();
  private nextToken = 1;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private snapshot: WebMcpToolActivitySnapshot = INACTIVE_SNAPSHOT;

  constructor(
    private readonly onChange: (snapshot: WebMcpToolActivitySnapshot) => void,
    private readonly settleMs = 160,
  ) {}

  /** Reopens the tracker when a React effect is remounted in development. */
  activate(): void {
    this.disposed = false;
  }

  begin(toolName: string): WebMcpToolActivityRelease {
    if (this.disposed) return () => undefined;
    this.clearSettleTimer();
    const token = this.nextToken++;
    this.tokens.set(token, toolName);
    this.publish(true);
    let released = false;
    return (immediate = false) => {
      if (released) return;
      released = true;
      if (this.disposed || !this.tokens.delete(token)) return;
      if (this.tokens.size) {
        this.publish(true);
        return;
      }
      if (immediate || this.settleMs <= 0) {
        this.publish(false);
        return;
      }
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        if (!this.disposed && this.tokens.size === 0) this.publish(false);
      }, this.settleMs);
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearSettleTimer();
    this.tokens.clear();
    this.publish(false);
  }

  private clearSettleTimer(): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private publish(active: boolean): void {
    const next = active
      ? {
          active: true,
          count: this.tokens.size,
          toolNames: [...new Set(this.tokens.values())],
        }
      : INACTIVE_SNAPSHOT;
    if (
      next.active === this.snapshot.active
      && next.count === this.snapshot.count
      && next.toolNames.length === this.snapshot.toolNames.length
      && next.toolNames.every((name, index) => name === this.snapshot.toolNames[index])
    ) return;
    this.snapshot = next;
    this.onChange(next);
  }
}
