import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import type { AppContext } from "../src/api/context.js";
import { db as pgPool } from "../src/db/pg.js";
import { buildContextBlock } from "../src/compose/prompts.js";
import { DEFAULT_POLICY, policyScope } from "../src/guardrails/policy.js";
import { runChain } from "../src/guardrails/chain.js";
import { withBoundaries, boundaryRules, disclosureRequirements } from "../src/persona/boundaries.js";
import { PersonaStore, type Persona } from "../src/persona/store.js";
import { VoiceCorpus, styleRef, voiceFact, type VoiceDoc } from "../src/persona/voice.js";
import { rig, cleanup, guardInput, type Rig } from "./helpers.js";
import type { ShowState } from "../src/domain/types.js";

// One paragraph of "your voice" is enough for a shopping question, where the
// buyer wants the answer and the register is a finish on it. It is nowhere near
// enough in a subreddit, where the register IS the credibility — a true
// sentence in brand-voice is downvoted before anyone checks that it was true.
//
// The insistence that makes the fix trustworthy rather than merely effective:
// style is CITED the way a fact is, and a style reference is never grounding.

const SHOW = {
  id: "s", title: "Friday Night Grails", sellerHandle: "@kicksbyrae",
  startedAt: "2026-09-16T09:00:00Z", viewers: 0, pinnedListingId: null, lotQueue: [],
  autonomyLevel: "L1_SUGGEST", undoWindowS: 90, source: "ebaylive",
  externalId: null, readOnly: false, status: "live",
} as ShowState;

const SELLER = { handle: "@kicksbyrae", name: "Rae", about: "Rae sells grails out of Portland.", voice: "warm, fast, specific" };

const PERSONA: Persona = {
  id: "default",
  name: "Rae",
  about: "Ten years of buying and selling sneakers, mostly Jordans.",
  voice: "short, dry, never hyped",
  boundaries: {
    never_claim: ["best in the game"],
    never_discuss: ["my supplier"],
    must_disclose: ["replies here are drafted with AI assistance"],
  },
  disclosure: null,
  registers: {
    reddit: { length: "medium", formality: 4, emoji: false, notes: "Answer the question, then stop." },
    twitch: { length: "short", formality: 1, emoji: true, notes: "" },
  },
  corpusDocIds: [],
  updatedAt: null,
};

const doc = (o: Partial<VoiceDoc> & { docId: string; text: string }): VoiceDoc => ({
  question: "", origin: "sent", showId: "s1", showTitle: "Ep. 12",
  at: "2026-03-04T10:00:00Z", ...o,
});

const CORPUS = [
  doc({ docId: "a", question: "do you ship to canada?", text: "Yeah, Canada's fine — flat rate, usually about a week and a half." }),
  doc({ docId: "b", question: "how does the sizing run?", text: "These run about half a size small, so I'd size up if you're between." }),
  doc({ docId: "c", question: "is the price negotiable?", text: "I can do a little better on a bundle, but not on this one on its own." }),
].map(voiceFact);

