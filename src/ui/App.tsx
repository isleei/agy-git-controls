import { useEffect, useState } from 'react';
import { api } from './api';
import type { RepoInfo, RepoStatus } from '../core/types';

export default function App() {
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const uris = (await window.sidecar?.getWorkspaceUris()) ?? [];
        const ctx = await api.pushContext(uris);
        setRepos(ctx.repos);
        if (ctx.repos[0]) setActive(ctx.repos[0].path);
      } catch (e) {
        setErr(String(e));
      }
    };
    void load();
    return window.sidecar?.onWorkspaceChange((uris) => {
      void api.pushContext(uris).then((ctx) => {
        setRepos(ctx.repos);
        setActive(ctx.repos[0]?.path ?? null);
      });
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    void api.status(active).then(setStatus).catch((e) => setErr(String(e)));
  }, [active]);

  return (
    <div style={{ padding: 12, fontSize: 13 }}>
      <h3 style={{ margin: '0 0 8px' }}>Git Controls</h3>
      {err && <div style={{ color: '#e5534b' }}>{err}</div>}
      {repos.length === 0 && <div>No git repos in workspace.</div>}
      {repos.map((r) => (
        <button key={r.path} onClick={() => setActive(r.path)} style={{ marginRight: 6 }}>
          {r.name}
          {r.isWorktree ? ' (wt)' : ''}
        </button>
      ))}
      {status && (
        <div style={{ marginTop: 12 }}>
          <div>
            <b>{status.branch ?? `detached ${status.detachedAt}`}</b>
            {status.upstream && <span> → {status.upstream}</span>}
            <span>
              {' '}
              ↑{status.ahead} ↓{status.behind}
            </span>
          </div>
          <div>
            staged {status.staged.length} · unstaged {status.unstaged.length} · untracked{' '}
            {status.untracked.length}
            {status.operation && <span> · {status.operation} in progress</span>}
          </div>
        </div>
      )}
    </div>
  );
}
