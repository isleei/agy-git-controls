import { describe, expect, it } from 'vitest';
import {
  assertMessage,
  assertSafeRef,
  assertSafeRemoteUrl,
  assertSafeSha,
  sanitizePathspec,
  sanitizePathspecs,
  validateRefName,
  validateTagName,
} from '../src/core/refs.js';

describe('validateRefName', () => {
  it('accepts normal branch names', async () => {
    for (const name of ['main', 'feature/x', 'v1.0.0', 'fix-123', 'release/1.2']) {
      await expect(validateRefName(name), name).resolves.toBe(true);
    }
  });

  it('rejects option injection and characters git forbids', async () => {
    const invalid = [
      '',
      '-x',
      '--help',
      'a..b',
      'a~b',
      'a^b',
      'a:b',
      'a?b',
      'a*b',
      'a[b',
      'a b',
      'a\tb',
      'a\nb',
      'a@{b',
      'a\\b',
      'x.lock',
      'x.',
      'a//b',
      '/a',
      'a/',
      '@',
    ];
    for (const name of invalid) {
      await expect(validateRefName(name), JSON.stringify(name)).resolves.toBe(false);
    }
  });

  it('rejects invalid tag names', async () => {
    await expect(validateTagName('v1.0.0')).resolves.toBe(true);
    await expect(validateTagName('release/2026-11')).resolves.toBe(true);
    await expect(validateTagName('bad..tag')).resolves.toBe(false);
    await expect(validateTagName('-tag')).resolves.toBe(false);
  });
});

describe('assertSafeRef', () => {
  it('throws on every option-injection / refname hazard', () => {
    for (const name of ['-x', 'a..b', 'a@{b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a b', 'a\\b', 'x.lock', 'x.', '@', '/a', 'a/', 'a//b']) {
      expect(() => assertSafeRef(name), JSON.stringify(name)).toThrow();
    }
  });

  it('accepts HEAD and ordinary names', () => {
    for (const name of ['HEAD', 'main', 'origin/main', 'v1.0.0', '0123abcd']) {
      expect(() => assertSafeRef(name), name).not.toThrow();
    }
  });
});

describe('pathspec sanitation', () => {
  it('allows repository-relative paths', () => {
    for (const p of ['a.txt', 'dir/file.ts', '.', 'a b.txt', 'src/[x].ts']) {
      expect(sanitizePathspec(p)).toBe(p);
    }
  });

  it('rejects option injection, absolute paths and traversal', () => {
    for (const p of ['', '-n', '../x', 'a/../../b', '/etc/passwd', 'C:\\x', '\\x', 'a\0b']) {
      expect(() => sanitizePathspec(p), JSON.stringify(p)).toThrow();
    }
  });

  it('requires a non-empty list', () => {
    expect(sanitizePathspecs(['a', 'b'])).toEqual(['a', 'b']);
    expect(() => sanitizePathspecs([])).toThrow(/at least one path/);
  });
});

describe('other input guards', () => {
  it('validates messages', () => {
    expect(() => assertMessage('hello')).not.toThrow();
    expect(() => assertMessage('  ')).toThrow(/required/);
    expect(() => assertMessage('a\0b')).toThrow(/NUL/);
  });

  it('validates commit ids', () => {
    for (const sha of ['abcd', '0123456789abcdef0123456789abcdef01234567']) {
      expect(() => assertSafeSha(sha)).not.toThrow();
    }
    for (const sha of ['-abc', 'xyz', 'abc', 'abcg', 'HEAD']) {
      expect(() => assertSafeSha(sha)).toThrow();
    }
  });

  it('rejects executable remote transports', () => {
    for (const url of [
      'https://example.com/repo.git',
      'ssh://git@example.com/repo.git',
      'git@example.com:org/repo.git',
      'file:///tmp/bare.git',
      '/tmp/bare.git',
      '/tmp/with space/bare.git',
    ]) {
      expect(() => assertSafeRemoteUrl(url), url).not.toThrow();
    }
    for (const url of [
      '',
      '-u',
      'ext::sh -c touch /tmp/pwned',
      'fd::3',
      'helper::command',
      'ftp://example.com/repo',
      'https://example.com/repo\n--upload-pack=evil',
    ]) {
      expect(() => assertSafeRemoteUrl(url), JSON.stringify(url)).toThrow();
    }
  });
});
