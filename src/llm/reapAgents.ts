// Run the agent garbage collector now, and say what it did.
//
//   npm run agents:gc          retire what is finished, reap what nothing names
//   npm run agents:gc -- --dry list what WOULD be reaped, delete nothing
//
// The scheduled pass runs every six hours, which is the wrong cadence when a
// workspace is already at its cap and every preparation is 429ing. This is the
// same code on demand.

import { db } from "../db/pg.js";
import { retireStaleAgents } from "./agentGc.js";
import { AGENT_NAME_PREFIX, listStreamAgents } from "./streamAgent.js";

const dry = process.argv.includes("--dry");

async function main(): Promise<void> {
  const pool = db();
  const before = await listStreamAgents().catch(() => []);
  const ours = before.filter((a) => (a.name ?? "").startsWith(AGENT_NAME_PREFIX));
  console.log(`workspace: ${before.length} agent(s), ${ours.length} of them ours`);

  if (dry) {
    const referenced = new Set<string>();
    for (const q of [
      "SELECT agent_id FROM shows WHERE agent_id IS NOT NULL",
      "SELECT agent_id FROM prepared_shows WHERE agent_id IS NOT NULL",
    ]) {
      const { rows } = await pool.query<{ agent_id: string }>(q);
      for (const r of rows) referenced.add(r.agent_id);
    }
    const orphans = ours.filter((a) => !referenced.has(a.id));
    console.log(`would reap ${orphans.length} orphan(s):`);
    for (const a of orphans) console.log(`  ${a.id}  ${a.name}`);
    return;
  }

  const res = await retireStaleAgents(pool);
  console.log(
    `retired ${res.retired} · dropped ${res.droppedPreparations} preparation(s) · ` +
    `reaped ${res.orphansReaped} orphan(s) · ${res.failed} failed`,
  );
  const after = await listStreamAgents().catch(() => []);
  console.log(`workspace now: ${after.length} agent(s)`);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  },
);
