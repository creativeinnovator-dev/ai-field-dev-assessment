// Small HS256 JWT helper, didn't want to pull in a library just for this.
import { createHmac, timingSafeEqual } from "node:crypto";

export type Role = "admin" | "viewer";
export interface Claims {
  sub: string;
  role: Role;
  exp?: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export function signToken(claims: Claims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// returns null for anything invalid (bad format, wrong signature, expired, unknown role)
export function verifyToken(token: string, secret: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  try {
    // only accept HS256, otherwise alg=none tricks are possible
    if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (claims.role !== "admin" && claims.role !== "viewer") return null;
    if (typeof claims.exp === "number" && claims.exp * 1000 < Date.now()) return null;
    return claims as Claims;
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined): string | null {
  const m = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return m ? m[1] : null;
}
