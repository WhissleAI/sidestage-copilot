/**
 * What this process is, as an answer rather than an assumption.
 *
 * There was no build identifier anywhere in this service. `/health` says "ok",
 * `/api/diagnostics` describes configuration, and neither could tell you which
 * commit was running — so "merged" and "live" were two beliefs with nothing
 * connecting them. On 2026-09-28 that cost a real outage-shaped hour: a Caddy
 * config change merged, deployed green, and was not serving, and the only way to
 * find out was to curl the header it should have set.
 *
 * Baked at image build, never computed at runtime. A stamp the process derives
 * for itself — reading git, or its own mtime — reports the box's state rather
 * than the image's, which is precisely the thing in question.
 *
 * `unknown` when the file is absent (`npm start` locally, a hand-built image).
 * Never a fabricated value: a wrong SHA is worse than no SHA, because it is
 * believed.
 */
import { readFileSync } from "node:fs";

export interface BuildStamp {
  /** Full commit SHA the image was built from, or "unknown". */
  sha: string;
  /** ISO time the image was built, or null. */
  builtAt: string | null;
  /** Short form, for a log line or a status row. */
  short: string;
}

function read(): BuildStamp {
  try {
    const raw = JSON.parse(readFileSync(new URL("../../build.json", import.meta.url), "utf8")) as {
      sha?: unknown;
      builtAt?: unknown;
    };
    const sha = typeof raw.sha === "string" && /^[0-9a-f]{7,40}$/.test(raw.sha) ? raw.sha : "unknown";
    const builtAt =
      typeof raw.builtAt === "string" && !Number.isNaN(Date.parse(raw.builtAt)) ? raw.builtAt : null;
    return { sha, builtAt, short: sha === "unknown" ? "unknown" : sha.slice(0, 12) };
  } catch {
    // Running from source. Say so rather than guess.
    return { sha: "unknown", builtAt: null, short: "unknown" };
  }
}

/** Read once: the file cannot change under a running process. */
export const build: BuildStamp = read();
