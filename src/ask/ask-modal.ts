import { App, Modal } from "obsidian";
import type { AskQuestion, Answers } from "./types";

/**
 * The native tap-to-answer surface — the heart of PocketOracle's reason to exist.
 *
 * Claude Code asks (via AskUserQuestion → the PreToolUse hook → the broker), and
 * this modal paints readable cards + big tappable buttons on whatever device has
 * the pane open (iPad first). A tap flows the answer back through the broker and
 * Claude continues. No keyboard, no typing into the pty.
 *
 * Design rules (from the osc-modal-arch research 2026-09-26):
 *  - settle-once Promise; onClose counts as cancel so a swipe-dismiss is honest.
 *  - full-width buttons, ≥64 px tall, scaled for a visually-impaired reader.
 *  - single question + single-select → tapping an option submits immediately
 *    (the common fast path). Otherwise collect selections and show a Submit.
 *  - "Type…" reveals a textarea (free-text / "Other") without covering the
 *    buttons — the keyboard only rises when the user asks for it.
 *  - the modal never writes to the pty; the answer leaves via HTTPS.
 */

export type AskResult =
  | { kind: "answered"; answers: Answers }
  | { kind: "cancel" }
  | { kind: "timeout" };

export class AskModal extends Modal {
  readonly qid: string;
  private questions: AskQuestion[];
  private settleFn!: (r: AskResult) => void;
  private done: boolean;
  private timer: number | null;
  private ttlMs: number;

  /** Per-question current selection. Single: one label. Multi: a Set of labels. */
  private selection: Map<number, Set<string>>;
  /** Per-question free-text value when the "Type…" path is used. */
  private typed: Map<number, string>;
  private submitBtn: HTMLButtonElement | null;

  readonly result: Promise<AskResult>;

  // NB: every field is assigned here in the constructor body — NOT via class-field
  // initializers. esbuild (target es2018) emitted the initializers as *native*
  // class fields, and the iOS Obsidian WebView does not run subclass field
  // initializers (AskModal extends Obsidian's Modal), leaving this.selection
  // undefined → a blank modal on the iPad. Constructor assignment always runs.
  constructor(app: App, qid: string, questions: AskQuestion[], ttlMs: number) {
    super(app);
    this.qid = qid;
    this.questions = questions;
    this.ttlMs = ttlMs;
    this.done = false;
    this.timer = null;
    this.selection = new Map<number, Set<string>>();
    this.typed = new Map<number, string>();
    this.submitBtn = null;
    this.result = new Promise<AskResult>((res) => (this.settleFn = res));
  }

  private finish(r: AskResult): void {
    if (this.done) return;
    this.done = true;
    if (this.timer != null) window.clearTimeout(this.timer);
    this.settleFn(r);
    this.close();
  }

  /** Called by the loop when another device answered first, or it timed out. */
  supersede(reason: "answered" | "timeout"): void {
    this.finish(reason === "timeout" ? { kind: "timeout" } : { kind: "cancel" });
  }

  private get singleFast(): boolean {
    return this.questions.length === 1 && !this.questions[0].multiSelect;
  }

  private buildAnswers(): Answers {
    const out: Answers = {};
    this.questions.forEach((q, i) => {
      const t = this.typed.get(i);
      if (t && t.trim()) {
        out[q.question] = t.trim();
        return;
      }
      const sel = this.selection.get(i);
      if (sel && sel.size) out[q.question] = [...sel].join(", ");
    });
    return out;
  }

  private everyAnswered(): boolean {
    return this.questions.every((q, i) => {
      const t = this.typed.get(i);
      if (t && t.trim()) return true;
      const sel = this.selection.get(i);
      return !!sel && sel.size > 0;
    });
  }

