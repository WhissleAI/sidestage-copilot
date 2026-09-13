/** Money is integer cents everywhere. These are the only two conversions. */
export const formatMoney = (cents: number): string =>
  `$${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

/** Parse every money mention in a piece of text into cents.
 *  Handles `$412`, `$412.00`, `$1,180`, `412 dollars`, and bare `380` when
 *  preceded by a negotiating verb ("can you do 380"). The bare-number case
 *  matters: buyers in live chat almost never type the dollar sign. */
export function extractMoneyCents(text: string): number[] {
  const out: number[] = [];
  const dollar = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)/g;
  for (const m of text.matchAll(dollar)) out.push(toCents(m[1]));
  const spelled = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:dollars|usd|bucks)\b/gi;
  for (const m of text.matchAll(spelled)) out.push(toCents(m[1]));
  // Bare numbers after a negotiating verb. Live-chat buyers almost never type
  // the dollar sign: "can you do 380", "would you take 360", "ill pay 350".
  // Two digits minimum, so quantities ("3 left") are not read as money.
  // The negative lookahead keeps "caps at 15% off" from reading as $15.00 —
  // a percentage is not a price, and confusing the two blocked a valid reply.
  const bare = /\b(?:do|take|for|at|pay|paying|offer|give)\s+\$?([0-9]{2,6}(?:\.[0-9]{1,2})?)\b(?!\s*%)/gi;
  for (const m of text.matchAll(bare)) out.push(toCents(m[1]));
  return [...new Set(out)];
}

function toCents(raw: string): number {
  return Math.round(Number(raw.replace(/,/g, "")) * 100);
}

export const pct = (part: number, whole: number): number => (whole === 0 ? 0 : (part / whole) * 100);
