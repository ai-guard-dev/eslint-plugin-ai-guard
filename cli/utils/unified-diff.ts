/**
 * unified-diff.ts — line-based unified diff (Myers O(ND)), no dependencies.
 *
 * Used by the MCP `ai_guard_fix` tool to show what an autofix would change
 * before anything is written. Autofixes touch a few lines, so D stays small;
 * a pathological input falls back to a single hunk instead of using
 * quadratic memory.
 */

type Op = { type: ' ' | '-' | '+'; text: string };

const MAX_EDIT_DISTANCE = 2000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function myers(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const size = 2 * max + 3;
  let v = new Int32Array(size);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    if (d > MAX_EDIT_DISTANCE) return null;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, offset);
      }
    }
    v = v.slice();
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]) ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ type: ' ', text: a[x - 1] });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push({ type: '+', text: b[y - 1] });
      else ops.push({ type: '-', text: a[x - 1] });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** One hunk spanning everything between the common prefix and suffix. */
function fallbackOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [
    ...a.slice(0, start).map((text) => ({ type: ' ' as const, text })),
    ...a.slice(start, endA).map((text) => ({ type: '-' as const, text })),
    ...b.slice(start, endB).map((text) => ({ type: '+' as const, text })),
    ...a.slice(endA).map((text) => ({ type: ' ' as const, text })),
  ];
}

/** Unified diff of two texts, or '' when they are equal. */
export function createUnifiedDiff(oldText: string, newText: string, fileName: string, context = 3): string {
  if (oldText === newText) return '';
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = myers(a, b) ?? fallbackOps(a, b);

  // Line numbers before each op
  const oldLine: number[] = [];
  const newLine: number[] = [];
  let ol = 1;
  let nl = 1;
  for (const op of ops) {
    oldLine.push(ol);
    newLine.push(nl);
    if (op.type !== '+') ol++;
    if (op.type !== '-') nl++;
  }

  const changed = ops.map((op, i) => (op.type === ' ' ? -1 : i)).filter((i) => i >= 0);
  if (changed.length === 0) return ''; // only line-ending differences
  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const out = [`--- a/${fileName}`, `+++ b/${fileName}`];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((op) => op.type !== '+').length;
    const newCount = slice.filter((op) => op.type !== '-').length;
    const oldStart = oldCount === 0 ? oldLine[start] - 1 : oldLine[start];
    const newStart = newCount === 0 ? newLine[start] - 1 : newLine[start];
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of slice) out.push(`${op.type}${op.text}`);
  }
  return out.join('\n') + '\n';
}
