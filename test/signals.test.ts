// What the show sounded and looked like, kept.
//
// The console measured the host's speech all along and none of it survived
// the show. These pin the persistence: an utterance keeps its distributions
// whole, a frame is kept only WITH its reading, an audio chunk re-sent under
// the same seq replaces itself, and the host summary sums probability mass
// rather than counting top labels.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rig, cleanup, type Rig } from "./helpers.js";
import { SessionSignals } from "../src/shows/signals.js";
import { parseConclusion } from "../src/shows/conclusion.js";

let r: Rig;
let sig: SessionSignals;

before(async () => {
  process.env.SHOW_MEDIA_DIR = ".tmp/test-media";
  r = await rig();
  sig = new SessionSignals(r.d);
});
after(async () => {
  sig.purge(r.showId);
  await cleanup();
});

const dist = (top: string, p: number, rest: [string, number][]) => ({
  topLabel: top, topP: p, topK: [{ label: top, p }, ...rest.map(([label, q]) => ({ label, p: q }))],
  changed: false, prevLabel: null, heldMs: 0, flips: 0, trusted: true,
});

describe("signals", () => {
  test("an utterance keeps its distributions whole", async () => {
    sig.recordUtterance({
      showId: r.showId, text: "last one in this waist", at: new Date().toISOString(),
      emotion: dist("EMOTION_EXCITED", 0.61, [["EMOTION_HAPPY", 0.24]]),
      intent: dist("INTENT_INFORM", 0.54, [["INTENT_COMMAND", 0.31]]),
      speechRate: 168, levels: [0.2, 0.4, 0.3],
    });
    // fire-and-forget: give the insert a tick
    await new Promise((res) => setTimeout(res, 50));
    const u = await sig.utterances(r.showId);
    assert.equal(u.length, 1);
    assert.equal(u[0]!.emotion?.topK.length, 2);
    assert.equal(u[0]!.intent?.topLabel, "INTENT_INFORM");
    assert.equal(u[0]!.speechRate, 168);
    assert.deepEqual(u[0]!.levels, [0.2, 0.4, 0.3]);
  });

  test("a frame is kept with its reading, as bytes on disk and a row", async () => {
    const png = "data:image/png;base64," + Buffer.from("not really a png").toString("base64");
    const f = await sig.recordFrame(r.showId, png, "Dark-wash jeans held up; price card reads 148.");
    assert.ok(f);
    assert.ok(existsSync(f!.path));
    const all = await sig.frames(r.showId);
    assert.equal(all.length, 1);
    assert.equal(all[0]!.reading, "Dark-wash jeans held up; price card reads 148.");
    assert.equal((await sig.recordFrame(r.showId, "nonsense", "x")), null);
  });

  test("an audio chunk re-sent under the same run key replaces itself; a new run appends", async () => {
    // The bridge numbers chunks from 0 on every page load. Before 2026-09-15
    // the row was keyed on that number, so a bridge reopened mid-show wrote
    // its chunk 0 over the show's first ten seconds. Numbering is the
    // server's now; the run key only identifies a retry.
    await sig.recordAudio(r.showId, "runA:3", Buffer.from("aaaa"), { durationMs: 10_000, mime: "audio/webm" });
    await sig.recordAudio(r.showId, "runA:3", Buffer.from("bbbbbb"), { durationMs: 9_800, mime: "audio/webm" });
    let a = await sig.audio(r.showId);
    assert.equal(a.length, 1);
    assert.equal(a[0]!.bytes, 6);
    assert.equal(a[0]!.durationMs, 9_800);
    // A reopened bridge starts its count again: same client seq, new run.
    const second = await sig.recordAudio(r.showId, "runB:3", Buffer.from("cc"), { durationMs: 10_000, mime: "audio/webm" });
    a = await sig.audio(r.showId);
    assert.equal(a.length, 2);
    assert.equal(second.seq, a[0]!.seq + 1);
    // An old bridge with no run key never overwrites anything either.
    await sig.recordAudio(r.showId, null, Buffer.from("d"), { durationMs: 10_000, mime: "audio/webm" });
    assert.equal((await sig.audio(r.showId)).length, 3);
  });

  test("a frame can be described after the fact", async () => {
    const png = "data:image/png;base64," + Buffer.from("frame").toString("base64");
    const f = await sig.recordFrame(r.showId, png, "White Nike sneaker");
    await sig.describe(r.showId, f!.seq, "A white Nike Air Force 1, men's size 10, held to camera; the card reads $58.");
    const got = (await sig.frames(r.showId)).find((x) => x.seq === f!.seq);
    assert.match(got!.description ?? "", /size 10/);
  });

  test("the host summary sums probability mass, not top labels", async () => {
    // Two more utterances where "excited" wins narrowly: counting labels would
    // say 100% excited; mass says well under.
    for (let i = 0; i < 2; i++) {
      sig.recordUtterance({
        showId: r.showId, text: `utterance ${i}`, at: new Date(Date.now() + i * 1000).toISOString(),
        emotion: dist("EMOTION_EXCITED", 0.34, [["EMOTION_NEUTRAL", 0.33], ["EMOTION_HAPPY", 0.33]]),
        intent: null, speechRate: 150, levels: [0.9],
      });
    }
    await new Promise((res) => setTimeout(res, 50));
    const h = await sig.hostSummary(r.showId);
    assert.ok(h);
    assert.equal(h!.utterances, 3);
    const excited = h!.emotion.find((e) => e.label === "EMOTION_EXCITED")!;
    assert.ok(excited.share < 0.5, `excited share ${excited.share} should be mass, not a label count`);
    assert.equal(h!.medianSpeechRate, 150);
    assert.equal(h!.loudestAtMs != null, true);
  });

  test("purge removes the bytes", async () => {
    const f = (await sig.frames(r.showId))[0]!;
    sig.purge(r.showId);
    assert.equal(existsSync(f.path), false);
  });
});

describe("the agent's conclusion", () => {
  test("parses a fenced JSON reply and drops unknown kinds to setup", () => {
    const c = parseConclusion(
      'Here you go:\n```json\n{"summary":"You answered most of it.","outcome":"steady","keyPoints":["a","b"],' +
      '"nextActions":[{"kind":"catalog","title":"Add fabric","why":"6 asked"},{"kind":"bogus","title":"x","why":""}]}\n```',
    );
    assert.ok(c);
    assert.equal(c!.outcome, "steady");
    assert.equal(c!.nextActions.length, 2);
    assert.equal(c!.nextActions[1]!.kind, "setup");
    assert.equal(c!.by, "agent");
  });
  test("a reply with no summary is no conclusion", () => {
    assert.equal(parseConclusion("{\"outcome\":\"strong\"}"), null);
    assert.equal(parseConclusion("I cannot help with that."), null);
  });
});
