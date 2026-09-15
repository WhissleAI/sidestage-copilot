// eBay tokens at rest.
//
// A refresh token is eighteen months of "act as this seller on eBay". It used
// to sit in Postgres as text. It is now sealed with AES-256-GCM under
// EBAY_TOKEN_KEY (32 bytes, hex); a row written before the key existed is
// still readable, and a process with no key stores plaintext and says so once,
// because a development database with no key is a real state and a crash is
// not the right answer to it.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "enc:v1:";
let warned = false;

function key(): Buffer | null {
  const hex = (process.env.EBAY_TOKEN_KEY || "").trim();
  if (!hex) {
    if (!warned) {
      warned = true;
      console.warn("  ebay: EBAY_TOKEN_KEY is not set — seller tokens are stored in plaintext");
    }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("EBAY_TOKEN_KEY must be 32 bytes as 64 hex characters");
  return Buffer.from(hex, "hex");
}

export function sealToken(plain: string | null | undefined): string | null {
  if (plain == null) return null;
  const k = key();
  if (!k) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `${PREFIX}${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export function openToken(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!stored.startsWith(PREFIX)) return stored; // written before the key existed
  const k = key();
  if (!k) throw new Error("a sealed eBay token cannot be read without EBAY_TOKEN_KEY");
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(":");
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(iv!, "base64"));
  d.setAuthTag(Buffer.from(tag!, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct!, "base64")), d.final()]).toString("utf8");
}
