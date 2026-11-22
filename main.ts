// mend — one patch tool for every AI edit format.
//
// Applies an AI-written edit to a tree of text files, in four formats:
// unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A
// patches and JSON tool calls. Everything changes or nothing does.
// Written from SPEC.md (version 1) in the session that built this entry.
// Node 22+, standard library only. Run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS: string[] = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch that cannot be read: carries the whole `error: ...` line. */
class ParseErr extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit that failed: carries its SPEC.md code and path. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at `\n`, one trailing `\r` off each, no empty piece after a final `\n`. */
function toPatchLines(text: string): string[] {
  if (text === '') return [];
  const ls = text.split('\n');
  if (text.endsWith('\n')) ls.pop();
  return ls.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and no `/` segment is empty, `.` or `..`. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** A file's lines under SPEC.md section 3. */
interface Split {
  lines: string[];
  br: string;
  finalBr: boolean;
}
function splitText(t: string): Split {
  if (t === '') return { lines: [], br: '\n', finalBr: false };
  const i = t.indexOf('\n');
  const br = i > 0 && t[i - 1] === '\r' ? '\r\n' : '\n';
  const finalBr = t.endsWith(br);
  const parts = t.split(br);
  if (finalBr) parts.pop();
  return { lines: parts, br, finalBr };
}
function joinText(s: Split): string {
  if (s.lines.length === 0) return '';
  return s.lines.join(s.br) + (s.finalBr ? s.br : '');
}

/** A `---`/`+++` path: text up to the first tab, trimmed, one leading `a/` or `b/` off. */
function stripAB(raw: string): string {
  let p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return trimTrail(s);
  return trimBoth(s);
}

/** Positions where `pat` matches `lines` at one tier; occurrences may overlap. */
function occAt(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0 || pat.length > lines.length) return out;
  const np = pat.map((l) => normLine(l, tier));
  for (let i = 0; i + pat.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < pat.length; j++) {
      if (normLine(lines[i + j]!, tier) !== np[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) with an occurrence at or after `from`. */
function firstTier(lines: string[], pat: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occAt(lines, pat, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One hunk or chunk: old lines O, new lines N, and for each line of N the index in O it is a context line of (-1 when it is not one). */
interface Hunk {
  o: string[];
  n: string[];
  ctx: number[];
}

/** Replace O at `at` with N (SPEC.md section 5): context lines are the file's own matched lines; at tier 2 every other line of N that starts with P, the leading whitespace of O's first line, has that P replaced by F, the leading whitespace of the file's first matched line. */
function applyLines(lines: string[], at: number, h: Hunk, tier: number): string[] {
  const out = lines.slice(0, at);
  const F = tier === 2 ? leadWs(lines[at] ?? '') : '';
  const P = tier === 2 ? leadWs(h.o[0] ?? '') : '';
  for (let j = 0; j < h.n.length; j++) {
    const c = h.ctx[j]!;
    if (c !== -1) {
      out.push(lines[at + c]!);
      continue;
    }
    const l = h.n[j]!;
    if (tier === 2 && l !== '' && l.trim() !== '' && l.startsWith(P)) out.push(F + l.slice(P.length));
    else out.push(l);
  }
  out.push(...lines.slice(at + h.o.length));
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly origCache = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  orig(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.orig(p);
  }
}

/** An edit: applied to the tree, it answers the moves it made as [old, new] pairs (none for most edits). */
type EditFn = (t: Tree) => Array<[string, string]>;

/** Detect the patch format (SPEC.md section 4). */
function detect(lines: string[]): string | null {
  const fi = lines.findIndex((l) => !isBlank(l));
  if (fi < 0) return null;
  if (lines[fi]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[fi]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, ix) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[ix + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** A hunk body's O and N, plus whether a `\` line follows its last context-or-`+` line and its last `+` line. */
function hunkParts(body: string[]): { h: Hunk; noEolCtxPlus: boolean; noEolPlus: boolean } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: number[] = [];
  let lastCP = -1;
  let lastP = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b.startsWith(' ')) {
      o.push(b.slice(1));
      n.push(b.slice(1));
      ctx.push(o.length - 1);
      lastCP = k;
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push(b.slice(1));
      ctx.push(-1);
      lastCP = k;
      lastP = k;
    } else if (b === '') {
      o.push('');
      n.push('');
      ctx.push(o.length - 1);
      lastCP = k;
    }
    // `\` lines are ignored here; they only decide the final line break.
  }
  return {
    h: { o, n, ctx },
    noEolCtxPlus: lastCP >= 0 && (body[lastCP + 1] ?? '').startsWith('\\'),
    noEolPlus: lastP >= 0 && (body[lastP + 1] ?? '').startsWith('\\'),
  };
}

/** Apply one unified hunk to a file's lines, tracking its final break (SPEC.md section 6). */
function applyUniHunk(f: Split, hk: UniHunk, d: number, strict: boolean, path: string): Split {
  const lines = f.lines;
  let fin = f.finalBr;
  if (hk.h.o.length === 0) {
    let at = hk.a + d;
    if (at < 0) at = 0;
    if (at > lines.length) at = lines.length;
    const out = [...lines.slice(0, at), ...hk.h.n, ...lines.slice(at)];
    if (at === lines.length) fin = !hk.noEolCtxPlus;
    return { lines: out, br: f.br, finalBr: fin };
  }
  const found = firstTier(lines, hk.h.o, strict);
  if (found === null) throw new EditFail('no-match', path);
  const target = hk.a - 1 + d;
  let best = found.pos[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.pos) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  if (best + hk.h.o.length === lines.length) fin = !hk.noEolCtxPlus;
  return { lines: applyLines(lines, best, hk.h, found.tier), br: f.br, finalBr: fin };
}

interface UniHunk {
  a: number;
  h: Hunk;
  noEolCtxPlus: boolean;
  noEolPlus: boolean;
}
interface UniSection {
  dOld: string;
  dNew: string;
  pOld: string | null;
  pNew: string | null;
  rOld: string | null;
  rNew: string | null;
  isNew: boolean;
  isDel: boolean;
  hunks: UniHunk[];
}

/** One unified section's edit (SPEC.md section 6). */
function uniEdit(s: UniSection, strict: boolean): EditFn {
  const oldPath = s.pOld ?? s.rOld ?? s.dOld;
  const newPath = s.pNew ?? s.rNew ?? s.dNew;
  const oldP = oldPath === '/dev/null' ? null : oldPath;
  const newP = newPath === '/dev/null' ? null : newPath;
  const creating = s.isNew || oldP === null;
  const deleting = !creating && (s.isDel || newP === null);
  const moving = !creating && !deleting && oldP !== newP;
  const applyAll = (text: string, path: string): string => {
    let f = splitText(text);
    let d = 0;
    for (const hk of s.hunks) {
      f = applyUniHunk(f, hk, d, strict, path);
      d += hk.h.n.length - hk.h.o.length;
    }
    return joinText(f);
  };
  if (creating) {
    const target = newP ?? '';
    return (t) => {
      if (!isSafe(target)) throw new EditFail('unsafe', target);
      if (t.get(target) !== null) throw new EditFail('exists', target);
      const plus: string[] = [];
      let fin = true;
      for (const hk of s.hunks) {
        let had = false;
        for (let j = 0; j < hk.h.n.length; j++) {
          if (hk.h.ctx[j] === -1) {
            plus.push(hk.h.n[j]!);
            had = true;
          }
        }
        if (had) fin = !hk.noEolPlus;
      }
      t.now.set(target, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return [];
    };
  }
  if (deleting) {
    const target = oldP ?? '';
    return (t) => {
      if (!isSafe(target)) throw new EditFail('unsafe', target);
      if (t.get(target) === null) throw new EditFail('missing', target);
      t.now.set(target, null);
      return [];
    };
  }
  if (moving) {
    const from = oldP ?? '';
    const to = newP ?? '';
    return (t) => {
      if (!isSafe(from)) throw new EditFail('unsafe', from);
      if (!isSafe(to)) throw new EditFail('unsafe', to);
      const before = t.get(from);
      if (before === null) throw new EditFail('missing', from);
      if (t.get(to) !== null) throw new EditFail('exists', to);
      const out = applyAll(before, from);
      t.now.set(to, out);
      t.now.set(from, null);
      return [[from, to]];
    };
  }
  const target = oldP ?? '';
  return (t) => {
    if (!isSafe(target)) throw new EditFail('unsafe', target);
    const before = t.get(target);
    if (before === null) throw new EditFail('missing', target);
    t.now.set(target, applyAll(before, target));
    return [];
  };
}

/** Read a unified diff patch (SPEC.md section 6). */
function parseUnified(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  const n = lines.length;
  let sec: UniSection | null = null;
  const flush = (): void => {
    if (sec !== null) edits.push(uniEdit(sec, strict));
    sec = null;
  };
  const blankSection = (dOld: string, dNew: string): UniSection => ({
    dOld,
    dNew,
    pOld: null,
    pNew: null,
    rOld: null,
    rNew: null,
    isNew: false,
    isDel: false,
    hunks: [],
  });
  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l.trimEnd());
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      flush();
      sec = blankSection(m[1]!, m[2]!);
      i++;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const po = stripAB(l.slice(4));
      const pn = stripAB(lines[i + 1]!.slice(4));
      if (sec !== null && sec.pOld === null && sec.hunks.length === 0) {
        sec.pOld = po;
        sec.pNew = pn;
      } else {
        flush();
        sec = blankSection('', '');
        sec.pOld = po;
        sec.pNew = pn;
      }
      i += 2;
    } else if (l.startsWith('--- ')) {
      if (sec !== null && sec.hunks.length === 0) throw new ParseErr(`error: parse ${i + 2}`);
      i++;
    } else if (l.startsWith('@@')) {
      if (sec === null) throw new ParseErr(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new ParseErr(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        // A hunk body ends at a `diff --git` line and at a `--- ` line followed by a `+++ ` line (SPEC.md section 6):
        // both start with `-` or a letter, so without this they would be swallowed as body lines and the next
        // section would never start.
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const parts = hunkParts(body);
      sec.hunks.push({ a, h: parts.h, noEolCtxPlus: parts.noEolCtxPlus, noEolPlus: parts.noEolPlus });
    } else if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('rename from ')) sec.rOld = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.rNew = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.isNew = true;
      else if (l.startsWith('deleted file mode')) sec.isDel = true;
      i++;
    } else {
      i++;
    }
  }
  flush();
  if (edits.length === 0) throw new ParseErr('error: parse 1');
  return edits;
}

/** One SEARCH/REPLACE block's edit (SPEC.md section 7). */
function srEdit(path: string, oldL: string[], newL: string[], strict: boolean): EditFn {
  if (oldL.length === 0) {
    return (t) => {
      if (!isSafe(path)) throw new EditFail('unsafe', path);
      if (t.get(path) !== null) throw new EditFail('exists', path);
      t.now.set(path, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return [];
    };
  }
  return (t) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    const before = t.get(path);
    if (before === null) throw new EditFail('missing', path);
    const f = splitText(before);
    const found = firstTier(f.lines, oldL, strict);
    if (found === null) throw new EditFail('no-match', path);
    if (found.pos.length > 1) throw new EditFail('ambiguous', path);
    const h: Hunk = { o: oldL, n: newL, ctx: newL.map(() => -1) };
    t.now.set(path, joinText({ lines: applyLines(f.lines, found.pos[0]!, h, found.tier), br: f.br, finalBr: f.finalBr }));
    return [];
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7). */
function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseErr(`error: parse ${sLine}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseErr(`error: parse ${sLine}`);
    const oldL = lines.slice(i + 1, eq);
    const newL = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let k = i - 1; k >= prevEnd; k--) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(`error: parse ${sLine}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = rep + 1;
    edits.push(srEdit(path, oldL, newL, strict));
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseErr('error: parse 1');
  return edits;
}

/** A V4A Update File chunk: an optional anchor, whether it is anchored to the end of the file, and its body lines. */
interface VChunk {
  anchor: string;
  eof: boolean;
  body: string[];
}

function v4aAdd(path: string, fileLines: string[]): EditFn {
  return (t) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (t.get(path) !== null) throw new EditFail('exists', path);
    t.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    return [];
  };
}

function v4aDelete(path: string): EditFn {
  return (t) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (t.get(path) === null) throw new EditFail('missing', path);
    t.now.set(path, null);
    return [];
  };
}

/** One V4A Update File section's edit (SPEC.md section 8). */
function v4aUpdate(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): EditFn {
  return (t) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFail('unsafe', moveTo);
    const before = t.get(path);
    if (before === null) throw new EditFail('missing', path);
    if (moveTo !== null && t.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const f = splitText(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== '') {
        const a = firstTier(lines, [ch.anchor], strict, cursor);
        if (a === null) throw new EditFail('no-match', path);
        cursor = a.pos[0]! + 1;
      }
      const { h } = hunkParts(ch.body);
      if (h.o.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...h.n, ...lines.slice(at)];
        cursor = at + h.n.length;
      } else {
        const found = firstTier(lines, h.o, strict, cursor);
        if (found === null) throw new EditFail('no-match', path);
        let at = -1;
        if (ch.eof) {
          for (const p of found.pos) {
            if (p + h.o.length === lines.length) {
              at = p;
              break;
            }
          }
          if (at === -1) throw new EditFail('no-match', path);
        } else {
          at = found.pos[0]!;
        }
        lines = applyLines(lines, at, h, found.tier);
        cursor = at + h.n.length;
      }
    }
    const out = joinText({ lines, br: f.br, finalBr: f.finalBr });
    if (moveTo !== null) {
      t.now.set(moveTo, out);
      t.now.set(path, null);
      return [[path, moveTo]];
    }
    t.now.set(path, out);
    return [];
  };
}

