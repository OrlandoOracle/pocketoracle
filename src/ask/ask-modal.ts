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
  private done = false;
  private timer: number | null = null;
  private ttlMs: number;

  /** Per-question current selection. Single: one label. Multi: a Set of labels. */
  private selection = new Map<number, Set<string>>();
  /** Per-question free-text value when the "Type…" path is used. */
  private typed = new Map<number, string>();
  private submitBtn: HTMLButtonElement | null = null;

  readonly result: Promise<AskResult>;

  constructor(app: App, qid: string, questions: AskQuestion[], ttlMs: number) {
    super(app);
    this.qid = qid;
    this.questions = questions;
    this.ttlMs = ttlMs;
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
    modalEl.addClass("po-ask");
    contentEl.empty();
    contentEl.addClass("po-ask-content");

    contentEl.createEl("div", { cls: "po-ask-brand", text: "◆ Oracle · Claude is asking" });

    this.questions.forEach((q, qi) => {
      this.selection.set(qi, new Set());
      const section = contentEl.createDiv({ cls: "po-ask-q" });
      if (q.header) section.createEl("div", { cls: "po-ask-header", text: q.header });
      section.createEl("div", { cls: "po-ask-question", text: q.question });

      const opts = section.createDiv({ cls: "po-ask-options" });
      for (const opt of q.options) {
        const btn = opts.createEl("button", { cls: "po-ask-option" });
        btn.createEl("div", { cls: "po-ask-option-label", text: opt.label });
        if (opt.description) {
          btn.createEl("div", { cls: "po-ask-option-desc", text: opt.description });
        }
        btn.addEventListener("click", () => this.onOptionTap(qi, q, opt.label, btn, opts));
      }

      // "Type…" free-text escape hatch (maps to an "Other" answer).
      const typeRow = section.createDiv({ cls: "po-ask-typerow" });
      const typeBtn = typeRow.createEl("button", { cls: "po-ask-type", text: "Type…" });
      typeBtn.addEventListener("click", () => {
        if (section.querySelector("textarea")) return;
        const ta = section.createEl("textarea", { cls: "po-ask-textarea" });
        ta.placeholder = "Type an answer…";
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
      // Fast path: submit on the tap.
      this.finish({ kind: "answered", answers: this.buildAnswers() });
    } else {
      this.refreshSubmit();
    }
  }

  onClose(): void {
    this.contentEl.empty();
    // A dismiss with nothing chosen is a cancel (settle-once guards double-fire).
    this.finish({ kind: "cancel" });
  }
}
