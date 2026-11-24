import { useEffect, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { StashEntry } from '../../core/types.js';
import { useStore } from '../store';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { PatchView } from '../components/DiffView';
import { Spinner } from '../components/Spinner';
import { useApi } from '../hooks/useApi';
import { relativeTime } from '../utils';

function StashShow({ repo, index }: { repo: string; index: number }) {
  const { data, loading, error, reload } = useApi(
    () => api.stashShow(repo, index),
    [repo, index],
  );

  if (loading && !data) {
    return (
      <div className="stash-show loading-center">
        <Spinner size={16} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="stash-show diff-error">
        <span>{error}</span>
        <button type="button" className="btn btn-sm" onClick={reload}>
          Retry
        </button>
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="stash-show">
      <div className="stash-show-head">
        <FileDiff size={12} />
        <span>stash@{index}</span>
        <span className="dim">diff stat and files</span>
      </div>
      <PatchView text={data.text} showFileHeaders emptyHint="This stash has no textual changes." />
    </div>
  );
}

export function StashSection() {
  const { state, activeRepo, isBusy, run, refreshStashes } = useStore();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(false);

  useEffect(() => {
    setExpanded(null);
    setPushOpen(false);
    setMessage('');
    setIncludeUntracked(false);
    if (activeRepo) void refreshStashes();
  }, [activeRepo, refreshStashes]);

  const stashes = state.stashes;

  const push = async (): Promise<void> => {
    if (!activeRepo) return;
    const result = await run(
      'stash-push',
      () =>
        api.stashPush(activeRepo, {
          ...(message.trim() ? { message: message.trim() } : {}),
          includeUntracked,
        }),
      { success: 'Changes stashed' },
    );
    if (result?.ok) {
      setPushOpen(false);
      setMessage('');
      setIncludeUntracked(false);
    }
  };

  const apply = async (entry: StashEntry, pop: boolean): Promise<void> => {
    if (!activeRepo) return;
    const result = await run(
      pop ? `stash-pop:${entry.index}` : `stash-apply:${entry.index}`,
      () => (pop ? api.stashPop(activeRepo, entry.index) : api.stashApply(activeRepo, entry.index)),
      { success: pop ? `Popped ${entry.name}` : `Applied ${entry.name}` },
    );
    if (result?.ok) setExpanded(null);
  };

  const drop = async (entry: StashEntry): Promise<void> => {
    if (!activeRepo) return;
    const result = await run(
      `stash-drop:${entry.index}`,
      () => api.stashDrop(activeRepo, entry.index, true),
      {
        confirm: {
          title: 'Drop stash entry?',
          target: `${entry.name} — ${entry.message}`,
          description: 'The stashed changes are permanently removed.',
          confirmLabel: 'Drop',
          danger: true,
        },
        success: `Dropped ${entry.name}`,
      },
    );
    if (result?.ok) setExpanded(null);
  };

  return (
    <div className="section-body stash">
      <div className="section-toolbar">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setPushOpen(true)}
          disabled={!activeRepo}
          title="Stash working tree changes"
        >
          <Plus size={12} />
          <span className="btn-label">Stash changes…</span>
        </button>
        <span className="header-spacer" />
        <span className="toolbar-count">{stashes.length}</span>
        <button
          type="button"
          className="icon-btn"
          title="Refresh stashes"
          onClick={() => void refreshStashes()}
          disabled={!activeRepo || state.stashesLoading}
        >
          {state.stashesLoading ? <Spinner size={12} /> : <RotateCw size={13} />}
        </button>
      </div>

      {!activeRepo ? (
        <EmptyState icon={<Archive size={26} />} title="No repository selected" />
      ) : state.stashesError && stashes.length === 0 ? (
        <EmptyState
          icon={<Archive size={26} />}
          title="Cannot load stashes"
          hint={state.stashesError}
          action={
            <button type="button" className="btn btn-sm" onClick={() => void refreshStashes()}>
              <RotateCw size={12} /> Retry
            </button>
          }
        />
      ) : state.stashesLoading && stashes.length === 0 ? (
        <div className="loading-center">
          <Spinner size={18} />
        </div>
      ) : stashes.length === 0 ? (
        <EmptyState
          icon={<Archive size={26} />}
          title="No stashes"
          hint="Stash uncommitted changes to switch context without committing."
        />
      ) : (
        <div className="section-scroll stash-list">
          {stashes.map((entry) => {
            const isOpen = expanded === entry.index;
            return (
              <div key={`${entry.index}:${entry.name}`} className="stash-item">
                <div
                  className={`row stash-row ${isOpen ? 'selected' : ''}`}
                  onClick={() => setExpanded(isOpen ? null : entry.index)}
                  title={entry.message}
                >
                  <button
                    type="button"
                    className="icon-btn stash-toggle"
                    onClick={(event) => {
                      event.stopPropagation();
                      setExpanded(isOpen ? null : entry.index);
                    }}
                    title={isOpen ? 'Hide stash diff' : 'Show stash diff'}
                  >
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                  <span className="stash-index">{entry.name}</span>
                  <span className="stash-message">{entry.message}</span>
                  <span className="stash-branch">{entry.branch ?? ''}</span>
                  <span className="stash-time">{relativeTime(entry.date)}</span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      title="Apply stash"
                      disabled={isBusy(`stash-apply:${entry.index}`)}
                      onClick={(event) => {
                        event.stopPropagation();
                        apply(entry, false);
                      }}
                    >
                      {isBusy(`stash-apply:${entry.index}`) ? (
                        <Spinner size={11} />
                      ) : (
                        <ArchiveRestore size={12} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      title="Pop stash (apply and drop)"
                      disabled={isBusy(`stash-pop:${entry.index}`)}
                      onClick={(event) => {
                        event.stopPropagation();
                        apply(entry, true);
                      }}
                    >
                      {isBusy(`stash-pop:${entry.index}`) ? (
                        <Spinner size={11} />
                      ) : (
                        <ArrowUpFromLine size={12} />
                      )}
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger-hover"
                      title="Drop stash…"
                      disabled={isBusy(`stash-drop:${entry.index}`)}
                      onClick={(event) => {
                        event.stopPropagation();
                        drop(entry);
                      }}
                    >
                      {isBusy(`stash-drop:${entry.index}`) ? (
                        <Spinner size={11} />
                      ) : (
                        <Trash2 size={12} />
                      )}
                    </button>
                  </span>
                </div>
                {isOpen && activeRepo ? (
                  <StashShow key={entry.index} repo={activeRepo} index={entry.index} />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {pushOpen ? (
        <Modal
          title="Stash changes"
          onClose={() => setPushOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setPushOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={isBusy('stash-push')}
                onClick={() => void push()}
              >
                {isBusy('stash-push') ? <Spinner size={11} /> : 'Stash'}
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">Message (optional)</span>
            <input
              className="text-input"
              autoFocus
              value={message}
              placeholder="WIP: …"
              onChange={(event) => setMessage(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={(event) => setIncludeUntracked(event.target.checked)}
            />
            <span>Include untracked files</span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
