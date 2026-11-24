import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import {
  ApiError,
  ConfirmRequiredError,
  api,
  errorMessage,
  operationFailure,
} from './api';
import type {
  BranchInfo,
  OperationResult,
  RemoteInfo,
  RepoInfo,
  RepoStatus,
  StashEntry,
  TagInfo,
  WorktreeInfo,
} from '../core/types.js';

export type Section = 'changes' | 'branches' | 'history' | 'stash' | 'worktrees' | 'remotes';

export const SECTIONS: ReadonlyArray<{ id: Section; label: string }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'branches', label: 'Branches' },
  { id: 'history', label: 'History' },
  { id: 'stash', label: 'Stash' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'remotes', label: 'Remotes' },
];

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

export interface ConfirmCheck {
  label: string;
  defaultChecked?: boolean;
}

export interface ConfirmSpec {
  title: string;
  target?: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
  check?: ConfirmCheck;
}

export interface ConfirmResult {
  confirmed: boolean;
  checked: boolean;
}

interface PendingConfirm extends ConfirmSpec {
  id: number;
  resolve: (result: ConfirmResult) => void;
}

export interface RunContext {
  confirmed: boolean;
  checked: boolean;
}

export interface RunOptions {
  confirm?: ConfirmSpec;
  success?: string;
}

interface State {
  ready: boolean;
  bootError: string | null;
  repos: RepoInfo[];
  registered: string[];
  activeRepo: string | null;
  section: Section;
  prefs: Record<string, unknown>;
  status: RepoStatus | null;
  statusLoading: boolean;
  statusError: string | null;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesError: string | null;
  stashes: StashEntry[];
  stashesLoading: boolean;
  stashesError: string | null;
  worktrees: WorktreeInfo[];
  worktreesLoading: boolean;
  worktreesError: string | null;
  remotes: RemoteInfo[];
  remotesLoading: boolean;
  remotesError: string | null;
  tags: TagInfo[];
  tagsLoading: boolean;
  tagsError: string | null;
  busy: Record<string, number>;
  toasts: ToastItem[];
  confirm: PendingConfirm | null;
  /** Bumped whenever repo data changed (write op or host-side change). */
  dataVersion: number;
}

type Action =
  | { type: 'ready' }
  | { type: 'boot-error'; error: string }
  | { type: 'clear-boot-error' }
  | { type: 'repos'; repos: RepoInfo[]; registered: string[] }
  | { type: 'active'; repo: string | null }
  | { type: 'section'; section: Section }
  | { type: 'prefs'; prefs: Record<string, unknown> }
  | { type: 'clear-repo-data' }
  | { type: 'status-loading'; silent: boolean }
  | { type: 'status'; status: RepoStatus }
  | { type: 'status-error'; error: string }
  | { type: 'branches-loading' }
  | { type: 'branches'; branches: BranchInfo[] }
  | { type: 'branches-error'; error: string }
  | { type: 'stashes-loading' }
  | { type: 'stashes'; stashes: StashEntry[] }
  | { type: 'stashes-error'; error: string }
  | { type: 'worktrees-loading' }
  | { type: 'worktrees'; worktrees: WorktreeInfo[] }
  | { type: 'worktrees-error'; error: string }
  | { type: 'remotes-loading' }
  | { type: 'remotes'; remotes: RemoteInfo[] }
  | { type: 'remotes-error'; error: string }
  | { type: 'tags-loading' }
  | { type: 'tags'; tags: TagInfo[] }
  | { type: 'tags-error'; error: string }
  | { type: 'busy'; key: string; on: boolean }
  | { type: 'toast'; toast: ToastItem }
  | { type: 'dismiss-toast'; id: number }
  | { type: 'confirm'; confirm: PendingConfirm | null }
  | { type: 'data-changed' };

