// What the process says about itself.
//
// Written because the deployed box produced ELEVEN log lines in sixteen hours
// of serving authenticated traffic and driving a headless Chrome. Every runtime
// fact went to `onStatus` and out to an SSE stream that may have had no browser
// attached, so a show that stopped answering left no trace anywhere — not in
// `docker logs`, not in Postgres. The listen session that was cut at exactly
// 300 seconds had to be diagnosed by reading a DIFFERENT system's logs.
//
// Deliberately not a logging library. One line of NDJSON on stdout, one
// `JSON.stringify` per call, no transport, no buffering, no dependency. The
// cost of a line must be low enough that nobody is ever tempted to remove one
// to make the box quieter.
//
// WHAT MUST NEVER GO IN A LINE
//   * a buyer's message text, a draft, a transcript segment, a host utterance;
//   * a token, key, password, cookie, authorization header or session id;
//   * a request body or a query string.
// Say WHICH show, WHICH surface, WHICH door, how many and how long. Counts and
// identifiers diagnose an incident; content is what a person said to a seller
// in confidence and it does not belong in an operator's terminal.

export type Level = "info" | "warn" | "error";

/** One structured line. */
export interface LogLine {
  at: string;
  level: Level;
  event: string;
  [field: string]: unknown;
}

/** Test seam. The suite reads lines instead of parsing stdout. */
type Sink = (line: LogLine) => void;
let taps: Sink[] = [];

/**
 * Watch every line this process emits. Returns the un-tap.
 *
 * Exists so a regression test can assert that a give-up SAYS SO, which is the
 * only way to test a log line without writing a hollow assertion about a
 * string constant.
 */
export function onLog(fn: Sink): () => void {
  taps.push(fn);
  return () => {
    taps = taps.filter((t) => t !== fn);
  };
}

/** Under test, stdout stays clean unless someone asks for it. */
const QUIET = process.env.NODE_ENV === "test" && process.env.SIDESTAGE_LOG !== "1";

/** Keys whose VALUE is never printed, whatever a caller passes. */
const SECRET = /token|key|secret|password|authorization|cookie|session|text|draft|body|transcript|message/i;

function safe(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    // A caller that names a field `token` has made a mistake; the line still
    // goes out, because dropping the whole line would lose the incident too.
    out[k] = SECRET.test(k) ? "[redacted]" : v;
  }
  return out;
}

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line: LogLine = { at: new Date().toISOString(), level, event, ...safe(fields) };
  for (const t of taps) {
    try {
      t(line);
    } catch {
      /* a tap must never take the process down */
    }
  }
  if (QUIET) return;
  const text = JSON.stringify(line) + "\n";
  try {
    if (level === "error") process.stderr.write(text);
    else process.stdout.write(text);
  } catch {
    /* a closed stdout is not worth a crash */
  }
}

export const logInfo = (event: string, fields?: Record<string, unknown>) => log("info", event, fields);
export const logWarn = (event: string, fields?: Record<string, unknown>) => log("warn", event, fields);
export const logError = (event: string, fields?: Record<string, unknown>) => log("error", event, fields);

/**
 * The shape every swallowed error should have.
 *
 * Keeping the swallow is usually right — a failed enrichment must not stop a
 * reply. What was wrong is that continuing was indistinguishable from
 * succeeding, for ever. A swallowed error with a line is a decision; without
 * one it is a blind spot.
 */
export function logSwallowed(event: string, e: unknown, fields: Record<string, unknown> = {}): void {
  logWarn(event, { ...fields, err: errText(e) });
}

export function errText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.slice(0, 200);
}