  private refreshSubmit(): void {
    if (this.submitBtn) this.submitBtn.disabled = !this.everyAnswered();
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    // Initialize the answer maps HERE, in the same method that reads them, rather
    // than relying on constructor/class-field init. On the iOS Obsidian WebView
    // this.selection was arriving undefined at onOpen despite a constructor
    // assignment (Modal-subclass + esbuild interaction we couldn't pin down) —
    // assigning immediately before use is immune to whatever happens between
    // construction and open().
    this.selection = new Map<number, Set<string>>();
    this.typed = new Map<number, string>();
    modalEl.addClass("po-ask");
    contentEl.empty();
    contentEl.addClass("po-ask-content");

    contentEl.createEl("div", { cls: "po-ask-brand", text: "◆ Oracle · Claude is asking" });

    // Instrumentation (0.4.1): a blank modal below the brand means the render
    // aborted. Surface the shape we actually received + any thrown error inline,
    // so a header-only card on the iPad becomes a readable diagnosis, not a guess.
    const qs = this.questions;
    if (!Array.isArray(qs) || qs.length === 0) {
      contentEl.createEl("div", {
        cls: "po-ask-error",
        text: `no questions to render (got: ${Object.prototype.toString.call(qs)})`,
      });
    }

    try {
      (Array.isArray(qs) ? qs : []).forEach((q, qi) => {
      this.selection.set(qi, new Set());
      const section = contentEl.createDiv({ cls: "po-ask-q" });
      if (q.header) section.createEl("div", { cls: "po-ask-header", text: q.header });
      section.createEl("div", { cls: "po-ask-question", text: q.question });

      const opts = section.createDiv({ cls: "po-ask-options" });
      q.options.forEach((opt, oi) => {
        const btn = opts.createEl("button", { cls: "po-ask-option" });
        // --i drives the staggered glide-in cascade (LG signature motion).
        btn.style.setProperty("--i", String(oi));
        btn.createEl("div", { cls: "po-ask-num", text: String(oi + 1) });
        btn.createEl("div", { cls: "po-ask-option-label", text: opt.label });
        if (opt.description) {
          btn.createEl("div", { cls: "po-ask-option-desc", text: opt.description });
        }
        // The ✓ is painted always but hidden by CSS until .is-selected/.confirming.
        btn.createEl("div", { cls: "po-ask-check", text: "✓" });
        btn.addEventListener("click", () => this.onOptionTap(qi, q, opt.label, btn, opts));
      });

      // "Type or dictate your own" free-text escape hatch (maps to an "Other"
      // answer; iOS dictation rides the keyboard mic once the textarea focuses).
      const typeRow = section.createDiv({ cls: "po-ask-typerow" });
      const typeBtn = typeRow.createEl("button", {
        cls: "po-ask-type",
        text: "Type or dictate your own",
      });
      typeBtn.addEventListener("click", () => {
        if (section.querySelector("textarea")) return;
        const ta = section.createEl("textarea", { cls: "po-ask-textarea" });
        ta.placeholder = "Type or dictate your answer…";
        ta.addEventListener("input", () => {
          this.typed.set(qi, ta.value);
          // Typing supersedes button selection for this question.
          this.selection.get(qi)?.clear();
          opts.querySelectorAll(".po-ask-option.is-selected").forEach((e) =>
            e.removeClass("is-selected"),
          );
          this.refreshSubmit();
        });
        // Focus inside the tap handler so iOS raises the keyboard.
        ta.focus();
      });
      });
    } catch (err) {
      contentEl.createEl("div", {
        cls: "po-ask-error",
        text: `render error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    // Submit / Cancel row. In the single-select fast path there is no Submit —
    // the option tap itself submits.
    const actions = contentEl.createDiv({ cls: "po-ask-actions" });
    if (!this.singleFast) {
      const submit = actions.createEl("button", { cls: "po-ask-submit", text: "Submit" });
      submit.disabled = true;
      submit.addEventListener("click", () => {
        if (this.everyAnswered()) this.finish({ kind: "answered", answers: this.buildAnswers() });
      });
      this.submitBtn = submit;
    }
    const cancel = actions.createEl("button", { cls: "po-ask-cancel", text: "Cancel" });
    cancel.addEventListener("click", () => this.finish({ kind: "cancel" }));

    // Auto-timeout mirrors the broker's TTL so the modal never lingers as a
    // ghost after Claude has already fallen back to the TUI.
    this.timer = window.setTimeout(() => this.finish({ kind: "timeout" }), this.ttlMs);
  }

  private onOptionTap(
    qi: number,
    q: AskQuestion,
    label: string,
    btn: HTMLButtonElement,
    opts: HTMLElement,
  ): void {
    // A tapped option clears any typed value for that question.
    this.typed.delete(qi);
    const sel = this.selection.get(qi)!;
    if (q.multiSelect) {
      if (sel.has(label)) {
        sel.delete(label);
        btn.removeClass("is-selected");
      } else {
        sel.add(label);
        btn.addClass("is-selected");
      }
      this.refreshSubmit();
      return;
    }
    // Single-select: exactly one.
    sel.clear();
    sel.add(label);
    opts.querySelectorAll(".po-ask-option.is-selected").forEach((e) => e.removeClass("is-selected"));
    btn.addClass("is-selected");
    if (this.singleFast) {
      // Fast path: play the gold tap-flourish, then submit. The brief delay lets
      // the pop/flash/beat land so choosing "feels satisfying" (the /ask ruling:
      // full LG motion + brief highlight then close).
      this.flourish(btn);
      window.setTimeout(() => this.finish({ kind: "answered", answers: this.buildAnswers() }), 240);
    } else {
      this.refreshSubmit();
    }
  }

  /** Gold tap-confirm flourish: pop/flash the chosen card + a center ring-pulse
   *  beat spawned on <body> (survives the modal close, self-removes). */
  private flourish(btn: HTMLButtonElement): void {
    btn.addClass("confirming");
    const beat = document.body.createDiv({ cls: "po-ask-beat" });
    window.setTimeout(() => beat.remove(), 500);
  }

  onClose(): void {
    this.contentEl.empty();
    // A dismiss with nothing chosen is a cancel (settle-once guards double-fire).
    this.finish({ kind: "cancel" });
  }
}
