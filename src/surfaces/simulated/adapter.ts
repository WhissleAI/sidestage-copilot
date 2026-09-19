// The scripted show, as a surface.
//
// `SimulatedShowSource` predates the surface abstraction and is used by the
// evals, the bench and the demo. Wrapping it rather than rewriting it keeps all
// three deterministic — the script, the seed and the inter-message timing are
// untouched — while making the demo reachable through the same `attach(input)`
// the console uses for a real link. A demo that is started by a different code
// path from the real thing is a demo that can pass while the real thing is
// broken.

import { SimulatedShowSource } from "../../ingest/sources.js";
import {
  SIMULATED_CAPABILITIES,
  type SurfaceAdapter, type SurfaceConnection, type SurfaceEvents, type SurfaceTarget,
} from "../types.js";

/** What an operator types to get the scripted show. Deliberately narrow: a
 *  pattern any looser would swallow a mistyped real link and hand back a fake
 *  show, which is the empty state this product spent a release getting rid of. */
const SIMULATED = /^(?:simulated|sim|demo)(?::([A-Za-z0-9_-]{1,40}))?$/i;

export const simulatedAdapter: SurfaceAdapter = {
  id: "simulated",
  label: "Simulated show",
  capabilities: SIMULATED_CAPABILITIES,

  parseTarget(input: string): SurfaceTarget | null {
    const m = input.trim().match(SIMULATED);
    if (!m) return null;
    return { externalId: m[1] || "demo", title: "Friday Night Grails — Ep. 42", handle: "@kicksbyrae" };
  },

  async open(t: SurfaceTarget, ev: SurfaceEvents): Promise<SurfaceConnection> {
    const source = new SimulatedShowSource();
    let n = 0;
    source.onMessage((m) => {
      n++;
      ev.onMessage?.({ id: m.externalId || `sim_${n}`, author: m.author, text: m.text });
    });
    await source.start();
    ev.onStatus?.({ connected: true, detail: `scripted show ${t.externalId}` });
    return {
      stop: async () => {
        source.stop();
      },
    };
  },
};
