/**
 * Newick parsing and serialisation.
 *
 * Written iteratively on purpose. Both source viewers recursed here — mytol's
 * `parseNewick`/`buildTree` and garrigue's `buildModel` (despite its comment
 * claiming otherwise) — so a ladder-shaped tree a few thousand nodes deep blew
 * the stack. Nothing in this file recurses.
 *
 * Tolerances, all of which real tool output needs:
 *  - quoted labels ('like this', with '' as an escaped quote);
 *  - `[...]` comments, including NHX `[&&NHX:...]` blocks, stripped anywhere;
 *  - missing branch lengths and missing labels;
 *  - IQ-TREE's `SH-aLRT/UFBoot` internal labels ("95/100");
 *  - a missing trailing semicolon.
 *
 * Labels are preserved VERBATIM. Newick's traditional `_` -> space rule is not
 * applied, because accessions like `GTDB~B~GCF_000005845_2~001~00141` and
 * `WP_001234.1_hyp` must survive a round trip unchanged.
 */

import type { Tree } from "./types";
import { finaliseTree } from "./model";

export class NewickError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} (at character ${position})`);
    this.name = "NewickError";
    this.position = position;
  }
}

/** Characters that terminate an unquoted label. */
const LABEL_STOP = new Set(["(", ")", ",", ":", ";", "[", "]"]);

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v";
}

/**
 * Split a file holding several `;`-terminated trees.
 * Semicolons inside quoted labels or comments do not split.
 */
export function splitNewick(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuote = false;
  let depthComment = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === "'") {
        if (text[i + 1] === "'") i++;
        else inQuote = false;
      }
      continue;
    }
    if (depthComment > 0) {
      if (c === "[") depthComment++;
      else if (c === "]") depthComment--;
      continue;
    }
    if (c === "'") inQuote = true;
    else if (c === "[") depthComment++;
    else if (c === ";") {
      const chunk = text.slice(start, i + 1).trim();
      if (chunk) out.push(chunk);
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Parse one Newick string into a Tree.
 *
 * @param text    the Newick source
 * @param startUid first uid to hand out; ids increase in pre-order
 */
export function parseNewick(text: string, startUid = 0): Tree {
  const n = text.length;
  let i = 0;

  // Growable plain arrays; converted to typed arrays by finaliseTree.
  const parent: number[] = [];
  const firstChild: number[] = [];
  const nextSib: number[] = [];
  const lastChild: number[] = [];
  const length: number[] = [];
  const name: string[] = [];

  let root = -1;

  function newNode(par: number): number {
    const id = parent.length;
    parent.push(par);
    firstChild.push(-1);
    nextSib.push(-1);
    lastChild.push(-1);
    length.push(NaN);
    name.push("");
    if (par === -1) {
      if (root !== -1) {
        throw new NewickError("more than one root — use splitNewick for multi-tree files", i);
      }
      root = id;
    } else {
      const prev = lastChild[par];
      if (prev === -1) firstChild[par] = id;
      else nextSib[prev] = id;
      lastChild[par] = id;
    }
    return id;
  }

  function skipTrivia(): void {
    for (;;) {
      while (i < n && isSpace(text[i])) i++;
      if (i < n && text[i] === "[") {
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
          if (text[i] === "[") depth++;
          else if (text[i] === "]") depth--;
          i++;
        }
        continue;
      }
      return;
    }
  }

  function readLabel(): string {
    skipTrivia();
    if (i >= n) return "";
    if (text[i] === "'") {
      i++;
      let out = "";
      for (;;) {
        if (i >= n) throw new NewickError("unterminated quoted label", i);
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            out += "'";
            i += 2;
            continue;
          }
          i++;
          break;
        }
        out += text[i++];
      }
      return out;
    }
    let out = "";
    while (i < n && !LABEL_STOP.has(text[i]) && !isSpace(text[i])) out += text[i++];
    return out;
  }

  function readLength(): number {
    skipTrivia();
    if (i >= n || text[i] !== ":") return NaN;
    i++;
    skipTrivia();
    const start = i;
    if (i < n && (text[i] === "+" || text[i] === "-")) i++;
    while (i < n && (text[i] >= "0" && text[i] <= "9")) i++;
    if (i < n && text[i] === ".") {
      i++;
      while (i < n && text[i] >= "0" && text[i] <= "9") i++;
    }
    if (i < n && (text[i] === "e" || text[i] === "E")) {
      const save = i;
      i++;
      if (i < n && (text[i] === "+" || text[i] === "-")) i++;
      if (i < n && text[i] >= "0" && text[i] <= "9") {
        while (i < n && text[i] >= "0" && text[i] <= "9") i++;
      } else {
        i = save;
      }
    }
    if (i === start) throw new NewickError("expected a branch length after ':'", i);
    const v = Number.parseFloat(text.slice(start, i));
    return Number.isNaN(v) ? NaN : v;
  }

  const stack: number[] = [];

  skipTrivia();
  if (i >= n) throw new NewickError("empty Newick input", 0);

  for (;;) {
    skipTrivia();
    if (i >= n) break;
    const c = text[i];

    if (c === "(") {
      i++;
      const par = stack.length ? stack[stack.length - 1] : -1;
      stack.push(newNode(par));
      continue;
    }

    if (c === ",") {
      i++;
      continue;
    }

    if (c === ")") {
      i++;
      const closed = stack.pop();
      if (closed === undefined) throw new NewickError("unbalanced ')'", i);
      name[closed] = readLabel();
      length[closed] = readLength();
      continue;
    }

    if (c === ";") {
      i++;
      break;
    }

    // Anything else begins a leaf label.
    const par = stack.length ? stack[stack.length - 1] : -1;
    const leaf = newNode(par);
    name[leaf] = readLabel();
    length[leaf] = readLength();
  }

  if (stack.length) throw new NewickError(`${stack.length} unclosed '(' at end of input`, i);
  if (root === -1) throw new NewickError("no tree found", 0);

  return finaliseTree({ parent, firstChild, nextSib, length, name, root, startUid });
}

// ============================================================
// Support values
// ============================================================

/**
 * Interpret an internal-node label as a branch support value in [0,1].
 *
 * Handles a plain number ("95", "0.95") and IQ-TREE's `SH-aLRT/UFBoot` pair
 * ("95/100"), where the second value (UFBoot) is the one comparable to a
 * bootstrap. Values above 1 are treated as percentages.
 *
 * Returns NaN when the label is not a support value (a real clade name).
 */
export function supportFromLabel(label: string): number {
  if (!label) return NaN;
  const slash = label.indexOf("/");
  if (slash !== -1) {
    const second = Number.parseFloat(label.slice(slash + 1));
    if (!Number.isNaN(second)) return second > 1 ? second / 100 : second;
    return NaN;
  }
  if (!/^-?\d+(\.\d+)?$/.test(label)) return NaN;
  const v = Number.parseFloat(label);
  if (Number.isNaN(v)) return NaN;
  return v > 1 ? v / 100 : v;
}

// ============================================================
// Serialisation
// ============================================================

/** True when a label needs quoting to survive a Newick round trip. */
function needsQuote(label: string): boolean {
  if (label === "") return false;
  for (const ch of label) {
    if (LABEL_STOP.has(ch) || isSpace(ch) || ch === "'") return true;
  }
  return false;
}

function quoteLabel(label: string): string {
  return needsQuote(label) ? `'${label.replace(/'/g, "''")}'` : label;
}

