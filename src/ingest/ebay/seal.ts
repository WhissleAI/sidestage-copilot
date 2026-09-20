// eBay tokens at rest.
//
// A refresh token is eighteen months of "act as this seller on eBay". It used
// to sit in Postgres as text. It is now sealed with AES-256-GCM under
// EBAY_TOKEN_KEY (32 bytes, hex); a row written before the key existed is
// still readable, and a process with no key stores plaintext and says so,
// because a development database with no key is a real state and a crash is
// not the right answer to it.
//
// The defect was never this code — the sealing is correct and applied
// everywhere. It was that the KEY'S ABSENCE was discovered here, lazily, at
// the first seal, as one warning line in a process that produced eleven lines
// in sixteen hours. It is now checked and announced AT BOOT (`checkConfig()`
// in src/config.ts, printed in an unmissable banner by src/index.ts) and
// reported by /api/diagnostics, so an operator learns it before a seller's
// credential ever arrives. What follows is the belt to that braces.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canHoldSellerTokens } from "../../config.js";
import { log } from "../../obs/log.js";

const PREFIX = "enc:v1:";
let warned = false;

function key(): Buffer | null {
  const hex = (process.env.EBAY_TOKEN_KEY || "").trim();
  if (!hex) {
    // Once per process. The severity is the honest one for the box it is
    // running on: on a machine that cannot receive a real credential this is
    // a note, and on one that can it is the most serious thing in the log.
    if (!warned) {
      warned = true;
      const atRisk = canHoldSellerTokens();
      log(atRisk ? "error" : "warn", "ebay.no_sealing_key", {
        why: "EBAY_TOKEN_KEY is not set",
        atRisk: atRisk
          ? "REAL third-party refresh tokens are being written to Postgres AS TEXT — " +
            "eighteen months of acting as that seller on eBay, or speaking as that channel on Twitch"
          : "no production credential can reach this box; tokens written here are development ones",
        fix: "openssl rand -hex 32",
      });
    }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("EBAY_TOKEN_KEY must be 32 bytes as 64 hex characters");
  return Buffer.from(hex, "hex");
}

export function sealToken(plain: string | null | undefined): string | null {
  if (plain == null) return null;
  const k = key();
  // Returns the plaintext when there is no key, unchanged. A fresh clone and
  // the suite must both work, and refusing here would turn a configuration gap
  // into a broken connect flow for everyone running this repo. The absence is
  // answered at boot instead; see the header.
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
