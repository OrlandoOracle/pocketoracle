/**
 * The ask-loop wire types. These mirror Claude Code's AskUserQuestion tool_input
 * (what the PreToolUse hook posts to the broker) and the broker's /po/pending
 * shape (what the plugin polls). Kept dependency-free so this file can be reasoned
 * about on its own.
 */

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskOption[];
}

/** One unanswered ask as returned by GET /po/pending. */
export interface PendingAsk {
  qid: string;
  questions: AskQuestion[];
  exp: number;
  ageMs: number;
}

/** answers[questionText] = the chosen label(s); multiSelect → comma-joined. */
export type Answers = Record<string, string>;
