// Every stream gets its own agent, and the workspace caps agents at fifty.
// Without something retiring them, the cap arrives after fifty shows — it did,
// on 2026-09-15, as "You've reached the limit of 50 agents" under every card on
// the Discover tab. An agent's work is done once its show's report is written:
// the report, the transcript, the frames and the audit all live in Postgres,
// not on the agent. So a day after the report, the agent goes; the row keeps
// the show. Preparations that nobody attached within two days go the same way.

import type { Pool } from "../db/pg.js";
import { Preparer } from "../shows/prepareEvent.js";
import { deleteStreamAgent } from "./streamAgent.js";

export interface GcResult {
  retired: number;
  droppedPreparations: number;
  failed: number;
}

/** One pass. Safe to run at any time; only touches what is provably finished. */
export async function retireStaleAgents(pool: Pool, opts: { reportAgeH?: number; preparedAgeH?: number } = {}): Promise<GcResult> {
  const reportAgeH = opts.reportAgeH ?? 24;
  const preparedAgeH = opts.preparedAgeH ?? 48;
  const out: GcResult = { retired: 0, droppedPreparations: 0, failed: 0 };

  // Shows that ended and whose report is older than a day — or that ended two
  // days ago and never got a report at all — no longer need their agent.
  const { rows } = await pool.query<{ id: string; agent_id: string }>(
    `SELECT s.id, s.agent_id
       FROM shows s
       LEFT JOIN show_reports r ON r.show_id = s.id
      WHERE s.status = 'ended' AND s.agent_id IS NOT NULL AND s.agent_owned
        AND (
          r.generated_at < now() - ($1 || ' hours')::interval
          OR (r.show_id IS NULL AND s.started_at::timestamptz < now() - ($2 || ' hours')::interval)
        )`,
    [String(reportAgeH), String(preparedAgeH)],
  );
  for (const r of rows) {
    const res = await deleteStreamAgent(r.agent_id);
    // A 404 means it is already gone; either way the row must stop pointing at it.
    if (res.ok || /404|not found/i.test(res.detail)) {
      await pool.query("UPDATE shows SET agent_id = NULL WHERE id = $1", [r.id]);
      out.retired += 1;
    } else {
      out.failed += 1;
      console.warn(`  agent-gc: could not retire agent for ${r.id} — ${res.detail}`);
    }
  }

  // Preparations nobody attached. Each holds an agent and a catalog file.
  const preparer = new Preparer(pool);
  const stale = await pool.query<{ event_id: string }>(
    `SELECT event_id FROM prepared_shows WHERE prepared_at < now() - ($1 || ' hours')::interval`,
    [String(preparedAgeH)],
  );
  for (const p of stale.rows) {
    try {
      await preparer.drop(p.event_id);
      out.droppedPreparations += 1;
    } catch (e) {
      out.failed += 1;
      console.warn(`  agent-gc: could not drop preparation ${p.event_id} — ${(e as Error).message}`);
    }
  }

  if (out.retired || out.droppedPreparations || out.failed) {
    console.log(`  agent-gc: retired ${out.retired} agent(s), dropped ${out.droppedPreparations} preparation(s), ${out.failed} failed`);
  }
  return out;
}

/** Boot + every six hours. Unref'd: never the reason the process stays alive. */
export function startAgentGc(pool: Pool, opts: { everyMs?: number; firstDelayMs?: number } = {}): () => void {
  let stopped = false;
  const tick = () => { if (!stopped) void retireStaleAgents(pool).catch((e) => console.warn(`  agent-gc: ${(e as Error).message}`)); };
  const first = setTimeout(tick, opts.firstDelayMs ?? 60_000);
  const timer = setInterval(tick, opts.everyMs ?? 6 * 60 * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
