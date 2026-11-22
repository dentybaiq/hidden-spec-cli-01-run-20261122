// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four shapes (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls) and applies it to the tree in the working
// directory, all or nothing. The contract is SPEC.md v1 in this repository.
//
// When MAKEFUN_ENV_URL is set this file hands the trial over to runner.ts,
// which runs the CLI once per check and posts the results.
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------

type Break = '\r\n' | '\n';

/** A text file, kept as lines plus the facts needed to write it back. */
interface Doc {
  lines: string[];
  crlf: boolean;
  trail: boolean;
}

function trimEdge(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function trimTail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Split patch text the way SPEC section 3 says: at \n, one trailing \r off. */
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function docFromText(text: string): Doc {
  if (text === '') return { lines: [], crlf: false, trail: false };
  const firstLf = text.indexOf('\n');
  const crlf = firstLf > 0 && text[firstLf - 1] === '\r';
  const brk: Break = crlf ? '\r\n' : '\n';
  const parts = text.split(brk);
  const trail = text.endsWith(brk);
  if (trail) parts.pop();
  return { lines: parts, crlf, trail };
}

function docToText(d: Doc): string {
  if (d.lines.length === 0) return '';
  const brk: Break = d.crlf ? '\r\n' : '\n';
  return d.lines.join(brk) + (d.trail ? brk : '');
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

/** Drop a leading a/ or b/ from a unified-diff path. */
function dropAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

class ParseFail extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5)
// ---------------------------------------------------------------------------

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimTail(line);
  return trimEdge(line);
}

