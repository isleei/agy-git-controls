import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export interface GroupHeaderProps {
  title: string;
  count?: number;
  tone?: 'default' | 'conflict' | 'muted';
  open: boolean;
  onToggle: () => void;
  actions?: ReactNode;
  sticky?: boolean;
}

export function GroupHeader({
  title,
  count,
  tone = 'default',
  open,
  onToggle,
  actions,
  sticky = true,
}: GroupHeaderProps) {
  return (
    <div className={`group-head ${sticky ? 'sticky' : ''} tone-${tone}`}>
      <button type="button" className="group-toggle" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span className="group-title">{title}</span>
        {count !== undefined ? <span className="group-count">{count}</span> : null}
      </button>
      {actions ? (
        <div className="group-actions" onClick={(event) => event.stopPropagation()}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

export interface CollapsibleGroupProps {
  title: string;
  count?: number;
  tone?: 'default' | 'conflict' | 'muted';
  defaultOpen?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}

export function CollapsibleGroup({
  title,
  count,
  tone = 'default',
  defaultOpen = true,
  actions,
  children,
}: CollapsibleGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="group">
      <GroupHeader
        title={title}
        {...(count !== undefined ? { count } : {})}
        tone={tone}
        open={open}
        onToggle={() => setOpen((value) => !value)}
        {...(actions !== undefined ? { actions } : {})}
      />
      {open ? <div className="group-body">{children}</div> : null}
    </div>
  );
}
