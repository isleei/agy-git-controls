import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowUp,
  Check,
  FileDiff,
  Minus,
  Plus,
  RotateCw,
  Sparkles,
  Undo2,
  X,
} from 'lucide-react';
import { api, errorMessage } from '../api';
import type { FileChange, RepoStatus } from '../../core/types.js';
import { useStore } from '../store';
import { useVirtualRows } from '../hooks/useVirtualRows';
import { DiffView, type DiffTarget } from '../components/DiffView';
import { EmptyState } from '../components/EmptyState';
import { GroupHeader } from '../components/Group';
import { Spinner } from '../components/Spinner';
import { splitPath, statusLetter } from '../utils';

type GroupId = 'conflicts' | 'staged' | 'changes' | 'untracked';

interface GroupDef {
  id: GroupId;
  title: string;
  tone: 'default' | 'conflict' | 'muted';
  changes: FileChange[];
}

type Row =
  | { kind: 'header'; group: GroupDef }
  | { kind: 'file'; group: GroupId; change: FileChange };

const ROW_HEIGHT = 22;
const VIRTUAL_THRESHOLD = 400;

function groupsOf(status: RepoStatus): GroupDef[] {
  return [
    {
      id: 'conflicts',
      title: 'Conflicts',
      tone: 'conflict',
      changes: status.conflicted,
    },
    { id: 'staged', title: 'Staged', tone: 'default', changes: status.staged },
    { id: 'changes', title: 'Changes', tone: 'default', changes: status.unstaged },
    { id: 'untracked', title: 'Untracked', tone: 'muted', changes: status.untracked },
  ];
}

interface Selection {
  group: GroupId;
  path: string;
}

