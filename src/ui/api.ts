import type { WorkspaceContext, RepoStatus } from '../core/types.js';

async function call<T>(url: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
  const f = window.sidecar?.fetch ?? fetch;
  const res = await f(url, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  ping: () => call<{ ok: boolean; ts: number; projectId?: string }>('/api/ping'),
  pushContext: (workspaceUris: string[]) =>
    call<WorkspaceContext>('/api/context', 'POST', { workspaceUris }),
  status: (repo: string) => call<RepoStatus>('/api/status', 'POST', { repo }),
  addRepo: (path: string) => call('/api/repos/add', 'POST', { path }),
};
