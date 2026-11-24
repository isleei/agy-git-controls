import { useEffect } from 'react';
import { GitBranch, RotateCw } from 'lucide-react';
import { Header } from './Header';
import {
  SECTIONS,
  StoreProvider,
  useStore,
  type Section,
} from './store';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Spinner } from './components/Spinner';
import { Toasts } from './components/Toasts';
import { ChangesSection } from './sections/Changes';
import { BranchesSection } from './sections/Branches';
import { HistorySection } from './sections/History';
import { StashSection } from './sections/Stash';
import { WorktreesSection } from './sections/Worktrees';
import { RemotesSection } from './sections/Remotes';
import { fireEscape } from './hooks/useEscape';
import { isEditableTarget, modLabel } from './utils';

function sectionCount(section: Section, state: ReturnType<typeof useStore>['state']): number {
  switch (section) {
    case 'changes':
      return state.status
        ? state.status.staged.length +
            state.status.unstaged.length +
            state.status.untracked.length +
            state.status.conflicted.length
        : 0;
    case 'branches':
      return state.branches.length;
    case 'history':
      return 0;
    case 'stash':
      return state.stashes.length;
    case 'worktrees':
      return state.worktrees.length;
    case 'remotes':
      return state.remotes.length + state.tags.length;
    default:
      return 0;
  }
}

function SectionView({ section }: { section: Section }) {
  switch (section) {
    case 'changes':
      return <ChangesSection />;
    case 'branches':
      return <BranchesSection />;
    case 'history':
      return <HistorySection />;
    case 'stash':
      return <StashSection />;
    case 'worktrees':
      return <WorktreesSection />;
    case 'remotes':
      return <RemotesSection />;
    default:
      return null;
  }
}

function BootScreen() {
  const { state, retryBoot } = useStore();
  return (
    <div className="boot">
      <div className="boot-card">
        <div className="boot-logo" aria-hidden="true">
          <GitBranch size={20} />
        </div>
        <div className="boot-title">Git Controls</div>
        {state.bootError ? (
          <>
            <div className="boot-error-title">Cannot reach the sidecar</div>
            <pre className="boot-detail">{state.bootError}</pre>
            <button type="button" className="btn btn-primary btn-sm" onClick={retryBoot}>
              <RotateCw size={12} /> Retry
            </button>
          </>
        ) : (
          <div className="boot-loading">
            <Spinner size={14} />
            <span>Connecting to the repository…</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Shell() {
  const { state, selectSection } = useStore();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        if (fireEscape()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (mod && !event.altKey && !event.shiftKey && /^[1-6]$/.test(event.key)) {
        const target = SECTIONS[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          selectSection(target.id);
        }
        return;
      }
      if (event.key === '/' && !mod && !event.altKey && !isEditableTarget(event.target)) {
        const search = document.querySelector<HTMLInputElement>('[data-agc-search]');
        if (search) {
          event.preventDefault();
          search.focus();
          search.select();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectSection]);

  if (!state.ready) return <BootScreen />;

  return (
    <div className="app">
      <Header />
      <nav className="tabs" role="tablist" aria-label="Git sections">
        {SECTIONS.map((section, index) => {
          const count = sectionCount(section.id, state);
          const active = state.section === section.id;
          return (
            <button
              key={section.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`tab ${active ? 'active' : ''}`}
              title={`${section.label} (${modLabel()}${index + 1})`}
              onClick={() => selectSection(section.id)}
            >
              <span className="tab-label">{section.label}</span>
              {count > 0 ? <span className="tab-badge">{count > 99 ? '99+' : count}</span> : null}
            </button>
          );
        })}
      </nav>
      <main className="app-main" role="tabpanel">
        <SectionView section={state.section} />
      </main>
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  );
}
