import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Info, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useStore, type ToastItem } from '../store';

function ToastCard({ toast }: { toast: ToastItem }) {
  const { dismissToast } = useStore();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => dismissToast(toast.id),
      toast.kind === 'error' ? 9000 : 4000,
    );
    return () => window.clearTimeout(timeout);
  }, [toast.id, toast.kind, dismissToast]);

  const Icon = toast.kind === 'success' ? Check : toast.kind === 'error' ? AlertTriangle : Info;

  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      <Icon size={14} className="toast-icon" />
      <div className="toast-main">
        <div className="toast-title">{toast.title}</div>
        {toast.detail && expanded ? <pre className="toast-detail">{toast.detail}</pre> : null}
        {toast.detail ? (
          <button
            type="button"
            className="toast-link"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? 'Hide details' : 'Details'}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="icon-btn toast-close"
        title="Dismiss"
        onClick={() => dismissToast(toast.id)}
      >
        <X size={12} />
      </button>
    </div>
  );
}

export function Toasts() {
  const { state } = useStore();
  if (state.toasts.length === 0) return null;
  return createPortal(
    <div className="toasts" aria-live="polite">
      {state.toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>,
    document.body,
  );
}
