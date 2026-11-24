/**
 * Input hardening for everything that reaches git as a ref, branch or path.
 *
 * Defence in depth: git is always invoked with an argument array (no shell),
 * but a leading `-` would still be parsed as an option, so refs and pathspecs
 * are rejected before they are handed to git. `--` separators are used at the
 * call sites for every path argument.
 */
import path from 'node:path';
import { git } from './git.js';

const REF_FORBIDDEN = /[~^:?*[\\]/;

/** Commit/tag/stash message cap (argv safety, E2BIG guard). */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** Pathspec cap (argv safety, E2BIG guard). */
export const MAX_PATHSPEC_BYTES = 4096;

/** Whitespace or C0/DEL control characters (forbidden in refnames). */
function hasUnsafeWhitespace(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** C0/DEL control characters, but ordinary spaces allowed. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Synchronous guard applied to any ref-like string (branch, tag, remote,
 * upstream, revision). Throws on anything that could be confused with an
 * option or on sequences git forbids in refnames.
 */
export function assertSafeRef(name: string, label = 'ref'): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${label} name is required`);
  }
  if (name.startsWith('-')) {
    throw new Error(`unsafe ${label} name (leading '-'): ${name}`);
  }
  if (name.includes('..')) {
    throw new Error(`unsafe ${label} name ('..'): ${name}`);
  }
  if (name.includes('@{')) {
    throw new Error(`unsafe ${label} name ('@{'): ${name}`);
  }
  if (hasUnsafeWhitespace(name) || REF_FORBIDDEN.test(name)) {
    throw new Error(`unsafe ${label} name (forbidden character): ${name}`);
  }
  if (name === '@') {
    throw new Error(`unsafe ${label} name ('@'): ${name}`);
  }
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    throw new Error(`unsafe ${label} name (slash placement): ${name}`);
  }
  if (name.endsWith('.') || name.split('/').some((part) => part.endsWith('.lock'))) {
    throw new Error(`unsafe ${label} name ('.' / '.lock' suffix): ${name}`);
  }
}

/**
 * Full branch-name validation: local guard plus `git check-ref-format
 * --branch`, which rejects every remaining syntax git itself refuses.
 */
export async function validateRefName(name: string): Promise<boolean> {
  try {
    assertSafeRef(name, 'branch');
  } catch {
    return false;
  }
  const res = await git(['check-ref-format', '--branch', name], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
    allowFail: true,
  });
  return res.code === 0;
}

/** Throwing variant used by write operations. */
export async function assertValidBranchName(name: string): Promise<void> {
  if (!(await validateRefName(name))) {
    throw new Error(`invalid branch name: ${name}`);
  }
}

/** Tag names follow ref syntax; validate the fully-qualified form. */
export async function validateTagName(name: string): Promise<boolean> {
  try {
    assertSafeRef(name, 'tag');
  } catch {
    return false;
  }
  const res = await git(['check-ref-format', `refs/tags/${name}`], {
    cwd: process.cwd(),
    timeoutMs: 10_000,
    allowFail: true,
  });
  return res.code === 0;
}

export async function assertValidTagName(name: string): Promise<void> {
  if (!(await validateTagName(name))) {
    throw new Error(`invalid tag name: ${name}`);
  }
}

/**
 * Validate a repository-relative path used as a pathspec.
 * Rejects option injection, absolute paths, traversal, NUL bytes, pathspec
 * magic (`:(...)`, `:!`) and oversized input.
 * Callers still place paths after `--`; `GIT_LITERAL_PATHSPECS=1` is set in
 * `git.ts` so even `*?[` stay literal.
 */
export function sanitizePathspec(p: string): string {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('path is required');
  }
  if (p.length > MAX_PATHSPEC_BYTES || Buffer.byteLength(p, 'utf8') > MAX_PATHSPEC_BYTES) {
    throw new Error(`unsafe path (too long, max ${MAX_PATHSPEC_BYTES} bytes): ${p.slice(0, 64)}…`);
  }
  if (p.includes('\0')) {
    throw new Error(`unsafe path (NUL byte): ${p}`);
  }
  if (p.startsWith('-')) {
    throw new Error(`unsafe path (leading '-'): ${p}`);
  }
  if (p.startsWith(':')) {
    throw new Error(`unsafe path (pathspec magic): ${p}`);
  }
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\')) {
    throw new Error(`unsafe path (absolute): ${p}`);
  }
  if (p.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe path (traversal): ${p}`);
  }
  return p;
}

/** Sanitize a non-empty list of pathspecs. */
export function sanitizePathspecs(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error('at least one path is required');
  }
  return paths.map(sanitizePathspec);
}

/** Commit/tag message sanity (no NUL, non-empty after trim, bounded size). */
export function assertMessage(message: string, label = 'message'): void {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  if (message.includes('\0')) {
    throw new Error(`${label} contains a NUL byte`);
  }
  if (
    message.length > MAX_MESSAGE_BYTES ||
    Buffer.byteLength(message, 'utf8') > MAX_MESSAGE_BYTES
  ) {
    throw new Error(`${label} is too long (max ${MAX_MESSAGE_BYTES} bytes)`);
  }
}

/** Abbreviated or full object ids accepted by cherry-pick/revert. */
export function assertSafeSha(sha: string): void {
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new Error(`invalid object id: ${sha}`);
  }
}

export interface RemoteUrlOptions {
  /**
   * Accept `file://` remotes. Internal opt-in for tests only — the REST layer
   * never exposes it, so users cannot point a repo at an unregistered local
   * work tree.
   */
  allowFileProtocol?: boolean;
}

/** A local filesystem path (`/x`, `./x`, `../x`, `~/x`, `C:\x`) is not a remote. */
const LOCAL_REMOTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/;

/** SCP-like ssh shorthand: `[user@]host:path`. */
const SCP_LIKE_REMOTE = /^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9._-]+:/;

/**
 * Remote URLs may not use a transport helper (`ext::`, `fd::`, any
 * `helper::address`), a local path, or `file://` (that would let the panel
 * read/write repositories outside the allowlist). http/https/ssh/git and the
 * SCP-like ssh shorthand are allowed.
 */
export function assertSafeRemoteUrl(url: string, opts: RemoteUrlOptions = {}): void {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('remote url is required');
  }
  if (url.length > 4096) {
    throw new Error('remote url is too long');
  }
  if (hasControlChar(url)) {
    throw new Error('remote url contains control characters');
  }
  if (url.startsWith('-')) {
    throw new Error(`unsafe remote url (leading '-'): ${url}`);
  }
  if (url.includes('::')) {
    throw new Error(`unsafe remote url (transport helper): ${url}`);
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const name = scheme[1]!.toLowerCase();
    if (name === 'file') {
      if (opts.allowFileProtocol === true) return;
      throw new Error(`unsafe remote url (file:// is not allowed): ${url}`);
    }
    const allowed = new Set(['http', 'https', 'ssh', 'git']);
    if (!allowed.has(name)) {
      throw new Error(`unsupported remote url scheme: ${scheme[1]}`);
    }
    return;
  }
  if (LOCAL_REMOTE_PATH.test(url) || /^(?:file|ext|fd):/i.test(url)) {
    throw new Error(`unsafe remote url (local path): ${url}`);
  }
  if (!SCP_LIKE_REMOTE.test(url)) {
    throw new Error(`unsafe remote url (expected scheme:// or user@host:path): ${url}`);
  }
}

/**
 * Strip URL userinfo (`scheme://user:token@host/path` -> `scheme://***@host/path`)
 * before a remote URL reaches a REST response, stderr or a log.
 */
export function redactUrl(url: string): string {
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/, '$1***@');
}
