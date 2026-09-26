#!/usr/bin/env node
/**
 * po-broker — the ask-loop broker for PocketOracle (P1, polling model).
 *
 * The whole point of PocketOracle is: Claude Code asks a question, native
 * buttons appear on the iPad, Sebastian taps, the answer flows back, Claude
 * continues — all from a couch, no keyboard. This broker is the middle of that
 * loop.
 *
 * Flow (P1 uses POLLING, not the signed OSC doorbell — see the project's
 * CONTINUE.md "P1 SCOPING" decision):
 *
 *   Claude Code (tmux `main`, Mini)
 *     │ calls AskUserQuestion
 *     ▼
 *   PreToolUse hook  ask-device.sh   (matcher "AskUserQuestion")
 *     │ POST 127.0.0.1:7893/po/ask  {questions}    ── blocks ≤290 s
 *     ▼
 *   po-broker: store pending[qid]={questions,exp}, hold the response open
 *     ▲                                              │
 *     │ the plugin POLLs GET /po/pending  ───────────┘
 *     │ over the authenticated wss channel (Caddy :7890 → loopback :7893),
 *     │ renders the AskModal, and on a tap:
 *     │ POST /po/answer {qid, answers}   (first-wins)
 *     ▼
 *   po-broker resolves the held /po/ask response with {answers}
 *     ▼
 *   hook prints hookSpecificOutput.updatedInput.answers → Claude continues.
 *   Timeout (no tap in 290 s) → 408 → hook exits 0 → normal TUI selector.
 *
 * Security model for P1: the qid is an unguessable 128-bit token and answers
 * only ever arrive over the private, cert-authenticated, tailnet-ACL'd wss
 * channel. There is no OSC injection surface (that arrives with the signed
 * doorbell in P2). The broker itself binds LOOPBACK ONLY; the tailnet never
 * reaches :7893 directly (it is ACL-filtered) — only Caddy's /po/* proxy does.
 *
 * No dependencies: Node stdlib only (http, crypto). Runs under launchd as
 * com.orlandooracle.po-broker.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";

const HOST = "127.0.0.1";
const PORT = 7893;
const ASK_TTL_MS = 290_000; // just under the hook's 300 s PreToolUse budget
const MAX_BODY = 64 * 1024; // AskUserQuestion payloads are tiny; cap hostile input
// Presence: if no device has polled /po/pending within this window, treat "no
// device is watching" and answer /po/ask immediately so Claude Code falls back
// to the TUI selector instead of hanging for 5 minutes at the desk. This is the
// "it just works, forgotten" guard — the loop must never make the Mac-side
// experience worse when no iPad is around.
const PRESENCE_WINDOW_MS = 20_000;
const startedAt = Date.now();
let lastPollAt = 0; // ms epoch of the most recent /po/pending poll (any device)

/**
 * pending: qid -> {
 *   questions,          // the AskUserQuestion questions array (rendered on-device)
 *   createdAt, exp,     // ms epoch
 *   answered,           // bool
 *   answers,            // the resolved answers object once tapped
 *   send,               // (statusCode, jsonBody) => void  — resolves the held /po/ask
 *   timer,              // the TTL timeout handle
 * }
 */
const pending = new Map();

function log(...a) {
  // No PHI here — questions are Claude's prompts, not lead data — but keep it terse.
  console.log(new Date().toISOString(), ...a);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    // requestUrl (Obsidian) bypasses CORS, but keep these harmless for a browser
    // smoke-test from the same origin.
    "cache-control": "no-store",
  });
  res.end(body);
}

