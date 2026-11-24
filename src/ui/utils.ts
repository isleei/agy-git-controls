/** Small presentation helpers. No git logic lives here. */

export interface PathParts {
  dir: string;
  name: string;
}

/** Split a repo-relative path into `dir/` and `basename`. */
export function splitPath(filePath: string): PathParts {
  const normalized = filePath.replace(/\\/g, '/');
  const slash = normalized.lastIndexOf('/');
  if (slash === -1) return { dir: '', name: normalized };
  return { dir: normalized.slice(0, slash + 1), name: normalized.slice(slash + 1) };
}

export function basename(filePath: string): string {
  return splitPath(filePath).name;
}

const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
  { unit: 'year', seconds: 365 * 24 * 3600 },
  { unit: 'month', seconds: 30 * 24 * 3600 },
  { unit: 'week', seconds: 7 * 24 * 3600 },
  { unit: 'day', seconds: 24 * 3600 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
  { unit: 'second', seconds: 1 },
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });

/** `3h ago`, `2d ago`, `just now` — compact relative time for list rows. */
export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const deltaSeconds = (time - Date.now()) / 1000;
  const abs = Math.abs(deltaSeconds);
  if (abs < 45) return 'just now';
  for (const { unit, seconds } of RELATIVE_UNITS) {
    if (abs >= seconds || unit === 'second') {
      return rtf.format(Math.round(deltaSeconds / seconds), unit);
    }
  }
  return '';
}

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return iso;
  return new Date(time).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Map a FileChange.kind to a safe CSS suffix and a display letter. */
export function statusLetter(kind: string): { letter: string; tone: string } {
  switch (kind) {
    case 'A':
      return { letter: 'A', tone: 'added' };
    case 'M':
      return { letter: 'M', tone: 'modified' };
    case 'D':
      return { letter: 'D', tone: 'deleted' };
    case 'R':
      return { letter: 'R', tone: 'renamed' };
    case 'C':
      return { letter: 'C', tone: 'copied' };
    case 'U':
      return { letter: 'U', tone: 'conflict' };
    case 'T':
      return { letter: 'T', tone: 'modified' };
    case '?':
      return { letter: 'U', tone: 'untracked' };
    default:
      return { letter: kind.slice(0, 1) || '?', tone: 'untracked' };
  }
}

/** `deadbeef` from a full sha; keeps already-short values intact. */
export function shortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 8) : sha;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform);
}

/** `⌘1` vs `Ctrl+1` in hints. */
export function modLabel(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl+';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  );
}
