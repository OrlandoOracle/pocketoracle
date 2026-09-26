/**
 * Minimal ttyd websocket client (protocol as of ttyd 1.7.x).
 *
 * Why hand-roll instead of loading ttyd's own HTML in an iframe: an iframe on
 * ttyd is cross-origin, so we could never theme the terminal, drive a command
 * palette into it, or write its output back to the vault. Speaking the raw WS
 * protocol keeps the xterm.js instance ours — that is the whole point of the
 * greenfield route (PLAN Phase 2/3/4).
 *
 * ttyd wire format (verified against ttyd 1.7.7 on the Mini):
 *   subprotocol: "tty", binaryType: arraybuffer
 *   on open, client sends the INIT message = raw JSON bytes (NO command prefix):
 *       {"AuthToken": "<cred or ''>", "columns": C, "rows": R}
 *   thereafter every message's first byte is a command char:
 *     client -> server:  '0'=INPUT(data)  '1'=RESIZE({columns,rows})  '2'=PAUSE  '3'=RESUME
 *     server -> client:  '0'=OUTPUT(raw bytes)  '1'=SET_WINDOW_TITLE(utf8)  '2'=SET_PREFERENCES(json)
 *   ttyd >=1.7 sends OUTPUT as raw bytes (not base64), so we hand the Uint8Array
 *   straight to xterm's write(), which accepts Uint8Array.
 */

const CMD_INPUT = "0";
const CMD_RESIZE = "1";

const SRV_OUTPUT = 0x30; // '0'
const SRV_TITLE = 0x31; // '1'
const SRV_PREFS = 0x32; // '2'

export interface TtydHandlers {
  onOutput: (bytes: Uint8Array) => void;
  onTitle?: (title: string) => void;
  onPrefs?: (prefs: unknown) => void;
  onOpen?: () => void;
  onClose?: (ev: CloseEvent) => void;
  onError?: (ev: Event) => void;
}

export class TtydClient {
  private ws: WebSocket | null = null;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();
  private opened = false;

  constructor(
    private readonly url: string,
    private readonly authToken: string,
    private readonly handlers: TtydHandlers,
  ) {}

  /** Connect and send the init handshake with the terminal's starting size. */
  connect(cols: number, rows: number): void {
    // ttyd registers exactly one WS subprotocol: "tty". Passing it is required —
    // libwebsockets rejects the upgrade otherwise.
    const ws = new WebSocket(this.url, ["tty"]);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.opened = true;
      const init = JSON.stringify({ AuthToken: this.authToken || "", columns: cols, rows: rows });
      ws.send(this.enc.encode(init));
      this.handlers.onOpen?.();
    };

    ws.onmessage = (ev: MessageEvent) => {
      const buf = ev.data as ArrayBuffer;
      if (!(buf instanceof ArrayBuffer) || buf.byteLength === 0) return;
      const all = new Uint8Array(buf);
      const cmd = all[0];
      const payload = all.subarray(1);
      switch (cmd) {
        case SRV_OUTPUT:
          this.handlers.onOutput(payload);
          break;
        case SRV_TITLE:
          this.handlers.onTitle?.(this.dec.decode(payload));
          break;
        case SRV_PREFS:
          try {
            this.handlers.onPrefs?.(JSON.parse(this.dec.decode(payload)));
          } catch {
            /* ttyd sends {} when no client prefs; ignore parse noise */
          }
          break;
        default:
          break;
      }
    };

    ws.onclose = (ev) => {
      this.opened = false;
      this.handlers.onClose?.(ev);
    };
    ws.onerror = (ev) => this.handlers.onError?.(ev);
  }

  /** Send user keystrokes. */
  sendInput(data: string): void {
    if (!this.opened || !this.ws) return;
    const body = this.enc.encode(data);
    const msg = new Uint8Array(body.length + 1);
    msg[0] = CMD_INPUT.charCodeAt(0);
    msg.set(body, 1);
    this.ws.send(msg);
  }

  /** Tell the far tmux/pty the new window size. */
  sendResize(cols: number, rows: number): void {
    if (!this.opened || !this.ws) return;
    const body = this.enc.encode(JSON.stringify({ columns: cols, rows: rows }));
    const msg = new Uint8Array(body.length + 1);
    msg[0] = CMD_RESIZE.charCodeAt(0);
    msg.set(body, 1);
    this.ws.send(msg);
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Raw socket state — lets the view detect a zombie/half-open socket that
   *  never fired onclose (the iOS-backgrounding blank-pane failure mode). */
  get readyState(): number {
    return this.ws?.readyState ?? WebSocket.CLOSED;
  }

  /** Bytes queued but not yet flushed. If this climbs across heartbeats and
   *  never drains, the underlying TCP is dead even if readyState says OPEN. */
  get bufferedAmount(): number {
    return this.ws?.bufferedAmount ?? 0;
  }

  /** Harmless keepalive / liveness probe: re-assert the current size. ttyd
   *  accepts a RESIZE anytime and never echoes, so it can't corrupt the pty. */
  probe(cols: number, rows: number): void {
    this.sendResize(cols, rows);
  }

  close(): void {
    this.opened = false;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    // Detach handlers BEFORE closing. ws.close() fires onclose asynchronously,
    // a tick later — by then forceReconnect/scheduleReconnect have already made
    // a fresh socket, so a still-attached onclose would call handlers.onClose →
    // scheduleReconnect → tear down the NEW socket. That is the disconnect/
    // reconnect loop. Nulling the handlers makes our own teardown silent; only a
    // genuine remote drop reaches onClose now.
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
}