describe("the persona in the prompt", () => {
  test("the register is per surface — the same persona sounds different in two rooms", () => {
    const reddit = buildContextBlock({
      show: { ...SHOW, source: "reddit" }, pinned: null, context: null, seller: SELLER,
      persona: PERSONA, facts: [], abstain: false, viaAnaphora: false,
    });
    const twitch = buildContextBlock({
      show: { ...SHOW, source: "twitch" }, pinned: null, context: null, seller: SELLER,
      persona: PERSONA, facts: [], abstain: false, viaAnaphora: false,
    });

    assert.match(reddit, /How you write on reddit: up to three or four sentences, polished/);
    assert.match(reddit, /no emoji/);
    assert.match(reddit, /Answer the question, then stop\./);

    assert.match(twitch, /How you write on twitch: one or two sentences, as loose as a message to a friend/);
    assert.match(twitch, /emoji are fine/);
    // The whole point: the same operator, the same about and voice, and not the
    // same instruction about how to write.
    assert.ok(!twitch.includes("polished"), "a register belongs to one surface, not to the persona");
    assert.ok(reddit.includes(PERSONA.about) && twitch.includes(PERSONA.about));
  });

  test("a surface with no register of its own gets none invented for it", () => {
    const live = buildContextBlock({
      show: SHOW, pinned: null, context: null, seller: SELLER, persona: PERSONA,
      facts: [], abstain: false, viaAnaphora: false,
    });
    assert.match(live, /=== THE PERSONA ===/);
    assert.ok(!live.includes("How you write on ebaylive"));
  });

  test("a must_disclose entry is a requirement in the prompt, not a blocker", () => {
    const block = buildContextBlock({
      show: SHOW, pinned: null, context: null, seller: SELLER, persona: PERSONA,
      facts: [], abstain: false, viaAnaphora: false,
    });
    assert.match(block, /Always make clear, in your own words[^\n]*drafted with AI assistance/);
    // And it is NOT a never-say rule: inverting a disclosure into "block any
    // reply that does not contain this" blocks "yes, still available".
    assert.deepEqual(
      boundaryRules(PERSONA).map((r) => r.pattern),
      ["best in the game", "my supplier"],
    );
    assert.deepEqual(disclosureRequirements(PERSONA), ["replies here are drafted with AI assistance"]);
  });

  test("a style reference is fenced as style, and never as grounding", () => {
    const block = buildContextBlock({
      show: SHOW, pinned: null, context: null, seller: SELLER, persona: PERSONA,
      styleRef: { factId: "persona:a", text: "Yeah, Canada's fine — flat rate.", label: "Your own words · March 2026" },
      facts: [], abstain: false, viaAnaphora: false,
    });
    assert.match(block, /How you answered something like this before \(Your own words · March 2026\)/);
    assert.match(block, /"Yeah, Canada's fine — flat rate\."/);
    assert.match(block, /That is HOW to say it, never WHAT to say/);
    assert.match(block, /it grounds\nno claim, you must not cite it/);
    // It is not in the grounding list, so a citation of it could not be
    // supported even if the model tried.
    assert.ok(!block.includes("[persona:a]"));
  });

  test("an account with no persona renders byte-identically to before", () => {
    // The same inputs the existing prompt tests build, with the two new fields
    // present and empty. A missing persona must change nothing at all — this is
    // the assertion that makes every account that never opens the page safe.
    const before = buildContextBlock({
      show: SHOW, pinned: null, context: null, seller: SELLER,
      facts: [], abstain: false, viaAnaphora: false,
    });
    const after = buildContextBlock({
      show: SHOW, pinned: null, context: null, seller: SELLER, persona: null, styleRef: null,
      facts: [], abstain: false, viaAnaphora: false,
    });
    assert.equal(after, before);
    assert.match(before, /=== THE SELLER ===\nRae sells grails out of Portland\.\nTheir voice: warm, fast, specific/);
    assert.ok(!before.includes("=== THE PERSONA ==="));
  });

  test("a persona supersedes the catalog's blurb rather than arguing with it", () => {
    // Two answers to "who is talking, and how do they sound", in two voices,
    // invites the model to average them.
    const block = buildContextBlock({
      show: SHOW, pinned: null, context: null, seller: SELLER, persona: PERSONA,
      facts: [], abstain: false, viaAnaphora: false,
    });
    assert.ok(!block.includes("=== THE SELLER ==="));
    assert.match(block, /Your voice: short, dry, never hyped/);
  });
});

describe("boundaries reach the guard that was already there", () => {
  let r: Rig;
  before(async () => { r = await rig(); });

  test("a never_claim phrase is blocked by the EXISTING policy guard", async () => {
    const input = await guardInput(r, "is this a good pair?", "Honestly, these are the best in the game.");

    const armed = withBoundaries(DEFAULT_POLICY, PERSONA);
    const withIt = policyScope.run(armed, () => runChain(input, { evidenceQuality: 0.9 }));
    const policyResult = withIt.guards.find((g) => g.guard === "policy");
    assert.equal(policyResult?.verdict, "block");
    assert.match(policyResult?.reason ?? "", /Rae never claims that/);

    // And the control: the same draft, the same guard, no persona.
    const without = policyScope.run(DEFAULT_POLICY, () => runChain(input, { evidenceQuality: 0.9 }));
    assert.notEqual(without.guards.find((g) => g.guard === "policy")?.verdict, "block");
  });

  test("an account with no persona is handed the very same policy object", () => {
    assert.equal(withBoundaries(DEFAULT_POLICY, null), DEFAULT_POLICY);
  });

  test("a boundary is a literal, so a bracket in one cannot take the guard down", async () => {
    // A guard that throws blocks every reply (chain.ts). An operator typing
    // "no 'guaranteed (real)' talk" into a text box is typing a phrase.
    const hostile: Persona = {
      ...PERSONA,
      boundaries: { never_claim: ["guaranteed (real) pairs"], never_discuss: [], must_disclose: [] },
    };
    const armed = withBoundaries(DEFAULT_POLICY, hostile);

    const hit = await guardInput(r, "are these real?", "We only sell guaranteed (real) pairs here.");
    const p = policyScope.run(armed, () => runChain(hit, {})).guards.find((g) => g.guard === "policy");
    assert.equal(p?.verdict, "block");
    assert.ok(!/guard error/.test(p?.reason ?? ""), "a literal boundary must not compile as a regex");

    // And the metacharacters are escaped rather than honoured: compiled as a
    // pattern, "(real)" would be a group and this draft would match too.
    const miss = await guardInput(r, "are these real?", "We only sell guaranteed real pairs here.");
    assert.notEqual(
      policyScope.run(armed, () => runChain(miss, {})).guards.find((g) => g.guard === "policy")?.verdict,
      "block",
    );
  });
});

