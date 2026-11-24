import { useEffect, useRef } from 'react';

/**
 * Shared Escape stack: the most recently opened layer consumes Escape first.
 * App owns the single window keydown listener and calls `fireEscape()`.
 */
const stack: Array<() => void> = [];

export function useEscape(handler: () => void, active = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) return undefined;
    const entry = (): void => handlerRef.current();
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
}

export function fireEscape(): boolean {
  const handler = stack[stack.length - 1];
  if (!handler) return false;
  handler();
  return true;
}
