import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useEscape } from '../hooks/useEscape';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}

export function Modal({ title, onClose, children, footer, width = 340, className }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEscape(onClose);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    // Respect an explicit autoFocus inside the panel (e.g. ConfirmDialog).
    if (panel.contains(document.activeElement)) return;
    const focusable = panel.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button',
    );
    focusable?.focus();
  }, []);

  return createPortal(
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`modal ${className ?? ''}`}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button type="button" className="icon-btn" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
