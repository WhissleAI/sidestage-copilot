# Lovable prompt — SideStage Operator Console

Paste everything below the line into Lovable as a single prompt. It is written so the
generated app runs standalone on mock data, and then switches to the real backend by
changing two env vars — no refactor.

---

# SideStage — Live Selling Copilot (Operator Console)

Build a **dark, dense, keyboard-first operator console** for a real-time AI copilot that
assists a **solo live-commerce seller** while they run a live selling show.

## Who uses this

One person running a 60–120 minute live sneaker/streetwear show on a marketplace, with
40–400 concurrent viewers, selling from a queue of lots. They are on camera, talking, and
holding product. They cannot read chat and sell at the same time. This console is the one
surface they glance at between lots. Every design decision should follow from that: glanceable,
high signal density, no modal dialogs, no hunting, everything reachable by keyboard.

The copilot drafts replies to buyer questions and proposes operational actions (price
markdowns, stock fixes, swapping the pinned lot). **The seller stays in control** — the
console's whole job is to make approving or rejecting each item take under two seconds, and to
show *why* the copilot said what it said.

## Tech

- React + TypeScript + Vite + Tailwind + shadcn/ui
- No routing library needed — this is a single full-screen console
- No state library — React state + a couple of custom hooks is right
- `lucide-react` for icons
- Do **not** add a backend, auth, or database. This is a pure frontend against a documented API.

---

## Layout