const initialState: State = {
  ready: false,
  bootError: null,
  repos: [],
  registered: [],
  activeRepo: null,
  section: 'changes',
  prefs: {},
  status: null,
  statusLoading: false,
  statusError: null,
  branches: [],
  branchesLoading: false,
  branchesError: null,
  stashes: [],
  stashesLoading: false,
  stashesError: null,
  worktrees: [],
  worktreesLoading: false,
  worktreesError: null,
  remotes: [],
  remotesLoading: false,
  remotesError: null,
  tags: [],
  tagsLoading: false,
  tagsError: null,
  busy: {},
  toasts: [],
  confirm: null,
  dataVersion: 0,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'ready':
      return { ...state, ready: true, bootError: null };
    case 'boot-error':
      return { ...state, ready: false, bootError: action.error };
    case 'clear-boot-error':
      return { ...state, bootError: null };
    case 'repos':
      return { ...state, repos: action.repos, registered: action.registered };
    case 'active':
      return { ...state, activeRepo: action.repo };
    case 'section':
      return { ...state, section: action.section };
    case 'prefs':
      return { ...state, prefs: action.prefs };
    case 'clear-repo-data':
      return {
        ...state,
        status: null,
        statusLoading: false,
        statusError: null,
        branches: [],
        branchesLoading: false,
        branchesError: null,
        stashes: [],
        stashesLoading: false,
        stashesError: null,
        worktrees: [],
        worktreesLoading: false,
        worktreesError: null,
        remotes: [],
        remotesLoading: false,
        remotesError: null,
        tags: [],
        tagsLoading: false,
        tagsError: null,
      };
    case 'status-loading':
      return action.silent ? state : { ...state, statusLoading: true };
    case 'status':
      return { ...state, status: action.status, statusLoading: false, statusError: null };
    case 'status-error':
      return { ...state, statusLoading: false, statusError: action.error };
    case 'branches-loading':
      return { ...state, branchesLoading: true, branchesError: null };
    case 'branches':
      return { ...state, branches: action.branches, branchesLoading: false, branchesError: null };
    case 'branches-error':
      return { ...state, branchesLoading: false, branchesError: action.error };
    case 'stashes-loading':
      return { ...state, stashesLoading: true, stashesError: null };
    case 'stashes':
      return { ...state, stashes: action.stashes, stashesLoading: false, stashesError: null };
    case 'stashes-error':
      return { ...state, stashesLoading: false, stashesError: action.error };
    case 'worktrees-loading':
      return { ...state, worktreesLoading: true, worktreesError: null };
    case 'worktrees':
      return {
        ...state,
        worktrees: action.worktrees,
        worktreesLoading: false,
        worktreesError: null,
      };
    case 'worktrees-error':
      return { ...state, worktreesLoading: false, worktreesError: action.error };
    case 'remotes-loading':
      return { ...state, remotesLoading: true, remotesError: null };
    case 'remotes':
      return { ...state, remotes: action.remotes, remotesLoading: false, remotesError: null };
    case 'remotes-error':
      return { ...state, remotesLoading: false, remotesError: action.error };
    case 'tags-loading':
      return { ...state, tagsLoading: true, tagsError: null };
    case 'tags':
      return { ...state, tags: action.tags, tagsLoading: false, tagsError: null };
    case 'tags-error':
      return { ...state, tagsLoading: false, tagsError: action.error };
    case 'busy': {
      const next = { ...state.busy };
      const count = (next[action.key] ?? 0) + (action.on ? 1 : -1);
      if (count > 0) next[action.key] = count;
      else delete next[action.key];
      return { ...state, busy: next };
    }
    case 'toast': {
      const toasts = [...state.toasts, action.toast];
      return { ...state, toasts: toasts.slice(-4) };
    }
    case 'dismiss-toast':
      return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
    case 'confirm':
      return { ...state, confirm: action.confirm };
    case 'data-changed':
      return { ...state, dataVersion: state.dataVersion + 1 };
    default:
      return state;
  }
}

const HUMAN_ACTIONS: Record<string, string> = {
  '/api/branch/delete': 'delete branch',
  '/api/discard': 'discard changes',
  '/api/push': 'force push',
  '/api/worktree/remove': 'remove worktree',
  '/api/stash': 'drop stash',
  '/api/remote/remove': 'remove remote',
  '/api/tag/delete': 'delete tag',
};

