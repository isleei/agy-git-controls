/**
 * Presentation-only parser for the unified patches returned by `/api/diff`.
 * It turns text into hunks/lines for rendering; it never invokes git.
 */

export type DiffLineKind = 'context' | 'add' | 'del' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  section: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  added: boolean;
  deleted: boolean;
  renamed: boolean;
  binary: boolean;
  hunks: DiffHunk[];
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    value = value.slice(1, -1);
    value = value.replace(/\\(["\\])/g, '$1');
  }
  return value;
}

function stripPrefix(raw: string, prefix: 'a/' | 'b/'): string {
  const value = unquote(raw);
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function parseHunkHeader(header: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
} | null {
  const match = header.match(HUNK);
  if (!match) return null;
  return {
    oldStart: Number(match[1] ?? 0),
    oldCount: match[2] !== undefined ? Number(match[2]) : 1,
    newStart: Number(match[3] ?? 0),
    newCount: match[4] !== undefined ? Number(match[4]) : 1,
    section: match[5] ?? '',
  };
}

export function parsePatch(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  if (!text) return files;

  const lines = text.split('\n');
  // A patch normally ends with a newline; the resulting empty tail is not a
  // context line and would otherwise inflate every hunk.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let file: FilePatch | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const finishHunk = (): void => {
    if (file && hunk) file.hunks.push(hunk);
    hunk = null;
  };
  const finishFile = (): void => {
    finishHunk();
    if (file) files.push(file);
    file = null;
  };

  for (const line of lines) {
    const diffMatch = line.match(DIFF_GIT);
    if (diffMatch) {
      finishFile();
      file = {
        oldPath: stripPrefix(`a/${diffMatch[1] ?? ''}`, 'a/'),
        newPath: stripPrefix(`b/${diffMatch[2] ?? ''}`, 'b/'),
        added: false,
        deleted: false,
        renamed: false,
        binary: false,
        hunks: [],
      };
      continue;
    }
    if (!file) continue;

    if (line.startsWith('@@')) {
      finishHunk();
      const parsed = parseHunkHeader(line);
      if (!parsed) continue;
      hunk = {
        header: line,
        section: parsed.section,
        oldStart: parsed.oldStart,
        oldCount: parsed.oldCount,
        newStart: parsed.newStart,
        newCount: parsed.newCount,
        lines: [],
      };
      oldNo = parsed.oldStart;
      newNo = parsed.newStart;
      continue;
    }

    if (line.startsWith('new file mode')) {
      file.added = true;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      file.deleted = true;
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = unquote(line.slice('rename from '.length));
      file.renamed = true;
      continue;
    }
    if (line.startsWith('rename to ')) {
      file.newPath = unquote(line.slice('rename to '.length));
      file.renamed = true;
      continue;
    }
    if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      const target = unquote(line.slice(4));
      if (target === '/dev/null') file.added = true;
      else file.oldPath = stripPrefix(target, 'a/');
      continue;
    }
    if (line.startsWith('+++ ')) {
      const target = unquote(line.slice(4));
      if (target === '/dev/null') file.deleted = true;
      else file.newPath = stripPrefix(target, 'b/');
      continue;
    }

    if (!hunk) continue;

    if (line.startsWith('\\')) {
      hunk.lines.push({ kind: 'meta', text: line, oldNo: null, newNo: null });
      continue;
    }

    const marker = line.charAt(0);
    if (marker === '+') {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo });
      newNo += 1;
      continue;
    }
    if (marker === '-') {
      hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo, newNo: null });
      oldNo += 1;
      continue;
    }
    if (marker === ' ') {
      hunk.lines.push({ kind: 'context', text: line.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    if (line === '') {
      // Tolerate producers that emit bare blank context lines.
      hunk.lines.push({ kind: 'context', text: '', oldNo, newNo });
      oldNo += 1;
      newNo += 1;
      continue;
    }
    // Anything else ends the hunk (e.g. the next file header without `diff --git`).
    finishHunk();
  }

  finishFile();
  return files;
}

export function patchStats(patch: FilePatch): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') added += 1;
      else if (line.kind === 'del') deleted += 1;
    }
  }
  return { added, deleted };
}

export function patchDisplayPath(patch: FilePatch): string {
  return patch.renamed ? `${patch.oldPath} → ${patch.newPath}` : patch.newPath || patch.oldPath;
}

/** Context lines are folded in the middle of long unchanged runs. */
export interface FoldableRow {
  kind: 'line' | 'fold';
  line?: DiffLine;
  foldLines?: DiffLine[];
  foldKey?: number;
}

export function foldHunkLines(lines: DiffLine[], keep = 3): FoldableRow[] {
  const rows: FoldableRow[] = [];
  let index = 0;
  let foldKey = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind !== 'context') {
      rows.push({ kind: 'line', line });
      index += 1;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end]!.kind === 'context') end += 1;
    const run = end - index;
    if (run > keep * 2 + 1) {
      for (let i = index; i < index + keep; i += 1) rows.push({ kind: 'line', line: lines[i]! });
      rows.push({ kind: 'fold', foldLines: lines.slice(index + keep, end - keep), foldKey });
      foldKey += 1;
      for (let i = end - keep; i < end; i += 1) rows.push({ kind: 'line', line: lines[i]! });
    } else {
      for (let i = index; i < end; i += 1) rows.push({ kind: 'line', line: lines[i]! });
    }
    index = end;
  }
  return rows;
}

/** Side-by-side alignment: pair deletion and addition blocks line by line. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

export function buildSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === 'context' || line.kind === 'meta') {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (index < lines.length && lines[index]!.kind === 'del') {
      dels.push(lines[index]!);
      index += 1;
    }
    while (index < lines.length && lines[index]!.kind === 'add') {
      adds.push(lines[index]!);
      index += 1;
    }
    const count = Math.max(dels.length, adds.length);
    for (let i = 0; i < count; i += 1) {
      rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    }
  }
  return rows;
}
