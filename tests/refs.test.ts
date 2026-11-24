import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  MAX_PATHSPEC_BYTES,
  assertMessage,
  assertSafeRef,
  assertSafeRemoteUrl,
  assertSafeSha,
  redactUrl,
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
    for (const name of ['-x', '--upload-pack=x', '-c', 'a..b', 'a@{b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a b', 'a\rb', 'a\nb', 'a\\b', 'x.lock', 'x.', '@', '/a', 'a/', 'a//b']) {
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

  it('rejects option injection, pathspec magic, absolute paths and traversal', () => {
    for (const p of [
      '',
      '-n',
      ':(glob)**',
      ':!a.txt',
      ':^a.txt',
      '../x',
      'a/../../b',
      '/etc/passwd',
      'C:\\x',
      '\\x',
      'a\0b',
    ]) {
      expect(() => sanitizePathspec(p), JSON.stringify(p)).toThrow();
    }
  });

  it('caps pathspec size', () => {
    expect(() => sanitizePathspec('a'.repeat(MAX_PATHSPEC_BYTES))).not.toThrow();
    expect(() => sanitizePathspec('a'.repeat(MAX_PATHSPEC_BYTES + 1))).toThrow(/too long/);
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
    expect(() => assertMessage('a'.repeat(MAX_MESSAGE_BYTES))).not.toThrow();
    expect(() => assertMessage('a'.repeat(MAX_MESSAGE_BYTES + 1))).toThrow(/too long/);
    expect(() => assertMessage('本'.repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1))).toThrow(
      /too long/,
    );
  });

  it('validates commit ids', () => {
    for (const sha of ['abcd', '0123456789abcdef0123456789abcdef01234567']) {
      expect(() => assertSafeSha(sha)).not.toThrow();
    }
    for (const sha of ['-abc', '--upload-pack=x', '-c', 'a b', 'a\rb', 'xyz', 'abc', 'abcg', 'HEAD']) {
      expect(() => assertSafeSha(sha), JSON.stringify(sha)).toThrow();
    }
  });

  it('rejects executable transports and local paths', () => {
    for (const url of [
      'https://example.com/repo.git',
      'ssh://git@example.com/repo.git',
      'git@example.com:org/repo.git',
      'git://example.com/repo.git',
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
      'file:///tmp/bare.git',
      'file://example.com/repo',
      '/tmp/bare.git',
      './bare.git',
      '../bare.git',
      '~/bare.git',
      'C:\\bare.git',
      'bare.git',
    ]) {
      expect(() => assertSafeRemoteUrl(url), JSON.stringify(url)).toThrow();
    }
  });

  it('accepts file:// only with the internal opt-in', () => {
    expect(() =>
      assertSafeRemoteUrl('file:///tmp/bare.git', { allowFileProtocol: true }),
    ).not.toThrow();
    expect(() =>
      assertSafeRemoteUrl('file:///tmp/bare.git', { allowFileProtocol: false }),
    ).toThrow();
  });

  it('redacts url userinfo', () => {
    expect(redactUrl('https://user:token@example.com/repo.git')).toBe(
      'https://***@example.com/repo.git',
    );
    expect(redactUrl('ssh://git@example.com/repo.git')).toBe('ssh://***@example.com/repo.git');
    expect(redactUrl('https://example.com/repo.git')).toBe('https://example.com/repo.git');
    expect(redactUrl('git@example.com:org/repo.git')).toBe('git@example.com:org/repo.git');
  });
});