export function ChangesSection() {
  const {
    state,
    activeRepo,
    isBusy,
    run,
    toast,
    refreshStatus,
  } = useStore();
  const status = state.status;
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<GroupId, boolean>>({
    conflicts: false,
    staged: false,
    changes: false,
    untracked: false,
  });
  const [selection, setSelection] = useState<Selection | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setMessage('');
    setAmend(false);
    setSelection(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [activeRepo]);

  useEffect(() => {
    if (!amend || message.trim().length > 0 || !activeRepo) return undefined;
    let cancelled = false;
    void api
      .log(activeRepo, { maxCount: 1 })
      .then((page) => {
        const commit = page.commits[0];
        if (!commit || cancelled) return;
        const text = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
        setMessage((current) => (current.trim().length > 0 ? current : text));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Intentionally not re-running when `message` changes.
  }, [amend, activeRepo]);

  const groups = useMemo(() => (status ? groupsOf(status) : []), [status]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const group of groups) {
      if (group.changes.length === 0) {
        // Conflicts stay visible only while an operation is in progress.
        if (group.id !== 'conflicts' || !status?.operation) continue;
      }
      out.push({ kind: 'header', group });
      if (!collapsed[group.id]) {
        for (const change of group.changes) out.push({ kind: 'file', group: group.id, change });
      }
    }
    return out;
  }, [groups, collapsed, status?.operation]);

  const virtual = rows.length > VIRTUAL_THRESHOLD;
  const virtualWindow = useVirtualRows(listRef, rows.length, ROW_HEIGHT, 10);
  const start = virtual ? virtualWindow.start : 0;
  const end = virtual ? virtualWindow.end : rows.length;

  const stickyGroup = useMemo(() => {
    if (!virtual) return null;
    let current: GroupDef | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.kind === 'header' && index * ROW_HEIGHT <= virtualWindow.scrollTop + 0.5) {
        current = row.group;
        continue;
      }
      if (index * ROW_HEIGHT > virtualWindow.scrollTop) break;
    }
    if (!current) return null;
    const headerIndex = rows.findIndex((row) => row.kind === 'header' && row.group.id === current?.id);
    if (headerIndex < 0 || virtualWindow.scrollTop <= headerIndex * ROW_HEIGHT + 0.5) return null;
    return current;
  }, [virtual, rows, virtualWindow.scrollTop]);

  const selectedChange = useMemo(() => {
    if (!selection || !status) return null;
    const source =
      selection.group === 'conflicts'
        ? status.conflicted
        : selection.group === 'staged'
          ? status.staged
          : selection.group === 'changes'
            ? status.unstaged
            : status.untracked;
    return source.find((change) => change.path === selection.path) ?? null;
  }, [selection, status]);

  useEffect(() => {
    if (selection && !selectedChange) setSelection(null);
  }, [selection, selectedChange]);

  const stage = (paths: string[]): void => {
    if (!activeRepo) return;
    void run('stage', () => api.stage(activeRepo, paths), {
      success: paths.length === 1 ? 'File staged' : `${paths.length} files staged`,
    });
  };

  const unstage = (paths: string[]): void => {
    if (!activeRepo) return;
    void run('unstage', () => api.unstage(activeRepo, paths), {
      success: paths.length === 1 ? 'File unstaged' : `${paths.length} files unstaged`,
    });
  };

  const discard = (change: FileChange, group: GroupId): void => {
    if (!activeRepo) return;
    const untracked = group === 'untracked' || change.kind === '?';
    void run(
      'discard',
      (ctx) =>
        api.discard(activeRepo, [change.path], {
          ...(group === 'staged' ? { staged: true } : {}),
          ...(untracked ? { deleteUntracked: ctx.checked } : {}),
          confirmed: true,
        }),
      {
        confirm: {
          title: untracked ? 'Delete untracked file?' : 'Discard changes?',
          target: change.path,
          description: untracked
            ? 'The file is removed from disk. This cannot be undone.'
            : 'Local changes are restored from HEAD. This cannot be undone.',
          confirmLabel: untracked ? 'Delete' : 'Discard',
          danger: true,
          ...(untracked
            ? { check: { label: 'Delete the file from disk', defaultChecked: true } }
            : {}),
        },
        success: untracked ? 'File deleted' : 'Changes discarded',
      },
    );
  };

  const abortOperation = (): void => {
    if (!activeRepo || !status?.operation) return;
    const operation = status.operation;
    const confirm = {
      title: `Abort ${operation}?`,
      description: 'The in-progress operation is rolled back to its previous state.',
      confirmLabel: 'Abort',
      danger: true,
    };
    if (operation === 'merge') {
      void run('abort', () => api.merge(activeRepo, { action: 'abort' }), {
        confirm,
        success: 'Merge aborted',
      });
    } else if (operation === 'rebase') {
      void run('abort', () => api.rebase(activeRepo, { action: 'abort' }), {
        confirm,
        success: 'Rebase aborted',
      });
    } else if (operation === 'cherry-pick') {
      void run('abort', () => api.cherryPick(activeRepo, { action: 'abort' }), {
        confirm,
        success: 'Cherry-pick aborted',
      });
    } else {
      toast('info', `Abort is not available for ${operation}`);
    }
  };

  const groupActions = (id: GroupId): ReactNode => {
    if (id === 'conflicts') {
      return status?.operation ? (
        <button
          type="button"
          className="text-btn danger"
          onClick={abortOperation}
          disabled={isBusy('abort')}
          title={`Abort ${status.operation}`}
        >
          {isBusy('abort') ? <Spinner size={11} /> : <X size={11} />}
          Abort
        </button>
      ) : null;
    }
    if (id === 'staged') {
      return (
        <button
          type="button"
          className="icon-btn"
          title="Unstage all"
          onClick={() => activeRepo && unstage(status?.staged.map((change) => change.path) ?? [])}
          disabled={isBusy('unstage')}
        >
          <Minus size={12} />
        </button>
      );
    }
    return null;
  };

  const stageAll = (): void => {
    if (!activeRepo) return;
    void run('stage-all', () => api.stageAll(activeRepo), { success: 'Staged all changes' });
  };

  const unstageAll = (): void => {
    if (!activeRepo) return;
    void run('unstage-all', () => api.unstageAll(activeRepo), { success: 'Unstaged all changes' });
  };

  const canCommit = !!activeRepo && message.trim().length > 0 && (amend || (status?.staged.length ?? 0) > 0);

  const resetComposer = (): void => {
    setMessage('');
    setAmend(false);
  };

  const commit = async (): Promise<void> => {
    if (!activeRepo || !canCommit) return;
    const result = await run('commit', () => api.commit(activeRepo, { message: message.trim(), amend }), {
      success: amend ? 'Commit amended' : 'Committed',
    });
    if (result?.ok) resetComposer();
  };

  const askAiForMessage = async (): Promise<void> => {
    if (!activeRepo || stagedCount === 0) return;
    setAiBusy(true);
    try {
      await api.sendToConversation(activeRepo, {
        kind: 'diff',
        staged: true,
        prompt:
          'Write a concise conventional-commit message (subject + optional body) for these staged changes. Reply with the message only.',
      });
      toast('success', 'Staged diff sent to Agent', 'Pick the suggested message from the conversation.');
    } catch (err) {
      toast('error', 'Cannot reach the Agent', errorMessage(err));
    } finally {
      setAiBusy(false);
    }
  };

  const commitAndPush = async (): Promise<void> => {
    if (!activeRepo || !canCommit || !status?.branch) return;
    const result = await run('commit', () => api.commit(activeRepo, { message: message.trim(), amend }), {
      success: 'Committed',
    });
    if (!result?.ok) return;
    resetComposer();
    await run(
      'push',
      () =>
        api.push(activeRepo, {
          ...(status?.upstream ? {} : { setUpstream: true }),
        }),
      { success: 'Pushed' },
    );
  };

  const diffTarget = (change: FileChange, group: GroupId): DiffTarget => {
    const hint =
      group === 'untracked' ? 'Untracked file — stage it to see a diff.' : undefined;
    return {
      key: `${group}:${change.path}`,
      title: change.path,
      request: group === 'staged' ? { path: change.path, staged: true } : { path: change.path },
      change,
      ...(hint !== undefined ? { hint } : {}),
    };
  };

  const selectedTarget =
    selection && selectedChange ? diffTarget(selectedChange, selection.group) : null;

  const handleComposerKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.nativeEvent.isComposing) return;
    event.preventDefault();
    void commit();
  };

  const renderFileRow = (change: FileChange, group: GroupId): ReactNode => {
    const parts = splitPath(change.path);
    const meta = statusLetter(change.kind);
    const selected = selection?.group === group && selection.path === change.path;
    const isConflicted = group === 'conflicts' || change.conflicted;
    return (
      <div
        key={`${group}:${change.path}`}
        className={`row file-row ${selected ? 'selected' : ''} ${isConflicted ? 'conflicted' : ''}`}
        title={change.origPath ? `${change.origPath} → ${change.path}` : change.path}
        onClick={() => setSelection({ group, path: change.path })}
      >
        <span className={`status-letter tone-${meta.tone}`}>{meta.letter}</span>
        <span className="file-name">{parts.name}</span>
        <span className="file-dir">{parts.dir}</span>
        <span className="row-actions">
          {group === 'staged' ? (
            <button
              type="button"
              className="icon-btn"
              title="Unstage"
              disabled={isBusy('unstage')}
              onClick={(event) => {
                event.stopPropagation();
                unstage([change.path]);
              }}
            >
              <Minus size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              title={isConflicted ? 'Mark resolved (stage)' : 'Stage'}
              disabled={isBusy('stage')}
              onClick={(event) => {
                event.stopPropagation();
                stage([change.path]);
              }}
            >
              <Plus size={12} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn danger-hover"
            title={group === 'untracked' ? 'Delete file…' : 'Discard changes…'}
            disabled={isBusy('discard')}
            onClick={(event) => {
              event.stopPropagation();
              discard(change, group);
            }}
          >
            <Undo2 size={12} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="View diff"
            onClick={(event) => {
              event.stopPropagation();
              setSelection({ group, path: change.path });
            }}
          >
            <FileDiff size={12} />
          </button>
        </span>
      </div>
    );
  };

  const renderRow = (row: Row): ReactNode => {
    if (row.kind === 'header') {
      const isOpen = !collapsed[row.group.id];
      const actions = groupActions(row.group.id);
      return (
        <GroupHeader
          key={`head:${row.group.id}`}
          title={row.group.title}
          count={row.group.changes.length}
          tone={row.group.tone}
          open={isOpen}
          onToggle={() =>
            setCollapsed((current) => ({ ...current, [row.group.id]: !current[row.group.id] }))
          }
          sticky={!virtual}
          {...(actions !== null && actions !== undefined ? { actions } : {})}
        />
      );
    }
    return renderFileRow(row.change, row.group);
  };

  if (!activeRepo) {
    return (
      <div className="section-body">
        <EmptyState
          icon={<FileDiff size={26} />}
          title="No repository selected"
          hint="Pick a repository in the header or add one."
        />
      </div>
    );
  }

  if (!status) {
    return (
      <div className="section-body">
        {state.statusError ? (
          <EmptyState
            icon={<FileDiff size={26} />}
            title="Cannot read repository status"
            hint={state.statusError}
            action={
              <button type="button" className="btn" onClick={() => void refreshStatus()}>
                <RotateCw size={12} /> Retry
              </button>
            }
          />
        ) : (
          <div className="loading-center">
            <Spinner size={18} />
          </div>
        )}
      </div>
    );
  }

  const stagedCount = status.staged.length;
  const changeCount = status.unstaged.length + status.untracked.length;
  const conflictCount = status.conflicted.length;

  return (
    <div className="section-body changes">
      <div className="commit-box">
        <textarea
          ref={textareaRef}
          className="commit-input"
          placeholder={amend ? 'Amend commit message' : 'Commit message'}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleComposerKey}
          rows={3}
          spellCheck={false}
        />
        <div className="commit-actions">
          <button
            type="button"
            className={`toggle ${amend ? 'active' : ''}`}
            onClick={() => setAmend((value) => !value)}
            title="Amend the last commit"
          >
            Amend
          </button>
          <span className="composer-hint">
            {message.trim().length === 0
              ? 'Enter a message'
              : stagedCount === 0 && !amend
                ? 'Stage files first'
                : `${stagedCount} staged`}
          </span>
          <div className="commit-buttons">
            <button
              type="button"
              className="icon-btn"
              disabled={!activeRepo || stagedCount === 0 || aiBusy}
              onClick={() => void askAiForMessage()}
              title="Send the staged diff to the Agent and ask for a commit message"
            >
              {aiBusy ? <Spinner size={11} /> : <Sparkles size={12} />}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canCommit || isBusy('commit')}
              onClick={() => void commit()}
              title="Commit (Enter)"
            >
              {isBusy('commit') ? <Spinner size={11} /> : <Check size={12} />}
              <span className="btn-label">Commit</span>
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!canCommit || !status?.branch || isBusy('commit') || isBusy('push')}
              onClick={() => void commitAndPush()}
              title="Commit, then push"
            >
              {isBusy('commit') || isBusy('push') ? (
                <Spinner size={11} />
              ) : (
                <ArrowUp size={12} />
              )}
              <span className="btn-label">Commit &amp; Push</span>
            </button>
          </div>
        </div>
        {status.operation ? (
          <div className="operation-banner">
            <span>
              {status.operation} in progress
              {conflictCount > 0 ? ` — ${conflictCount} conflicted` : ''}
            </span>
            {['merge', 'rebase', 'cherry-pick'].includes(status.operation) ? (
              <button
                type="button"
                className="text-btn danger"
                onClick={abortOperation}
                disabled={isBusy('abort')}
              >
                Abort
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="changes-actions">
        <button
          type="button"
          className="text-btn"
          onClick={stageAll}
          disabled={isBusy('stage-all')}
          title="Stage every change"
        >
          {isBusy('stage-all') ? <Spinner size={11} /> : <Plus size={11} />}
          <span className="btn-label">Stage all</span>
        </button>
        <button
          type="button"
          className="text-btn"
          onClick={unstageAll}
          disabled={isBusy('unstage-all') || stagedCount === 0}
          title="Unstage everything"
        >
          {isBusy('unstage-all') ? <Spinner size={11} /> : <Minus size={11} />}
          <span className="btn-label">Unstage all</span>
        </button>
        <span className="changes-summary">
          {stagedCount} staged · {changeCount} changed
          {conflictCount > 0 ? ` · ${conflictCount} conflicted` : ''}
        </span>
      </div>

      {conflictCount > 0 ? (
        <div className="conflict-hint">
          Resolve each conflict in the editor, then stage the file to mark it resolved.
        </div>
      ) : null}

      <div className={`changes-list ${virtual ? 'virtual' : ''}`} ref={listRef}>
        {stickyGroup ? (
          <div className="virtual-sticky">
            <GroupHeader
              title={stickyGroup.title}
              count={stickyGroup.changes.length}
              tone={stickyGroup.tone}
              open={!collapsed[stickyGroup.id]}
              onToggle={() =>
                setCollapsed((current) => ({
                  ...current,
                  [stickyGroup.id]: !current[stickyGroup.id],
                }))
              }
              sticky={false}
              {...(groupActions(stickyGroup.id) !== null &&
              groupActions(stickyGroup.id) !== undefined
                ? { actions: groupActions(stickyGroup.id) }
                : {})}
            />
          </div>
        ) : null}
        {rows.length === 0 ? (
          <EmptyState
            icon={<Check size={26} />}
            title="Working tree clean"
            hint="Nothing to commit. Pull or fetch to sync with the remote."
          />
        ) : (
          <>
            {virtual ? <div style={{ height: start * ROW_HEIGHT }} /> : null}
            {rows.slice(start, end).map((row) => renderRow(row))}
            {virtual ? <div style={{ height: Math.max(0, (rows.length - end) * ROW_HEIGHT) }} /> : null}
          </>
        )}
      </div>

      {selection && selectedTarget ? (
        <div className="changes-diff">
          <DiffView
            key={selectedTarget.key}
            repo={activeRepo}
            target={selectedTarget}
            onClose={() => setSelection(null)}
          />
        </div>
      ) : null}
    </div>
  );
}