/** Drop a pending ask, clearing its timer. Optionally resolve its held response. */
function settle(qid, code, obj) {
  const p = pending.get(qid);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(qid);
  if (p.send) {
    try {
      p.send(code, obj);
    } catch {
      /* client already gone */
    }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const path = url.pathname;

  try {
    // --- health ------------------------------------------------------------
    if (req.method === "GET" && path === "/po/health") {
      // `present` mirrors the /po/ask presence gate: a device has polled
      // /po/pending within PRESENCE_WINDOW_MS, so a modal fired now will be
      // seen. The scheduled-modal launcher reads this to decide fire-vs-nudge
      // (see pocketoracle/scheduled/evening-modal.sh) — if no device is
      // watching it sends a text nudge instead of hanging a headless session.
      const lastPollAgoMs = lastPollAt ? Date.now() - lastPollAt : null;
      return sendJson(res, 200, {
        ok: true,
        pending: pending.size,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        lastPollAgoMs,
        present: lastPollAt > 0 && Date.now() - lastPollAt <= PRESENCE_WINDOW_MS,
        presenceWindowMs: PRESENCE_WINDOW_MS,
      });
    }

    // --- pending list (the plugin polls this) ------------------------------
    if (req.method === "GET" && path === "/po/pending") {
      lastPollAt = Date.now(); // presence heartbeat: a device is watching
      const now = Date.now();
      const items = [];
      for (const [qid, p] of pending) {
        if (p.answered) continue;
        items.push({ qid, questions: p.questions, exp: p.exp, ageMs: now - p.createdAt });
      }
      return sendJson(res, 200, { pending: items });
    }

    // --- ask (the hook posts here and blocks) ------------------------------
    if (req.method === "POST" && path === "/po/ask") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendJson(res, 400, { error: "invalid json" });
      }
      // The hook posts the AskUserQuestion tool_input, which has .questions.
      const questions = Array.isArray(body.questions) ? body.questions : null;
      if (!questions || questions.length === 0) {
        return sendJson(res, 400, { error: "no questions" });
      }
      // Presence gate: no device polling recently → don't hang the hook, fall
      // back to the TUI at once.
      if (Date.now() - lastPollAt > PRESENCE_WINDOW_MS) {
        log("ask skipped — no device present");
        return sendJson(res, 409, { error: "no-device" });
      }
      const qid = randomBytes(16).toString("hex"); // 128-bit unguessable
      const createdAt = Date.now();
      const exp = createdAt + ASK_TTL_MS;
      const entry = {
        questions,
        createdAt,
        exp,
        answered: false,
        answers: null,
        send: (code, obj) => sendJson(res, code, obj),
        timer: setTimeout(() => {
          // No tap in time → tell the hook to fall back to the TUI selector.
          log("ask timeout", qid);
          settle(qid, 408, { error: "timeout", qid });
        }, ASK_TTL_MS),
      };
      pending.set(qid, entry);
      // If the client disconnects (hook killed / Claude moved on), drop it.
      req.on("close", () => {
        const p = pending.get(qid);
        if (p && !p.answered) {
          clearTimeout(p.timer);
          pending.delete(qid);
          log("ask abandoned (client closed)", qid);
        }
      });
      log("ask", qid, `${questions.length}q`);
      return; // response is held open until settle()
    }

    // --- answer (the plugin posts a tap here) ------------------------------
    if (req.method === "POST" && path === "/po/answer") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return sendJson(res, 400, { error: "invalid json" });
      }
      const { qid, answers } = body;
      if (!qid || typeof answers !== "object" || answers === null) {
        return sendJson(res, 400, { error: "need {qid, answers}" });
      }
      const p = pending.get(qid);
      if (!p) {
        // Already answered, timed out, or never existed → first-wins loser.
        return sendJson(res, 410, { error: "gone", qid });
      }
      p.answered = true;
      p.answers = answers;
      // Resolve the held /po/ask with the answers the hook will inject.
      settle(qid, 200, { qid, answers });
      log("answer", qid);
      // Tell the tapping client it won.
      return sendJson(res, 200, { ok: true, qid });
    }

    // --- dismiss (client-driven cancel; optional) --------------------------
    if (req.method === "POST" && path === "/po/dismiss") {
      const raw = await readBody(req);
      let body = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        /* tolerate */
      }
      const qid = body.qid;
      if (qid && settle(qid, 409, { error: "dismissed", qid })) {
        log("dismiss", qid);
        return sendJson(res, 200, { ok: true, qid });
      }
      return sendJson(res, 410, { error: "gone" });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    log("ERR", path, e?.message || String(e));
    if (!res.headersSent) sendJson(res, 500, { error: "internal" });
  }
});

server.listen(PORT, HOST, () => {
  log(`po-broker listening on http://${HOST}:${PORT} (loopback only)`);
});

// Graceful shutdown: resolve any held asks so hooks don't hang on restart.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    log(`${sig} — draining ${pending.size} pending`);
    for (const qid of [...pending.keys()]) settle(qid, 503, { error: "broker restarting" });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
  });
}