A single full-viewport, non-scrolling **three-column console** with a fixed top bar. Only the
individual columns scroll internally. No page-level scroll. Minimum supported width 1280px;
below that, collapse the left column into a toggleable drawer.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ TOPBAR: show title · LIVE dot · viewers · latency meter · autonomy ladder · counters│
├──────────────┬────────────────────────────────────────┬──────────────────────────┤
│ LEFT 300px   │ CENTER (flex, the focus of the screen) │ RIGHT 380px              │
│ Buyer chat   │ Reply proposal queue                   │ Show rail                │
│ (firehose)   │ (cards, keyboard-driven)               │ pinned lot / actions /   │
│              │                                        │ audit log                │
└──────────────┴────────────────────────────────────────┴──────────────────────────┘
```

### TOP BAR (56px, fixed)

Left→right:
1. Show title (`Friday Night Grails — Ep. 42`) and seller handle (`@kicksbyrae`), handle muted.
2. A **LIVE** pill: red dot with a slow pulse, plus elapsed show time counting up `01:12:44` in
   tabular monospace.
3. Viewer count with a small up/down delta.
4. **Latency meter** — the signature element. Label `p95`, then the value in large tabular
   monospace (`840ms`), then a thin horizontal bar showing value against the 2000ms budget.
   Bar fills green under 60% of budget, amber 60–100%, red over. On hover, a popover shows
   p50 / p95 / p99, the budget, breach count, and cache hit rate.
5. **Autonomy ladder** — a 5-segment horizontal selector, the product's most important control:
   `L0 Observe · L1 Suggest · L2 One-tap · L3 Auto-reply · L4 Auto-act`.
   Selected segment is filled with the accent; segments to the right of the selection are
   dimmed with a subtle diagonal hatch to read as "not yet unlocked". Hovering a segment shows
   a popover with its one-line definition (given below). Changing it calls `POST /api/autonomy`.
   Moving to L3 or L4 requires a confirmation step inline in the popover (a small "Enable"
   button), never a modal.
6. Right-aligned counters, small and muted: `sent · auto · blocked · undone`.

Autonomy level definitions for the popovers:
- **L0 Observe** — copilot classifies chat but suggests nothing.
- **L1 Suggest** — copilot drafts replies; you send every one.
- **L2 One-tap** — drafts are pre-approved for one keystroke send.
- **L3 Auto-reply** — replies in allow-listed intents that pass every guardrail send themselves.
- **L4 Auto-act** — bounded actions (stock fixes, markdowns above your floor) execute themselves, with undo.

### LEFT COLUMN — Buyer chat firehose

Header: `Buyer chat` with a live per-minute message rate, and a segmented toggle
`All / Admitted`. Below, a reverse-chronological list (newest at the bottom, auto-scroll to
bottom unless the operator has scrolled up — then show a "N new" pill that scrolls back down).

Each message row is compact (two lines max):
- Author in accent-tinted text, message text in primary text.
- A small intent badge on the right: `price`, `stock`, `sizing`, `shipping`, `returns`,
  `authenticity`, `compare`, `discount`, `hype`, `other`. Each intent gets its own muted
  color chip. Badge appears a moment after the message (classification is async) — animate it in.
- Messages that were **not admitted** (filtered out as hype/spam/rate-capped) render at 45%
  opacity with a tiny `·` prefix, and show the drop reason on hover. In `Admitted` mode they
  are hidden entirely.
- When a message has become a proposal in the center column, show a thin accent left border
  and, on hover, highlight the linked proposal card.

At the bottom of this column: a small composer input `Inject a buyer message…` that posts to
`POST /api/chat/inject` — used for demos and manual testing. Enter sends.

### CENTER COLUMN — Reply proposal queue

This is where the operator lives. Header: `Proposals`, the count of items awaiting a decision,
and a muted keyboard legend: `J/K move · Enter send · E edit · X dismiss · R regenerate`.

A vertical list of **proposal cards**, newest first. Exactly one card is "focused" at a time;
the focused card has a 2px accent ring and a slightly raised surface. `J`/`K` and the arrow
keys move focus. The focused card scrolls itself into view.

Each card, top to bottom:

1. **The buyer's question** — author + verbatim text, in a slightly inset quote block with a
   left rule. Above it, small and muted: time ago, and the intent badge.

2. **The drafted reply**.
   - While `status === "drafting"`, the text streams in token by token with a blinking caret,
     and a thin indeterminate progress line sits under the card header. Do not show buttons yet.
   - When ready, render the final reply in the primary text size (this is the thing the
     operator actually reads — give it the most visual weight in the card).
   - If the operator presses `E`, the reply becomes an inline editable textarea in place
     (autofocus, text selected at the end). `Cmd/Ctrl+Enter` sends the edited text, `Escape`
     cancels. Never open a modal.

3. **Provenance chips** — a horizontal wrap of small chips, one per `evidence` item. Each chip
   shows the `label` (e.g. `Listing · price`, `Policy · returns`, `Market · comps`) with a tiny
   source icon. Hovering a chip opens a popover with the full `text` of the fact and its
   `factId` in monospace. Chips are the trust surface — make them legible, not decorative.
   If `evidence` is empty, render a muted `No grounding facts — abstained` chip instead.

4. **Guardrail strip** — a single row of six small pills, always all six present and in this
   fixed order so the operator learns the positions: `price · stock · policy · grounding ·
   tone · pii`. Each pill is green when that guard returned `allow`, amber for `revise`,
   red for `block`, and neutral grey when the guard did not apply. Hovering shows the guard's
   `reason` plus the `expected` vs `found` detail when present. To the right of the strip:
   a confidence readout (`0.86` in monospace with a 3-segment mini bar), and the total latency
   (`1.24s`) — red if `spans.overBudget`.
   If `repaired` is true, show a small amber `repaired` tag with a tooltip:
   "First draft failed a guardrail and was re-grounded before you saw it."

5. **Actions row** — `Send` (primary, accent), `Edit`, `Dismiss`, `Regenerate`. Show the
   keyboard key inside each button as a small kbd glyph.

Card variants by `status`:
- `ready` — as described.
- `needs_review` — amber left edge; the `Send` button reads `Send anyway` and is secondary
  rather than accent.
- `blocked` — red left edge, reply text shown struck-through and dimmed, a prominent line
  stating which guard blocked it and why, and the only actions are `Edit` and `Dismiss`.
  This state is important — make it unmistakable but not alarming.
- `sent` / `auto_sent` — card collapses to a single compact line (green check, the sent text
  truncated, latency, and `auto` tag when auto-sent) and slides down into a "Recent" section
  below the live queue. Keep the last 20.
- `dismissed` — animate out.

Empty state: a centered, quiet message — `Listening to chat. Proposals appear here.` with a
subtle animated three-dot indicator. Not an illustration.

### RIGHT COLUMN — Show rail

Three stacked sections, each independently scrollable if needed.

**1. Pinned lot** (top, ~200px)
A product card for the currently pinned listing: image thumbnail (use a placeholder image
service), title, size + condition chips, and the price in large tabular monospace. Under it, a
compact stat row: `stock`, `sold this show`, `views`. A `v12` version tag in muted monospace in
the corner (this is the listing version the copilot grounds against — surface it). When the
listing updates, briefly flash the changed field's background in the accent color.
Below it, a horizontal strip of the next 4 lots in the queue as small thumbnails with prices.

**2. Action proposals**
Header `Actions` with a count. A list of action cards, each showing:
- A kind icon and a plain-language summary line, e.g.
  `Mark down AJ1 Chicago · size 10 — $412 → $370 (−10%)`.
- The copilot's `rationale` in muted smaller text, e.g. "4 buyers asked for a discount in the
  last 3 minutes; median comp is $368."
- A **preflight checklist** — each check as a row with a tick or cross and its detail, e.g.
  `✓ above floor price ($355)`, `✓ within 15% max discount`, `✗ show action budget reached`.
  When any check fails, the whole card is disabled with a red tint and `Approve` is not offered.
- `Approve` / `Reject` buttons.
- Status transitions to render distinctly: `committing` (spinner + "committing…"),
  `committed` (green, shows an **Undo** button with a live countdown of the remaining undo
  window in seconds, e.g. `Undo · 74s`), `failed` (red with the error text and a `Retry`
  button), `rolled_back` (muted with a struck summary).
- Show the `idempotencyKey` truncated in monospace at the bottom-right of the card, muted.
  Small detail, but it signals the system is real.

**3. Audit log**
Header `Audit` with a tiny chain-link icon and the current chain height. A dense
reverse-chronological list. Each entry is one line: timestamp in monospace, an actor badge
(`copilot` / `seller` / `system`), and the summary. Entries are colored by kind
(committed = green, rolled_back = amber, failed/blocked = red, everything else neutral).
Hovering shows the entry's `hash` and `prevHash` in monospace in a popover, and expanding shows
the `detail` object pretty-printed. Include a small `Verify chain` button that walks the loaded
entries, confirms each `prevHash` matches the previous entry's `hash`, and shows an inline
`✓ chain intact (N entries)` or a red mismatch notice.

### Research (a command palette, not a column)

`Cmd/Ctrl+K` opens a command palette overlay with a single input: `Research a product…`.
Typing and pressing Enter posts to `POST /api/research`. The result renders inside the palette
as a **research card**: a headline, a median price in large monospace, a table of recent
comparable sales (title, size, condition, sold price, date), a one-line pricing suggestion, an
optional spec-difference table, provenance chips, and the latency in the corner (red if over
2000ms). `Escape` closes. Also offer quick actions in the palette when nothing is typed:
`Research the pinned lot`, `Set autonomy level`, `Verify audit chain`.

---

## Design language

This is a broadcast operator tool, not a marketing site. Aim for the density and restraint of a
trading terminal or a video switcher — calm, dark, precise. Avoid gradients, glassmorphism,
large rounded cards, drop shadows, emoji, and decorative illustration.

- **Dark only.** Canvas `#0A0B0D`. Panels `#101216`. Elevated surfaces `#161920`.
  Hairline borders `#23262E` at 1px — borders, not shadows, do the separating.
