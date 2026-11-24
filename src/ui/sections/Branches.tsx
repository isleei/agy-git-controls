import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine,
  ArrowLeftRight,
  Check,
  Copy,
  GitBranch,
  Link2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Search,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import { api } from '../api';
import type { BranchInfo } from '../../core/types.js';
import { useStore } from '../store';
import { ContextMenu, useContextMenu, type MenuItem } from '../components/ContextMenu';
import { CollapsibleGroup } from '../components/Group';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { copyText, relativeTime } from '../utils';

interface NewFromState {
  start: string;
  name: string;
  checkout: boolean;
}

export function BranchesSection() {
  const { state, activeRepo, isBusy, run, refreshBranches, toast } = useStore();
  const menuCtrl = useContextMenu();
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<{ name: string; value: string } | null>(null);
  const [newFrom, setNewFrom] = useState<NewFromState | null>(null);

  useEffect(() => {
    setRenaming(null);
    setNewFrom(null);
    if (activeRepo) void refreshBranches();
  }, [activeRepo, refreshBranches]);

  const branches = state.branches;
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return branches;
    return branches.filter(
      (branch) =>
        branch.name.toLowerCase().includes(needle) ||
        (branch.upstream ?? '').toLowerCase().includes(needle),
    );
  }, [branches, query]);

  const locals = filtered
    .filter((branch) => !branch.remote)
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const remotes = filtered
    .filter((branch) => branch.remote)
    .sort((a, b) => a.name.localeCompare(b.name));

  const checkout = async (branch: BranchInfo): Promise<void> => {
    if (!activeRepo || branch.current) return;
    await run('branch-checkout', () => api.checkoutBranch(activeRepo, branch.name), {
      success: `Switched to ${branch.name}`,
    });
  };

  const commitRename = async (): Promise<void> => {
    if (!activeRepo || !renaming) return;
    const next = renaming.value.trim();
    if (!next || next === renaming.name) {
      setRenaming(null);
      return;
    }
    const result = await run(
      'branch-rename',
      () => api.renameBranch(activeRepo, renaming.name, next),
      { success: `Renamed ${renaming.name} → ${next}` },
    );
    if (result?.ok) setRenaming(null);
  };

  const confirmDelete = async (branch: BranchInfo): Promise<void> => {
    if (!activeRepo) return;
    await run(
      `branch-delete:${branch.name}`,
      (ctx) =>
        api.deleteBranch(activeRepo, branch.name, {
          force: ctx.checked,
          confirmed: true,
        }),
      {
        confirm: {
          title: 'Delete local branch?',
          target: branch.name,
          description:
            'The branch ref is removed. Commits that are not merged elsewhere become unreachable.',
          confirmLabel: 'Delete',
          danger: true,
          check: { label: 'Force delete (unmerged commits)', defaultChecked: false },
        },
        success: `Deleted ${branch.name}`,
      },
    );
  };

  const setUpstream = async (branch: BranchInfo, upstream: string | null): Promise<void> => {
    if (!activeRepo) return;
    await run(
      'branch-upstream',
      () => api.setUpstream(activeRepo, branch.name, upstream),
      { success: upstream ? `Upstream set to ${upstream}` : 'Upstream unset' },
    );
  };

  const openUpstreamMenu = (branch: BranchInfo, point: { x: number; y: number }): void => {
    const remoteBranches = branches.filter((candidate) => candidate.remote);
    const items: MenuItem[] = [{ type: 'header', label: `Upstream for ${branch.name}` }];
    if (branch.upstream) {
      items.push({
        label: `Unset (${branch.upstream})`,
        icon: <Unlink size={12} />,
        onSelect: () => void setUpstream(branch, null),
      });
    }
    if (remoteBranches.length === 0) {
      items.push({ type: 'header', label: 'No remote branches' });
    } else {
      for (const remoteBranch of remoteBranches) {
        items.push({
          label: remoteBranch.name,
          icon: <Link2 size={12} />,
          onSelect: () => void setUpstream(branch, remoteBranch.name),
        });
      }
    }
    menuCtrl.openAt(point.x, point.y, items);
  };

  const track = async (branch: BranchInfo): Promise<void> => {
    if (!activeRepo) return;
    await run('branch-track', () => api.trackRemote(activeRepo, branch.name), {
      success: `Tracking ${branch.name}`,
    });
  };

  const copyName = async (branch: BranchInfo): Promise<void> => {
    const ok = await copyText(branch.name);
    toast(ok ? 'success' : 'error', ok ? 'Branch name copied' : 'Clipboard unavailable');
  };

  const buildMenu = (branch: BranchInfo): MenuItem[] => {
    const items: MenuItem[] = [];
    if (!branch.current) {
      items.push({
        label: 'Checkout',
        icon: <Play size={12} />,
        onSelect: () => void checkout(branch),
      });
    }
    if (!branch.remote) {
      items.push({
        label: 'Rename…',
        icon: <Pencil size={12} />,
        onSelect: () => setRenaming({ name: branch.name, value: branch.name }),
      });
      items.push({
        label: 'Set upstream…',
        icon: <ArrowLeftRight size={12} />,
        onSelect: () => openUpstreamMenu(branch, menuCtrl.lastPointRef.current),
      });
      items.push({
        label: 'New branch from…',
        icon: <Plus size={12} />,
        onSelect: () => setNewFrom({ start: branch.name, name: '', checkout: true }),
      });
      items.push({ type: 'separator' });
      items.push({
        label: 'Delete…',
        icon: <Trash2 size={12} />,
        danger: true,
        disabled: branch.current,
        onSelect: () => void confirmDelete(branch),
      });
    } else {
      items.push({
        label: 'Track as local branch',
        icon: <ArrowDownToLine size={12} />,
        onSelect: () => void track(branch),
      });
      items.push({
        label: 'New branch from…',
        icon: <Plus size={12} />,
        onSelect: () => setNewFrom({ start: branch.name, name: '', checkout: true }),
      });
      items.push({ type: 'separator' });
    }
    items.push({
      label: 'Copy branch name',
      icon: <Copy size={12} />,
      onSelect: () => void copyName(branch),
    });
    return items;
  };

  const openRowMenuAt = (event: React.MouseEvent<HTMLButtonElement>, branch: BranchInfo): void => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    menuCtrl.openAt(rect.left, rect.bottom + 2, buildMenu(branch));
  };

  const submitNewFrom = async (): Promise<void> => {
    if (!activeRepo || !newFrom) return;
    const name = newFrom.name.trim();
    if (!name) return;
    const result = await run(
      'branch-create',
      () =>
        api.createBranch(activeRepo, {
          name,
          startPoint: newFrom.start,
          checkout: newFrom.checkout,
        }),
      { success: `Created ${name} from ${newFrom.start}` },
    );
    if (result?.ok) setNewFrom(null);
  };

  const renderRow = (branch: BranchInfo): ReactNode => {
    if (renaming?.name === branch.name) {
      return (
        <form
          key={`rename:${branch.name}`}
          className="row branch-row renaming"
          onSubmit={(event) => {
            event.preventDefault();
            void commitRename();
          }}
        >
          <input
            className="text-input inline-input"
            autoFocus
            value={renaming.value}
            onChange={(event) => setRenaming({ name: branch.name, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setRenaming(null);
              }
            }}
            spellCheck={false}
          />
          <button
            type="submit"
            className="icon-btn"
            title="Save"
            disabled={isBusy('branch-rename') || !renaming.value.trim()}
          >
            {isBusy('branch-rename') ? <Spinner size={11} /> : <Check size={12} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Cancel"
            onClick={() => setRenaming(null)}
          >
            <X size={12} />
          </button>
        </form>
      );
    }

    const meta = branch.current;
    return (
      <div
        key={branch.ref}
        className={`row branch-row ${meta ? 'current' : ''}`}
        onContextMenu={(event) => menuCtrl.open(event, buildMenu(branch))}
        title={branch.name}
      >
        <span className="branch-name">
          {branch.current ? <Check size={12} className="branch-check" /> : null}
          <span className={branch.current ? 'strong' : ''}>{branch.name}</span>
        </span>
        <span className="branch-upstream">{branch.upstream ?? ''}</span>
        <span className="branch-ab" title={`${branch.ahead} ahead, ${branch.behind} behind`}>
          <span>↑{branch.ahead}</span>
          <span>↓{branch.behind}</span>
        </span>
        <span className="branch-time">{relativeTime(branch.lastCommitAt)}</span>
        <span className="row-actions">
          {!branch.current ? (
            <button
              type="button"
              className="icon-btn"
              title="Checkout"
              disabled={isBusy('branch-checkout')}
              onClick={(event) => {
                event.stopPropagation();
                void checkout(branch);
              }}
            >
              <Play size={12} />
            </button>
          ) : null}
          {!branch.remote ? (
            <>
              <button
                type="button"
                className="icon-btn"
                title="Rename"
                onClick={(event) => {
                  event.stopPropagation();
                  setRenaming({ name: branch.name, value: branch.name });
                }}
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                className="icon-btn danger-hover"
                title="Delete"
                disabled={branch.current}
                onClick={(event) => {
                  event.stopPropagation();
                  void confirmDelete(branch);
                }}
              >
                <Trash2 size={12} />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="icon-btn"
              title="Track remote branch"
              disabled={isBusy('branch-track')}
              onClick={(event) => {
                event.stopPropagation();
                void track(branch);
              }}
            >
              <ArrowDownToLine size={12} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="More actions"
            onClick={(event) => openRowMenuAt(event, branch)}
          >
            <MoreHorizontal size={12} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <div className="section-body branches">
      <div className="section-toolbar">
        <div className="search-box">
          <Search size={12} />
          <input
            className="search-input"
            data-agc-search
            placeholder="Filter branches"
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
        <span className="toolbar-count">{filtered.length}</span>
      </div>

      {!activeRepo ? (
        <EmptyState icon={<GitBranch size={26} />} title="No repository selected" />
      ) : state.branchesError && branches.length === 0 ? (
        <EmptyState
          icon={<GitBranch size={26} />}
          title="Cannot load branches"
          hint={state.branchesError}
          action={
            <button type="button" className="btn btn-sm" onClick={() => void refreshBranches()}>
              <RotateCw size={12} /> Retry
            </button>
          }
        />
      ) : state.branchesLoading && branches.length === 0 ? (
        <div className="loading-center">
          <Spinner size={18} />
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<GitBranch size={26} />}
          title={query ? 'No matching branches' : 'No branches'}
          {...(query ? { hint: 'Try a different filter.' } : {})}
        />
      ) : (
        <div className="section-scroll">
          {locals.length > 0 || !query ? (
            <CollapsibleGroup title="Local" count={locals.length}>
              {locals.length === 0 ? (
                <div className="dim-row">No local branches</div>
              ) : (
                locals.map(renderRow)
              )}
            </CollapsibleGroup>
          ) : null}
          {remotes.length > 0 || !query ? (
            <CollapsibleGroup title="Remote" count={remotes.length}>
              {remotes.length === 0 ? (
                <div className="dim-row">No remote branches</div>
              ) : (
                remotes.map(renderRow)
              )}
            </CollapsibleGroup>
          ) : null}
        </div>
      )}

      <ContextMenu menu={menuCtrl.menu} onClose={menuCtrl.close} />

      {newFrom ? (
        <Modal
          title="New branch"
          onClose={() => setNewFrom(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setNewFrom(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!newFrom.name.trim() || isBusy('branch-create')}
                onClick={() => void submitNewFrom()}
              >
                {isBusy('branch-create') ? <Spinner size={11} /> : 'Create'}
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">Branch name</span>
            <input
              className="text-input"
              autoFocus
              value={newFrom.name}
              placeholder="feature/my-branch"
              onChange={(event) => setNewFrom({ ...newFrom, name: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Start point</span>
            <input
              className="text-input"
              value={newFrom.start}
              onChange={(event) => setNewFrom({ ...newFrom, start: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={newFrom.checkout}
              onChange={(event) => setNewFrom({ ...newFrom, checkout: event.target.checked })}
            />
            <span>Checkout after creating</span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}
