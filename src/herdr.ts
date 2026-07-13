// Minimal client for the herdr socket API.
// Protocol: newline-delimited JSON over a unix socket, ONE request per
// connection — except events.subscribe, which keeps streaming event lines.

import net from "node:net";
import path from "node:path";
import os from "node:os";

export class HerdrApiError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrApiError";
    this.code = code;
  }
}

function socketPath(): string {
  const p = process.env.HERDR_SOCKET_PATH;
  if (p && p.trim()) return p.trim();
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(config, "herdr", "herdr.sock");
}

let reqSeq = 0;

export function request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `wb:${process.pid}:${++reqSeq}`;
    const sock = net.createConnection(socketPath());
    let buf = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };
    sock.setTimeout(15_000, () => finish(() => reject(new Error(`herdr: timeout on ${method}`))));
    sock.on("error", (err) => finish(() => reject(err)));
    sock.on("close", () => finish(() => reject(new Error(`herdr: connection closed during ${method}`))));
    sock.on("connect", () => {
      sock.write(JSON.stringify({ id, method, params }) + "\n");
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      finish(() => {
        try {
          const msg = JSON.parse(line);
          if (msg.error) reject(new HerdrApiError(msg.error.code ?? "unknown", msg.error.message ?? "herdr error"));
          else resolve(msg.result as T);
        } catch (err) {
          reject(err as Error);
        }
      });
    });
  });
}

export interface HerdrEvent {
  event: string;
  data: any;
}

export interface EventStream {
  close(): void;
}

/**
 * Long-lived event subscription on its own connection. `onDown` fires once
 * when the stream dies for any reason other than an explicit close().
 */
export function subscribe(
  subscriptions: Array<Record<string, unknown>>,
  onEvent: (ev: HerdrEvent) => void,
  onDown: (err?: Error) => void,
): EventStream {
  const sock = net.createConnection(socketPath());
  let buf = "";
  let acked = false;
  let done = false;
  const down = (err?: Error) => {
    if (done) return;
    done = true;
    sock.destroy();
    onDown(err);
  };
  sock.on("connect", () => {
    sock.write(JSON.stringify({ id: `wb:sub:${process.pid}`, method: "events.subscribe", params: { subscriptions } }) + "\n");
  });
  sock.on("error", (err) => down(err));
  sock.on("close", () => down());
  sock.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!acked) {
        acked = true;
        if (msg.error) down(new HerdrApiError(msg.error.code ?? "unknown", msg.error.message ?? "subscribe failed"));
        continue;
      }
      if (msg.event && !done) onEvent(msg as HerdrEvent);
    }
  });
  return {
    close() {
      done = true;
      sock.destroy();
    },
  };
}