- **Text.** Primary `#E8EAED`, secondary `#9BA1AC`, muted `#646B77`.
- **Accent** a single restrained cyan-leaning blue `#4C8DFF`, used for focus rings, the primary
  button, and live indicators. Nothing else is accent-colored.
- **Semantic** green `#3FB950`, amber `#D29922`, red `#F85149`. Use them only for verdicts,
  statuses and thresholds — never decoratively.
- **Type.** Inter (or the system UI stack) for prose. A monospace face (JetBrains Mono or
  ui-monospace) for every number that a human compares: latency, prices, versions, hashes,
  confidence, timers. Use `font-variant-numeric: tabular-nums` on all of them so digits do not
  jitter as values update. Base size 13px, dense line heights. Section headers 11px uppercase
  with letterspacing, in muted.
- **Radius** small and consistent: 6px on cards, 4px on chips and buttons.
- **Motion** fast and functional: 120–160ms ease-out. Animate only what carries meaning —
  a card arriving, a value changing, a state transition. No parallax, no page transitions.
  Respect `prefers-reduced-motion` by disabling transforms and keeping only opacity fades.
- **Accessibility.** All interactive elements reachable and operable by keyboard with a visible
  accent focus ring. Every color-coded state also carries text or an icon — never color alone.
  Live regions announce new proposals and action state changes politely.