/** Start positions where `old` matches `fileLines` at `tier` (may overlap). */
function occurrencesAt(fileLines: string[], old: string[], tier: number): number[] {
  const hits: number[] = [];
  if (old.length === 0) return hits;
  const want = old.map((l) => normLine(l, tier));
  for (let i = 0; i + old.length <= fileLines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(fileLines[i + j], tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  return hits;
}

/** First tier (0, then 1, then 2; only 0 when strict) with a hit at/after `from`. */
function tierHits(
  fileLines: string[],
  old: string[],
  strict: boolean,
  from: number,
): { tier: number; at: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = occurrencesAt(fileLines, old, t).filter((i) => i >= from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of a replacement: `ctx >= 0` means a context line (index into old). */
interface NewLine {
  text: string;
  ctx: number;
}

/** Build the replacement lines for a match at `at`, honouring section 5. */
function spliceLines(
  fileLines: string[],
  at: number,
  old: string[],
  repl: NewLine[],
  tier: number,
): string[] {
  const f = fileLines.length > at ? leadWs(fileLines[at]) : '';
  const p = old.length > 0 ? leadWs(old[0]) : '';
  const out: string[] = [];
  for (const nl of repl) {
    if (nl.ctx >= 0) {
      out.push(fileLines[at + nl.ctx]);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The tree and edits
// ---------------------------------------------------------------------------

type Fail = { code: string; path: string };
type MoveRec = { old: string; nw: string };

interface Edit {
  /** Paths the edit names, old first, for the safety check. */
  paths: string[];
  run: (tree: Map<string, Doc>, moves: MoveRec[]) => Fail | null;
}

function firstUnsafe(paths: string[]): string | null {
  for (const p of paths) {
    if (!isSafePath(p)) return p;
  }
  return null;
}

function loadTree(): Map<string, Doc> {
  const out = new Map<string, Doc>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      const rel = prefix === '' ? name : `${prefix}/${name}`;
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile()) out.set(rel, docFromText(readFileSync(full, 'utf8')));
    }
  };
  walk(process.cwd(), '');
  return out;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (trimEdge(lines[i]) !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  if (trimEdge(lines[first]) === '*** Begin Patch') return 'v4a';
  const head = lines[first].replace(/^[ \t]+/, '');
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  for (const l of lines) {
    if (trimTail(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  old: string[];
  repl: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

/** Path after `--- ` / `+++ `: up to the first tab, trimmed, a/ or b/ dropped. */
function headerPath(line: string): string | null {
  const raw = trimEdge(line.slice(4).split('\t')[0]);
  if (raw === '/dev/null') return null;
  return dropAB(raw);
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface BodyItem {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

/** Parse one hunk body starting after the header at `headIdx`. */
function parseHunkBody(lines: string[], headIdx: number): { hunk: Hunk; next: number } {
  const items: BodyItem[] = [];
  let j = headIdx + 1;
  while (j < lines.length) {
    const ln = lines[j];
    if (ln.startsWith('diff --git ')) break;
    if (ln.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (ln === '') {
      items.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const c = ln[0];
    if (c === ' ') {
      items.push({ kind: 'ctx', text: ln.slice(1) });
      j += 1;
    } else if (c === '-') {
      items.push({ kind: 'del', text: ln.slice(1) });
      j += 1;
    } else if (c === '+') {
      items.push({ kind: 'add', text: ln.slice(1) });
      j += 1;
    } else if (c === '\\') {
      items.push({ kind: 'bs', text: '' });
      j += 1;
    } else {
      break;
    }
  }
  while (items.length > 0) {
    const last = items[items.length - 1];
    if (last.kind === 'ctx' && last.text === '') items.pop();
    else break;
  }
  const m = HUNK_HEAD.exec(lines[headIdx]);
  const a = m === null ? 0 : Number(m[1]);
  const old: string[] = [];
  const repl: NewLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') {
      repl.push({ text: it.text, ctx: old.length });
      old.push(it.text);
    } else if (it.kind === 'del') {
      old.push(it.text);
    } else if (it.kind === 'add') {
      repl.push({ text: it.text, ctx: -1 });
    }
  }
  // The `\` marker only matters after the last context or `+` line.
  let lastCtxAdd = -1;
  for (let k = 0; k < items.length; k += 1) {
    if (items[k].kind === 'ctx' || items[k].kind === 'add') lastCtxAdd = k;
  }
  const noEol =
    lastCtxAdd >= 0 && lastCtxAdd + 1 < items.length && items[lastCtxAdd + 1].kind === 'bs';
  return { hunk: { a, old, repl, noEol }, next: j };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hasPair = false;
  let inHeader = false;

  const openSection = (oldP: string | null, newP: string | null, pair: boolean): void => {
    cur = { oldPath: oldP, newPath: newP, creation: false, deletion: false, hunks: [] };
    sections.push(cur);
    hasPair = pair;
    inHeader = true;
  };

  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (cur === null) {
      if (ln.startsWith('diff --git ')) {
        const m = DIFF_GIT.exec(ln);
        if (m === null) throw new ParseFail(i + 1);
        openSection(m[1], m[2], false);
        i += 1;
        continue;
      }
      if (ln.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        openSection(headerPath(ln), headerPath(lines[i + 1]), true);
        i += 2;
        continue;
      }
      if (ln.startsWith('@@')) throw new ParseFail(i + 1);
      i += 1;
      continue;
    }
    if (inHeader) {
      if (ln.startsWith('@@')) {
        if (!HUNK_HEAD.test(ln)) throw new ParseFail(i + 1);
        const { hunk, next } = parseHunkBody(lines, i);
        cur.hunks.push(hunk);
        inHeader = false;
        i = next;
        continue;
      }
      if (ln.startsWith('diff --git ')) {
        const m = DIFF_GIT.exec(ln);
        if (m === null) throw new ParseFail(i + 1);
        openSection(m[1], m[2], false);
        i += 1;
        continue;
      }
      if (ln.startsWith('--- ')) {
        if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          if (hasPair) {
            openSection(headerPath(ln), headerPath(lines[i + 1]), true);
          } else {
            cur.oldPath = headerPath(ln);
            cur.newPath = headerPath(lines[i + 1]);
            hasPair = true;
          }
          i += 2;
          continue;
        }
        throw new ParseFail(i + 2);
      }
      if (ln.startsWith('rename from ')) {
        cur.oldPath = trimEdge(ln.slice('rename from '.length));
        i += 1;
        continue;
      }
      if (ln.startsWith('rename to ')) {
        cur.newPath = trimEdge(ln.slice('rename to '.length));
        i += 1;
        continue;
      }
      if (ln.startsWith('new file mode')) {
        cur.creation = true;
        i += 1;
        continue;
      }
      if (ln.startsWith('deleted file mode')) {
        cur.deletion = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    // After the first hunk: new hunks, new sections, or ignored prose.
    if (ln.startsWith('@@')) {
      if (!HUNK_HEAD.test(ln)) throw new ParseFail(i + 1);
      const { hunk, next } = parseHunkBody(lines, i);
      cur.hunks.push(hunk);
      i = next;
      continue;
    }
    if (ln.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(ln);
      if (m === null) throw new ParseFail(i + 1);
      openSection(m[1], m[2], false);
      i += 1;
      continue;
    }
    if (ln.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      openSection(headerPath(ln), headerPath(lines[i + 1]), true);
      i += 2;
      continue;
    }
    i += 1;
  }

  return sections.map((sec) => {
    const paths: string[] = [];
    if (sec.oldPath !== null) paths.push(sec.oldPath);
    if (sec.newPath !== null && sec.newPath !== sec.oldPath) paths.push(sec.newPath);
    return {
      paths,
      run: (tree, moves) => runUnifiedSection(sec, tree, moves, strict),
    } as Edit;
  });
}

function runUnifiedSection(
  sec: UniSection,
  tree: Map<string, Doc>,
  moves: MoveRec[],
  strict: boolean,
): Fail | null {
  const bad = firstUnsafe([sec.oldPath, sec.newPath].filter((p): p is string => p !== null));
  if (bad !== null) return { code: 'unsafe', path: bad };
  const isCreation = sec.oldPath === null || sec.creation;
  const isDeletion = !isCreation && (sec.newPath === null || sec.deletion);
  if (isCreation) {
    const np = sec.newPath;
    if (np === null) return null;
    if (tree.has(np)) return { code: 'exists', path: np };
    const plus: string[] = [];
    let lastPlusHunk: Hunk | null = null;
    for (const h of sec.hunks) {
      let added = false;
      for (const nl of h.repl) {
        if (nl.ctx < 0) {
          plus.push(nl.text);
          added = true;
        }
      }
      if (added) lastPlusHunk = h;
    }
    const noEol = lastPlusHunk !== null ? lastPlusHunk.noEol : false;
    tree.set(np, {
      lines: plus,
      crlf: false,
      trail: plus.length === 0 ? false : !noEol,
    });
    return null;
  }
  if (isDeletion) {
    const op = sec.oldPath;
    if (op === null) return null;
    if (!tree.has(op)) return { code: 'missing', path: op };
    tree.delete(op);
    return null;
  }
  const op = sec.oldPath;
  const np = sec.newPath;
  if (op === null || np === null) return null;
  if (op !== np) {
    if (!tree.has(op)) return { code: 'missing', path: op };
    if (tree.has(np)) return { code: 'exists', path: np };
    const got = applyHunks(tree.get(op) as Doc, sec.hunks, strict);
    if (!got.ok) return { code: got.code, path: op };
    tree.delete(op);
    tree.set(np, got.doc);
    moves.push({ old: op, nw: np });
    return null;
  }
  if (!tree.has(op)) return { code: 'missing', path: op };
  const got = applyHunks(tree.get(op) as Doc, sec.hunks, strict);
  if (!got.ok) return { code: got.code, path: op };
  tree.set(op, got.doc);
  return null;
}

function applyHunks(
  file: Doc,
  hunks: Hunk[],
  strict: boolean,
): { ok: true; doc: Doc } | { ok: false; code: string } {
  let cur = file;
  let d = 0;
  for (const h of hunks) {
    const r = applyHunk(cur, h, d, strict);
    if (!r.ok) return r;
    cur = r.doc;
    d += h.repl.length - h.old.length;
  }
  return { ok: true, doc: cur };
}

function applyHunk(
  file: Doc,
  h: Hunk,
  d: number,
  strict: boolean,
): { ok: true; doc: Doc } | { ok: false; code: string } {
  if (h.old.length === 0) {
    const pos = Math.max(0, Math.min(h.a + d, file.lines.length));
    const inserted = h.repl.map((nl) => nl.text);
    const lines = [...file.lines.slice(0, pos), ...inserted, ...file.lines.slice(pos)];
    const trail = pos === file.lines.length ? !h.noEol : file.trail;
    return { ok: true, doc: { lines, crlf: file.crlf, trail } };
  }
  const found = tierHits(file.lines, h.old, strict, 0);
  if (found === null) return { ok: false, code: 'no-match' };
  const target = h.a - 1 + d;
  let best = found.at[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.at) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const repl = spliceLines(file.lines, best, h.old, h.repl, found.tier);
  const lines = [...file.lines.slice(0, best), ...repl, ...file.lines.slice(best + h.old.length)];
  const trail = best + h.old.length === file.lines.length ? !h.noEol : file.trail;
  return { ok: true, doc: { lines, crlf: file.crlf, trail } };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimTail(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const t = trimEdge(lines[j]);
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFail(searchNo);
    }
    let eq = -1;
    let k = i + 1;
    while (k < lines.length) {
      if (trimTail(lines[k]) === '=======') {
        eq = k;
        break;
      }
      if (trimTail(lines[k]) === '>>>>>>> REPLACE') break;
      k += 1;
    }
    if (eq === -1) throw new ParseFail(searchNo);
    let rep = -1;
    k = eq + 1;
    while (k < lines.length) {
      if (trimTail(lines[k]) === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      k += 1;
    }
    if (rep === -1) throw new ParseFail(searchNo);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push({
      paths: [p],
      run: (tree) => runSearchReplace(p, oldLines, newLines, tree, strict),
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function runSearchReplace(
  path: string,
  oldLines: string[],
  newLines: string[],
  tree: Map<string, Doc>,
  strict: boolean,
): Fail | null {
  const bad = firstUnsafe([path]);
  if (bad !== null) return { code: 'unsafe', path: bad };
  if (oldLines.length === 0) {
    if (tree.has(path)) return { code: 'exists', path };
    tree.set(path, { lines: [...newLines], crlf: false, trail: true });
    return null;
  }
  const file = tree.get(path);
  if (file === undefined) return { code: 'missing', path };
  const found = tierHits(file.lines, oldLines, strict, 0);
  if (found === null) return { code: 'no-match', path };
  if (found.at.length !== 1) return { code: 'ambiguous', path };
  const at = found.at[0];
  const repl = spliceLines(
    file.lines,
    at,
    oldLines,
    newLines.map((t) => ({ text: t, ctx: -1 })),
    found.tier,
  );
  const lines = [...file.lines.slice(0, at), ...repl, ...file.lines.slice(at + oldLines.length)];
  tree.set(path, { lines, crlf: file.crlf, trail: file.trail });
  return null;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyItem[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  headerLine: number;
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOVE = '*** Move to: ';

function v4aSectionStart(ln: string): 'add' | 'delete' | 'update' | null {
  if (ln.startsWith(V4A_ADD)) return 'add';
  if (ln.startsWith(V4A_DEL)) return 'delete';
  if (ln.startsWith(V4A_UPD)) return 'update';
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (trimEdge(lines[i]) !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseFail(1);
  if (trimEdge(lines[first]) !== '*** Begin Patch') throw new ParseFail(first + 1);
  if (trimEdge(lines[last]) !== '*** End Patch') throw new ParseFail(lines.length + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const ln = lines[i];
    if (trimEdge(ln) === '') {
      i += 1;
      continue;
    }
    const kind = v4aSectionStart(ln);
    if (kind === null) throw new ParseFail(i + 1);
    const prefix = kind === 'add' ? V4A_ADD : kind === 'delete' ? V4A_DEL : V4A_UPD;
    const sec: V4aSection = {
      kind,
      path: trimEdge(ln.slice(prefix.length)),
      moveTo: null,
      lines: [],
      chunks: [],
      headerLine: i + 1,
    };
    // Collect this section's raw lines (with their numbers) up to the next
    // section start or the End Patch line.
    const raw: string[] = [];
    const rawNos: number[] = [];
    i += 1;
    while (i < last) {
      if (v4aSectionStart(lines[i]) !== null) break;
      raw.push(lines[i]);
      rawNos.push(i + 1);
      i += 1;
    }
    while (raw.length > 0 && trimEdge(raw[raw.length - 1]) === '') {
      raw.pop();
      rawNos.pop();
    }
    if (kind === 'add') {
      for (let k = 0; k < raw.length; k += 1) {
        const l2 = raw[k];
        if (l2 === '') sec.lines.push('');
        else if (l2.startsWith('+')) sec.lines.push(l2.slice(1));
        else throw new ParseFail(rawNos[k]);
      }
    } else if (kind === 'delete') {
      for (let k = 0; k < raw.length; k += 1) {
        if (trimEdge(raw[k]) !== '') throw new ParseFail(rawNos[k]);
      }
    } else {
      let off = 0;
      if (raw.length > 0 && raw[0].startsWith(V4A_MOVE)) {
        sec.moveTo = trimEdge(raw[0].slice(V4A_MOVE.length));
        off = 1;
      }
      let curChunk: V4aChunk | null = null;
      for (let k = off; k < raw.length; k += 1) {
        const l2 = raw[k];
        const no = rawNos[k];
        if (l2.startsWith('@@')) {
          const anchor = trimEdge(l2.slice(2));
          curChunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          sec.chunks.push(curChunk);
          continue;
        }
        if (trimEdge(l2) === '*** End of File') {
          if (curChunk === null) throw new ParseFail(no);
          curChunk.eof = true;
          curChunk = null;
          continue;
        }
        const isBody = l2 === '' || l2.startsWith(' ') || l2.startsWith('-') || l2.startsWith('+');
        if (isBody) {
          if (curChunk === null) {
            if (sec.chunks.length === 0) {
              curChunk = { anchor: null, body: [], eof: false };
              sec.chunks.push(curChunk);
            } else if (l2 === '') {
              continue;
            } else {
              throw new ParseFail(no);
            }
          }
          const c = l2 === '' || l2[0] === ' ' ? 'ctx' : l2[0] === '-' ? 'del' : 'add';
          curChunk.body.push({ kind: c, text: l2 === '' ? '' : l2.slice(1) });
          continue;
        }
        throw new ParseFail(no);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) {
        throw new ParseFail(sec.headerLine);
      }
    }
    sections.push(sec);
  }

  return sections.map((sec) => ({
    paths: sec.moveTo !== null && sec.moveTo !== sec.path ? [sec.path, sec.moveTo] : [sec.path],
    run: (tree, moves) => runV4aSection(sec, tree, moves, strict),
  }));
}

function runV4aSection(
  sec: V4aSection,
  tree: Map<string, Doc>,
  moves: MoveRec[],
  strict: boolean,
): Fail | null {
  const paths = sec.moveTo !== null ? [sec.path, sec.moveTo] : [sec.path];
  const bad = firstUnsafe(paths);
  if (bad !== null) return { code: 'unsafe', path: bad };
  if (sec.kind === 'add') {
    if (tree.has(sec.path)) return { code: 'exists', path: sec.path };
    tree.set(sec.path, {
      lines: [...sec.lines],
      crlf: false,
      trail: sec.lines.length > 0,
    });
    return null;
  }
  if (sec.kind === 'delete') {
    if (!tree.has(sec.path)) return { code: 'missing', path: sec.path };
    tree.delete(sec.path);
    return null;
  }
  const file = tree.get(sec.path);
  if (file === undefined) return { code: 'missing', path: sec.path };
  if (sec.moveTo !== null && tree.has(sec.moveTo)) return { code: 'exists', path: sec.moveTo };
  let cur: Doc = { lines: [...file.lines], crlf: file.crlf, trail: file.trail };
  let cursor = 0;
  for (const ch of sec.chunks) {
    const r = applyV4aChunk(cur, ch, cursor, strict);
    if (!r.ok) return { code: r.code, path: sec.path };
    cur = r.doc;
    cursor = r.cursor;
  }
  if (sec.moveTo !== null) {
    tree.delete(sec.path);
    tree.set(sec.moveTo, cur);
    moves.push({ old: sec.path, nw: sec.moveTo });
  } else {
    tree.set(sec.path, cur);
  }
  return null;
}

function chunkOldNew(ch: V4aChunk): { old: string[]; repl: NewLine[] } {
  const old: string[] = [];
  const repl: NewLine[] = [];
  for (const it of ch.body) {
    if (it.kind === 'ctx') {
      repl.push({ text: it.text, ctx: old.length });
      old.push(it.text);
    } else if (it.kind === 'del') {
      old.push(it.text);
    } else {
      repl.push({ text: it.text, ctx: -1 });
    }
  }
  return { old, repl };
}

function applyV4aChunk(
  file: Doc,
  ch: V4aChunk,
  cursor: number,
  strict: boolean,
): { ok: true; doc: Doc; cursor: number } | { ok: false; code: string } {
  let at = cursor;
  if (ch.anchor !== null) {
    const anchor = ch.anchor;
    let foundAt = -1;
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      for (let k = cursor; k < file.lines.length; k += 1) {
        if (normLine(file.lines[k], t) === normLine(anchor, t)) {
          foundAt = k;
          break;
        }
      }
      if (foundAt !== -1) break;
    }
    if (foundAt === -1) return { ok: false, code: 'no-match' };
    at = foundAt + 1;
  }
  const { old, repl } = chunkOldNew(ch);
  if (old.length === 0) {
    const pos = ch.eof ? file.lines.length : at;
    const inserted = repl.map((nl) => nl.text);
    const lines = [...file.lines.slice(0, pos), ...inserted, ...file.lines.slice(pos)];
    return {
      ok: true,
      doc: { lines, crlf: file.crlf, trail: file.trail },
      cursor: pos + inserted.length,
    };
  }
  const found = tierHits(file.lines, old, strict, at);
  if (found === null) return { ok: false, code: 'no-match' };
  let pick = found.at[0];
  if (ch.eof) {
    const endOk = found.at.find((p) => p + old.length === file.lines.length);
    if (endOk === undefined) return { ok: false, code: 'no-match' };
    pick = endOk;
  }
  const made = spliceLines(file.lines, pick, old, repl, found.tier);
  const lines = [...file.lines.slice(0, pick), ...made, ...file.lines.slice(pick + old.length)];
  return {
    ok: true,
    doc: { lines, crlf: file.crlf, trail: file.trail },
    cursor: pick + made.length,
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

interface JsonOp {
  path: string;
  command: 'create' | 'str_replace' | 'insert';
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function jsonEditFromValue(v: unknown): JsonOp | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { path: o.path, command: 'create', fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return {
      path: o.path,
      command: 'str_replace',
      oldStr: o.old_str,
      newStr: typeof o.new_str === 'string' ? o.new_str : '',
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'insert', insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (trimEdge(lines[i]) !== '') {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) throw new ParseFail(1);
  const ops: JsonOp[] = [];
  const head = lines[firstNonBlank].replace(/^[ \t]+/, '');
  if (head.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFail(firstNonBlank + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFail(firstNonBlank + 1);
    for (const el of parsed) {
      const op = jsonEditFromValue(el);
      if (op === null) throw new ParseFail(firstNonBlank + 1);
      ops.push(op);
    }
  } else {
    for (let i = 0; i < lines.length; i += 1) {
      if (trimEdge(lines[i]) === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        throw new ParseFail(i + 1);
      }
      const op = jsonEditFromValue(parsed);
      if (op === null) throw new ParseFail(i + 1);
      ops.push(op);
    }
  }
  return ops.map((op) => ({
    paths: [op.path],
    run: (tree) => runJsonOp(op, tree),
  }));
}

function countOverlaps(text: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return n;
    n += 1;
    from = idx + 1;
  }
}

function runJsonOp(op: JsonOp, tree: Map<string, Doc>): Fail | null {
  const bad = firstUnsafe([op.path]);
  if (bad !== null) return { code: 'unsafe', path: bad };
  if (op.command === 'create') {
    if (tree.has(op.path)) return { code: 'exists', path: op.path };
    tree.set(op.path, docFromText(op.fileText as string));
    return null;
  }
  const file = tree.get(op.path);
  if (file === undefined) return { code: 'missing', path: op.path };
  if (op.command === 'str_replace') {
    const oldStr = op.oldStr as string;
    const newStr = op.newStr as string;
    let text = docToText(file);
    let oldN = oldStr;
    let newN = newStr;
    if (file.crlf) {
      text = text.replace(/\r\n/g, '\n');
      oldN = oldStr.replace(/\r\n/g, '\n');
      newN = newStr.replace(/\r\n/g, '\n');
    }
    const hits = countOverlaps(text, oldN);
    if (hits === 0) return { code: 'no-match', path: op.path };
    if (hits > 1) return { code: 'ambiguous', path: op.path };
    const at = text.indexOf(oldN);
    const made = text.slice(0, at) + newN + text.slice(at + oldN.length);
    const back = file.crlf ? made.replace(/\n/g, '\r\n') : made;
    tree.set(op.path, docFromText(back));
    return null;
  }
  // insert
  const lineNo = op.insertLine as number;
  if (lineNo < 0 || lineNo > file.lines.length) return { code: 'no-match', path: op.path };
  const added = splitPatch(op.newStr as string);
  const lines = [...file.lines.slice(0, lineNo), ...added, ...file.lines.slice(lineNo)];
  tree.set(op.path, { lines, crlf: file.crlf, trail: file.trail });
  return null;
}

// ---------------------------------------------------------------------------
// Patch parsing entry point
// ---------------------------------------------------------------------------

function parsePatch(fmt: string, text: string, strict: boolean): Edit[] {
  const lines = splitPatch(text);
  let edits: Edit[];
  if (fmt === 'unified') edits = parseUnified(lines, strict);
  else if (fmt === 'search-replace') edits = parseSearchReplace(lines, strict);
  else if (fmt === 'v4a') edits = parseV4a(lines, strict);
  else edits = parseJson(text, lines);
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const FORMATS = new Set(['unified', 'search-replace', 'v4a', 'json', 'auto']);

function usageError(): number {
  process.stdout.write('error: usage\n');
  return 2;
}

function runCli(argv: string[]): number {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];

  for (const arg of argv) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return usageError();
        seenCheck = true;
        checkOnly = true;
      } else if (arg === '--strict') {
        if (seenStrict) return usageError();
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return usageError();
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (!FORMATS.has(v)) return usageError();
        format = v;
      } else {
        return usageError();
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return usageError();

  const patchArg = positional.length === 1 ? positional[0] : null;
  let patchText: string;
  try {
    patchText =
      patchArg === null || patchArg === '-'
        ? readFileSync(0, 'utf8')
        : readFileSync(patchArg, 'utf8');
  } catch {
    process.stdout.write('error: no-patch\n');
    return 2;
  }

  const lines = splitPatch(patchText);
  let fmt = format;
  if (fmt === null) {
    fmt = detectFormat(lines);
    if (fmt === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
  }

  let edits: Edit[];
  try {
    edits = parsePatch(fmt, patchText, strict);
  } catch (e) {
    if (e instanceof ParseFail) {
      process.stdout.write(`error: parse ${e.line}\n`);
      return 2;
    }
    throw e;
  }

  const initial = loadTree();
  const initialText = new Map<string, string>();
  for (const [p, d] of initial) initialText.set(p, docToText(d));
  const tree = new Map<string, Doc>(initial);
  const moves: MoveRec[] = [];
  const failures: Fail[] = [];
  for (const e of edits) {
    const f = e.run(tree, moves);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(`${out.join('\n')}\n`);
    return 1;
  }

  const finalText = new Map<string, string>();
  for (const [p, d] of tree) finalText.set(p, docToText(d));

  const covered = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const m of moves) {
    if (
      initialText.has(m.old) &&
      !finalText.has(m.old) &&
      !initialText.has(m.nw) &&
      finalText.has(m.nw)
    ) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      covered.add(m.old);
      covered.add(m.nw);
    }
  }
  const allPaths = new Set([...initialText.keys(), ...finalText.keys()]);
  for (const p of allPaths) {
    if (covered.has(p)) continue;
    if (!initialText.has(p)) rows.push({ key: p, text: `A ${p}` });
    else if (!finalText.has(p)) rows.push({ key: p, text: `D ${p}` });
    else if (initialText.get(p) !== finalText.get(p)) rows.push({ key: p, text: `M ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  const outLines = rows.map((r) => r.text);
  outLines.push(`ok: ${rows.length} file${rows.length === 1 ? '' : 's'}`);

  if (!checkOnly) {
    for (const [p, text] of finalText) {
      if (initialText.get(p) !== text) {
        const full = join(process.cwd(), ...p.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
    }
    for (const p of initialText.keys()) {
      if (!finalText.has(p)) rmSync(join(process.cwd(), ...p.split('/')), { force: true });
    }
  }
  process.stdout.write(`${outLines.join('\n')}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  process.exitCode = runCli(process.argv.slice(2));
}
