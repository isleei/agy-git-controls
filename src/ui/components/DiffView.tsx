import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns2, FileDiff, RotateCw, X } from 'lucide-react';
import { api, type DiffRequest } from '../api';
import type { FileChange } from '../../core/types.js';
import { useApi } from '../hooks/useApi';
import { useEscape } from '../hooks/useEscape';
import {
  buildSplitRows,
  foldHunkLines,
  parsePatch,
  patchStats,
  type DiffHunk,
  type DiffLine,
  type FilePatch,
} from '../diff';
import { statusLetter } from '../utils';
import { Spinner } from './Spinner';

export interface DiffTarget {
  key: string;
  title: string;
  request: DiffRequest;
  change?: FileChange;
  hint?: string;
}

type ViewMode = 'unified' | 'split';

function signOf(line: DiffLine): string {
  if (line.kind === 'add') return '+';
  if (line.kind === 'del') return '-';
  if (line.kind === 'meta') return '\\';
  return ' ';
}

function UnifiedLine({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-gutter">{line.oldNo ?? ''}</span>
      <span className="diff-gutter">{line.newNo ?? ''}</span>
      <span className="diff-sign">{signOf(line)}</span>
      <span className="diff-text">{line.text.length > 0 ? line.text : ' '}</span>
    </div>
  );
}

function UnifiedHunk({ hunk, fileIndex }: { hunk: DiffHunk; fileIndex: number }) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const rows = useMemo(() => foldHunkLines(hunk.lines), [hunk]);

  const toggle = (key: number): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="diff-hunk">
      <div className="diff-hunk-head" title={hunk.header}>
        {hunk.header}
      </div>
      {rows.map((row, index) => {
        if (row.kind === 'fold') {
          const key = row.foldKey ?? index;
          const foldKey = `${fileIndex}:${key}`;
          if (expanded.has(key)) {
            return (row.foldLines ?? []).map((line, lineIndex) => (
              <UnifiedLine key={`${foldKey}:${lineIndex}`} line={line} />
            ));
          }
          return (
            <button
              key={`fold:${foldKey}`}
              type="button"
              className="diff-fold"
              onClick={() => toggle(key)}
              title="Show hidden context"
            >
              ⋯ {row.foldLines?.length ?? 0} unchanged lines
            </button>
          );
        }
        return (
          <UnifiedLine key={`line:${fileIndex}:${index}`} line={row.line as DiffLine} />
        );
      })}
    </div>
  );
}

function SplitSide({ line, side }: { line: DiffLine | null; side: 'old' | 'new' }) {
  if (!line) return <div className="split-side empty" />;
  const number = side === 'old' ? line.oldNo : line.newNo;
  return (
    <div className={`split-side ${line.kind}`}>
      <span className="diff-gutter">{number ?? ''}</span>
      <span className="diff-sign">{signOf(line)}</span>
      <span className="diff-text">{line.text.length > 0 ? line.text : ' '}</span>
    </div>
  );
}

function SplitHunk({ hunk, fileIndex }: { hunk: DiffHunk; fileIndex: number }) {
  const rows = useMemo(() => buildSplitRows(hunk), [hunk]);
  return (
    <div className="diff-hunk split">
      <div className="diff-hunk-head" title={hunk.header}>
        {hunk.header}
      </div>
      {rows.map((row, index) => {
        if (row.left && row.left.kind === 'meta') {
          return (
            <div key={`meta:${fileIndex}:${index}`} className="diff-line meta split-wide">
              <span className="diff-text">{row.left.text}</span>
            </div>
          );
        }
        return (
          <div key={`row:${fileIndex}:${index}`} className="diff-split-row">
            <SplitSide line={row.left} side="old" />
            <SplitSide line={row.right} side="new" />
          </div>
        );
      })}
    </div>
  );
}