## Keyboard shortcuts (implement all of these)

| Key | Action |
|---|---|
| `J` / `↓` | focus next proposal |
| `K` / `↑` | focus previous proposal |
| `Enter` | send the focused proposal |
| `E` | edit the focused proposal inline |
| `Cmd/Ctrl+Enter` | send while editing |
| `Escape` | cancel edit / close palette |
| `X` | dismiss the focused proposal |
| `R` | regenerate the focused proposal |
| `A` | approve the top pending action proposal |
| `U` | undo the most recent undoable committed action |
| `Cmd/Ctrl+K` | open the research command palette |
| `?` | toggle a keyboard-shortcut overlay |

Shortcuts must not fire while a text input or textarea has focus.

---

## API contract — implement exactly this, invent nothing else

Put every network call in `src/lib/api.ts` and every type in `src/lib/types.ts`.

Read the base URL from `import.meta.env.VITE_API_BASE` (default `http://localhost:8790`), and
a mock switch from `import.meta.env.VITE_USE_MOCKS` (default `"true"`).

**When `VITE_USE_MOCKS === "true"`** the app must run fully standalone against a mock driver in
`src/lib/mockStream.ts` that simulates a believable live show: a buyer message every 1–3
seconds drawn from a realistic script, proposals that stream their draft in character by
character over 500–1200ms, occasional `blocked` and `needs_review` proposals, action proposals
appearing every 30–60s, and metrics that drift. Mock mode is what a reviewer sees first, so
make the simulated show genuinely convincing. **When it is `"false"`, the exact same UI must
work against the real endpoints with no component changes.**

### Server-sent events

`GET {BASE}/api/stream` — an `EventSource`. Named events, each with a JSON payload:

| event | payload |
|---|---|
| `hello` | `{ show: ShowState, listings: Listing[], proposals: ReplyProposal[], actions: ActionProposal[], audit: AuditEntry[], metrics: Metrics, context: ShowContext }` |
| `chat` | `ChatMessage` |
| `proposal` | `ReplyProposal` — upsert by `id`; arrives repeatedly while the draft streams |
| `action` | `ActionProposal` — upsert by `id` |
| `listing` | `Listing` — upsert by `id` |
| `audit` | `AuditEntry` — append |
| `metrics` | `Metrics` — replace |
| `context` | `ShowContext` — replace |

Reconnect with backoff if the stream drops, and show a small amber `reconnecting…` pill in the
top bar while disconnected.

### REST

