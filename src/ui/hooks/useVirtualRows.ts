import { useEffect, useState, type RefObject } from 'react';

export interface VirtualRows {
  start: number;
  end: number;
  totalHeight: number;
  scrollTop: number;
  viewportHeight: number;
}

/**
 * Minimal fixed-row-height windowing for long lists (> ~500 rows).
 * No dependency; the scroll container is measured with ResizeObserver.
 */
export function useVirtualRows(
  containerRef: RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number,
  overscan = 8,
): VirtualRows {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const updateScroll = (): void => setScrollTop(element.scrollTop);
    const updateSize = (): void => setViewportHeight(element.clientHeight);
    updateScroll();
    updateSize();
    element.addEventListener('scroll', updateScroll, { passive: true });
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => {
      element.removeEventListener('scroll', updateScroll);
      observer.disconnect();
    };
  }, [containerRef]);

  useEffect(() => {
    setScrollTop((current) => (rowCount === 0 ? 0 : current));
  }, [rowCount]);

  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(rowCount, start + Math.max(visibleCount, 0));
  return {
    start,
    end,
    totalHeight: rowCount * rowHeight,
    scrollTop,
    viewportHeight,
  };
}
