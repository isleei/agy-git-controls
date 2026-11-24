import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useEscape } from '../hooks/useEscape';

export interface MenuAction {
  type?: 'item';
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSeparator {
  type: 'separator';
}

export interface MenuHeader {
  type: 'header';
  label: string;
}

export type MenuItem = MenuAction | MenuSeparator | MenuHeader;

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function useContextMenu() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const lastPointRef = useRef({ x: 0, y: 0 });

  const open = useCallback((event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    lastPointRef.current = { x: event.clientX, y: event.clientY };
    setMenu({ x: event.clientX, y: event.clientY, items });
  }, []);

  const openAt = useCallback((x: number, y: number, items: MenuItem[]) => {
    lastPointRef.current = { x, y };
    setMenu({ x, y, items });
  }, []);

  const close = useCallback(() => setMenu(null), []);

  return { menu, open, openAt, close, lastPointRef };
}

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEscape(onClose, menu !== null);

  useLayoutEffect(() => {
    if (!menu) {
      setPosition(null);
      return;
    }
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const left = Math.max(4, Math.min(menu.x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(menu.y, window.innerHeight - rect.height - 4));
    setPosition({ left, top });
  }, [menu]);

  if (!menu) return null;

  return createPortal(
    <div
      className="menu-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        className="menu"
        role="menu"
        style={{
          left: position?.left ?? menu.x,
          top: position?.top ?? menu.y,
          visibility: position ? 'visible' : 'hidden',
        }}
      >
        {menu.items.map((item, index) => {
          if (item.type === 'separator') {
            return <div key={`sep-${index}`} className="menu-sep" role="separator" />;
          }
          if (item.type === 'header') {
            return (
              <div key={`head-${index}`} className="menu-header">
                {item.label}
              </div>
            );
          }
          return (
            <button
              key={`${item.label}-${index}`}
              type="button"
              role="menuitem"
              className={`menu-item ${item.danger ? 'danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span className="menu-icon">{item.icon}</span>
              <span className="menu-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