| method | path | body | returns |
|---|---|---|---|
| `POST` | `/api/proposals/:id/send` | `{ text?: string }` | `ReplyProposal` |
| `POST` | `/api/proposals/:id/dismiss` | — | `ReplyProposal` |
| `POST` | `/api/proposals/:id/regenerate` | — | `ReplyProposal` |
| `POST` | `/api/actions/:id/approve` | — | `ActionProposal` |
| `POST` | `/api/actions/:id/reject` | — | `ActionProposal` |
| `POST` | `/api/actions/:id/rollback` | — | `ActionProposal` |
| `POST` | `/api/autonomy` | `{ level: AutonomyLevel }` | `ShowState` |
| `POST` | `/api/chat/inject` | `{ author: string, text: string }` | `ChatMessage` |
| `POST` | `/api/research` | `{ query: string, listingId?: string }` | `ResearchCard` |
| `GET` | `/api/audit?limit=200` | — | `AuditEntry[]` |
| `GET` | `/api/metrics` | — | `Metrics` |

All money values are **integer cents** (`priceCents: 41200` renders as `$412.00`). Write one
`formatMoney` helper and use it everywhere. All timestamps are ISO 8601 strings.

### Types — copy these verbatim into `src/lib/types.ts`

```ts
export type AutonomyLevel =
  | "L0_OBSERVE" | "L1_SUGGEST" | "L2_ONE_TAP" | "L3_AUTO_REPLY" | "L4_AUTO_ACT";

export type ChatIntent =
  | "price_question" | "availability" | "sizing" | "shipping" | "returns"
  | "authenticity" | "comparison" | "discount_request" | "hype" | "other";

export type GuardName = "price" | "availability" | "policy" | "claim_grounding" | "tone" | "pii";
export type Verdict = "allow" | "revise" | "block";

export interface ShowState {
  id: string;
  title: string;
  sellerHandle: string;
  startedAt: string;
  viewers: number;
  pinnedListingId: string | null;
  lotQueue: string[];
  autonomyLevel: AutonomyLevel;
  undoWindowS: number;
}

export interface Listing {
  id: string;
  sku: string;
  title: string;
  brand: string;
  model: string;
  colorway: string;
  size: string;
  condition: "DS" | "VNDS" | "USED";
  priceCents: number;
  floorPriceCents: number;
  costCents: number;
  qty: number;
  soldThisShow: number;
  views: number;
  state: "draft" | "queued" | "live" | "ended";
  pinned: boolean;
  version: number;
  imageUrl: string;
  shippingProfile: string;
  authenticated: boolean;
  certId: string | null;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  author: string;
  text: string;
  at: string;
  intent: ChatIntent | null;
  admitted: boolean;
  dropReason?: string;
  proposalId?: string;
}

export interface Evidence {
  factId: string;
  source: "listing" | "policy" | "catalog" | "qa" | "market";
  label: string;
  text: string;
  score: number;
  listingVersion?: number;
}

export interface GuardResult {
  guard: GuardName;
  verdict: Verdict | "n/a";
  reason?: string;
  detail?: { expected?: string; found?: string };
}

export interface Claim { text: string; factId: string; supported: boolean }

export interface SpanBreakdown {
  admitMs: number; classifyMs: number; retrieveMs: number;
  composeMs: number; guardMs: number; repairMs: number;
  totalMs: number; cacheHit: boolean; budgetMs: number; overBudget: boolean;
}

export interface ReplyProposal {
  id: string;
  message: ChatMessage;
  status: "drafting" | "ready" | "needs_review" | "blocked" | "sent" | "auto_sent" | "dismissed";
  draft: string;
  claims: Claim[];
  evidence: Evidence[];
  guards: GuardResult[];
  verdict: Verdict;
  confidence: number;
  repaired: boolean;
  spans: SpanBreakdown;
  createdAt: string;
  sentText?: string;
}

export type ActionKind =
  | "push_listing" | "swap_pinned" | "markdown_price" | "adjust_stock" | "end_listing";

export interface PreflightCheck { name: string; ok: boolean; detail: string }

export interface ActionProposal {
  id: string;
  kind: ActionKind;
  listingId: string;
  listingTitle: string;
  summary: string;
  rationale: string;
  params: Record<string, unknown>;
  before: Record<string, unknown>;
  status: "proposed" | "preflight_failed" | "approved" | "committing"
        | "committed" | "failed" | "rolled_back" | "rejected";
  preflight: { ok: boolean; checks: PreflightCheck[] };
  idempotencyKey: string;
  undoableUntil: string | null;
  error?: string;
  createdAt: string;
}

export interface AuditEntry {
  seq: number;
  at: string;
  hash: string;
  prevHash: string;
  kind: "action_proposed" | "action_preflight_failed" | "action_committed"
      | "action_failed" | "action_rolled_back" | "reply_sent" | "reply_blocked"
      | "autonomy_changed";
  actorType: "copilot" | "seller" | "system";
  summary: string;
  detail: Record<string, unknown>;
}

export interface Metrics {
  proposals: number; sent: number; autoSent: number; dismissed: number; blocked: number;
  guardBlocks: Record<GuardName, number>;
  latency: { p50: number; p95: number; p99: number; budgetMs: number; breaches: number };
  cacheHitRate: number;
  answeredRate: number;
  actionsCommitted: number;
  actionsRolledBack: number;
}

export interface ShowContext {
  currentTopic: string;
  listingInFocus: string | null;
  recentPoints: string[];
  tone: string | null;
  updatedAt: string;
}

export interface Comp {
  title: string; soldPriceCents: number; soldAt: string; condition: string; size: string;
}

export interface ResearchCard {
  query: string;
  listingId: string | null;
  headline: string;
  comps: Comp[];
  medianCents: number;
  suggestion: string;
  specDiff?: { attribute: string; ours: string; theirs: string }[];
  latencyMs: number;
  evidence: Evidence[];
}
```