/**
 * Serialise back to Newick. Iterative, so it is safe on deep trees.
 * Names round-trip unchanged; lengths are omitted where they were absent.
 */
export function toNewick(t: Tree, opts: { includeSupport?: boolean } = {}): string {
  const includeSupport = opts.includeSupport ?? true;
  const out: string[] = [];
  // false = entering the node, true = leaving it
  const stack: Array<[number, boolean]> = [[t.root, false]];

  /** Emit the separator that follows a just-finished node. */
  const closeNode = (id: number): void => {
    if (t.nextSib[id] !== -1) out.push(",");
  };

  while (stack.length) {
    const frame = stack[stack.length - 1];
    const id = frame[0];

    if (!frame[1]) {
      frame[1] = true;

      if (t.isLeaf[id]) {
        out.push(quoteLabel(t.name[id]));
        const len = t.length[id];
        if (!Number.isNaN(len)) out.push(":", String(len));
        stack.pop();
        closeNode(id);
        continue;
      }

      out.push("(");
      const kids: number[] = [];
      for (let c = t.firstChild[id]; c !== -1; c = t.nextSib[c]) kids.push(c);
      // pushed in reverse so the leftmost child is handled first
      for (let k = kids.length - 1; k >= 0; k--) stack.push([kids[k], false]);
      continue;
    }

    out.push(")");
    let label = t.name[id];
    if (!label && includeSupport && !Number.isNaN(t.support[id])) {
      label = String(t.support[id]);
    }
    if (label) out.push(quoteLabel(label));
    const len = t.length[id];
    if (!Number.isNaN(len)) out.push(":", String(len));
    stack.pop();
    closeNode(id);
  }

  return out.join("") + ";";
}
