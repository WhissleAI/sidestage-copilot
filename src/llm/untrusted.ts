// Text on its way to a model that this process did not write.
//
// Every prompt this app builds is STRUCTURED BY NEWLINES — `=== SECTION ===`
// headings, `[factId] the fact` evidence lines, `  <id> = <title>` id maps,
// `author: text` thread lines — so a newline inside a value does not misformat a
// prompt, it writes new lines OF it. And several call sites wrap a value in bare
// quotes, which one `"` ends early.
//
// It lives beside the LLM client rather than in `compose/` because five modules
// build prompts and only one of them is the composer: `compose/prompts.ts`,
// `ingest/showContext.ts`, `ingest/threadContext.ts`, `ingest/enrichLot.ts` and
// `shows/conclusion.ts`. `nothing-a-stranger-typed-is-an-instruction.test.ts`
// scans all five.

function oneLine(s: string, max: number): string {
  return String(s)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    // A value that begins `=== ` reads as one of a block's own headings.
    .replace(/^[\s=]*={3,}[\s=]*/, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

/** Untrusted text on its way into a prompt: one line, bounded, no control
 *  characters, and JSON-quoted. A buyer name or a chat message is data, never an
 *  instruction, and the model is told so wherever one appears. */
export function quoted(s: string, max = 400): string {
  return JSON.stringify(oneLine(s, max));
}

/**
 * The same sanitising WITHOUT the surrounding quotes, for the places whose
 * rendered shape has to stay as it is — a lot title inside a sentence, a fact on
 * its own `[id] text` line, an id map the model is told to choose from.
 *
 * Two functions rather than one, because the choice at each call site is about
 * FORMAT: making every value JSON-quoted to get the escaping would change what
 * the model reads on nearly every line of a prompt.
 */
export function safe(s: string, max = 400): string {
  return oneLine(s, max);
}