## Mock data to seed

Seller `@kicksbyrae`, show `Friday Night Grails — Ep. 42`, 247 viewers. Listings drawn from
sneakers and streetwear, for example: `Air Jordan 1 Retro High OG "Chicago Reimagined" — size
10, DS, $412.00, floor $355.00, qty 1, v12, pinned`; `New Balance 990v6 Grey — size 9.5, VNDS,
$218.00`; `Supreme Box Logo Hoodie FW22 Black — size L, DS, $565.00`; `Nike Dunk Low Panda —
size 11, DS, $128.00, qty 3`; `Yeezy Slide Bone — size 10, DS, $92.00`.

Buyer chat should read like a real show: `"what's the lowest on the chicagos"`,
`"does it come with the box?"`, `"ship to canada?"`, `"is that the reimagined or the 2015"`,
`"size 10 still there??"`, `"W"`, `"LETS GOOO"`, `"how much for the panda"`, `"return policy?"`,
`"are these authenticated"`, `"can you do 380"`.

Include at least one mock proposal in each interesting state so all the UI is visible without
waiting: one `ready` with four provenance chips and all-green guards; one `needs_review` with
an amber `tone` guard; one **`blocked` by the `price` guard** with the detail
`expected: "$370.00 (v13)"` / `found: "$412.00"` and the reason
`"Reply quotes a price from listing version 12; the live listing is version 13 after a markdown."`
— this is the system's signature failure case, make sure it looks right; and one `sent`.

Include one action proposal of kind `markdown_price` in `proposed` state with three passing
preflight checks, and one `committed` action with a live `Undo` countdown.

## Definition of done

- Runs with no backend, showing a convincing live show, on first load.
- Every keyboard shortcut works.
- All proposal statuses, all action statuses, and all six guardrail states render correctly.
- Nothing scrolls at the page level; the three columns scroll independently.
- All numeric values use tabular monospace and do not jitter as they update.
- `src/lib/api.ts` is the single place any URL appears.
