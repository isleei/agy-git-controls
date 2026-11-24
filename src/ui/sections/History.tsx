import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Copy,
  GitCommitHorizontal,
  MoreHorizontal,
  RotateCw,
  Search,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../api';
import type { CommitInfo } from '../../core/types.js';
import { useStore } from '../store';
import { useContextMenu, ContextMenu, type MenuItem } from '../components/ContextMenu';
import { DiffView, type DiffTarget } from '../components/DiffView';
import { EmptyState } from '../components/EmptyState';
import { Spinner } from '../components/Spinner';
import { useApi } from '../hooks/useApi';
import { useEscape } from '../hooks/useEscape';
import { copyText, formatDate, relativeTime, shortSha, statusLetter } from '../utils';
import { parsePatch, patchStats, type FilePatch } from '../diff';

const PAGE_SIZE = 150;
const ROW_HEIGHT = 26;
const LANE_WIDTH = 10;
const LANES = 6;

interface GraphRow {
  lane: number;
  width: number;
  enter: number[];
  exit: number[];
  curves: Array<{ from: number; to: number }>;
}

/**
 * Assign commit lanes from parent relationships. The graph is recomputed for
 * the loaded page; lanes whose commit is not in the page terminate cleanly.
 */
export function buildGraphRows(commits: CommitInfo[]): GraphRow[] {
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.sha);
    if (lane === -1) {
      lane = lanes.findIndex((value) => value === null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
      lanes[lane] = commit.sha;
    }

    const enter = lanes.flatMap((value, index) => (value === null ? [] : [index]));
    const curves: Array<{ from: number; to: number }> = [];

    const firstParent = commit.parents[0];
    if (firstParent !== undefined) {
      const existing = lanes.findIndex(
        (value, index) => index !== lane && value === firstParent,
      );
      if (existing >= 0) {
        lanes[lane] = null;
        curves.push({ from: lane, to: existing });
      } else {
        lanes[lane] = firstParent;
      }
    } else {
      lanes[lane] = null;
    }

    for (const parent of commit.parents.slice(1)) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = lanes.findIndex((value) => value === null);
        if (target === -1) {
          target = lanes.length;
          lanes.push(null);
        }
        lanes[target] = parent;
      }
      curves.push({ from: lane, to: target });
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const exit = lanes.flatMap((value, index) => (value === null ? [] : [index]));
    const width = Math.max(
      1,
      lane + 1,
      ...enter.map((index) => index + 1),
      ...exit.map((index) => index + 1),
      ...curves.map((curve) => curve.to + 1),
    );
    rows.push({ lane, width, enter, exit, curves });
  }

  const maxWidth = rows.reduce((max, row) => Math.max(max, row.width), 1);
  return rows.map((row) => ({ ...row, width: maxWidth }));
}

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function Graph({ row }: { row: GraphRow }) {
  const width = row.width * LANE_WIDTH;
  const mid = ROW_HEIGHT / 2;
  const curveTargets = new Set(row.curves.map((curve) => curve.to));
  const exit = row.exit.filter(
    (lane) => !curveTargets.has(lane) || row.enter.includes(lane),
  );

  return (
    <svg
      className="graph-svg"
      width={width}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${width} ${ROW_HEIGHT}`}
      aria-hidden="true"
    >
      {row.enter.map((lane) => (
        <line
          key={`in:${lane}`}
          className={`graph-line lane-${lane % LANES}`}
          x1={laneX(lane)}
          y1={0}
          x2={laneX(lane)}
          y2={mid}
        />
      ))}
      {exit.map((lane) => (
        <line
          key={`out:${lane}`}
          className={`graph-line lane-${lane % LANES}`}
          x1={laneX(lane)}
          y1={mid}
          x2={laneX(lane)}
          y2={ROW_HEIGHT}
        />
      ))}
      {row.curves.map((curve, index) => (
        <path
          key={`curve:${index}:${curve.from}:${curve.to}`}
          className={`graph-line lane-${curve.to % LANES}`}
          d={`M ${laneX(curve.from)} ${mid} C ${laneX(curve.from)} ${
            mid + ROW_HEIGHT * 0.3
          }, ${laneX(curve.to)} ${ROW_HEIGHT * 0.7}, ${laneX(curve.to)} ${ROW_HEIGHT}`}
          fill="none"
        />
      ))}
      <circle
        className={`graph-dot lane-${row.lane % LANES}`}
        cx={laneX(row.lane)}
        cy={mid}
        r={3}
      />
    </svg>
  );
}

function RefChips({ commit }: { commit: CommitInfo }) {
  if (commit.refs.length === 0) return null;
  const seen = new Set<string>();
  const refs = commit.refs.filter((ref) => {
    const key = `${ref.type}:${ref.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <span className="ref-chips">
      {refs.map((ref) => (
        <span
          key={`${ref.type}:${ref.name}`}
          className={`ref-chip ref-${ref.type}`}
          title={ref.name}
        >
          {ref.name}
        </span>
      ))}
    </span>
  );
}

function patchKind(patch: FilePatch): string {
  if (patch.added) return 'A';
  if (patch.deleted) return 'D';
  if (patch.renamed) return 'R';
  return 'M';
}

function CommitDrawer({
  repo,
  commit,
  onClose,
}: {
  repo: string;
  commit: CommitInfo;
  onClose: () => void;
}) {
  const parent = commit.parents[0] ?? null;
  const [fileTarget, setFileTarget] = useState<DiffTarget | null>(null);
  useEscape(onClose);

  const files = useApi(
    () => (parent ? api.diff(repo, { ref: parent, ref2: commit.sha }) : null),
    [repo, commit.sha, parent],
  );
  const patches = useMemo(() => (files.data ? parsePatch(files.data.hunks) : []), [files.data]);

  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onPointerDown={onClose} />
      <aside className="commit-drawer" aria-label="Commit details">
        <div className="drawer-head">
          <GitCommitHorizontal size={14} className="drawer-icon" />
          <span className="drawer-title">{shortSha(commit.sha)}</span>
          <button type="button" className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="drawer-body">
          <div className="commit-full-subject">{commit.subject}</div>
          {commit.body ? <pre className="commit-full-body">{commit.body}</pre> : null}
          <dl className="commit-detail-meta">
            <dt>Author</dt>
            <dd>
              {commit.author} <span className="dim">&lt;{commit.authorEmail}&gt;</span>
            </dd>
            <dt>Date</dt>
            <dd>{formatDate(commit.date)}</dd>
            <dt>Parents</dt>
            <dd className="commit-parents">
              {commit.parents.length === 0 ? (
                <span className="dim">root commit</span>
              ) : (
                commit.parents.map((sha) => (
                  <span key={sha} className="sha-chip" title={sha}>
                    {shortSha(sha)}
                  </span>
                ))
              )}
            </dd>
            <dt>SHA</dt>
            <dd>
              <span className="sha-chip" title={commit.sha}>
                {commit.sha}
              </span>
            </dd>
          </dl>

          <div className="drawer-section-title">
            Changed files
            {patches.length > 0 ? <span className="group-count">{patches.length}</span> : null}
          </div>

          {parent === null ? (
            <div className="dim-row">Root commit — file list is unavailable from the diff API.</div>
          ) : files.loading ? (
            <div className="loading-center">
              <Spinner size={16} />
            </div>
          ) : files.error ? (
            <div className="diff-error">
              <span>{files.error}</span>
              <button type="button" className="btn btn-sm" onClick={files.reload}>
                Retry
              </button>
            </div>
          ) : patches.length === 0 ? (
            <div className="dim-row">No changed files.</div>
          ) : (
            <>
              {files.data?.truncated ? (
                <div className="diff-banner warn">File list truncated by the diff size cap.</div>
              ) : null}
              <div className="history-files">
                {patches.map((patch, index) => {
                  const meta = statusLetter(patchKind(patch));
                  const stats = patchStats(patch);
                  const path = patch.newPath || patch.oldPath;
                  return (
                    <button
                      key={`${index}:${path}`}
                      type="button"
                      className="row history-file-row"
                      title={patch.renamed ? `${patch.oldPath} → ${patch.newPath}` : path}
                      onClick={() =>
                        setFileTarget({
                          key: `${commit.sha}:${path}`,
                          title: path,
                          request: { ref: parent, ref2: commit.sha, path },
                        })
                      }
                    >
                      <span className={`status-letter tone-${meta.tone}`}>{meta.letter}</span>
                      <span className="history-file-name">
                        {patch.renamed ? `${patch.oldPath} → ${patch.newPath}` : path}
                      </span>
                      <span className="diff-stat-add">+{stats.added}</span>
                      <span className="diff-stat-del">-{stats.deleted}</span>
                      {patch.binary ? <span className="diff-chip">binary</span> : null}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {fileTarget ? (
            <div className="drawer-diff">
              <DiffView
                key={fileTarget.key}
                repo={repo}
                target={fileTarget}
                onClose={() => setFileTarget(null)}
              />
            </div>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

export function HistorySection() {
  const { state, activeRepo, run, toast } = useStore();
  const menuCtrl = useContextMenu();
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<CommitInfo | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const repoRef = useRef(activeRepo);
  repoRef.current = activeRepo;

  useEffect(() => {
    setQuery('');
    setSelected(null);
  }, [activeRepo]);

  useEffect(() => {
    if (!activeRepo) {
      setCommits([]);
      setHasMore(false);
      setLoading(false);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .log(activeRepo, { maxCount: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setCommits(page.commits);
        setHasMore(page.hasMore);
        setSelected((current) =>
          current ? page.commits.find((commit) => commit.sha === current.sha) ?? null : null,
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCommits([]);
        setHasMore(false);
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRepo, state.dataVersion, reloadNonce]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commits;
    return commits.filter(
      (commit) =>
        commit.subject.toLowerCase().includes(needle) ||
        commit.author.toLowerCase().includes(needle) ||
        commit.sha.toLowerCase().includes(needle) ||
        commit.shortSha.toLowerCase().includes(needle),
    );
  }, [commits, query]);

  const graphRows = useMemo(() => buildGraphRows(filtered), [filtered]);

  const loadMore = async (): Promise<void> => {
    if (!activeRepo || loadingMore) return;
    const repo = activeRepo;
    setLoadingMore(true);
    try {
      const page = await api.log(repo, {
        maxCount: PAGE_SIZE,
        skip: commits.length,
      });
      if (repoRef.current !== repo) return;
      setCommits((current) => [...current, ...page.commits]);
      setHasMore(page.hasMore);
    } catch (err) {
      if (repoRef.current !== repo) return;
      toast('error', 'Cannot load more commits', errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const copySha = async (commit: CommitInfo): Promise<void> => {
    const ok = await copyText(commit.sha);
    toast(ok ? 'success' : 'error', ok ? 'Commit SHA copied' : 'Clipboard unavailable');
  };

  const cherryPick = (commit: CommitInfo): void => {
    if (!activeRepo) return;
    void run(
      `cherry-pick:${commit.shortSha}`,
      () => api.cherryPick(activeRepo, { shas: [commit.sha] }),
      { success: `Cherry-picked ${commit.shortSha}` },
    );
  };

  const revert = (commit: CommitInfo): void => {
    if (!activeRepo) return;
    void run(`revert:${commit.shortSha}`, () => api.revert(activeRepo, [commit.sha]), {
      success: `Reverted ${commit.shortSha}`,
    });
  };

  const sendToAgent = async (commit: CommitInfo): Promise<void> => {
    if (!activeRepo) return;
    try {
      await api.sendToConversation(activeRepo, { kind: 'commit', ref: commit.sha });
      toast('success', 'Commit sent to Agent');
    } catch (err) {
      toast('error', 'Cannot send commit to Agent', errorMessage(err));
    }
  };

  const menuFor = (commit: CommitInfo): MenuItem[] => [
    {
      label: 'Copy SHA',
      icon: <Copy size={12} />,
      onSelect: () => void copySha(commit),
    },
    { type: 'separator' },
    {
      label: 'Cherry-pick',
      icon: <GitCommitHorizontal size={12} />,
      onSelect: () => cherryPick(commit),
    },
    {
      label: 'Revert commit',
      icon: <Undo2 size={12} />,
      onSelect: () => revert(commit),
    },
    { type: 'separator' },
    {
      label: 'Send to Agent',
      icon: <Sparkles size={12} />,
      onSelect: () => void sendToAgent(commit),
    },
  ];

  const openRowMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    commit: CommitInfo,
  ): void => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    menuCtrl.openAt(rect.left, rect.bottom + 2, menuFor(commit));
  };

  if (!activeRepo) {
    return (
      <div className="section-body history">
        <EmptyState
          icon={<GitCommitHorizontal size={26} />}
          title="No repository selected"
          hint="Pick a repository in the header or add one."
        />
      </div>
    );
  }

  return (
    <div className="section-body history">
      <div className="section-toolbar">
        <div className="search-box">
          <Search size={12} />
          <input
            className="search-input"
            data-agc-search
            placeholder="Filter commits (subject, author, sha)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="icon-btn" title="Clear" onClick={() => setQuery('')}>
              <X size={11} />
            </button>
          ) : null}
        </div>
        <span className="toolbar-count">
          {filtered.length}
          {query && filtered.length !== commits.length ? ` / ${commits.length}` : ''}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Reload history"
          onClick={() => setReloadNonce((value) => value + 1)}
          disabled={loading}
        >
          {loading ? <Spinner size={12} /> : <RotateCw size={13} />}
        </button>
      </div>

      {error ? (
        <EmptyState
          icon={<GitCommitHorizontal size={26} />}
          title="Cannot load history"
          hint={error}
          action={
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setReloadNonce((value) => value + 1)}
            >
              <RotateCw size={12} /> Retry
            </button>
          }
        />
      ) : loading && commits.length === 0 ? (
        <div className="loading-center">
          <Spinner size={18} />
        </div>
      ) : commits.length === 0 ? (
        <EmptyState
          icon={<GitCommitHorizontal size={26} />}
          title="No commits yet"
          hint="Commit your first change in the Changes section."
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Search size={26} />}
          title="No matching commits"
          hint={
            hasMore
              ? 'Only loaded commits are searched. Load more to continue.'
              : 'Try a shorter search term.'
          }
          {...(hasMore
            ? {
                action: (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void loadMore()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? <Spinner size={11} /> : null}
                    Load more
                  </button>
                ),
              }
            : {})}
        />
      ) : (
        <div className="history-list" ref={listRef}>
          {filtered.map((commit, index) => {
            const graph = graphRows[index];
            if (!graph) return null;
            return (
              <div
                key={commit.sha}
                className={`history-row ${selected?.sha === commit.sha ? 'selected' : ''}`}
                style={{
                  gridTemplateColumns: `${graph.width * LANE_WIDTH}px minmax(0, 1fr) auto auto auto`,
                }}
                onClick={() => setSelected(commit)}
                onContextMenu={(event) => menuCtrl.open(event, menuFor(commit))}
                title={`${commit.subject}\n${commit.author} · ${formatDate(commit.date)}`}
              >
                <span className="graph-cell">
                  <Graph row={graph} />
                </span>
                <span className="commit-main">
                  <RefChips commit={commit} />
                  <span className="commit-subject">{commit.subject}</span>
                </span>
                <span className="commit-meta">
                  {commit.author} · {relativeTime(commit.date)}
                </span>
                <span className="commit-sha" title={commit.sha}>
                  {commit.shortSha}
                </span>
                <button
                  type="button"
                  className="icon-btn commit-more"
                  title="Commit actions"
                  onClick={(event) => openRowMenu(event, commit)}
                >
                  <MoreHorizontal size={12} />
                </button>
              </div>
            );
          })}
          {hasMore ? (
            <div className="load-more">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void loadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? <Spinner size={11} /> : null}
                Load more
              </button>
            </div>
          ) : (
            <div className="load-more dim-row">All loaded commits are shown.</div>
          )}
        </div>
      )}

      <ContextMenu menu={menuCtrl.menu} onClose={menuCtrl.close} />

      {selected ? (
        <CommitDrawer
          key={selected.sha}
          repo={activeRepo}
          commit={selected}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
