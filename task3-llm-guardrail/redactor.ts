// PII redaction for streamed text.
//
// The tricky part is that an email/card/ssn can be split across two chunks.
// Instead of holding back a fixed number of chars, we only hold back the end
// of the buffer that could still turn into a match. All patterns only use
// [A-Za-z0-9._%+-@] (plus a single space between card digit groups), so we
// walk back from the end until we hit a char that can't be part of any match.
// Everything before that point is safe to redact and send right away.
// For normal text that means we only hold the last partial word.

const PII_CHAR = /[A-Za-z0-9._%+\-@]/;
const DIGIT = /\d/;

// max email length is 254, so we never need to hold more than that
export const MAX_HOLD = 254;

export const REDACTED = "[REDACTED]";

function luhnValid(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl && (d *= 2) > 9) d -= 9;
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const PATTERNS: Array<{ name: string; re: RegExp; validate?: (m: string) => boolean }> = [
  { name: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { name: "ssn", re: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g },
  {
    name: "card",
    // 13-19 digits, can be grouped with spaces or dashes.
    // Luhn check so we don't redact random long numbers like order ids.
    re: /(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)/g,
    validate: (m) => luhnValid(m.replace(/\D/g, "")),
  },
];

export function redact(text: string): string {
  for (const { re, validate } of PATTERNS) {
    text = text.replace(re, (m) => (!validate || validate(m) ? REDACTED : m));
  }
  return text;
}

// index where the part we still need to hold back starts
function unsafeTailStart(buf: string): number {
  let i = buf.length;
  while (i > 0) {
    const c = buf[i - 1];
    if (PII_CHAR.test(c)) { i--; continue; }
    // a space after a digit could be inside a card number like "4111 1111 ..."
    if (c === " " && i >= 2 && DIGIT.test(buf[i - 2])) { i--; continue; }
    break;
  }
  return Math.max(i, buf.length - MAX_HOLD);
}

export class StreamRedactor {
  private buf = "";

  // returns whatever is safe to send now (can be empty)
  push(delta: string): string {
    this.buf += delta;
    const cut = unsafeTailStart(this.buf);
    if (cut === 0) return "";
    const safe = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return redact(safe);
  }

  // call at the end of the stream
  flush(): string {
    const out = redact(this.buf);
    this.buf = "";
    return out;
  }

  get pending(): number {
    return this.buf.length;
  }
}
