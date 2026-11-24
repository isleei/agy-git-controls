import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CloudDownload,
  FolderGit2,
  GitBranch,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { api } from './api';
import { useStore } from './store';
import { useEscape } from './hooks/useEscape';
import { Spinner } from './components/Spinner';
import { basename } from './utils';

export function Header() {
  const {
    state,
    activeRepo,
    selectRepo,
    refreshAll,
    refreshBranches,
    isBusy,
    run,
    addRepo,
    removeRepo,
    requestConfirm,
  } = useStore();

  const [repoOpen, setRepoOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [branchQuery, setBranchQuery] = useState('');
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const headerRef = useRef<HTMLElement>(null);

  const status = state.status;
  const activeInfo = state.repos.find((repo) => repo.path === activeRepo) ?? null;
  const workspaceRepos = state.repos.filter((repo) => repo.source === 'workspace');
  const registeredRepos = state.repos.filter((repo) => repo.source === 'registered');
  const knownPaths = new Set(state.repos.map((repo) => repo.path));
  const missingRegistered = state.registered.filter((path) => !knownPaths.has(path));
  const localBranches = state.branches
    .filter((branch) => !branch.remote)
    .sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  const filteredBranches = localBranches.filter((branch) =>
    branch.name.toLowerCase().includes(branchQuery.trim().toLowerCase()),
  );

  const anyMenuOpen = repoOpen || branchOpen || moreOpen;
  useEscape(() => {
    setRepoOpen(false);
    setBranchOpen(false);
    setMoreOpen(false);
    setAddOpen(false);
  }, anyMenuOpen);

  useEffect(() => {
    setBranchQuery('');
    setNewBranchOpen(false);
    setRepoOpen(false);
    setBranchOpen(false);
    setMoreOpen(false);
    setAddOpen(false);
  }, [activeRepo]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      if (!headerRef.current?.contains(event.target as Node)) {
        setRepoOpen(false);
        setBranchOpen(false);
        setMoreOpen(false);
        setAddOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const closeMenus = (): void => {
    setRepoOpen(false);
    setBranchOpen(false);
    setMoreOpen(false);
    setAddOpen(false);
  };

  const doRefresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshAll();
    } catch {
      /* individual refresh calls already surface errors via state/toast */
    } finally {
      window.setTimeout(() => setRefreshing(false), 350);
    }
  };

  const fetchNow = (): void => {
    if (!activeRepo) return;
    closeMenus();
    void run('fetch', () => api.fetch(activeRepo, {}), { success: 'Fetched from remote' });
  };

  const pullNow = (mode: 'ff' | 'merge' | 'rebase'): void => {
    if (!activeRepo) return;
    closeMenus();
    const label = mode === 'ff' ? 'Pulled' : `Pulled (${mode})`;
    void run('pull', () => api.pull(activeRepo, mode), { success: label });
  };

  const pushNow = (force: boolean): void => {
    if (!activeRepo) return;
    closeMenus();
    if (force) {
      void run(
        'push',
        (ctx) => api.push(activeRepo, { forceWithLease: true, confirmed: ctx.confirmed }),
        {
          success: 'Force pushed (with lease)',
          confirm: {
            title: 'Force push with lease?',
            ...(status?.branch ? { target: status.branch } : {}),
            description:
              'Updates the remote branch only if it still matches your last fetch. Remote commits can be overwritten.',
            confirmLabel: 'Force push',
            danger: true,
          },
        },
      );
      return;
    }
    const setUpstream = !status?.upstream;
    void run(
      'push',
      () => api.push(activeRepo, { ...(setUpstream ? { setUpstream: true } : {}) }),
      { success: setUpstream ? 'Pushed and set upstream' : 'Pushed' },
    );
  };

  const checkout = async (name: string): Promise<void> => {
    if (!activeRepo) return;
    const result = await run('branch-checkout', () => api.checkoutBranch(activeRepo, name), {
      success: `Switched to ${name}`,
    });
    if (result?.ok) closeMenus();
  };

  const createBranch = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!activeRepo) return;
    const name = newBranchName.trim();
    if (!name) return;
    const result = await run('branch-create', () => api.createBranch(activeRepo, { name, checkout: true }), {
      success: `Created ${name}`,
    });
    if (result?.ok) {
      setNewBranchName('');
      setNewBranchOpen(false);
      closeMenus();
    }
  };

  const submitRepo = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const ok = await addRepo(addPath);
    if (ok) {
      setAddPath('');
      setAddOpen(false);
      closeMenus();
    }
  };

  const confirmRemove = async (path: string): Promise<void> => {
    const answer = await requestConfirm({
      title: 'Remove repository from the panel?',
      target: path,
      description: 'Only the registration is removed. Files on disk are not touched.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (answer.confirmed) await removeRepo(path);
  };

  const branchLabel = status
    ? status.branch ?? (status.detachedAt ? `detached @${status.detachedAt}` : 'no branch')
    : '—';

  return (
    <header className="header" ref={headerRef}>
      <div className="header-row">
        <div className="dropdown">
          <button
            type="button"
            className="repo-btn"
            onClick={() => {
              setRepoOpen((value) => !value);
              setBranchOpen(false);
              setMoreOpen(false);
            }}
            aria-haspopup="menu"
            aria-expanded={repoOpen}
            title={activeRepo ?? 'Select repository'}
          >
            <FolderGit2 size={13} />
            <span className="repo-name">{activeInfo?.name ?? 'Select repository'}</span>
            {activeInfo?.isWorktree ? <span className="mini-badge">wt</span> : null}
            <ChevronDown size={12} className="chev" />
          </button>
          {repoOpen ? (
            <div className="menu header-menu repo-menu" role="menu">
              {workspaceRepos.length > 0 ? (
                <>
                  <div className="menu-header">Workspace</div>
                  {workspaceRepos.map((repo) => (
                    <button
                      key={repo.path}
                      type="button"
                      role="menuitem"
                      className={`menu-item repo-item ${repo.path === activeRepo ? 'selected' : ''}`}
                      title={repo.path}
                      onClick={() => {
                        selectRepo(repo.path);
                        closeMenus();
                      }}
                    >
                      <span className="menu-icon">
                        {repo.path === activeRepo ? <Check size={12} /> : null}
                      </span>
                      <span className="menu-label">
                        <span className="menu-name">{repo.name}</span>
                        <span className="menu-path">{repo.path}</span>
                      </span>
                    </button>
                  ))}
                </>
              ) : null}

              {registeredRepos.length > 0 ? (
                <>
                  <div className="menu-header">Registered</div>
                  {registeredRepos.map((repo) => (
                    <div key={repo.path} className="repo-item-wrap">
                      <button
                        type="button"
                        role="menuitem"
                        className={`menu-item repo-item ${repo.path === activeRepo ? 'selected' : ''}`}
                        title={repo.path}
                        onClick={() => {
                          selectRepo(repo.path);
                          closeMenus();
                        }}
                      >
                        <span className="menu-icon">
                          {repo.path === activeRepo ? <Check size={12} /> : null}
                        </span>
                        <span className="menu-label">
                          <span className="menu-name">{repo.name}</span>
                          <span className="menu-path">{repo.path}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="icon-btn repo-remove"
                        title="Remove from panel"
                        onClick={(event) => {
                          event.stopPropagation();
                          void confirmRemove(repo.path);
                        }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </>
              ) : null}

              {missingRegistered.length > 0 ? (
                <>
                  <div className="menu-header">Missing</div>
                  {missingRegistered.map((path) => (
                    <div key={path} className="repo-item-wrap">
                      <button
                        type="button"
                        className="menu-item repo-item"
                        title={`${path} (not available)`}
                        onClick={() => undefined}
                        disabled
                      >
                        <span className="menu-icon" />
                        <span className="menu-label">
                          <span className="menu-name">{basename(path)}</span>
                          <span className="menu-path">{path}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="icon-btn repo-remove"
                        title="Remove from panel"
                        onClick={() => void confirmRemove(path)}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </>
              ) : null}

              {state.repos.length === 0 && missingRegistered.length === 0 ? (
                <div className="menu-empty">No repository in this workspace.</div>
              ) : null}

              <div className="menu-sep" />
              <button
                type="button"
                className="menu-item"
                onClick={() => setAddOpen((value) => !value)}
              >
                <span className="menu-icon">
                  <Plus size={12} />
                </span>
                <span className="menu-label">Add repository…</span>
              </button>
              {addOpen ? (
                <form className="menu-form" onSubmit={(event) => void submitRepo(event)}>
                  <input
                    className="text-input"
                    autoFocus
                    placeholder="/absolute/path/to/repo"
                    value={addPath}
                    onChange={(event) => setAddPath(event.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={!addPath.trim() || isBusy('repo-add')}
                  >
                    {isBusy('repo-add') ? <Spinner size={11} /> : 'Add'}
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="header-spacer" />

        <button
          type="button"
          className="icon-btn"
          title="Refresh"
          onClick={() => void doRefresh()}
          disabled={!activeRepo || refreshing}
        >
          {refreshing ? <Spinner size={13} /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="header-row branch-row">
        <div className="dropdown branch-dropdown">
          <button
            type="button"
            className="branch-btn"
            onClick={() => {
              setBranchOpen((value) => {
                if (!value) void refreshBranches();
                return !value;
              });
              setRepoOpen(false);
              setMoreOpen(false);
            }}
            aria-haspopup="menu"
            aria-expanded={branchOpen}
            disabled={!activeRepo}
            title={status?.upstream ? `Upstream: ${status.upstream}` : 'Switch branch'}
          >
            <GitBranch size={13} />
            <span className="branch-name">{branchLabel}</span>
            <ChevronDown size={12} className="chev" />
          </button>
          {branchOpen && activeRepo ? (
            <div className="menu header-menu branch-menu" role="menu">
              <div className="menu-search">
                <Search size={12} />
                <input
                  autoFocus
                  placeholder="Search branches"
                  value={branchQuery}
                  onChange={(event) => setBranchQuery(event.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="menu-list">
                {filteredBranches.map((branch) => (
                  <button
                    key={branch.ref}
                    type="button"
                    role="menuitem"
                    className={`menu-item ${branch.current ? 'selected' : ''}`}
                    title={branch.name}
                    onClick={() => {
                      if (branch.current) {
                        closeMenus();
                        return;
                      }
                      void checkout(branch.name);
                    }}
                  >
                    <span className="menu-icon">
                      {branch.current ? <Check size={12} /> : null}
                    </span>
                    <span className="menu-label branch-option">{branch.name}</span>
                  </button>
                ))}
                {filteredBranches.length === 0 ? (
                  <div className="menu-empty">No matching branch.</div>
                ) : null}
              </div>
              <div className="menu-sep" />
              {newBranchOpen ? (
                <form className="menu-form" onSubmit={(event) => void createBranch(event)}>
                  <input
                    className="text-input"
                    autoFocus
                    placeholder="new-branch-name"
                    value={newBranchName}
                    onChange={(event) => setNewBranchName(event.target.value)}
                    spellCheck={false}
                  />
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={!newBranchName.trim() || isBusy('branch-create')}
                  >
                    {isBusy('branch-create') ? <Spinner size={11} /> : 'Create'}
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => setNewBranchOpen(true)}
                >
                  <span className="menu-icon">
                    <Plus size={12} />
                  </span>
                  <span className="menu-label">New branch…</span>
                </button>
              )}
            </div>
          ) : null}
        </div>

        {status ? (
          <button
            type="button"
            className="ab-badge"
            title="Fetch now"
            onClick={fetchNow}
            disabled={!activeRepo || isBusy('fetch')}
          >
            <span className="ab-a">
              <ArrowUp size={10} />
              {status.ahead}
            </span>
            <span className="ab-b">
              <ArrowDown size={10} />
              {status.behind}
            </span>
          </button>
        ) : null}

        <div className="sync-group">
          <button
            type="button"
            className="icon-btn"
            title="Fetch"
            onClick={fetchNow}
            disabled={!activeRepo || isBusy('fetch')}
          >
            {isBusy('fetch') ? <Spinner size={13} /> : <CloudDownload size={14} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Pull (fast-forward only)"
            onClick={() => pullNow('ff')}
            disabled={!activeRepo || isBusy('pull')}
          >
            {isBusy('pull') ? <Spinner size={13} /> : <ArrowDown size={14} />}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Push"
            onClick={() => pushNow(false)}
            disabled={!activeRepo || !status?.branch || isBusy('push')}
          >
            {isBusy('push') ? <Spinner size={13} /> : <ArrowUp size={14} />}
          </button>
          <div className="dropdown">
            <button
              type="button"
              className="icon-btn"
              title="More sync options"
              onClick={() => {
                setMoreOpen((value) => !value);
                setRepoOpen(false);
                setBranchOpen(false);
              }}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              disabled={!activeRepo}
            >
              <MoreHorizontal size={14} />
            </button>
            {moreOpen ? (
              <div className="menu header-menu more-menu" role="menu">
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    closeMenus();
                    if (activeRepo) {
                      void run('fetch', () => api.fetch(activeRepo, { all: true, prune: true }), {
                        success: 'Fetched all remotes (pruned)',
                      });
                    }
                  }}
                >
                  <span className="menu-icon" />
                  <span className="menu-label">Fetch all (prune)</span>
                </button>
                <button type="button" className="menu-item" onClick={() => pullNow('merge')}>
                  <span className="menu-icon" />
                  <span className="menu-label">Pull (merge)</span>
                </button>
                <button type="button" className="menu-item" onClick={() => pullNow('rebase')}>
                  <span className="menu-icon" />
                  <span className="menu-label">Pull (rebase)</span>
                </button>
                <div className="menu-sep" />
                <button
                  type="button"
                  className="menu-item danger"
                  onClick={() => pushNow(true)}
                  disabled={!status?.branch}
                >
                  <span className="menu-icon" />
                  <span className="menu-label">Force push (with lease)</span>
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {state.statusError ? <div className="header-error">{state.statusError}</div> : null}
    </header>
  );
}