const v4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Read a V4A patch (SPEC.md section 8). */
function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseErr(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseErr(`error: parse ${n + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i++;
      continue;
    }
    // A section's lines run to the next section start or `*** End Patch`; blank lines at its end are not part of it.
    const extent = (): Array<[number, string]> => {
      const ext: Array<[number, string]> = [];
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j]!)) {
        ext.push([j + 1, lines[j]!]);
        j++;
      }
      while (ext.length > 0 && isBlank(ext[ext.length - 1]![1])) ext.pop();
      return ext;
    };
    const sectionEnd = (ext: Array<[number, string]>): number => {
      // Index just past the section: the extent's last line, or the section line itself when the extent is empty.
      if (ext.length === 0) return i + 1;
      return ext[ext.length - 1]![0];
    };
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const ext = extent();
      const fileLines: string[] = [];
      for (const [ln, b] of ext) {
        if (b.startsWith('+')) fileLines.push(b.slice(1));
        else if (isBlank(b)) fileLines.push('');
        else throw new ParseErr(`error: parse ${ln}`);
      }
      edits.push(v4aAdd(path, fileLines));
      i = sectionEnd(ext);
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      const ext = extent();
      for (const [ln, b] of ext) {
        if (!isBlank(b)) throw new ParseErr(`error: parse ${ln}`);
      }
      edits.push(v4aDelete(path));
      i = sectionEnd(ext);
    } else if (l.startsWith('*** Update File: ')) {
      const updLine = i + 1;
      const path = l.slice('*** Update File: '.length).trim();
      const ext = extent();
      let moveTo: string | null = null;
      let k = 0;
      if (k < ext.length && ext[k]![1].startsWith('*** Move to: ')) {
        moveTo = ext[k]![1].slice('*** Move to: '.length).trim();
        k++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let hasChunk = false;
      for (; k < ext.length; k++) {
        const [ln, b] = ext[k]!;
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: b.slice(2).trim(), eof: false, body: [] };
          hasChunk = true;
        } else if (b.trimEnd() === '*** End of File') {
          // Matched without its leading whitespace: a body line that starts with a space is a context line
          // (its text may itself be `*** End of File`), so only a marker at column 0 ends the chunk.
          if (cur !== null) {
            cur.eof = true;
            chunks.push(cur);
            cur = null;
          } else {
            chunks.push({ anchor: '', eof: true, body: [] });
            hasChunk = true;
          }
        } else if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || isBlank(b)) {
          if (cur === null) {
            cur = { anchor: '', eof: false, body: [] };
            hasChunk = true;
          }
          cur.body.push(b);
        } else {
          throw new ParseErr(`error: parse ${ln}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (!hasChunk && moveTo === null) throw new ParseErr(`error: parse ${updLine}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
      i = sectionEnd(ext);
    } else {
      throw new ParseErr(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new ParseErr('error: parse 1');
  return edits;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEditObj(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (t) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (t.get(p) !== null) throw new EditFail('exists', p);
      t.now.set(p, text);
      return [];
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldS = o.old_str;
    const newS = (o.new_str as string | undefined) ?? '';
    return (t) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = t.get(p);
      if (before === null) throw new EditFail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const txt = toLf(before);
      const oldN = toLf(oldS);
      let count = 0;
      for (let k = txt.indexOf(oldN); k >= 0; k = txt.indexOf(oldN, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = txt.indexOf(oldN);
      const out = txt.slice(0, at) + toLf(newS) + txt.slice(at + oldN.length);
      t.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return [];
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const ln = o.insert_line;
    const add = toPatchLines(o.new_str);
    return (t) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      const before = t.get(p);
      if (before === null) throw new EditFail('missing', p);
      const f = splitText(before);
      if (ln < 0 || ln > f.lines.length) throw new EditFail('no-match', p);
      const ls = [...f.lines];
      ls.splice(ln, 0, ...add);
      t.now.set(p, joinText({ lines: ls, br: f.br, finalBr: f.finalBr }));
      return [];
    };
  }
  return null;
}

/** Read JSON edits: one array, or one edit object per line (SPEC.md section 9). */
function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseErr('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseErr(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseErr(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEditObj(x);
      if (e === null) throw new ParseErr(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditObj(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseErr(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

/** The whole run: parse the arguments, read and parse the patch, apply the edits, answer. */
function runCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !checkOnly) checkOnly = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = toPatchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new ParseErr('error: parse 1');
  } catch (e) {
    if (e instanceof ParseErr) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in order to the tree as earlier edits left it (SPEC.md section 10). A failed edit changes nothing.
  const tree = new Tree();
  const fails: EditFail[] = [];
  const moves: Array<[string, string]> = [];
  for (const ed of edits) {
    const snap = new Map(tree.now);
    try {
      const made = ed(tree);
      for (const pair of made) moves.push(pair);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // A move that succeeded is reported as one `R <old> -> <new>` line, sorted by <new>, in place of its `D` and `A`.
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  const rows: Array<{ key: string; line: string }> = [];
  for (const [o, nw] of moves) {
    if (tree.orig(o) !== null && tree.now.get(o) === null && tree.orig(nw) === null && tree.now.get(nw) !== null) {
      rOld.add(o);
      rNew.add(nw);
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
    }
  }
  for (const p of [...tree.now.keys()]) {
    const was = tree.orig(p);
    const cur = tree.now.get(p)!;
    if (was === cur) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : cur === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!checkOnly) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.orig(p);
      const cur = tree.now.get(p)!;
      if (was === cur) continue;
      if (cur === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, cur);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
