// Terminal primitives: a styled cell buffer, width-aware text (CJK safe),
// box drawing, and a stateful input parser for keys, SGR mouse events, and
// bracketed paste. Zero dependencies; full repaint per frame inside a
// synchronized-output block.

export const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  inverse: "\x1b[7m",
  text: "\x1b[38;5;252m",
  dim: "\x1b[38;5;245m",
  faint: "\x1b[38;5;240m",
  border: "\x1b[38;5;238m",
  accent: "\x1b[38;5;75m",
  accentBold: "\x1b[1;38;5;75m",
  green: "\x1b[38;5;41m",
  amber: "\x1b[38;5;179m",
  red: "\x1b[38;5;167m",
  blue: "\x1b[38;5;68m",
  gray: "\x1b[38;5;245m",
  lilac: "\x1b[38;5;140m",
  headerBg: "\x1b[48;5;236m",
};

const hasBunWidth = typeof Bun !== "undefined" && typeof Bun.stringWidth === "function";

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (hasBunWidth) return Bun.stringWidth(ch);
  // fallback: common wide ranges (CJK, Hangul, fullwidth forms, emoji)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function strWidth(s: string): number {
  if (hasBunWidth) return Bun.stringWidth(s);
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

/** Truncate to a display width, appending an ellipsis when cut. */
export function truncate(s: string, maxW: number): string {
  if (maxW <= 0) return "";
  if (strWidth(s) <= maxW) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > maxW - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

interface Cell {
  ch: string; // "" marks the continuation half of a wide char
  style: string;
  wide: boolean; // true on the lead cell of a wide char
}

export class Screen {
  readonly w: number;
  readonly h: number;
  private cells: Cell[];

  constructor(w: number, h: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.cells = new Array(this.w * this.h);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = { ch: " ", style: "", wide: false };
  }

  private idx(x: number, y: number): number {
    return y * this.w + x;
  }

  /**
   * Write one cell. Overwriting either half of an existing wide char blanks
   * the surviving half so a row never renders with a dangling lead or
   * continuation (which would shift everything after it).
   */
  set(x: number, y: number, ch: string, style: string, wide = false): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const cell = this.cells[this.idx(x, y)];
    if (cell.ch === "" && x > 0) {
      const lead = this.cells[this.idx(x - 1, y)];
      if (lead.wide) {
        lead.ch = " ";
        lead.wide = false;
      }
    }
    if (cell.wide && x + 1 < this.w) {
      const cont = this.cells[this.idx(x + 1, y)];
      if (cont.ch === "") {
        cont.ch = " ";
        cont.wide = false;
      }
    }
    cell.ch = ch;
    cell.style = style;
    cell.wide = wide;
  }

  /** Write text starting at (x,y), clipped to maxW display columns. */
  text(x: number, y: number, s: string, style: string, maxW?: number): number {
    const limit = maxW === undefined ? this.w - x : Math.min(maxW, this.w - x);
    let cx = 0;
    for (const ch of s) {
      const cw = charWidth(ch);
      if (cw === 0) continue;
      if (cx + cw > limit) break;
      if (cw === 2) {
        this.set(x + cx, y, ch, style, true);
        this.set(x + cx + 1, y, "", style);
      } else {
        this.set(x + cx, y, ch, style);
      }
      cx += cw;
    }
    return cx;
  }

  fill(x: number, y: number, w: number, h: number, ch: string, style: string): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) this.set(xx, yy, ch, style);
    }
  }

  hline(x: number, y: number, w: number, style: string, ch = "─"): void {
    for (let i = 0; i < w; i++) this.set(x + i, y, ch, style);
  }

  box(x: number, y: number, w: number, h: number, style: string): void {
    if (w < 2 || h < 2) return;
    this.set(x, y, "╭", style);
    this.set(x + w - 1, y, "╮", style);
    this.set(x, y + h - 1, "╰", style);
    this.set(x + w - 1, y + h - 1, "╯", style);
    this.hline(x + 1, y, w - 2, style);
    this.hline(x + 1, y + h - 1, w - 2, style);
    for (let yy = y + 1; yy < y + h - 1; yy++) {
      this.set(x, yy, "│", style);
      this.set(x + w - 1, yy, "│", style);
    }
  }

  render(): string {
    let out = "\x1b[?2026h\x1b[H";
    for (let y = 0; y < this.h; y++) {
      let style = "\0";
      for (let x = 0; x < this.w; x++) {
        const cell = this.cells[this.idx(x, y)];
        if (cell.ch === "") continue; // wide-char continuation
        if (cell.style !== style) {
          out += SGR.reset + cell.style;
          style = cell.style;
        }
        out += cell.ch;
      }
      out += SGR.reset;
      if (y < this.h - 1) out += "\r\n";
    }
    return out + "\x1b[?2026l";
  }
}