function FileBlock({
  patch,
  fileIndex,
  mode,
  showHeader,
}: {
  patch: FilePatch;
  fileIndex: number;
  mode: ViewMode;
  showHeader: boolean;
}) {
  const stats = useMemo(() => patchStats(patch), [patch]);
  const title = patch.renamed ? `${patch.oldPath} → ${patch.newPath}` : patch.newPath || patch.oldPath;
  return (
    <div className="diff-file">
      {showHeader ? (
        <div className="diff-file-head">
          <span className="diff-file-title">{title}</span>
          <span className="diff-stat-add">+{stats.added}</span>
          <span className="diff-stat-del">-{stats.deleted}</span>
          {patch.binary ? <span className="diff-chip">binary</span> : null}
        </div>
      ) : null}
      {patch.binary ? (
        <div className="diff-notice">Binary file — no text diff.</div>
      ) : patch.hunks.length === 0 ? (
        <div className="diff-notice">No textual changes.</div>
      ) : mode === 'unified' ? (
        patch.hunks.map((hunk, index) => (
          <UnifiedHunk key={`${fileIndex}:${index}`} hunk={hunk} fileIndex={fileIndex} />
        ))
      ) : (
        patch.hunks.map((hunk, index) => (
          <SplitHunk key={`${fileIndex}:${index}`} hunk={hunk} fileIndex={fileIndex} />
        ))
      )}
    </div>
  );
}

export interface PatchViewProps {
  text: string;
  mode?: ViewMode;
  /** `auto` shows a header per file when the patch spans more than one file. */
  showFileHeaders?: boolean | 'auto';
  emptyHint?: string;
}

/**
 * Render a raw unified patch that was already produced by the backend
 * (e.g. `/api/stash show`), without another API call.
 */
export function PatchView({
  text,
  mode = 'unified',
  showFileHeaders = 'auto',
  emptyHint,
}: PatchViewProps) {
  const patches = useMemo(() => parsePatch(text), [text]);
  if (patches.length === 0) {
    return <div className="diff-empty">{emptyHint ?? 'No textual changes.'}</div>;
  }
  const headers = showFileHeaders === 'auto' ? patches.length > 1 : showFileHeaders;
  return (
    <>
      {patches.map((patch, index) => (
        <FileBlock
          key={`${index}:${patch.newPath}:${patch.oldPath}`}
          patch={patch}
          fileIndex={index}
          mode={mode}
          showHeader={headers}
        />
      ))}
    </>
  );
}

export interface DiffViewProps {
  repo: string;
  target: DiffTarget;
  onClose: () => void;
}

export function DiffView({ repo, target, onClose }: DiffViewProps) {
  const [mode, setMode] = useState<ViewMode>('unified');
  const bodyRef = useRef<HTMLDivElement>(null);
  useEscape(onClose);

  const { data, loading, error, reload } = useApi(
    () => api.diff(repo, target.request),
    [repo, target.key],
  );

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [target.key]);

  const patches = useMemo(() => (data ? parsePatch(data.hunks) : []), [data]);
  const status = target.change ? statusLetter(target.change.kind) : null;
  const renamed = data?.oldPath
    ? `${data.oldPath} → ${target.title}`
    : patches.length === 1 && patches[0]?.renamed
      ? `${patches[0].oldPath} → ${patches[0].newPath}`
      : null;

  return (
    <div className="diff">
      <div className="diff-head">
        <FileDiff size={13} className="diff-icon" />
        <span className="diff-title" title={target.title}>
          {target.title}
        </span>
        {status ? (
          <span className={`status-letter tone-${status.tone}`} title={target.change?.kind}>
            {status.letter}
          </span>
        ) : null}
        {loading ? <Spinner size={12} /> : null}
        <div className="diff-tools">
          <div className="segmented" role="group" aria-label="Diff layout">
            <button
              type="button"
              className={mode === 'unified' ? 'active' : ''}
              onClick={() => setMode('unified')}
              title="Unified view"
            >
              Unified
            </button>
            <button
              type="button"
              className={mode === 'split' ? 'active' : ''}
              onClick={() => setMode('split')}
              title="Split view"
            >
              <Columns2 size={12} />
              <span className="seg-label">Split</span>
            </button>
          </div>
          <button type="button" className="icon-btn" title="Reload diff" onClick={reload}>
            <RotateCw size={13} />
          </button>
          <button type="button" className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>

      {renamed ? <div className="diff-rename">{renamed}</div> : null}
      {data?.truncated ? (
        <div className="diff-banner warn">
          Diff truncated — only the beginning of this file is shown.
        </div>
      ) : null}

      <div className="diff-body" ref={bodyRef}>
        {error ? (
          <div className="diff-error">
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={reload}>
              Retry
            </button>
          </div>
        ) : loading && !data ? (
          <div className="diff-loading">
            <Spinner size={16} />
          </div>
        ) : data && data.hunks.trim().length > 0 ? (
          <PatchView text={data.hunks} mode={mode} />
        ) : data ? (
          <div className="diff-empty">
            {data.binary ? 'Binary file — no text diff.' : target.hint ?? 'No changes to show.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}
