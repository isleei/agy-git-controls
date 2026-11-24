/**
 * Git CLI runner. `spawn` only — argument arrays, never a shell string.
 *
 * Every run owns a fresh process group on POSIX (`detached: true`), so a
 * timeout or abort can take down ssh / git-remote-https helpers together
 * with git itself, and the group is SIGKILLed after every run as a backstop
 * against orphans. `execFile` cannot do this: Node's execFile option
 * allowlist silently drops `detached`, which is why the previous version
 * left orphaned ssh children and why this module owns the child directly.
 */
import { spawn, type ChildProcess } from 'node:child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when the run hit `timeoutMs` and was killed. */
  timedOut?: boolean;
  /** Signal that terminated the process (SIGTERM for timeout/abort). */
  signal?: string;
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
  /** Cap output size per stream (bytes). Default 8 MiB. */
  maxBuffer?: number;
}

/** Env that keeps git non-interactive and output parseable. */
const BASE_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  LC_ALL: 'C',
  // Every path we pass comes from `git status`, never from a glob: disable
  // pathspec magic so `:(glob)**`, `:!x` etc. stay literal (B2).
  GIT_LITERAL_PATHSPECS: '1',
  // Keep user credential helpers working: HOME, SSH_AUTH_SOCK and the
  // credential-helper config are intentionally not touched.
};

/**
 * Variables that would silently point git at another repository or inject
 * config (`GIT_CONFIG_KEY_*` can set `core.sshCommand`/`core.fsmonitor`),
 * defeating the `cwd`-based repo boundary. Credential/SSH variables are kept.
 */
const DROPPED_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
] as const;

const GIT_CONFIG_PAIR = /^GIT_CONFIG_(?:KEY|VALUE)_/;

function buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of DROPPED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_PAIR.test(key)) delete env[key];
  }
  return { ...env, ...BASE_ENV, ...(extra ?? {}) };
}

/** Send `signal` to the whole process group (POSIX) or the child (win32). */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* process group already gone */
    }
  }
}

const MAX_BUFFER_MESSAGE = 'output maxBuffer length exceeded';

export async function git(args: string[], opts: RunOptions): Promise<GitResult> {
  const { cwd, timeoutMs = 30_000, signal, env, allowFail = false, maxBuffer = 8 * 1024 * 1024 } = opts;

  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      const result: GitResult = { stdout: '', stderr: 'aborted', code: 1, signal: 'SIGTERM' };
      if (allowFail) resolve(result);
      else reject(new GitError(args, result));
      return;
    }

    const child = spawn('git', args, {
      cwd,
      env: buildEnv(env),
      windowsHide: true,
      // Own process group so timeout/abort reaches grandchildren.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const terminate = (): void => {
      if (settled) return;
      signalTree(child, 'SIGTERM');
    };

    const onAbort = (): void => {
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let spawnError: Error | null = null;

    const settle = (code: number | null, termSignal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Backstop: reap anything still alive in the group (ssh helpers that
      // ignored SIGTERM, or a normal exit that raced a child spawn).
      signalTree(child, 'SIGKILL');

      const collectedStderr = Buffer.concat(stderr).toString('utf8');
      let finalStderr = collectedStderr;
      if (overflow) {
        finalStderr =
          finalStderr.length > 0 ? `${finalStderr}\n${MAX_BUFFER_MESSAGE}` : MAX_BUFFER_MESSAGE;
      } else if (finalStderr.length === 0 && spawnError !== null) {
        // ENOENT for the git binary etc. — surface the reason.
        finalStderr = spawnError.message;
      }
      const result: GitResult = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: finalStderr,
        code: overflow ? 1 : typeof code === 'number' ? code : 1,
      };
      if (termSignal !== null) result.signal = termSignal;
      if (timedOut) result.timedOut = true;
      if ((overflow || result.code !== 0) && !allowFail) {
        reject(new GitError(args, result));
      } else {
        resolve(result);
      }
    };

    const collect = (chunks: Buffer[], chunk: Buffer, total: number): number => {
      if (overflow) return total;
      const next = total + chunk.length;
      if (next > maxBuffer) {
        overflow = true;
        chunks.length = 0;
        terminate();
        return next;
      }
      chunks.push(chunk);
      return next;
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });

    child.on('error', (err: Error) => {
      // Spawn failures (ENOENT etc.): cannot get a PID/status.
      spawnError = err;
      settle(null, null);
    });
    child.on('close', (code, termSignal) => {
      settle(code, termSignal);
    });

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate();
    }, timeoutMs);
    // A pending timeout alone must not keep a short-lived process alive.
    timer.unref?.();
  });
}
