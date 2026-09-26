import { App, requestUrl } from "obsidian";
import { AskModal } from "./ask-modal";
import type { PendingAsk, Answers } from "./types";

/**
 * The client half of the ask-loop. Polls the broker's /po/pending over the same
 * authenticated wss front the terminal uses (Caddy :7890 → loopback :7893),
 * pops an AskModal for each new pending ask, and POSTs the tap back to
 * /po/answer. First-wins across devices: whoever answers first wins; the broker
 * 410s the losers and this loop closes their modal on the next poll.
 *
 * P1 uses polling, not the signed OSC doorbell (see CONTINUE.md "P1 SCOPING").
 * That keeps the whole delivery path on HTTPS — no terminal-injection surface —
 * and the visibilitychange kick directly fixes the iOS-backgrounding trust-killer
 * (a socket that went zombie while the app was backgrounded would silently miss
 * a doorbell; a fresh poll on resume cannot).
 */
export class AskLoop {
  private app: App;
  private brokerBase: string; // e.g. https://mac-mini.tail1fd1c8.ts.net:7890/po
  private ttlMs: number;
  private pollMs: number;
  private timer: number | null = null;
  private polling = false;
  private stopped = false;
  private modals = new Map<string, AskModal>();
  private onVisibility = (): void => {
    if (document.visibilityState === "visible") void this.pollOnce();
  };

  constructor(app: App, brokerBase: string, opts: { ttlMs: number; pollMs: number }) {
    this.app = app;
    this.brokerBase = brokerBase.replace(/\/$/, "");
    this.ttlMs = opts.ttlMs;
    this.pollMs = opts.pollMs;
  }

  start(): void {
    if (this.timer != null) return;
    this.stopped = false;
    document.addEventListener("visibilitychange", this.onVisibility);
    const tick = (): void => {
      void this.pollOnce();
      this.timer = window.setTimeout(tick, this.pollMs);
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
    document.removeEventListener("visibilitychange", this.onVisibility);
    for (const m of this.modals.values()) m.supersede("timeout");
    this.modals.clear();
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const res = await requestUrl({
        url: `${this.brokerBase}/pending`,
        method: "GET",
        throw: false,
      });
      if (res.status !== 200) return;
      const pending: PendingAsk[] = res.json?.pending ?? [];
      const live = new Set(pending.map((p) => p.qid));

      // Close any modal whose ask is no longer pending (answered elsewhere / TTL).
      for (const [qid, modal] of [...this.modals]) {
        if (!live.has(qid)) {
          modal.supersede("timeout");
          this.modals.delete(qid);
        }
      }

      // Open a modal for each new pending ask.
      for (const ask of pending) {
        if (this.modals.has(ask.qid)) continue;
        this.openModal(ask);
      }
    } catch {
      /* transient network — the next tick retries */
    } finally {
      this.polling = false;
    }
  }

  private openModal(ask: PendingAsk): void {
    // Clamp the modal TTL to the ask's remaining life so it never outlives it.
    const remaining = Math.max(5_000, Math.min(this.ttlMs, ask.exp - Date.now()));
    const modal = new AskModal(this.app, ask.qid, ask.questions, remaining);
    this.modals.set(ask.qid, modal);
    modal.open();
    void modal.result.then((r) => {
      this.modals.delete(ask.qid);
      if (r.kind === "answered") void this.postAnswer(ask.qid, r.answers);
      // cancel/timeout: leave it pending on the broker — another device (or a
      // later poll here) can still answer, or the broker TTL will 408 the hook.
    });
  }

  private async postAnswer(qid: string, answers: Answers): Promise<void> {
    try {
      await requestUrl({
        url: `${this.brokerBase}/answer`,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qid, answers }),
        throw: false,
      });
      // 200 = we won; 410 = someone else won first. Either way we're done.
    } catch {
      /* the tap was lost to the network — the ask stays pending, poll continues */
    }
  }
}

/**
 * Derive the broker base URL from the ttyd wss URL when the user hasn't set an
 * explicit one. wss://host:7890/ws → https://host:7890/po
 */
export function deriveBrokerBase(wsUrl: string): string {
  try {
    const u = new URL(wsUrl);
    const proto = u.protocol === "wss:" ? "https:" : "http:";
    return `${proto}//${u.host}/po`;
  } catch {
    return "";
  }
}
