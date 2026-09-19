// A DOM small enough to keep, so a selector can be tested without a browser.
//
// The scraped surfaces read their pages with CSS selectors, and a selector is
// only ever wrong at runtime — against a live room, at whatever hour the room
// happens to be on. That is a terrible place to find out, and it is where the
// eBay watcher's selectors have had to be found out, because its DOM read is an
// inline `page.evaluate` callback that cannot run anywhere else.
//
// `extractInPage` was written to run in two places instead (src/surfaces/
// scrapeDom.ts), and this is the second one: enough of `Element` to satisfy it,
// over an HTML string, in Node, with no dependency and no browser. The suite
// then asserts on fixtures, and a broken selector is a failing test.
//
// It is deliberately NOT a browser. It implements the selector grammar the
// scrapers actually use — tag, `#id`, `.class`, `[attr]`, `[attr="v"]`,
// `[attr*="v"]`, `[attr^="v"]`, `[attr$="v"]`, descendant chains, comma lists —
// and nothing else. The browser remains the authority on what the real page
// says; this only keeps the selectors honest about the shape they assume, which
// is what the fixtures record.
//
// The two were checked against each other on 2026-09-18: `extractInPage` run
// through `page.evaluate` in real Chromium over all four fixtures returns
// output identical, field for field, to the same function run over this parser.
// Worth re-running by hand after any change here — it is the only thing that
// says the second implementation still agrees with the first.

import type { DocumentLike, ElementLike } from "../src/surfaces/scrapeDom.js";

interface Node {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
  parent: Node | null;
  text: string | null;
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
/** Elements whose content is text, not markup. A `<` inside one of these is a
 *  less-than sign, and parsing it as a tag is how a hand-written parser
 *  swallows the rest of the document. */
const RAW = new Set(["script", "style", "textarea", "title"]);

// The named entities a consumer page actually uses. Typographic quotes and
// dashes are on the list because chat text is full of them and a fixture that
// rendered "what&rsquo;s shipping" as literal ampersand-r-s-q-u-o would make
// the test disagree with the browser about the message body — which is the one
// thing the extractor is for.
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…",
};

function decode(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const known = ENTITIES[name.toLowerCase()];
    if (known) return known;
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return whole;
  });
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([-a-zA-Z_:@][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    attrs[m[1]!.toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/** Tolerant on purpose: a trimmed fixture is hand-edited, and an unclosed tag
 *  should cost a wrong parent, not an exception in the middle of a test run. */
function parse(html: string): Node {
  const root: Node = { tag: "#root", attrs: {}, children: [], parent: null, text: null };
  let cur = root;
  const tagRe = /<(\/)?([a-zA-Z][-a-zA-Z0-9:]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?>/g;
  let at = 0;

  const addText = (s: string) => {
    if (!s) return;
    cur.children.push({ tag: "#text", attrs: {}, children: [], parent: cur, text: decode(s) });
  };

  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    addText(html.slice(at, m.index));
    at = tagRe.lastIndex;
    const tag = m[2]!.toLowerCase();

    if (m[1]) {
      // A close tag: pop to the nearest matching ancestor, and ignore it
      // entirely when there is none rather than unwinding the whole document.
      let n: Node | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n?.parent) cur = n.parent;
      continue;
    }

    const el: Node = { tag, attrs: parseAttrs(m[3] || ""), children: [], parent: cur, text: null };
    cur.children.push(el);
    if (VOID.has(tag) || m[4]) continue;

    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, at);
      const end = close === -1 ? html.length : close;
      el.children.push({ tag: "#text", attrs: {}, children: [], parent: el, text: html.slice(at, end) });
      at = end;
      tagRe.lastIndex = end;
      continue;
    }
    cur = el;
  }
  addText(html.slice(at));
  return root;
}

// ── selectors ────────────────────────────────────────────────────────────────

interface Simple {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; op: string | null; value: string }[];
}

