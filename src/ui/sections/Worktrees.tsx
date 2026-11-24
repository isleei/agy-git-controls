import { useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  FolderTree,
  GitBranch,
  Lock,
  Plus,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import type { WorktreeInfo } from '../../core/types.js';
import { useStore } from '../store';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { shortSha } from '../utils';

interface AddWorktreeState {
  path: string;
  branch: string;
  create: boolean;
  detached: boolean;
}

const emptyForm: AddWorktreeState = {
  path: '',
  branch: '',
  create: false,
  detached: false,
};

export function WorktreesSection() {
  const {
    state,
    activeRepo,
    selectRepo,
    addRepo,
    isBusy,
    run,
    refreshWorktrees,
  } = useStore();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState<AddWorktreeState>(emptyForm);

  useEffect(() => {
    setAddOpen(false);
    setForm(emptyForm);
    if (activeRepo) void refreshWorktrees();
  }, [activeRepo, refreshWorktrees]);

  const worktrees = state.worktrees;
  const localBranches = state.branches.filter((branch) => !branch.remote);

  const submitAdd = async (): Promise<void> => {
    if (!activeRepo) return;
    const worktreePath = form.path.trim();
    const branch = form.branch.trim();
    if (!worktreePath) return;
    if (!form.detached && !branch) return;
    const result = await run(
      'worktree-add',
      () =>
        api.worktreeAdd(activeRepo, {
          path: worktreePath,
          ...(form.detached
            ? { detached: true }
            : form.create
              ? { newBranch: branch }
              : { branch }),
        }),
      { success: 'Worktree added' },
    );
    if (result?.ok) {
      setAddOpen(false);
      setForm(emptyForm);
    }
  };

  const remove = (worktree: WorktreeInfo): void => {
    if (!activeRepo) return;
    void run(
      `worktree-remove:${worktree.path}`,
      (ctx) =>
        api.worktreeRemove(activeRepo, worktree.path, {
          force: ctx.checked,
          confirmed: true,
        }),
      {
        confirm: {
          title: 'Remove worktree?',
          target: worktree.path,
          description:
            'The checkout directory is removed. Commits on its branch remain in the repository.',
          confirmLabel: 'Remove',
          danger: true,
          check: { label: 'Force remove (dirty or locked worktree)', defaultChecked: false },
        },
        success: 'Worktree removed',
      },
    );
  };

  const switchTo = async (worktree: WorktreeInfo): Promise<void> => {
    if (worktree.path === activeRepo) return;
    if (state.repos.some((repo) => repo.path === worktree.path)) {
      selectRepo(worktree.path);
      return;
    }
    // A worktree outside the workspace is not callable until it is registered.
    await addRepo(worktree.path);
  };

  const addDisabled =
    !form.path.trim() || (!form.detached && !form.branch.trim()) || isBusy('worktree-add');

  return (
    <div className="section-body worktrees">
      <div className="section-toolbar">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setAddOpen(true)}
          disabled={!activeRepo}
          title="Add a linked worktree"
        >
          <Plus size={12} />
          <span className="btn-label">Add worktree…</span>
        </button>
        <span className="header-spacer" />
        <span className="toolbar-count">{worktrees.length}</span>
        <button
          type="button"
          className="icon-btn"
          title="Refresh worktrees"
          onClick={() => void refreshWorktrees()}
          disabled={!activeRepo || state.worktreesLoading}
        >
          {state.worktreesLoading ? <Spinner size={12} /> : <RotateCw size={13} />}
        </button>
      </div>

      {!activeRepo ? (
        <EmptyState icon={<FolderTree size={26} />} title="No repository selected" />
      ) : state.worktreesError && worktrees.length === 0 ? (
        <EmptyState
          icon={<FolderTree size={26} />}
          title="Cannot load worktrees"
          hint={state.worktreesError}
          action={
            <button type="button" className="btn btn-sm" onClick={() => void refreshWorktrees()}>
              <RotateCw size={12} /> Retry
            </button>
          }
        />
      ) : state.worktreesLoading && worktrees.length === 0 ? (
        <div className="loading-center">
          <Spinner size={18} />
        </div>
      ) : worktrees.length === 0 ? (
        <EmptyState
          icon={<FolderTree size={26} />}
          title="No worktrees"
          hint="Add a linked worktree to work on another branch in parallel."
        />
      ) : (
        <div className="section-scroll">
          {worktrees.map((worktree) => {
            const isCurrent = worktree.path === activeRepo;
            const label = worktree.bare
              ? 'bare'
              : worktree.detached
                ? `detached @${shortSha(worktree.head)}`
                : worktree.branch ?? 'unknown';
            return (
              <div
                key={worktree.path}
                className={`row worktree-row ${isCurrent ? 'current' : ''}`}
                title={worktree.path}
              >
                <FolderTree size={13} className="worktree-icon" />
                <span className="worktree-path">
                  {worktree.path}
                  {isCurrent ? <span className="mini-badge">current</span> : null}
                </span>
                <span className="worktree-branch" title={label}>
                  <GitBranch size={11} />
                  {label}
                </span>
                {worktree.locked ? (
                  <span className="worktree-badge locked" title="Locked worktree">
                    <Lock size={10} /> locked
                  </span>
                ) : null}
                {worktree.prunable ? (
                  <span className="worktree-badge prunable" title="Worktree directory is missing">
                    prunable
                  </span>
                ) : null}
                <span className="row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="Switch the panel to this worktree"
                    disabled={isCurrent}
                    onClick={() => void switchTo(worktree)}
                  >
                    <ArrowRightLeft size={12} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger-hover"
                    title={isCurrent ? 'The active worktree cannot be removed here' : 'Remove worktree…'}
                    disabled={isCurrent || isBusy(`worktree-remove:${worktree.path}`)}
                    onClick={() => remove(worktree)}
                  >
                    {isBusy(`worktree-remove:${worktree.path}`) ? (
                      <Spinner size={11} />
                    ) : (
                      <Trash2 size={12} />
                    )}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {addOpen ? (
        <Modal
          title="Add worktree"
          onClose={() => setAddOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setAddOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={addDisabled}
                onClick={() => void submitAdd()}
              >
                {isBusy('worktree-add') ? <Spinner size={11} /> : 'Add'}
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">Path</span>
            <input
              className="text-input"
              autoFocus
              value={form.path}
              placeholder="/path/to/new-worktree"
              onChange={(event) => setForm({ ...form, path: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Branch</span>
            <input
              className="text-input"
              value={form.branch}
              placeholder={form.create ? 'new-branch-name' : 'existing-branch'}
              list={form.create ? undefined : 'agc-local-branches'}
              onChange={(event) => setForm({ ...form, branch: event.target.value })}
              disabled={form.detached}
              spellCheck={false}
            />
            <datalist id="agc-local-branches">
              {localBranches.map((branch) => (
                <option key={branch.ref} value={branch.name} />
              ))}
            </datalist>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.create}
              disabled={form.detached}
              onChange={(event) => setForm({ ...form, create: event.target.checked })}
            />
            <span>Create a new branch with this name</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={form.detached}
              onChange={(event) => setForm({ ...form, detached: event.target.checked })}
            />
            <span>Detached HEAD (ignore branch)</span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
