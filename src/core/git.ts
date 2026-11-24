/**
 * Git CLI runner. execFile only — argument arrays, never a shell string.
 */
import { execFile } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class GitError extends Error {
  readonly result: GitResult;
  readonly args: string[];
  constructor(args: string[], result: GitResult) {
    super(`git ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.result = result;
  }
}

export interface RunOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra env merged over a sanitized base. */
  env?: Record<string, string>;
  /** If true, return result even on non-zero exit instead of throwing. */
  allowFail?: boolean;
  /** Cap output size (bytes). Default 8 MiB. */
  maxBuffer?: number;
}

/** Env that keeps git non-interactive and output parseable. */
const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  LC_ALL: 'C',
  // Keep user credential helpers working: we do NOT touch
  // GIT_CONFIG_* / HOME / SSH_AUTH_SOCK.
};

export async function git(args: string[], opts: RunOptions): Promise<GitResult> {
  const { cwd, timeoutMs = 30_000, signal, env, allowFail = false, maxBuffer = 8 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer,
        signal,
        env: { ...process.env, ...BASE_ENV, ...env },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = typeof (error as { code?: number } | null)?.code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
        const result: GitResult = {
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code,
        };
        if ((error || code !== 0) && !allowFail) {
          reject(new GitError(args, result));
        } else {
          resolve(result);
        }
      },
    );
    void child;
  });
}
