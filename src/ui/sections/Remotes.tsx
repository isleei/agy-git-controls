import { useEffect, useState } from 'react';
import { Cloud, Plus, RotateCw, Tag, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { RemoteInfo, TagInfo } from '../../core/types.js';
import { useStore } from '../store';
import { CollapsibleGroup } from '../components/Group';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { shortSha } from '../utils';

interface RemoteForm {
  name: string;
  url: string;
}

interface TagForm {
  name: string;
  ref: string;
  message: string;
  annotated: boolean;
}

const emptyRemote: RemoteForm = { name: '', url: '' };
const emptyTag: TagForm = { name: '', ref: '', message: '', annotated: false };

export function RemotesSection() {
  const { state, activeRepo, isBusy, run, refreshRemotes } = useStore();
  const [remoteForm, setRemoteForm] = useState<RemoteForm | null>(null);
  const [tagForm, setTagForm] = useState<TagForm | null>(null);

  useEffect(() => {
    setRemoteForm(null);
    setTagForm(null);
    if (activeRepo) void refreshRemotes();
  }, [activeRepo, refreshRemotes]);

  const { remotes, tags } = state;

  const submitRemote = async (): Promise<void> => {
    if (!activeRepo || !remoteForm) return;
    const result = await run(
      'remote-add',
      () => api.remoteAdd(activeRepo, remoteForm.name.trim(), remoteForm.url.trim()),
      { success: 'Remote added' },
    );
    if (result?.ok) setRemoteForm(null);
  };

  const submitTag = async (): Promise<void> => {
    if (!activeRepo || !tagForm) return;
    const result = await run(
      'tag-create',
      () =>
        api.tagCreate(activeRepo, {
          name: tagForm.name.trim(),
          ...(tagForm.ref.trim() ? { ref: tagForm.ref.trim() } : {}),
          ...(tagForm.annotated ? { annotated: true, message: tagForm.message } : {}),
        }),
      { success: 'Tag created' },
    );
    if (result?.ok) setTagForm(null);
  };

  const removeRemote = (remote: RemoteInfo): void => {
    if (!activeRepo) return;
    void run(
      `remote-remove:${remote.name}`,
      () => api.remoteRemove(activeRepo, remote.name, true),
      {
        confirm: {
          title: `Remove remote "${remote.name}"?`,
          target: remote.fetchUrl,
          description: 'Remote-tracking branches for this remote are removed too.',
          confirmLabel: 'Remove',
          danger: true,
        },
        success: 'Remote removed',
      },
    );
  };

  const deleteTag = (tag: TagInfo): void => {
    if (!activeRepo) return;
    void run(
      `tag-delete:${tag.name}`,
      () => api.tagDelete(activeRepo, tag.name, true),
      {
        confirm: {
          title: `Delete tag "${tag.name}"?`,
          target: shortSha(tag.sha),
          description: 'Only the local tag is deleted; remote tags are unaffected.',
          confirmLabel: 'Delete',
          danger: true,
        },
        success: 'Tag deleted',
      },
    );
  };

  const loading = state.remotesLoading || state.tagsLoading;
  const loadError = state.remotesError ?? state.tagsError;

  return (
    <div className="section-body remotes">
      <div className="section-toolbar">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setRemoteForm({ ...emptyRemote })}
          disabled={!activeRepo}
          title="Add a remote"
        >
          <Plus size={12} />
          <span className="btn-label">Add remote…</span>
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setTagForm({ ...emptyTag })}
          disabled={!activeRepo}
          title="Create a tag"
        >
          <Tag size={12} />
          <span className="btn-label">New tag…</span>
        </button>
        <span className="header-spacer" />
        <span className="toolbar-count">{remotes.length + tags.length}</span>
        <button
          type="button"
          className="icon-btn"
          title="Refresh remotes and tags"
          onClick={() => void refreshRemotes()}
          disabled={!activeRepo || loading}
        >
          {loading ? <Spinner size={12} /> : <RotateCw size={13} />}
        </button>
      </div>

      {!activeRepo ? (
        <EmptyState icon={<Cloud size={26} />} title="No repository selected" />
      ) : loadError && remotes.length === 0 && tags.length === 0 ? (
        <EmptyState
          icon={<Cloud size={26} />}
          title="Cannot load remotes"
          hint={loadError}
          action={
            <button type="button" className="btn btn-sm" onClick={() => void refreshRemotes()}>
              <RotateCw size={12} /> Retry
            </button>
          }
        />
      ) : loading && remotes.length === 0 && tags.length === 0 ? (
        <div className="loading-center">
          <Spinner size={18} />
        </div>
      ) : (
        <div className="section-scroll">
          <CollapsibleGroup title="REMOTES" count={remotes.length}>
            {remotes.length === 0 ? (
              <div className="group-empty">No remotes configured</div>
            ) : (
              remotes.map((remote) => (
                <div key={remote.name} className="row remote-row" title={remote.fetchUrl}>
                  <Cloud size={13} className="worktree-icon" />
                  <span className="remote-name">{remote.name}</span>
                  <span className="remote-url">{remote.fetchUrl}</span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="icon-btn danger-hover"
                      title="Remove remote…"
                      disabled={isBusy(`remote-remove:${remote.name}`)}
                      onClick={() => removeRemote(remote)}
                    >
                      {isBusy(`remote-remove:${remote.name}`) ? (
                        <Spinner size={11} />
                      ) : (
                        <Trash2 size={12} />
                      )}
                    </button>
                  </span>
                </div>
              ))
            )}
          </CollapsibleGroup>

          <CollapsibleGroup title="TAGS" count={tags.length}>
            {tags.length === 0 ? (
              <div className="group-empty">No tags</div>
            ) : (
              tags.map((tag) => (
                <div key={tag.name} className="row tag-row" title={tag.message ?? tag.name}>
                  <Tag size={13} className="worktree-icon" />
                  <span className="remote-name">{tag.name}</span>
                  {tag.annotated ? <span className="mini-badge">annotated</span> : null}
                  <span className="tag-sha">{shortSha(tag.sha)}</span>
                  <span className="row-actions">
                    <button
                      type="button"
                      className="icon-btn danger-hover"
                      title="Delete tag…"
                      disabled={isBusy(`tag-delete:${tag.name}`)}
                      onClick={() => deleteTag(tag)}
                    >
                      {isBusy(`tag-delete:${tag.name}`) ? <Spinner size={11} /> : <Trash2 size={12} />}
                    </button>
                  </span>
                </div>
              ))
            )}
          </CollapsibleGroup>
        </div>
      )}

      {remoteForm ? (
        <Modal
          title="Add remote"
          onClose={() => setRemoteForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRemoteForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!remoteForm.name.trim() || !remoteForm.url.trim() || isBusy('remote-add')}
                onClick={() => void submitRemote()}
              >
                {isBusy('remote-add') ? <Spinner size={11} /> : 'Add'}
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="text-input"
              autoFocus
              value={remoteForm.name}
              placeholder="origin"
              onChange={(event) => setRemoteForm({ ...remoteForm, name: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">URL</span>
            <input
              className="text-input"
              value={remoteForm.url}
              placeholder="https:// or git@host:path"
              onChange={(event) => setRemoteForm({ ...remoteForm, url: event.target.value })}
              spellCheck={false}
            />
          </label>
        </Modal>
      ) : null}

      {tagForm ? (
        <Modal
          title="New tag"
          onClose={() => setTagForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setTagForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!tagForm.name.trim() || isBusy('tag-create')}
                onClick={() => void submitTag()}
              >
                {isBusy('tag-create') ? <Spinner size={11} /> : 'Create'}
              </button>
            </>
          }
        >
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="text-input"
              autoFocus
              value={tagForm.name}
              placeholder="v1.0.0"
              onChange={(event) => setTagForm({ ...tagForm, name: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Target (optional, defaults to HEAD)</span>
            <input
              className="text-input"
              value={tagForm.ref}
              placeholder="branch, sha or ref"
              onChange={(event) => setTagForm({ ...tagForm, ref: event.target.value })}
              spellCheck={false}
            />
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={tagForm.annotated}
              onChange={(event) => setTagForm({ ...tagForm, annotated: event.target.checked })}
            />
            <span>Annotated tag (with message)</span>
          </label>
          {tagForm.annotated ? (
            <label className="field">
              <span className="field-label">Message</span>
              <input
                className="text-input"
                value={tagForm.message}
                placeholder="release notes…"
                onChange={(event) => setTagForm({ ...tagForm, message: event.target.value })}
                spellCheck={false}
              />
            </label>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