describe("the one past answer that most resembles this question", () => {
  test("it picks the nearest, and exactly one", () => {
    const ref = styleRef("does this ship to canada?", CORPUS);
    assert.equal(ref?.factId, "persona:a");
    assert.match(ref?.label ?? "", /March 2026/);
    assert.equal(ref?.text, CORPUS[0]!.text);

    assert.equal(styleRef("how do these fit, do they run small?", CORPUS)?.factId, "persona:b");
  });

  test("nothing close means no reference at all", () => {
    // Nearest-of-five-unrelated teaches the model the wrong rhythm with full
    // confidence, under a line claiming it is how the operator writes.
    assert.equal(styleRef("what time is the eclipse in Lagos tomorrow", CORPUS), null);
    assert.equal(styleRef("hello", CORPUS), null);
    assert.equal(styleRef("does this ship to canada?", []), null);
  });

  test("only a voice-corpus fact can be a style reference", () => {
    // A listing fact resembling the question is an ANSWER. Letting it in here
    // would put a live price in the prompt under "this is not a fact".
    const listing = { ...CORPUS[0]!, factId: "listing:x#shipping", source: "listing" as const, corpus: "listing" as const };
    assert.equal(styleRef("does this ship to canada?", [listing]), null);
  });
});

describe("learning the operator's own voice", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  const json = { "content-type": "application/json" };

  const register = async (tag: string) => {
    const r = (await app.inject({
      method: "POST", url: "/api/auth/register", headers: json,
      payload: {
        email: `${tag}-${Date.now()}-${Math.random().toString(16).slice(2)}@test.local`,
        password: "password-123", displayName: tag,
      },
    })).json() as { token: string; account: { id: string } };
    return { headers: { authorization: `Bearer ${r.token}`, ...json }, id: r.account.id };
  };

  let A: { headers: Record<string, string>; id: string };
  let B: { headers: Record<string, string>; id: string };
  const shows: string[] = [];

  /** A finished show with replies on it, owned by one account. */
  const seedSends = async (
    accountId: string,
    showId: string,
    title: string,
    sends: { q: string; a: string; status?: string }[],
  ) => {
    shows.push(showId);
    await pgPool().query(
      `INSERT INTO shows (id, owner_account_id, title, seller_handle, started_at, source, status)
       VALUES ($1,$2,$3,'@seller',$4,'ebaylive','ended') ON CONFLICT (id) DO NOTHING`,
      [showId, accountId, title, new Date().toISOString()],
    );
    let n = 0;
    for (const s of sends) {
      n++;
      await pgPool().query(
        `INSERT INTO reply_proposals (show_id, id, message_id, author, question, draft, sent_text, status, verdict, at)
         VALUES ($1,$2,$3,'buyer',$4,$5,$6,$7,'allow',$8)`,
        [showId, `p${n}`, `m${n}`, s.q, s.a, s.a, s.status ?? "sent", new Date().toISOString()],
      );
    }
  };

  before(async () => {
    ({ app, ctx } = await buildApp());
    A = await register("persona-a");
    B = await register("persona-b");
    await seedSends(A.id, `t_persona_a_${process.pid}`, "Rae · Ep. 12", [
      { q: "do you ship to canada?", a: "Yeah, Canada's fine — flat rate, usually about a week and a half." },
      { q: "how does the sizing run?", a: "These run about half a size small, so I'd size up if you're between.", status: "auto_sent" },
      { q: "still there?", a: "yep" },                                   // too short to model a voice
      { q: "what about the box?", a: "Box is there, lid's a little soft but it's the original." },
      { q: "any discount?", a: "Not on this one, sorry — it's already under what they go for.", status: "dismissed" },
    ]);
    await seedSends(B.id, `t_persona_b_${process.pid}`, "Someone else · Ep. 3", [
      { q: "shipping?", a: "ABSOLUTELY we ship worldwide, hit that follow button for a discount!!" },
    ]);
  });

  after(async () => {
    const d = pgPool();
    for (const id of shows) await d.query("DELETE FROM shows WHERE id = $1", [id]).catch(() => {});
    for (const who of [A, B]) {
      await d.query("DELETE FROM persona_voice WHERE account_id = $1", [who.id]).catch(() => {});
      await d.query("DELETE FROM personas WHERE account_id = $1", [who.id]).catch(() => {});
    }
    await app.close();
    await ctx.stop();
    await cleanup();
  });

  test("it indexes this account's own sends, and nobody else's", async () => {
    const r = await app.inject({ method: "POST", url: "/api/persona/learn", headers: A.headers, payload: {} });
    assert.equal(r.statusCode, 200);
    const body = r.json() as {
      indexed: number; total: number; shows: { showId: string; title: string; count: number }[];
      voice: { docs: { text: string }[] };
    };
    // Three of the five: "yep" is too short to model a voice, and a dismissed
    // draft is one the operator declined to put their name to.
    assert.equal(body.indexed, 3);
    assert.equal(body.total, 3);
    assert.deepEqual(body.shows.map((s) => s.title), ["Rae · Ep. 12"]);
    const texts = body.voice.docs.map((d) => d.text).join(" ");
    assert.ok(texts.includes("Canada's fine"));
    assert.ok(!texts.includes("hit that follow button"), "another seller's voice is not this operator's");
  });

  test("learning twice does not grow a duplicate corpus", async () => {
    const again = (await app.inject({ method: "POST", url: "/api/persona/learn", headers: A.headers, payload: {} }))
      .json() as { total: number };
    assert.equal(again.total, 3);
  });

  test("pasted text joins the corpus, and the store is account-scoped", async () => {
    const paste = "I keep it short. If I don't know, I say I'll check and then I actually check.";
    const r = (await app.inject({
      method: "POST", url: "/api/persona/learn", headers: A.headers, payload: { paste: [paste, "no"] },
    })).json() as { total: number; pasted: number };
    assert.equal(r.pasted, 1, "two-character pastes are not a writing sample");
    assert.equal(r.total, 4);

    const corpus = new VoiceCorpus(pgPool());
    assert.equal((await corpus.docs(B.id)).length, 0, "B's corpus is empty and stays empty");
  });

  test("a style reference comes out of the account's own learned corpus", async () => {
    const corpus = new VoiceCorpus(pgPool());
    const ref = styleRef("does it ship to canada?", await corpus.facts(A.id));
    assert.match(ref?.text ?? "", /Canada's fine/);
  });

  test("the persona round-trips, and a partial save keeps the boundaries", async () => {
    const put = await app.inject({
      method: "PUT", url: "/api/persona", headers: A.headers,
      payload: {
        name: "Rae", about: "Ten years of Jordans.", voice: "short, dry",
        boundaries: { never_claim: ["best in the game"], never_discuss: [], must_disclose: ["drafted with AI assistance"] },
        registers: { reddit: { length: "medium", formality: 9, emoji: true, notes: "cite the receipt" } },
        // Not an editable field: it must be dropped, not merged.
        corpusDocIds: ["persona:whatever"],
      },
    });
    assert.equal(put.statusCode, 200);
    const saved = (put.json() as { persona: Persona }).persona;
    assert.equal(saved.registers.reddit?.formality, 5, "a formality of 9 is a typo with a straight face");
    assert.deepEqual(saved.corpusDocIds, []);

    // An edit to the about text is not a decision to drop every guard rule.
    await app.inject({ method: "PUT", url: "/api/persona", headers: A.headers, payload: { about: "Eleven years now." } });
    const after = ((await app.inject({ method: "GET", url: "/api/persona", headers: A.headers })).json() as { persona: Persona }).persona;
    assert.equal(after.about, "Eleven years now.");
    assert.deepEqual(after.boundaries.never_claim, ["best in the game"]);
  });

  test("one account cannot see another's persona", async () => {
    const theirs = (await app.inject({ method: "GET", url: "/api/persona", headers: B.headers })).json() as { persona: Persona | null };
    assert.equal(theirs.persona, null);
    assert.equal((await app.inject({ method: "GET", url: "/api/persona" })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/api/persona/learn", headers: json, payload: {} })).statusCode, 401);
  });

  test("the store's cache is invalidated by the write that changed it", async () => {
    const store = new PersonaStore(pgPool());
    assert.equal((await store.forAccount(A.id))?.about, "Eleven years now.");
    await store.upsert(A.id, { about: "Twelve, if we are counting." });
    assert.equal((await store.forAccount(A.id))?.about, "Twelve, if we are counting.");
  });
});