export function fmtAge(sinceMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// ---- input parsing ----

export type KeyName =
  | "up" | "down" | "left" | "right"
  | "enter" | "esc" | "backspace" | "tab" | "delete"
  | "home" | "end" | "pgup" | "pgdn"
  | "ctrl-c" | "ctrl-u" | "ctrl-w";

export type InputEvent =
  | { type: "char"; ch: string }
  | { type: "key"; name: KeyName }
  | { type: "paste"; text: string }
  | { type: "mouse"; kind: "press" | "release" | "drag" | "wheel-up" | "wheel-down"; x: number; y: number; button: number };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Stateful parser: escape sequences, bracketed pastes, and surrogate pairs
 * split across stdin chunks are carried over to the next feed() instead of
 * being misparsed. If a chunk ends in a bare ESC, the caller should invoke
 * flushEscape() after a short delay to surface a genuine Esc key press.
 */
export class InputParser {
  private pending = "";
  private pasting: string | null = null;

  feed(data: string): InputEvent[] {
    const out: InputEvent[] = [];
    let buf = this.pending + data;
    this.pending = "";

    if (this.pasting !== null) {
      const end = buf.indexOf(PASTE_END);
      if (end < 0) {
        // Keep a tail in `pending` (prepended next feed) so a PASTE_END split
        // across chunks is still found; the rest is confirmed paste content.
        const keep = Math.max(0, buf.length - (PASTE_END.length - 1));
        this.pasting += buf.slice(0, keep);
        this.pending = buf.slice(keep);
        return out;
      }
      out.push({ type: "paste", text: this.pasting + buf.slice(0, end) });
      this.pasting = null;
      buf = buf.slice(end + PASTE_END.length);
    }

    let i = 0;
    const n = buf.length;
    while (i < n) {
      const ch = buf[i];
      if (ch === "\x1b") {
        if (i + 1 >= n) {
          this.pending = buf.slice(i); // bare ESC at chunk end — wait for more
          break;
        }
        if (buf[i + 1] === "[") {
          let j = i + 2;
          while (j < n && !/[a-zA-Z~]/.test(buf[j])) j++;
          if (j >= n) {
            this.pending = buf.slice(i); // incomplete CSI — carry over
            break;
          }
          const body = buf.slice(i + 2, j);
          const final = buf[j];
          i = j + 1;
          if (body === "200" && final === "~") {
            // bracketed paste start
            const end = buf.indexOf(PASTE_END, i);
            if (end < 0) {
              this.pasting = "";
              this.pending = "";
              // reuse the mid-paste carry logic for the tail
              const rest = buf.slice(i);
              const keep = Math.max(0, rest.length - (PASTE_END.length - 1));
              this.pasting = rest.slice(0, keep);
              this.pending = rest.slice(keep);
              return out;
            }
            out.push({ type: "paste", text: buf.slice(i, end) });
            i = end + PASTE_END.length;
            continue;
          }
          if (body.startsWith("<")) {
            // SGR mouse: ESC [ < b ; x ; y (M|m)
            const [b, x, y] = body.slice(1).split(";").map((v) => parseInt(v, 10));
            if (!Number.isFinite(b) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (b >= 128) continue; // extended buttons (back/forward…) — ignore
            if (b & 64) {
              const dir = b & 3;
              if (dir === 0) out.push({ type: "mouse", kind: "wheel-up", x: x - 1, y: y - 1, button: -1 });
              else if (dir === 1) out.push({ type: "mouse", kind: "wheel-down", x: x - 1, y: y - 1, button: -1 });
              // wheel-left/right (2/3): ignore
            } else if (b & 32) {
              out.push({ type: "mouse", kind: "drag", x: x - 1, y: y - 1, button: b & 3 });
            } else {
              out.push({ type: "mouse", kind: final === "M" ? "press" : "release", x: x - 1, y: y - 1, button: b & 3 });
            }
            continue;
          }
          switch (final) {
            case "A": out.push({ type: "key", name: "up" }); break;
            case "B": out.push({ type: "key", name: "down" }); break;
            case "C": out.push({ type: "key", name: "right" }); break;
            case "D": out.push({ type: "key", name: "left" }); break;
            case "H": out.push({ type: "key", name: "home" }); break;
            case "F": out.push({ type: "key", name: "end" }); break;
            case "~":
              if (body === "3") out.push({ type: "key", name: "delete" });
              else if (body === "5") out.push({ type: "key", name: "pgup" });
              else if (body === "6") out.push({ type: "key", name: "pgdn" });
              else if (body === "1" || body === "7") out.push({ type: "key", name: "home" });
              else if (body === "4" || body === "8") out.push({ type: "key", name: "end" });
              break;
          }
          continue;
        }
        // ESC followed by something that isn't CSI: treat as Esc, reprocess next char
        out.push({ type: "key", name: "esc" });
        i += 1;
        continue;
      }
      i += 1;
      switch (ch) {
        case "\x03": out.push({ type: "key", name: "ctrl-c" }); break;
        case "\r": case "\n": out.push({ type: "key", name: "enter" }); break;
        case "\x7f": case "\b": out.push({ type: "key", name: "backspace" }); break;
        case "\t": out.push({ type: "key", name: "tab" }); break;
        case "\x15": out.push({ type: "key", name: "ctrl-u" }); break;
        case "\x17": out.push({ type: "key", name: "ctrl-w" }); break;
        default: {
          const code = ch.charCodeAt(0);
          if (code >= 0xd800 && code <= 0xdbff) {
            if (i >= n) {
              this.pending = ch; // lone high surrogate at chunk end
              break;
            }
            out.push({ type: "char", ch: ch + buf[i] });
            i += 1;
          } else if (ch >= " " || code > 0x7f) {
            out.push({ type: "char", ch });
          }
        }
      }
    }
    return out;
  }

  /** True when the carry buffer holds exactly a bare ESC (outside a paste). */
  hasPendingEscape(): boolean {
    return this.pasting === null && this.pending === "\x1b";
  }

  /** Surface a bare ESC that never grew into a sequence (call after ~40ms). */
  flushEscape(): InputEvent[] {
    if (!this.hasPendingEscape()) return [];
    this.pending = "";
    return [{ type: "key", name: "esc" }];
  }
}