export interface StoreValue {
  state: State;
  activeRepo: string | null;
  isBusy: (key: string) => boolean;
  selectRepo: (path: string) => void;
  selectSection: (section: Section) => void;
  refreshStatus: (silent?: boolean) => Promise<void>;
  refreshBranches: () => Promise<void>;
  refreshStashes: () => Promise<void>;
  refreshWorktrees: () => Promise<void>;
  refreshRemotes: () => Promise<void>;
  refreshAll: () => Promise<void>;
  toast: (kind: ToastKind, title: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  requestConfirm: (spec: ConfirmSpec) => Promise<ConfirmResult>;
  resolveConfirm: (result: ConfirmResult) => void;
  run: (
    key: string,
    task: (ctx: RunContext) => Promise<OperationResult>,
    options?: RunOptions,
  ) => Promise<OperationResult | null>;
  addRepo: (path: string) => Promise<boolean>;
  removeRepo: (path: string) => Promise<boolean>;
  retryBoot: () => void;
}

const StoreContext = createContext<StoreValue | null>(null);

function chooseActive(repos: RepoInfo[], preferred: unknown): string | null {
  if (typeof preferred === 'string') {
    const match = repos.find((repo) => repo.path === preferred);
    if (match) return match.path;
  }
  return repos.find((repo) => repo.source === 'workspace')?.path ?? repos[0]?.path ?? null;
}

function isSection(value: unknown): value is Section {
  return SECTIONS.some((section) => section.id === value);
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const prefsRef = useRef<Record<string, unknown>>({});
  const toastSeq = useRef(0);
  const confirmSeq = useRef(0);
  const booting = useRef(false);

  const toast = useCallback((kind: ToastKind, title: string, detail?: string) => {
    toastSeq.current += 1;
    const item: ToastItem = {
      id: toastSeq.current,
      kind,
      title,
      ...(detail !== undefined ? { detail } : {}),
    };
    dispatch({ type: 'toast', toast: item });
  }, []);

  const dismissToast = useCallback((id: number) => {
    dispatch({ type: 'dismiss-toast', id });
  }, []);

  const savePrefs = useCallback((patch: Record<string, unknown>) => {
    const next = { ...prefsRef.current, ...patch };
    prefsRef.current = next;
    dispatch({ type: 'prefs', prefs: next });
    void api.setPrefs(next).catch(() => undefined);
  }, []);

  /* ---------------------------------------------------------------- */
  /* data refresh                                                      */
  /* ---------------------------------------------------------------- */

  const refreshStatus = useCallback(async (silent = false) => {
    const repo = stateRef.current.activeRepo;
    if (!repo) return;
    dispatch({ type: 'status-loading', silent });
    try {
      const status = await api.status(repo);
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'status', status });
    } catch (err) {
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'status-error', error: errorMessage(err) });
    }
  }, []);

  const refreshBranches = useCallback(async () => {
    const repo = stateRef.current.activeRepo;
    if (!repo) return;
    dispatch({ type: 'branches-loading' });
    try {
      const { branches } = await api.branches(repo);
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'branches', branches });
    } catch (err) {
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'branches-error', error: errorMessage(err) });
    }
  }, []);

  const refreshStashes = useCallback(async () => {
    const repo = stateRef.current.activeRepo;
    if (!repo) return;
    dispatch({ type: 'stashes-loading' });
    try {
      const { entries } = await api.stashes(repo);
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'stashes', stashes: entries });
    } catch (err) {
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'stashes-error', error: errorMessage(err) });
    }
  }, []);

  const refreshWorktrees = useCallback(async () => {
    const repo = stateRef.current.activeRepo;
    if (!repo) return;
    dispatch({ type: 'worktrees-loading' });
    try {
      const { worktrees } = await api.worktrees(repo);
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'worktrees', worktrees });
    } catch (err) {
      if (stateRef.current.activeRepo !== repo) return;
      dispatch({ type: 'worktrees-error', error: errorMessage(err) });
    }
  }, []);

  const refreshRemotes = useCallback(async () => {
    const repo = stateRef.current.activeRepo;
    if (!repo) return;
    dispatch({ type: 'remotes-loading' });
    dispatch({ type: 'tags-loading' });
    const [remotesResult, tagsResult] = await Promise.allSettled([
      api.remotes(repo),
      api.tags(repo),
    ]);
    if (stateRef.current.activeRepo !== repo) return;
    if (remotesResult.status === 'fulfilled') {
      dispatch({ type: 'remotes', remotes: remotesResult.value.remotes });
    } else {
      dispatch({ type: 'remotes-error', error: errorMessage(remotesResult.reason) });
    }
    if (tagsResult.status === 'fulfilled') {
      dispatch({ type: 'tags', tags: tagsResult.value.tags });
    } else {
      dispatch({ type: 'tags-error', error: errorMessage(tagsResult.reason) });
    }
  }, []);

  const refreshCurrentSection = useCallback(() => {
    const section = stateRef.current.section;
    if (section === 'branches') void refreshBranches();
    else if (section === 'stash') void refreshStashes();
    else if (section === 'worktrees') void refreshWorktrees();
    else if (section === 'remotes') void refreshRemotes();
  }, [refreshBranches, refreshStashes, refreshWorktrees, refreshRemotes]);

  const refreshAll = useCallback(async () => {
    dispatch({ type: 'data-changed' });
    await Promise.all([
      refreshStatus(),
      refreshBranches(),
      refreshStashes(),
      refreshWorktrees(),
      refreshRemotes(),
    ]);
  }, [refreshStatus, refreshBranches, refreshStashes, refreshWorktrees, refreshRemotes]);

  /* ---------------------------------------------------------------- */
  /* confirmation                                                      */
  /* ---------------------------------------------------------------- */

  const requestConfirm = useCallback((spec: ConfirmSpec): Promise<ConfirmResult> => {
    confirmSeq.current += 1;
    const id = confirmSeq.current;
    return new Promise<ConfirmResult>((resolve) => {
      dispatch({ type: 'confirm', confirm: { ...spec, id, resolve } });
    });
  }, []);

  const resolveConfirm = useCallback((result: ConfirmResult) => {
    const pending = stateRef.current.confirm;
    if (!pending) return;
    dispatch({ type: 'confirm', confirm: null });
    pending.resolve(result);
  }, []);

  /* ---------------------------------------------------------------- */
  /* write operations                                                  */
  /* ---------------------------------------------------------------- */

  const run = useCallback(
    async (
      key: string,
      task: (ctx: RunContext) => Promise<OperationResult>,
      options: RunOptions = {},
    ): Promise<OperationResult | null> => {
      let confirmed = false;
      let checked = false;
      if (options.confirm) {
        const answer = await requestConfirm(options.confirm);
        if (!answer.confirmed) return null;
        confirmed = true;
        checked = answer.checked;
      }

      dispatch({ type: 'busy', key, on: true });
      try {
        let result: OperationResult;
        try {
          result = await task({ confirmed, checked });
        } catch (err) {
          if (!(err instanceof ConfirmRequiredError)) throw err;
          const label = HUMAN_ACTIONS[err.action] ?? err.action;
          const answer = await requestConfirm({
            title: `Confirm ${label}`,
            ...(err.action ? { target: err.action } : {}),
            description: 'This action needs explicit confirmation.',
            confirmLabel: 'Continue',
            danger: true,
          });
          if (!answer.confirmed) return null;
          result = await task({ confirmed: true, checked: answer.checked });
        }

        if (!result.ok) {
          const failure = operationFailure(result);
          toast('error', failure.summary, failure.detail);
          if (result.conflicted && result.conflicted.length > 0) {
            if (stateRef.current.section !== 'changes') {
              dispatch({ type: 'section', section: 'changes' });
              savePrefs({ section: 'changes' });
            }
            toast(
              'info',
              `${result.conflicted.length} conflicted file(s)`,
              'Resolve them, then stage the files. Abort is available in the Conflicts group.',
            );
          }
        } else {
          dispatch({ type: 'data-changed' });
          if (options.success) toast('success', options.success);
        }

        await refreshStatus(true);
        refreshCurrentSection();
        return result;
      } catch (err) {
        if (err instanceof ApiError) toast('error', err.message, err.code ? `code: ${err.code}` : undefined);
        else toast('error', errorMessage(err));
        await refreshStatus(true);
        return null;
      } finally {
        dispatch({ type: 'busy', key, on: false });
      }
    },
    [refreshStatus, refreshCurrentSection, requestConfirm, savePrefs, toast],
  );

  /* ---------------------------------------------------------------- */
  /* boot / repos                                                      */
  /* ---------------------------------------------------------------- */

  const boot = useCallback(async () => {
    if (booting.current) return;
    booting.current = true;
    dispatch({ type: 'clear-boot-error' });
    try {
      const prefs: Record<string, unknown> = await api
        .getPrefs()
        .then((response) => response.prefs ?? {})
        .catch(() => ({}));
      prefsRef.current = prefs;
      dispatch({ type: 'prefs', prefs });
      if (isSection(prefs.section)) dispatch({ type: 'section', section: prefs.section });

      const uris = (await window.sidecar?.getWorkspaceUris()) ?? [];
      await api.pushContext(uris);
      const listing = await api.reposList();
      dispatch({ type: 'repos', repos: listing.repos, registered: listing.registered });
      dispatch({ type: 'active', repo: chooseActive(listing.repos, prefs.activeRepo) });
      dispatch({ type: 'ready' });
    } catch (err) {
      dispatch({ type: 'boot-error', error: errorMessage(err) });
    } finally {
      booting.current = false;
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const bridge = window.sidecar;
    if (!bridge) return undefined;
    const off = bridge.onWorkspaceChange((uris) => {
      void (async () => {
        try {
          await api.pushContext(uris);
          const listing = await api.reposList();
          dispatch({ type: 'repos', repos: listing.repos, registered: listing.registered });
          const current = stateRef.current.activeRepo;
          if (!current || !listing.repos.some((repo) => repo.path === current)) {
            const next = chooseActive(listing.repos, prefsRef.current.activeRepo);
            dispatch({ type: 'active', repo: next });
            if (next) savePrefs({ activeRepo: next });
          }
        } catch (err) {
          toast('error', 'Workspace update failed', errorMessage(err));
        }
      })();
    });
    return off;
  }, [savePrefs, toast]);

  useEffect(() => {
    if (!state.activeRepo) {
      dispatch({ type: 'clear-repo-data' });
      return;
    }
    dispatch({ type: 'clear-repo-data' });
    void refreshStatus();
    void refreshBranches();
    void refreshStashes();
    void refreshWorktrees();
    void refreshRemotes();
  }, [state.activeRepo, refreshStatus, refreshBranches, refreshStashes, refreshWorktrees, refreshRemotes]);

  /* Light dirty-poll: /api/version (no git call) every 3s while visible. */
  useEffect(() => {
    const repo = state.activeRepo;
    if (!repo || !state.ready) return undefined;
    let last: number | null = null;
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped || document.hidden) return;
      try {
        const info = await api.version(repo);
        if (stopped || document.hidden) return;
        if (last === null) {
          last = info.v;
          return;
        }
        if (info.v !== last) {
          last = info.v;
          dispatch({ type: 'data-changed' });
          void refreshStatus(true);
          refreshCurrentSection();
        }
      } catch {
        /* version polling is best-effort */
      }
    };

    const timer = window.setInterval(() => void tick(), 3000);
    const onVisibility = (): void => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [state.activeRepo, state.ready, refreshStatus, refreshCurrentSection]);

  /* ---------------------------------------------------------------- */
  /* selection                                                         */
  /* ---------------------------------------------------------------- */

  const selectRepo = useCallback(
    (path: string) => {
      dispatch({ type: 'active', repo: path });
      savePrefs({ activeRepo: path });
    },
    [savePrefs],
  );

  const selectSection = useCallback(
    (section: Section) => {
      dispatch({ type: 'section', section });
      savePrefs({ section });
    },
    [savePrefs],
  );

  const addRepo = useCallback(
    async (path: string): Promise<boolean> => {
      const trimmed = path.trim();
      if (!trimmed) return false;
      dispatch({ type: 'busy', key: 'repo-add', on: true });
      try {
        const info = await api.addRepo(trimmed);
        const listing = await api.reposList();
        dispatch({ type: 'repos', repos: listing.repos, registered: listing.registered });
        dispatch({ type: 'active', repo: info.path });
        dispatch({ type: 'data-changed' });
        savePrefs({ activeRepo: info.path });
        toast('success', `Added ${info.name}`);
        return true;
      } catch (err) {
        toast('error', 'Cannot add repository', errorMessage(err));
        return false;
      } finally {
        dispatch({ type: 'busy', key: 'repo-add', on: false });
      }
    },
    [savePrefs, toast],
  );

  const removeRepo = useCallback(
    async (path: string): Promise<boolean> => {
      dispatch({ type: 'busy', key: 'repo-remove', on: true });
      try {
        await api.removeRepo(path);
        const listing = await api.reposList();
        dispatch({ type: 'repos', repos: listing.repos, registered: listing.registered });
        if (stateRef.current.activeRepo === path) {
          const next = chooseActive(listing.repos, prefsRef.current.activeRepo);
          dispatch({ type: 'active', repo: next });
          if (next) savePrefs({ activeRepo: next });
        }
        toast('success', 'Removed from repository list');
        return true;
      } catch (err) {
        toast('error', 'Cannot remove repository', errorMessage(err));
        return false;
      } finally {
        dispatch({ type: 'busy', key: 'repo-remove', on: false });
      }
    },
    [savePrefs, toast],
  );

  const isBusy = useCallback((key: string) => (state.busy[key] ?? 0) > 0, [state.busy]);

  const value = useMemo<StoreValue>(
    () => ({
      state,
      activeRepo: state.activeRepo,
      isBusy,
      selectRepo,
      selectSection,
      refreshStatus,
      refreshBranches,
      refreshStashes,
      refreshWorktrees,
      refreshRemotes,
      refreshAll,
      toast,
      dismissToast,
      requestConfirm,
      resolveConfirm,
      run,
      addRepo,
      removeRepo,
      retryBoot: () => void boot(),
    }),
    [
      state,
      isBusy,
      selectRepo,
      selectSection,
      refreshStatus,
      refreshBranches,
      refreshStashes,
      refreshWorktrees,
      refreshRemotes,
      refreshAll,
      toast,
      dismissToast,
      requestConfirm,
      resolveConfirm,
      run,
      addRepo,
      removeRepo,
      boot,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error('useStore must be used inside <StoreProvider>');
  return value;
}
