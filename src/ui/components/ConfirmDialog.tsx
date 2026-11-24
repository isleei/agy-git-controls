import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { useStore } from '../store';

export function ConfirmDialog() {
  const { state, resolveConfirm } = useStore();
  const pending = state.confirm;
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setChecked(pending?.check?.defaultChecked ?? false);
  }, [pending?.id, pending?.check?.defaultChecked]);

  if (!pending) return null;

  const cancel = (): void => resolveConfirm({ confirmed: false, checked: false });
  const confirm = (): void => resolveConfirm({ confirmed: true, checked });

  return (
    <Modal
      title={pending.title}
      onClose={cancel}
      className="confirm-modal"
      footer={
        <>
          <button type="button" className="btn" onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${pending.danger === false ? 'btn-primary' : 'btn-danger'}`}
            onClick={confirm}
            autoFocus
          >
            {pending.confirmLabel ?? 'Confirm'}
          </button>
        </>
      }
    >
      {pending.target ? (
        <div className="confirm-target">
          <span className="confirm-target-icon" aria-hidden="true">
            <AlertTriangle size={13} />
          </span>
          <code>{pending.target}</code>
        </div>
      ) : null}
      {pending.description ? <p className="confirm-desc">{pending.description}</p> : null}
      {pending.check ? (
        <label className="check-row">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
          <span>{pending.check.label}</span>
        </label>
      ) : null}
    </Modal>
  );
}
