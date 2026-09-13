// The show script — a deterministic, replayable live chat.
//
// This is both the demo input and the benchmark input, which is why it is seeded
// rather than random: `npm run bench` must produce comparable numbers run to run,
// and a reviewer driving the UI must see the same show a test saw. The mix is
// drawn from how live selling chat actually reads — roughly half reaction, and
// the questions heavily weighted to price, availability and shipping.

export interface ScriptedMessage {
  author: string;
  text: string;
}

const AUTHORS = [
  "mia_k", "dre_23", "solefed", "kicksnkraft", "j_ortiz", "bigmike", "tashaaa",
  "grailhunter", "vntgvic", "onlyheat", "dunkdad", "rae_b", "sz10plug", "cop_or_drop",
  "nб_nick", "quietstorm", "thriftgod", "lacedup", "boxlogobri", "panda_pat",
];

/** Questions, tagged by the listing they are about so the bench can assert
 *  retrieval resolved to the right lot. */
export const QUESTIONS: { text: string; about?: string }[] = [
  // price / negotiation — the highest-stakes class
  { text: "whats the lowest on the chicagos?", about: "lst_aj1_chi_10" },
  { text: "how much for the chicago 1s", about: "lst_aj1_chi_10" },
  { text: "can you do 380", about: "lst_aj1_chi_10" },
  { text: "would you take 360 shipped", about: "lst_aj1_chi_10" },
  { text: "best price on the lost and found?", about: "lst_aj1_chi_10" },
  { text: "how much for the pandas", about: "lst_dunk_panda_11" },
  { text: "price on the box logo?", about: "lst_bogo_l" },
  { text: "what are the 990s going for", about: "lst_nb990_95" },
  { text: "any deal if i take two", about: "lst_aj1_chi_10" },
  { text: "whats the chunky dunky at", about: "lst_sb_dunk_9" },

  // availability
  { text: "size 10 still there??", about: "lst_aj1_chi_10" },
  { text: "are the chicagos still available", about: "lst_aj1_chi_10" },
  { text: "how many pandas left", about: "lst_dunk_panda_11" },
  { text: "is the bogo gone already", about: "lst_bogo_l" },
  { text: "did the slides sell", about: "lst_yz_slide_10" },
  { text: "claiming the 990s if theyre up", about: "lst_nb990_95" },

  // shipping
  { text: "ship to canada?" },
  { text: "do you ship international" },
  { text: "how fast do these ship" },
  { text: "is shipping free on the chicagos", about: "lst_aj1_chi_10" },
  { text: "do i pay customs to the uk" },
  { text: "whats shipping on the slides", about: "lst_yz_slide_10" },

  // returns
  { text: "whats the return policy" },
  { text: "can i return if they dont fit" },
  { text: "who pays return shipping" },

  // authenticity
  { text: "are these authenticated", about: "lst_aj1_chi_10" },
  { text: "do the pandas come with a cert", about: "lst_dunk_panda_11" },
  { text: "how do i verify the checkcheck number" },
  { text: "are the box logos legit checked", about: "lst_bogo_l" },

  // sizing / condition
  { text: "do the 990s run big", about: "lst_nb990_95" },
  { text: "do yeezy slides run big", about: "lst_yz_slide_10" },
  { text: "is the cracked leather a flaw on the lost and founds", about: "lst_aj1_chi_10" },
  { text: "how much creasing on the chunky dunkys", about: "lst_sb_dunk_9" },
  { text: "does it come with the original box", about: "lst_aj1_chi_10" },
  { text: "what condition are the 990s", about: "lst_nb990_95" },

  // comparison / research
  { text: "chicago reimagined vs the 2015 chicago which is better" },
  { text: "are the pandas worth it at that price", about: "lst_dunk_panda_11" },

  // things the catalog genuinely cannot answer — the abstain path
  { text: "do you have these in a 12?" },
  { text: "will you be selling jordan 4s next week" },
  { text: "can you hold it til friday" },
];

/** Pure reaction. Must be filtered out, and visibly so. */
export const HYPE: string[] = [
  "W", "LETS GOOO", "🔥🔥", "clean", "heat", "grail", "gg", "pog", "sheesh",
  "fire", "yessir", "nice", "dope", "banger", "W W W", "lol", "facts", "sick",
  "peak", "bro", "damn", "wow", "cop", "ez",
];

/** Deterministic PRNG (mulberry32) so a replay is byte-identical. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a show script. `hypeRatio` is the share of messages that are reaction —
 * 0.55 matches what a mid-sized live show actually looks like, and it is what
 * makes the admission gate's job visible in the demo.
 */
export function buildScript(count: number, seed = 42, hypeRatio = 0.55): ScriptedMessage[] {
  const rand = rng(seed);
  const out: ScriptedMessage[] = [];
  for (let i = 0; i < count; i++) {
    const author = AUTHORS[Math.floor(rand() * AUTHORS.length)];
    if (rand() < hypeRatio) {
      out.push({ author, text: HYPE[Math.floor(rand() * HYPE.length)] });
    } else {
      out.push({ author, text: QUESTIONS[Math.floor(rand() * QUESTIONS.length)].text });
    }
  }
  return out;
}

/** What the host is saying on camera, for the rolling show-context engine. In a
 *  real deployment these arrive as transcript segments from a Whissle
 *  listen-only voice session (src/ingest/audio.ts). */
export const HOST_TRANSCRIPT: string[] = [
  "Alright, we are starting tonight with the Lost and Found Chicago one, size ten, deadstock.",
  "This is the twenty twenty-two release, so you get the aged paper box lid and the extra laces.",
  "That cracked leather look is factory, that is how Nike made them, it is not wear.",
  "It is authenticated, the CheckCheck card is in the box with the cert number.",
  "I have got exactly one of these, size ten, so if you want it do not sit on it.",
  "Next up after this we are going into the New Balance nine ninety v six in grey.",
  "Those are very near deadstock, worn twice indoors, no creasing on the toe.",
  "I will say it now, the nine nineties run about half a size large.",
  "Then we have got the box logo hoodie, FW twenty-two, black, size large, deadstock with tags.",
  "And for anyone asking about the pandas, yes I have three pairs in an eleven.",
];
