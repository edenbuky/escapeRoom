/** Unified diff of two file sets, in the format `git diff` prints (3 lines of context, no rename detection). */
export interface DiffFile { oid: string; text: string }
export type FileSet = Map<string, DiffFile>;

const eofMarker = '\u0001';
const context = 3;

function lines(text: string): string[] {
  if (!text) return [];
  const parts = text.split('\n');
  const last = parts.pop();
  return last === '' ? parts : [...parts, `${last}${eofMarker}`];
}

type Op = { t: ' ' | '-' | '+'; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops: Op[] = a.slice(0, start).map(line => ({ t: ' ', line }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length * midB.length > 4_000_000) {
    ops.push(...midA.map(line => ({ t: '-' as const, line })), ...midB.map(line => ({ t: '+' as const, line })));
  } else {
    const width = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * width);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * width + j] = midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { ops.push({ t: ' ', line: midA[i] }); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) ops.push({ t: '-', line: midA[i++] });
      else ops.push({ t: '+', line: midB[j++] });
    }
    while (i < midA.length) ops.push({ t: '-', line: midA[i++] });
    while (j < midB.length) ops.push({ t: '+', line: midB[j++] });
  }
  ops.push(...a.slice(endA).map(line => ({ t: ' ' as const, line })));
  return ops;
}

function range(start: number, count: number): string {
  const first = count === 0 ? start : start + 1;
  return count === 1 ? `${first}` : `${first},${count}`;
}

function hunks(ops: Op[]): string[] {
  const changed = ops.flatMap((op, index) => op.t === ' ' ? [] : [index]);
  const out: string[] = [];
  let group = 0;
  while (group < changed.length) {
    let last = group;
    while (last + 1 < changed.length && changed[last + 1] - changed[last] <= 2 * context + 1) last++;
    const from = Math.max(0, changed[group] - context);
    const to = Math.min(ops.length, changed[last] + context + 1);
    let oldStart = 0;
    let newStart = 0;
    for (let k = 0; k < from; k++) { if (ops[k].t !== '+') oldStart++; if (ops[k].t !== '-') newStart++; }
    const slice = ops.slice(from, to);
    const oldCount = slice.filter(op => op.t !== '+').length;
    const newCount = slice.filter(op => op.t !== '-').length;
    out.push(`@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@`);
    for (const op of slice) {
      const eof = op.line.endsWith(eofMarker);
      out.push(`${op.t}${eof ? op.line.slice(0, -1) : op.line}`);
      if (eof) out.push('\\ No newline at end of file');
    }
    group = last + 1;
  }
  return out;
}

export function diffFileSets(before: FileSet, after: FileSet, paths?: string[]): string {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort()
    .filter(name => !paths?.length || paths.some(path => name === path || name.startsWith(`${path}/`)));
  const out: string[] = [];
  for (const name of names) {
    const a = before.get(name);
    const b = after.get(name);
    if (a?.oid === b?.oid && a && b) continue;
    out.push(`diff --git a/${name} b/${name}`);
    if (!a) out.push('new file mode 100644');
    if (!b) out.push('deleted file mode 100644');
    out.push(`index ${a ? a.oid.slice(0, 7) : '0000000'}..${b ? b.oid.slice(0, 7) : '0000000'}${a && b ? ' 100644' : ''}`);
    out.push(`--- ${a ? `a/${name}` : '/dev/null'}`, `+++ ${b ? `b/${name}` : '/dev/null'}`);
    out.push(...hunks(diffOps(lines(a?.text ?? ''), lines(b?.text ?? ''))));
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