function parseSimple(s: string): Simple {
  const out: Simple = { tag: null, id: null, classes: [], attrs: [] };
  const re = /([a-zA-Z][-a-zA-Z0-9]*)|#([-\w]+)|\.([-\w]+)|\[\s*([-\w:]+)\s*(?:([*^$|~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.id = m[2];
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) out.attrs.push({ name: m[4].toLowerCase(), op: m[5] ?? null, value: m[6] ?? m[7] ?? m[8] ?? "" });
  }
  return out;
}

function matchesSimple(n: Node, s: Simple): boolean {
  if (n.tag.startsWith("#")) return false;
  if (s.tag && n.tag !== s.tag) return false;
  if (s.id && n.attrs.id !== s.id) return false;
  if (s.classes.length) {
    const have = new Set((n.attrs.class || "").split(/\s+/).filter(Boolean));
    if (!s.classes.every((c) => have.has(c))) return false;
  }
  for (const a of s.attrs) {
    const v = n.attrs[a.name];
    if (v === undefined) return false;
    if (!a.op) continue;
    // Attribute VALUES are case-sensitive in CSS, which matters here: the
    // hashed class names these selectors chase are camelCase on one platform
    // and kebab-case on the other, and the scrapers list both spellings
    // precisely because a browser would not fold them together either.
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
  }
  return true;
}

/** Descendant combinators only — the scrapers use no others, and a `>` that
 *  silently behaved like a space would be worse than one that throws. */
function matchesChain(n: Node, chain: Simple[]): boolean {
  if (!matchesSimple(n, chain[chain.length - 1]!)) return false;
  let i = chain.length - 2;
  let p = n.parent;
  while (i >= 0 && p) {
    if (matchesSimple(p, chain[i]!)) i--;
    p = p.parent;
  }
  return i < 0;
}

function compile(selector: string): Simple[][] {
  return selector
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (/[>+~]/.test(part)) throw new Error(`domlite: unsupported combinator in "${part}"`);
      return part.split(/\s+/).map(parseSimple);
    });
}

function* descendants(n: Node): Generator<Node> {
  for (const c of n.children) {
    if (!c.tag.startsWith("#")) yield c;
    yield* descendants(c);
  }
}

class El implements ElementLike {
  constructor(private n: Node) {}

  getAttribute(name: string): string | null {
    const v = this.n.attrs[name.toLowerCase()];
    return v === undefined ? null : v;
  }

  get textContent(): string {
    let out = "";
    const walk = (n: Node) => {
      if (n.text !== null) out += n.text;
      for (const c of n.children) walk(c);
    };
    walk(this.n);
    return out;
  }

  querySelector(selector: string): ElementLike | null {
    for (const e of this.querySelectorAll(selector)) return e;
    return null;
  }

  querySelectorAll(selector: string): ElementLike[] {
    const chains = compile(selector);
    const out: ElementLike[] = [];
    for (const d of descendants(this.n)) {
      if (chains.some((c) => matchesChain(d, c))) out.push(new El(d));
    }
    return out;
  }
}

/** Parse an HTML string into something `extractInPage` can read. */
export function domFromHtml(html: string): DocumentLike {
  return new El(parse(html));
}

/**
 * Run `fn` with `document` pointing at a parsed fixture.
 *
 * `extractInPage` reads `globalThis.document` because that is the only way a
 * function handed to `page.evaluate` can reach the page — it is serialised by
 * `toString()` and arrives in the browser with no scope. Node has no
 * `document`, so borrowing the name for the length of one call is free, and
 * restoring it afterwards keeps one test from leaking into the next.
 */
export function withDocument<T>(doc: DocumentLike, fn: () => T): T {
  const g = globalThis as unknown as { document?: unknown };
  const had = "document" in g;
  const before = g.document;
  g.document = doc;
  try {
    return fn();
  } finally {
    if (had) g.document = before;
    else delete g.document;
  }
}
