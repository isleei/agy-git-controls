// src/sidecar-backend/main.ts
import fs6 from "node:fs";
import os from "node:os";
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { Response, SidecarApp } from "sidecar_sdk";

// src/sidecar-backend/registry.ts
import fs2 from "node:fs/promises";
import path2 from "node:path";
import { fileURLToPath } from "node:url";

// src/core/allowlist.ts
var REGISTRY_FILE = "git-controls.json";
var MAX_REGISTRY_BYTES = 1024 * 1024;
var CASE_INSENSITIVE_PLATFORM = process.platform === "darwin" || process.platform === "win32";

// src/core/repo.ts
import fs from "node:fs/promises";
import path from "node:path";

// src/core/git.ts
import { spawn } from "node:child_process";
var GitError = class extends Error {
  result;
  args;
  constructor(args, result) {
    super(`git ${args.join(" ")} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitError";
    this.args = args;
    this.result = result;
  }
};
var BASE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  SSH_ASKPASS: "",
  LC_ALL: "C",
  // Every path we pass comes from `git status`, never from a glob: disable
  // pathspec magic so `:(glob)**`, `:!x` etc. stay literal (B2).
  GIT_LITERAL_PATHSPECS: "1"
  // Keep user credential helpers working: HOME, SSH_AUTH_SOCK and the
  // credential-helper config are intentionally not touched.
};
var DROPPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS"
];
var GIT_CONFIG_PAIR = /^GIT_CONFIG_(?:KEY|VALUE)_/;
function buildEnv(extra) {
  const env = { ...process.env };
  for (const key of DROPPED_ENV) delete env[key];
  for (const key of Object.keys(env)) {
    if (GIT_CONFIG_PAIR.test(key)) delete env[key];
  }
  return { ...env, ...BASE_ENV, ...extra ?? {} };
}
function signalTree(child, signal) {
  if (child.pid === void 0) return;
  if (process.platform === "win32") {
    try {
      child.kill(signal);
    } catch {
    }
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
    }
  }
}
var MAX_BUFFER_MESSAGE = "output maxBuffer length exceeded";
async function git(args, opts) {
  const { cwd, timeoutMs = 3e4, signal, env, allowFail = false, maxBuffer = 8 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      const result = { stdout: "", stderr: "aborted", code: 1, signal: "SIGTERM" };
      if (allowFail) resolve(result);
      else reject(new GitError(args, result));
      return;
    }
    const child = spawn("git", args, {
      cwd,
      env: buildEnv(env),
      windowsHide: true,
      // Own process group so timeout/abort reaches grandchildren.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    let settled = false;
    let timer;
    const terminate = () => {
      if (settled) return;
      signalTree(child, "SIGTERM");
    };
    const onAbort = () => {
      terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let spawnError = null;
    const settle = (code, termSignal) => {
      if (settled) return;
      settled = true;
      if (timer !== void 0) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      signalTree(child, "SIGKILL");
      const collectedStderr = Buffer.concat(stderr).toString("utf8");
      let finalStderr = collectedStderr;
      if (overflow) {
        finalStderr = finalStderr.length > 0 ? `${finalStderr}
${MAX_BUFFER_MESSAGE}` : MAX_BUFFER_MESSAGE;
      } else if (finalStderr.length === 0 && spawnError !== null) {
        finalStderr = spawnError.message;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: finalStderr,
        code: overflow ? 1 : typeof code === "number" ? code : 1
      };
      if (termSignal !== null) result.signal = termSignal;
      if (timedOut) result.timedOut = true;
      if ((overflow || result.code !== 0) && !allowFail) {
        reject(new GitError(args, result));
      } else {
        resolve(result);
      }
    };
    const collect = (chunks, chunk, total) => {
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
    child.stdout?.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes);
    });
    child.stderr?.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes);
    });
    child.on("error", (err) => {
      spawnError = err;
      settle(null, null);
    });
    child.on("close", (code, termSignal) => {
      settle(code, termSignal);
    });
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate();
    }, timeoutMs);
    timer.unref?.();
  });
}

// src/core/repo.ts
async function canonicalPath(p) {
  const resolved = path.resolve(p);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}
async function findRepoRoot(p) {
  const res = await git(["-C", p, "rev-parse", "--show-toplevel"], { cwd: p, allowFail: true });
  if (res.code !== 0) return null;
  const top = res.stdout.trim();
  return top ? canonicalPath(top) : null;
}
async function isLinkedWorktree(root) {
  const res = await git(["rev-parse", "--git-dir"], { cwd: root, allowFail: true });
  if (res.code !== 0) return false;
  return res.stdout.trim().includes(`${path.sep}worktrees${path.sep}`) || res.stdout.trim().includes("/worktrees/");
}
async function repoInfoFor(root, source) {
  const repoRoot = await findRepoRoot(root);
  if (!repoRoot) return null;
  return {
    path: repoRoot,
    name: path.basename(repoRoot),
    isWorktree: await isLinkedWorktree(repoRoot),
    source
  };
}
function splitStatusFields(line, count) {
  const fields = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    const space = line.indexOf(" ", pos);
    if (space === -1) return { fields, rest: "" };
    fields.push(line.slice(pos, space));
    pos = space + 1;
  }
  return { fields, rest: line.slice(pos) };
}
function parsePorcelainV2(out, repo) {
  const status = {
    repo,
    branch: null,
    detachedAt: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    clean: true,
    operation: null,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: []
  };
  let detached = false;
  let headOid = null;
  const nulSeparated = out.includes("\0");
  const records = nulSeparated ? out.split("\0") : out.split("\n");
  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;
    if (line.startsWith("# branch.head ")) {
      const v = line.slice("# branch.head ".length).trim();
      if (v === "(detached)") detached = true;
      else status.branch = v;
    } else if (line.startsWith("# branch.oid ")) {
      headOid = line.slice("# branch.oid ".length).trim();
    } else if (line.startsWith("# branch.upstream ")) {
      status.upstream = line.slice("# branch.upstream ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line);
      if (m) {
        status.ahead = Number(m[1]);
        status.behind = Number(m[2]);
      }
    } else if (line[0] === "1" || line[0] === "2") {
      const isRename = line[0] === "2";
      let head = line;
      let origPath;
      if (isRename) {
        if (nulSeparated) {
          origPath = records[i + 1];
          i += 1;
        } else {
          const tab = line.indexOf("	");
          if (tab !== -1) {
            head = line.slice(0, tab);
            origPath = line.slice(tab + 1);
          }
        }
      }
      const { fields, rest } = splitStatusFields(head, isRename ? 9 : 8);
      if (!rest) continue;
      const xy = fields[1] ?? "..";
      const x = xy[0] ?? ".";
      const y = xy[1] ?? ".";
      const change = {
        path: rest,
        ...origPath !== void 0 ? { origPath } : {},
        staged: x !== "." && x !== "?",
        unstaged: y !== ".",
        kind: x !== "." ? x : y,
        conflicted: false
      };
      if (change.staged) status.staged.push(change);
      if (change.unstaged) status.unstaged.push(change);
    } else if (line[0] === "u") {
      const { rest } = splitStatusFields(line, 10);
      if (!rest) continue;
      status.conflicted.push({
        path: rest,
        staged: false,
        unstaged: false,
        kind: "U",
        conflicted: true
      });
    } else if (line[0] === "?") {
      status.untracked.push({
        path: line.slice(2),
        staged: false,
        unstaged: false,
        kind: "?",
        conflicted: false
      });
    }
  }
  if (detached) {
    status.detachedAt = headOid === null ? "" : headOid === "(initial)" ? "(no commits)" : headOid.slice(0, 10);
  }
  status.clean = status.staged.length === 0 && status.unstaged.length === 0 && status.untracked.length === 0 && status.conflicted.length === 0;
  return status;
}
async function detectOperation(root) {
  const res = await git(["rev-parse", "--git-dir"], { cwd: root, allowFail: true });
  if (res.code !== 0) return null;
  const gitDir = path.resolve(root, res.stdout.trim());
  const checks = [
    ["MERGE_HEAD", "merge"],
    ["REBASE_HEAD", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"]
  ];
  for (const [file, op] of checks) {
    try {
      await fs.access(path.join(gitDir, file));
      return op;
    } catch {
    }
  }
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      await fs.access(path.join(gitDir, dir));
      return "rebase";
    } catch {
    }
  }
  return null;
}
async function getStatus(repo) {
  const res = await git(
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"],
    {
      cwd: repo,
      timeoutMs: 2e4,
      // Porcelain v2 is ~100 B per entry; 64 MiB keeps large monorepos whole.
      maxBuffer: 64 * 1024 * 1024
    }
  );
  const status = parsePorcelainV2(res.stdout, repo);
  status.operation = await detectOperation(repo);
  return status;
}

// src/sidecar-backend/registry.ts
var MAX_PREFS_BYTES = 256 * 1024;
var MAX_REGISTRY_BYTES2 = 1024 * 1024;
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uriToLocalPath(uri) {
  try {
    if (uri.startsWith("file://")) return fileURLToPath(uri);
    if (path2.isAbsolute(uri)) return uri;
    return null;
  } catch {
    return null;
  }
}
async function findRepoRootForInput(inputPath) {
  try {
    const stat = await fs2.stat(inputPath);
    if (stat.isFile()) return findRepoRoot(path2.dirname(inputPath));
  } catch {
  }
  return findRepoRoot(inputPath);
}
async function isDirectory(target) {
  try {
    return (await fs2.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
var RepoRegistry = class {
  dataDir;
  file;
  #workspacePaths = [];
  #workspaceRepos = /* @__PURE__ */ new Map();
  #registered = [];
  #registeredSet = /* @__PURE__ */ new Set();
  #registeredInfo = /* @__PURE__ */ new Map();
  #prefs = {};
  #listeners = /* @__PURE__ */ new Set();
  #writeChain = Promise.resolve();
  #loaded = false;
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.file = path2.join(opts.dataDir, REGISTRY_FILE);
  }
  /** Load persisted registered repos + prefs. Missing/corrupt files are not fatal. */
  async load() {
    if (this.#loaded) return;
    this.#loaded = true;
    let raw = null;
    try {
      const stat = await fs2.stat(this.file);
      if (stat.size <= MAX_REGISTRY_BYTES2) raw = await fs2.readFile(this.file, "utf8");
      else console.warn("[git-controls] registry file is too large; ignoring it");
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn("[git-controls] cannot read registry file:", err);
      }
    }
    if (raw === null) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn("[git-controls] registry file is not valid JSON; ignoring it:", err);
      return;
    }
    if (!isRecord(parsed)) return;
    if (Array.isArray(parsed.registeredRepos)) {
      const seen = /* @__PURE__ */ new Set();
      for (const entry of parsed.registeredRepos) {
        if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) continue;
        if (!path2.isAbsolute(entry)) continue;
        const canonical = await canonicalPath(entry);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        this.#registered.push(canonical);
        this.#registeredSet.add(canonical);
      }
    }
    if (Array.isArray(parsed.workspaceRepos)) {
      const seen = /* @__PURE__ */ new Set();
      for (const entry of parsed.workspaceRepos) {
        if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) continue;
        if (!path2.isAbsolute(entry)) continue;
        const canonical = await canonicalPath(entry);
        if (seen.has(canonical) || this.#workspaceRepos.has(canonical)) continue;
        seen.add(canonical);
        const info = await repoInfoFor(canonical, "workspace");
        if (info) this.#workspaceRepos.set(info.path, info);
      }
    }
    if (isRecord(parsed.prefs)) {
      const bytes = Buffer.byteLength(JSON.stringify(parsed.prefs), "utf8");
      if (bytes <= MAX_PREFS_BYTES) this.#prefs = parsed.prefs;
      else console.warn("[git-controls] persisted prefs exceed the size limit; ignoring them");
    }
    for (const root of this.#registered) {
      this.#registeredInfo.set(root, await repoInfoFor(root, "registered"));
    }
  }
  /* ---------------------------------------------------------------- */
  /* workspace                                                         */
  /* ---------------------------------------------------------------- */
  async setWorkspace(uris) {
    const paths = [];
    const seenPaths = /* @__PURE__ */ new Set();
    for (const uri of uris) {
      const local = uriToLocalPath(uri);
      if (local === null || seenPaths.has(local)) continue;
      seenPaths.add(local);
      paths.push(local);
    }
    const next = /* @__PURE__ */ new Map();
    for (const local of paths) {
      const info = await repoInfoFor(local, "workspace");
      if (info) next.set(info.path, info);
    }
    const changed = paths.length !== this.#workspacePaths.length || paths.some((p, i) => p !== this.#workspacePaths[i]) || next.size !== this.#workspaceRepos.size || [...next.keys()].some((p) => !this.#workspaceRepos.has(p));
    this.#workspacePaths = paths;
    this.#workspaceRepos = next;
    if (changed) {
      try {
        await this.#persist();
      } catch (err) {
        console.warn("[git-controls] cannot persist workspace repos:", err);
      }
      this.#notify();
    }
    return { workspaceUris: paths, repos: [...next.values()] };
  }
  get workspacePaths() {
    return this.#workspacePaths.slice();
  }
  /* ---------------------------------------------------------------- */
  /* registered repos                                                  */
  /* ---------------------------------------------------------------- */
  /** Validate + persist a user-registered repo. Returns null when not a work tree. */
  async addRegistered(inputPath) {
    const canonical = await canonicalPath(inputPath);
    const info = await repoInfoFor(canonical, "registered");
    if (!info) return null;
    if (!this.#registeredSet.has(info.path)) {
      this.#registered.push(info.path);
      this.#registeredSet.add(info.path);
      this.#registeredInfo.set(info.path, info);
      await this.#persist();
      this.#notify();
    } else {
      this.#registeredInfo.set(info.path, info);
    }
    return this.#workspaceRepos.has(info.path) ? { ...info, source: "workspace" } : info;
  }
  async removeRegistered(inputPath) {
    const canonical = await canonicalPath(inputPath);
    let target;
    if (this.#registeredSet.has(canonical)) {
      target = canonical;
    } else {
      const root = await findRepoRootForInput(canonical);
      if (root !== null && this.#registeredSet.has(root)) target = root;
    }
    if (target === void 0) return false;
    this.#registered = this.#registered.filter((p) => p !== target);
    this.#registeredSet.delete(target);
    this.#registeredInfo.delete(target);
    await this.#persist();
    this.#notify();
    return true;
  }
  /** Persisted registered paths, in insertion order (may include missing dirs). */
  registeredPaths() {
    return this.#registered.slice();
  }
  /**
   * Resolve an input path to a known repo.
   * Accepts the canonical repo root, or any sub-path whose work-tree root is
   * already registered. Returns null otherwise.
   */
  async resolveRepo(inputPath) {
    if (typeof inputPath !== "string" || inputPath.length === 0) return null;
    const canonical = await canonicalPath(inputPath);
    const workspace = this.#workspaceRepos.get(canonical);
    if (workspace) return await isDirectory(workspace.path) ? workspace : null;
    const registered = await this.#registeredRepo(canonical);
    if (registered) return await isDirectory(registered.path) ? registered : null;
    const root = await findRepoRootForInput(canonical);
    if (root === null) return null;
    const workspaceRoot = this.#workspaceRepos.get(root);
    if (workspaceRoot) return await isDirectory(root) ? workspaceRoot : null;
    const registeredRoot = await this.#registeredRepo(root);
    return registeredRoot && await isDirectory(root) ? registeredRoot : null;
  }
  /** Workspace + registered repos, de-duplicated by canonical path. */
  async listRepos() {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const info of this.#workspaceRepos.values()) {
      if (seen.has(info.path)) continue;
      seen.add(info.path);
      out.push(info);
    }
    for (const root of this.#registered) {
      if (seen.has(root)) continue;
      const info = await this.#registeredRepo(root);
      if (!info || seen.has(info.path)) continue;
      seen.add(info.path);
      out.push(info);
    }
    return out;
  }
  /**
   * Cached RepoInfo for a registered root. A repo that was missing when the
   * registry was loaded is re-probed on demand (it may have been restored).
   */
  async #registeredRepo(root) {
    if (!this.#registeredSet.has(root)) return null;
    const cached = this.#registeredInfo.get(root);
    if (cached) return cached;
    const info = await repoInfoFor(root, "registered");
    this.#registeredInfo.set(root, info);
    return info;
  }
  /* ---------------------------------------------------------------- */
  /* prefs                                                             */
  /* ---------------------------------------------------------------- */
  getPrefs() {
    return structuredClone(this.#prefs);
  }
  async setPrefs(prefs) {
    if (!isRecord(prefs)) throw new Error("prefs must be an object");
    const json = JSON.stringify(prefs);
    if (Buffer.byteLength(json, "utf8") > MAX_PREFS_BYTES) {
      throw new Error(`prefs exceed the ${MAX_PREFS_BYTES}-byte limit`);
    }
    this.#prefs = structuredClone(prefs);
    await this.#persist();
  }
  /* ---------------------------------------------------------------- */
  /* change notification / persistence                                 */
  /* ---------------------------------------------------------------- */
  /** Subscribe to repo-set changes (used to resync fs watchers). */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #notify() {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (err) {
        console.warn("[git-controls] registry listener failed:", err);
      }
    }
  }
  /** Atomic write (tmp + rename), serialized so concurrent saves never interleave. */
  #persist() {
    const state = {
      registeredRepos: this.#registered.slice(),
      workspaceRepos: [...this.#workspaceRepos.keys()],
      prefs: structuredClone(this.#prefs)
    };
    const json = JSON.stringify(state, null, 2);
    const write = async () => {
      await fs2.mkdir(this.dataDir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await fs2.writeFile(tmp, json, { encoding: "utf8", mode: 384 });
      try {
        await fs2.rename(tmp, this.file);
      } catch (err) {
        await fs2.unlink(tmp).catch(() => void 0);
        throw err;
      }
    };
    const run = this.#writeChain.then(write, write);
    this.#writeChain = run.catch(() => void 0);
    return run;
  }
};

// src/core/ops.ts
import fs4 from "node:fs/promises";
import path5 from "node:path";

// src/core/locks.ts
import fs3 from "node:fs/promises";
import path3 from "node:path";
var tails = /* @__PURE__ */ new Map();
var CASE_INSENSITIVE_PLATFORM2 = process.platform === "darwin" || process.platform === "win32";
async function lockKey(repo) {
  let key;
  try {
    key = await fs3.realpath(repo);
  } catch {
    key = path3.resolve(repo);
  }
  return CASE_INSENSITIVE_PLATFORM2 ? key.toLowerCase() : key;
}
async function withRepoLock(repo, fn) {
  const key = await lockKey(repo);
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => void 0,
    () => void 0
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return run;
}

// src/core/refs.ts
import path4 from "node:path";
var REF_FORBIDDEN = /[~^:?*[\\]/;
var MAX_MESSAGE_BYTES = 64 * 1024;
var MAX_PATHSPEC_BYTES = 4096;
function hasUnsafeWhitespace(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 32 || code === 127) return true;
  }
  return false;
}
function hasControlChar(value) {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}
function assertSafeRef(name, label = "ref") {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${label} name is required`);
  }
  if (name.startsWith("-")) {
    throw new Error(`unsafe ${label} name (leading '-'): ${name}`);
  }
  if (name.includes("..")) {
    throw new Error(`unsafe ${label} name ('..'): ${name}`);
  }
  if (name.includes("@{")) {
    throw new Error(`unsafe ${label} name ('@{'): ${name}`);
  }
  if (hasUnsafeWhitespace(name) || REF_FORBIDDEN.test(name)) {
    throw new Error(`unsafe ${label} name (forbidden character): ${name}`);
  }
  if (name === "@") {
    throw new Error(`unsafe ${label} name ('@'): ${name}`);
  }
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) {
    throw new Error(`unsafe ${label} name (slash placement): ${name}`);
  }
  if (name.endsWith(".") || name.split("/").some((part) => part.endsWith(".lock"))) {
    throw new Error(`unsafe ${label} name ('.' / '.lock' suffix): ${name}`);
  }
}
async function validateRefName(name) {
  try {
    assertSafeRef(name, "branch");
  } catch {
    return false;
  }
  const res = await git(["check-ref-format", "--branch", name], {
    cwd: process.cwd(),
    timeoutMs: 1e4,
    allowFail: true
  });
  return res.code === 0;
}
async function assertValidBranchName(name) {
  if (!await validateRefName(name)) {
    throw new Error(`invalid branch name: ${name}`);
  }
}
async function validateTagName(name) {
  try {
    assertSafeRef(name, "tag");
  } catch {
    return false;
  }
  const res = await git(["check-ref-format", `refs/tags/${name}`], {
    cwd: process.cwd(),
    timeoutMs: 1e4,
    allowFail: true
  });
  return res.code === 0;
}
async function assertValidTagName(name) {
  if (!await validateTagName(name)) {
    throw new Error(`invalid tag name: ${name}`);
  }
}
function sanitizePathspec(p) {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("path is required");
  }
  if (p.length > MAX_PATHSPEC_BYTES || Buffer.byteLength(p, "utf8") > MAX_PATHSPEC_BYTES) {
    throw new Error(`unsafe path (too long, max ${MAX_PATHSPEC_BYTES} bytes): ${p.slice(0, 64)}\u2026`);
  }
  if (p.includes("\0")) {
    throw new Error(`unsafe path (NUL byte): ${p}`);
  }
  if (p.startsWith("-")) {
    throw new Error(`unsafe path (leading '-'): ${p}`);
  }
  if (p.startsWith(":")) {
    throw new Error(`unsafe path (pathspec magic): ${p}`);
  }
  if (path4.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\")) {
    throw new Error(`unsafe path (absolute): ${p}`);
  }
  if (p.split(/[\\/]/).includes("..")) {
    throw new Error(`unsafe path (traversal): ${p}`);
  }
  return p;
}
function sanitizePathspecs(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("at least one path is required");
  }
  return paths.map(sanitizePathspec);
}
function assertMessage(message, label = "message") {
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  if (message.includes("\0")) {
    throw new Error(`${label} contains a NUL byte`);
  }
  if (message.length > MAX_MESSAGE_BYTES || Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    throw new Error(`${label} is too long (max ${MAX_MESSAGE_BYTES} bytes)`);
  }
}
function assertSafeSha(sha) {
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    throw new Error(`invalid object id: ${sha}`);
  }
}
var LOCAL_REMOTE_PATH = /^(?:[a-zA-Z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/;
var SCP_LIKE_REMOTE = /^(?:[A-Za-z0-9._~-]+@)?[A-Za-z0-9._-]+:/;
function assertSafeRemoteUrl(url, opts = {}) {
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("remote url is required");
  }
  if (url.length > 4096) {
    throw new Error("remote url is too long");
  }
  if (hasControlChar(url)) {
    throw new Error("remote url contains control characters");
  }
  if (url.startsWith("-")) {
    throw new Error(`unsafe remote url (leading '-'): ${url}`);
  }
  if (url.includes("::")) {
    throw new Error(`unsafe remote url (transport helper): ${url}`);
  }
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(url);
  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === "file") {
      if (opts.allowFileProtocol === true) return;
      throw new Error(`unsafe remote url (file:// is not allowed): ${url}`);
    }
    const allowed = /* @__PURE__ */ new Set(["http", "https", "ssh", "git"]);
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
function redactUrl(url) {
  return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/, "$1***@");
}

// src/core/query.ts
var MAX_DIFF_BYTES = 512 * 1024;
var DIFF_MAX_BUFFER = 64 * 1024 * 1024;
var BRANCH_FORMAT = [
  "%(refname)",
  "%(refname:short)",
  "%(HEAD)",
  "%(upstream:short)",
  "%(upstream:track)",
  "%(committerdate:iso-strict)",
  "%(objectname)",
  "%(symref)"
].join("%00");
function trackedCount(track, label) {
  const m = new RegExp(`${label} (\\d+)`).exec(track);
  return m ? Number(m[1]) : 0;
}
async function listBranches(repo) {
  const res = await git(
    ["for-each-ref", `--format=${BRANCH_FORMAT}`, "refs/heads", "refs/remotes"],
    { cwd: repo, timeoutMs: 2e4 }
  );
  const branches = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const [ref = "", name = "", head = "", upstream = "", track = "", date = "", sha = "", symref = ""] = line.split("\0");
    if (symref || name.includes(" -> ")) continue;
    branches.push({
      name,
      ref,
      remote: ref.startsWith("refs/remotes/"),
      current: head === "*",
      upstream: upstream || null,
      ahead: trackedCount(track, "ahead"),
      behind: trackedCount(track, "behind"),
      lastCommitAt: date,
      lastCommitSha: sha
    });
  }
  if (!branches.some((b) => b.current)) {
    const sym = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: repo,
      allowFail: true,
      timeoutMs: 1e4
    });
    const name = sym.stdout.trim();
    if (sym.code === 0 && name) {
      branches.unshift({
        name,
        ref: `refs/heads/${name}`,
        remote: false,
        current: true,
        upstream: null,
        ahead: 0,
        behind: 0,
        lastCommitAt: "",
        lastCommitSha: ""
      });
    }
  }
  return branches;
}
async function listWorktrees(repo) {
  const res = await git(["worktree", "list", "--porcelain"], { cwd: repo, timeoutMs: 2e4 });
  const out = [];
  let current = null;
  const flush = () => {
    if (current) {
      out.push(current);
      current = null;
    }
  };
  for (const raw of res.stdout.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      flush();
      continue;
    }
    const space = line.indexOf(" ");
    const key = space === -1 ? line : line.slice(0, space);
    const value = space === -1 ? "" : line.slice(space + 1);
    if (key === "worktree") {
      flush();
      current = {
        path: value,
        branch: null,
        head: "",
        detached: false,
        bare: false,
        locked: false,
        prunable: false
      };
      continue;
    }
    if (!current) continue;
    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = true;
        break;
      case "prunable":
        current.prunable = true;
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}
async function listRemotes(repo) {
  const res = await git(["remote"], { cwd: repo, timeoutMs: 2e4 });
  const names = res.stdout.split("\n").map((n) => n.trim()).filter(Boolean);
  return Promise.all(
    names.map(async (name) => {
      const fetchRes = await git(["remote", "get-url", name], {
        cwd: repo,
        allowFail: true,
        timeoutMs: 1e4
      });
      const pushRes = await git(["remote", "get-url", "--push", name], {
        cwd: repo,
        allowFail: true,
        timeoutMs: 1e4
      });
      const fetchUrl = fetchRes.code === 0 ? redactUrl(fetchRes.stdout.trim()) : "";
      const pushUrl = pushRes.code === 0 ? redactUrl(pushRes.stdout.trim()) : fetchUrl;
      return { name, fetchUrl, pushUrl };
    })
  );
}
var TAG_FORMAT = [
  "%(refname:short)",
  "%(objecttype)",
  "%(objectname)",
  "%(*objectname)",
  "%(creatordate:iso-strict)",
  "%(subject)"
].join("%00");
async function listTags(repo) {
  const res = await git(
    ["for-each-ref", "--sort=-creatordate", `--format=${TAG_FORMAT}`, "refs/tags"],
    { cwd: repo, timeoutMs: 2e4 }
  );
  const tags = [];
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const [name = "", type = "", objectSha = "", peeledSha = "", date = "", subject = ""] = line.split("\0");
    const annotated = type === "tag";
    const tag = {
      name,
      annotated,
      sha: annotated ? peeledSha || objectSha : objectSha
    };
    if (date) tag.date = date;
    if (annotated && subject) tag.message = subject;
    tags.push(tag);
  }
  return tags;
}
function parseStashList(out) {
  const entries = [];
  out.split("\n").filter(Boolean).forEach((line, index) => {
    const nul = line.indexOf("\0");
    const subject = nul === -1 ? line : line.slice(0, nul);
    const epoch = nul === -1 ? "" : line.slice(nul + 1);
    const m = /^(?:WIP on|On) ([^:]+):\s?(.*)$/.exec(subject);
    const seconds = Number(epoch);
    const entry = {
      index,
      name: `stash@{${index}}`,
      message: m ? m[2] : subject,
      date: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1e3).toISOString() : ""
    };
    if (m) entry.branch = m[1];
    entries.push(entry);
  });
  return entries;
}
async function listStashes(repo) {
  const res = await git(["stash", "list", "--format=%gs%x00%ct"], {
    cwd: repo,
    timeoutMs: 2e4
  });
  return parseStashList(res.stdout);
}
var LOG_FORMAT = "%H%x00%h%x00%P%x00%an%x00%ae%x00%aI%x00%D%x00%s%x00%b%x1e";
function shortRefName(ref, type) {
  switch (type) {
    case "branch":
      return ref.replace(/^refs\/heads\//, "");
    case "tag":
      return ref.replace(/^refs\/tags\//, "");
    case "remote":
      return ref.replace(/^refs\/remotes\//, "");
    default:
      return ref;
  }
}
function parseCommitRefs(decoration) {
  const refs = [];
  for (const raw of decoration.split(",")) {
    const part = raw.trim();
    if (!part) continue;
    if (part === "HEAD") {
      refs.push({ name: "HEAD", type: "head" });
      continue;
    }
    if (part.startsWith("HEAD -> ")) {
      const target = part.slice("HEAD -> ".length).trim();
      refs.push({ name: "HEAD", type: "head" });
      refs.push({ name: shortRefName(target, "branch"), type: "branch" });
      continue;
    }
    if (part.includes(" -> ")) {
      continue;
    }
    if (part.startsWith("tag: ")) {
      const target = part.slice("tag: ".length).trim();
      refs.push({ name: shortRefName(target, "tag"), type: "tag" });
      continue;
    }
    if (part.startsWith("refs/heads/")) {
      refs.push({ name: shortRefName(part, "branch"), type: "branch" });
      continue;
    }
    if (part.startsWith("refs/remotes/")) {
      refs.push({ name: shortRefName(part, "remote"), type: "remote" });
      continue;
    }
    if (part.startsWith("refs/tags/")) {
      refs.push({ name: shortRefName(part, "tag"), type: "tag" });
      continue;
    }
    if (part === "refs/stash" || part === "stash") {
      refs.push({ name: "stash", type: "stash" });
      continue;
    }
    refs.push({ name: part, type: "branch" });
  }
  return refs;
}
async function getLog(repo, opts = {}) {
  const maxCount = opts.maxCount ?? 200;
  const skip = opts.skip ?? 0;
  if (!Number.isInteger(maxCount) || maxCount <= 0) {
    throw new Error(`invalid maxCount: ${maxCount}`);
  }
  if (!Number.isInteger(skip) || skip < 0) {
    throw new Error(`invalid skip: ${skip}`);
  }
  const args = [
    "log",
    "--no-color",
    "--no-show-signature",
    "--decorate=full",
    `--max-count=${maxCount + 1}`,
    `--skip=${skip}`,
    `--format=${LOG_FORMAT}`
  ];
  if (opts.all !== false && opts.ref === void 0) args.push("--all");
  if (opts.query !== void 0) {
    if (opts.query.length === 0 || opts.query.includes("\0")) {
      throw new Error("invalid log query");
    }
    args.push(`--grep=${opts.query}`);
  }
  if (opts.ref !== void 0) {
    assertSafeRef(opts.ref, "revision");
    args.push("--end-of-options", opts.ref);
  }
  if (opts.path !== void 0) args.push("--", sanitizePathspec(opts.path));
  const res = await git(args, {
    cwd: repo,
    timeoutMs: 3e4,
    allowFail: true,
    maxBuffer: 32 * 1024 * 1024
  });
  if (res.code !== 0) {
    if (/does not have any commits yet|bad revision|unknown revision|ambiguous argument/i.test(res.stderr)) {
      return { commits: [], hasMore: false };
    }
    throw new GitError(args, res);
  }
  const commits = [];
  for (const chunk of res.stdout.split("")) {
    const record = chunk.startsWith("\n") ? chunk.slice(1) : chunk;
    if (!record.trim()) continue;
    const fields = record.split("\0");
    if (fields.length < 8) continue;
    const [sha = "", shortSha = "", parentList = "", author = "", authorEmail = "", date = "", decoration = "", subject = "", bodyRaw = ""] = fields;
    const commit2 = {
      sha,
      shortSha,
      parents: parentList ? parentList.split(" ").filter(Boolean) : [],
      author,
      authorEmail,
      date,
      subject,
      refs: parseCommitRefs(decoration)
    };
    const body = bodyRaw.replace(/\s+$/, "");
    if (body) commit2.body = body;
    commits.push(commit2);
  }
  const hasMore = commits.length > maxCount;
  return {
    commits: hasMore ? commits.slice(0, maxCount) : commits,
    hasMore
  };
}
function byteSlice(text, maxBytes) {
  const total = Buffer.byteLength(text, "utf8");
  if (total <= maxBytes) return { text, truncated: false };
  const buf = Buffer.from(text, "utf8");
  let end = Math.min(maxBytes, buf.length);
  while (end > 0 && (buf[end] & 192) === 128) end -= 1;
  return {
    text: `${buf.subarray(0, end).toString("utf8")}
\u2026 [truncated]`,
    truncated: true
  };
}
function assertDiffOptions(opts) {
  const context = opts.context ?? 3;
  if (!Number.isInteger(context) || context < 0 || context > 1e4) {
    throw new Error(`invalid diff context: ${context}`);
  }
  const maxBytes = opts.maxBytes ?? MAX_DIFF_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`invalid maxBytes: ${maxBytes}`);
  }
  if (opts.staged && (opts.ref !== void 0 || opts.ref2 !== void 0)) {
    throw new Error("staged diffs cannot be combined with ref/ref2");
  }
  if (opts.ref2 !== void 0 && opts.ref === void 0) {
    throw new Error("ref2 requires ref");
  }
  return { context, maxBytes };
}
function appendDiffTarget(args, opts) {
  if (opts.staged) {
    args.push("--cached");
  } else if (opts.ref !== void 0) {
    assertSafeRef(opts.ref, "revision");
    args.push("--end-of-options", opts.ref);
    if (opts.ref2 !== void 0) {
      assertSafeRef(opts.ref2, "revision");
      args.push(opts.ref2);
    }
  }
}
async function runDiff(repo, opts, paths, maxBytes) {
  const { context } = assertDiffOptions(opts);
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    `--unified=${context}`
  ];
  appendDiffTarget(args, opts);
  if (paths.length > 0) args.push("--", ...paths);
  const res = await git(args, {
    cwd: repo,
    timeoutMs: 3e4,
    maxBuffer: DIFF_MAX_BUFFER
  });
  const binary = /^Binary files .+ differ$/m.test(res.stdout) || res.stdout.includes("GIT binary patch");
  const sliced = byteSlice(res.stdout, maxBytes);
  return {
    path: "",
    hunks: sliced.text,
    binary,
    truncated: sliced.truncated
  };
}
async function getDiff(repo, opts = {}) {
  const { maxBytes } = assertDiffOptions(opts);
  const paths = opts.path !== void 0 ? [sanitizePathspec(opts.path)] : [];
  const result = await runDiff(repo, opts, paths, maxBytes);
  result.path = opts.path ?? "";
  return result;
}
async function getDiffForPaths(repo, paths, opts = {}) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("at least one path is required");
  }
  const safe = paths.map(sanitizePathspec);
  const { maxBytes } = assertDiffOptions(opts);
  const result = await runDiff(repo, opts, safe, maxBytes);
  result.path = "";
  return result;
}
async function findRenameSource(repo, opts, filePath) {
  const args = ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", "--no-textconv"];
  appendDiffTarget(args, opts);
  const res = await git(args, {
    cwd: repo,
    timeoutMs: 3e4,
    maxBuffer: 32 * 1024 * 1024
  });
  const tokens = res.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 2;
      if (newPath === filePath && oldPath && oldPath !== filePath) return oldPath;
    } else {
      i += 1;
    }
  }
  return void 0;
}
async function getFileDiff(repo, opts) {
  const { path: rawPath, ...rest } = opts;
  const filePath = sanitizePathspec(rawPath);
  const { maxBytes } = assertDiffOptions(opts);
  const canRename = opts.staged === true || opts.ref !== void 0;
  const oldPath = canRename ? await findRenameSource(repo, opts, filePath) : void 0;
  const paths = oldPath !== void 0 ? [sanitizePathspec(oldPath), filePath] : [filePath];
  const result = await runDiff(repo, rest, paths, maxBytes);
  result.path = filePath;
  if (oldPath !== void 0) result.oldPath = oldPath;
  return result;
}
async function listConflicted(repo) {
  const res = await git(["diff", "--name-only", "--diff-filter=U", "-z"], {
    cwd: repo,
    timeoutMs: 2e4
  });
  return res.stdout.split("\0").filter(Boolean);
}

// src/core/ops.ts
var LONG_TIMEOUT = 12e4;
var SHORT_TIMEOUT = 3e4;
async function runWrite(repo, args, opts = {}) {
  const res = await git(args, {
    cwd: repo,
    allowFail: true,
    timeoutMs: opts.timeoutMs ?? SHORT_TIMEOUT,
    ...opts.signal ? { signal: opts.signal } : {},
    ...opts.env ? { env: opts.env } : {}
  });
  const result = { ok: res.code === 0, code: res.code };
  const stdout = res.stdout.trim();
  const stderr = res.stderr.trim();
  if (stdout) result.stdout = stdout;
  if (stderr) result.stderr = stderr;
  if (res.timedOut) result.timedOut = true;
  if (res.signal !== void 0) result.signal = res.signal;
  if (!result.ok && opts.conflicts) {
    const conflicted = await listConflicted(repo).catch(() => []);
    if (conflicted.length > 0) result.conflicted = conflicted;
  }
  return result;
}
async function assertRepo(repo) {
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error("repo path is required");
  }
  const res = await git(["rev-parse", "--git-dir"], {
    cwd: repo,
    allowFail: true,
    timeoutMs: 1e4
  });
  if (res.code !== 0) throw new Error(`not a git repository: ${repo}`);
}
async function repoWrite(repo, fn) {
  return withRepoLock(repo, async () => {
    await assertRepo(repo);
    return fn();
  });
}
async function hasHead(repo) {
  const res = await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd: repo,
    allowFail: true,
    timeoutMs: 1e4
  });
  return res.code === 0;
}
async function stage(repo, paths) {
  const safe = sanitizePathspecs(paths);
  return repoWrite(repo, () => runWrite(repo, ["add", "-A", "--", ...safe]));
}
async function unstage(repo, paths) {
  const safe = sanitizePathspecs(paths);
  return repoWrite(repo, async () => {
    if (await hasHead(repo)) {
      return runWrite(repo, ["restore", "--staged", "--", ...safe]);
    }
    return runWrite(repo, ["rm", "--cached", "-r", "--", ...safe]);
  });
}
async function stageAll(repo) {
  return repoWrite(repo, () => runWrite(repo, ["add", "-A", "--", "."]));
}
async function unstageAll(repo) {
  return repoWrite(repo, async () => {
    if (await hasHead(repo)) {
      return runWrite(repo, ["restore", "--staged", "--", "."]);
    }
    return runWrite(repo, ["rm", "--cached", "-r", "--", "."]);
  });
}
function isUntracked(statusPaths, requested) {
  return statusPaths.some((p) => {
    const base = p.endsWith("/") ? p.slice(0, -1) : p;
    return requested === base || requested.startsWith(`${base}/`);
  });
}
function isWithin(root, target) {
  const rel = path5.relative(root, target);
  return rel === "" || !rel.startsWith(`..${path5.sep}`) && rel !== ".." && !path5.isAbsolute(rel);
}
async function resolveUntrackedTarget(repo, rel) {
  const repoReal = await fs4.realpath(repo);
  const abs = path5.resolve(repoReal, rel);
  const relPath = path5.relative(repoReal, abs);
  if (relPath !== "" && !isWithin(repoReal, abs)) {
    throw new Error(`refusing to delete outside the repository: ${rel}`);
  }
  let current = repoReal;
  for (const segment of relPath.split(path5.sep).filter(Boolean)) {
    current = path5.join(current, segment);
    let stat;
    try {
      stat = await fs4.lstat(current);
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to delete a path through a symlink: ${rel}`);
    }
  }
  const parentReal = await fs4.realpath(path5.dirname(abs));
  if (parentReal !== repoReal && !isWithin(repoReal, parentReal)) {
    throw new Error(`refusing to delete outside the repository: ${rel}`);
  }
  return abs;
}
async function discard(repo, paths, opts = {}) {
  const safe = sanitizePathspecs(paths);
  return repoWrite(repo, async () => {
    const status = await getStatus(repo);
    const untrackedPaths = status.untracked.map((u) => u.path);
    const untracked = safe.filter((p) => isUntracked(untrackedPaths, p));
    if (untracked.length > 0 && opts.deleteUntracked !== true) {
      throw new Error(
        `refusing to delete untracked path(s) without deleteUntracked: ${untracked.join(", ")}`
      );
    }
    const tracked = safe.filter((p) => !untracked.includes(p));
    let result = { ok: true, code: 0 };
    if (tracked.length > 0) {
      if (opts.staged && !await hasHead(repo)) {
        result = await runWrite(repo, ["rm", "--cached", "-r", "--", ...tracked]);
      } else {
        const args = ["restore"];
        if (opts.staged) args.push("--staged");
        args.push("--worktree", "--", ...tracked);
        result = await runWrite(repo, args);
      }
      if (!result.ok) return result;
    }
    if (untracked.length > 0) {
      try {
        for (const p of untracked) {
          const target = await resolveUntrackedTarget(repo, p);
          if (target === null) continue;
          try {
            await fs4.rm(target, { recursive: true, force: false });
          } catch (err) {
            if (err.code === "ENOENT") continue;
            throw err;
          }
        }
      } catch (err) {
        return {
          ok: false,
          code: 1,
          stderr: err instanceof Error ? err.message : String(err)
        };
      }
    }
    return result;
  });
}
async function commit(repo, opts) {
  assertMessage(opts.message);
  return repoWrite(repo, () => {
    const args = ["commit", "-m", opts.message];
    if (opts.amend) args.push("--amend");
    if (opts.signoff) args.push("--signoff");
    return runWrite(repo, args, { conflicts: true });
  });
}
async function createBranch(repo, opts) {
  return repoWrite(repo, async () => {
    await assertValidBranchName(opts.name);
    if (opts.startPoint !== void 0) assertSafeRef(opts.startPoint, "start point");
    const args = opts.checkout ? ["checkout", "-b", opts.name] : ["branch", opts.name];
    if (opts.startPoint !== void 0) args.push("--end-of-options", opts.startPoint);
    return runWrite(repo, args);
  });
}
async function checkoutBranch(repo, name) {
  return repoWrite(repo, async () => {
    await assertValidBranchName(name);
    return runWrite(repo, ["checkout", name]);
  });
}
async function renameBranch(repo, oldName, newName) {
  return repoWrite(repo, async () => {
    await assertValidBranchName(oldName);
    await assertValidBranchName(newName);
    return runWrite(repo, ["branch", "-m", oldName, newName]);
  });
}
async function deleteBranch(repo, name, opts = {}) {
  return repoWrite(repo, async () => {
    await assertValidBranchName(name);
    return runWrite(repo, ["branch", opts.force ? "-D" : "-d", name]);
  });
}
async function trackRemote(repo, remoteBranch, opts = {}) {
  return repoWrite(repo, async () => {
    assertSafeRef(remoteBranch, "remote branch");
    const slash = remoteBranch.indexOf("/");
    if (slash <= 0 || slash === remoteBranch.length - 1) {
      throw new Error(`invalid remote branch (expected <remote>/<branch>): ${remoteBranch}`);
    }
    const local = opts.localName ?? remoteBranch.slice(slash + 1);
    await assertValidBranchName(local);
    return runWrite(repo, ["checkout", "--track", "-b", local, "--end-of-options", remoteBranch]);
  });
}
async function setUpstream(repo, branch, upstream) {
  return repoWrite(repo, async () => {
    await assertValidBranchName(branch);
    if (upstream === null) {
      return runWrite(repo, ["branch", "--unset-upstream", "--end-of-options", branch]);
    }
    assertSafeRef(upstream, "upstream");
    return runWrite(repo, [
      "branch",
      `--set-upstream-to=${upstream}`,
      "--end-of-options",
      branch
    ]);
  });
}
async function fetch(repo, opts = {}) {
  return repoWrite(repo, () => {
    if (opts.all && opts.remote !== void 0) {
      throw new Error("remote cannot be combined with all");
    }
    const args = ["fetch"];
    if (opts.prune !== false) args.push("--prune");
    if (opts.all) {
      args.push("--all");
    } else if (opts.remote !== void 0) {
      assertSafeRef(opts.remote, "remote");
      args.push(opts.remote);
    }
    return runWrite(repo, args, {
      timeoutMs: LONG_TIMEOUT,
      ...opts.signal ? { signal: opts.signal } : {}
    });
  });
}
async function pull(repo, opts = {}) {
  return repoWrite(repo, () => {
    const mode = opts.mode ?? "ff";
    if (mode !== "ff" && mode !== "merge" && mode !== "rebase") {
      throw new Error(`invalid pull mode: ${String(mode)}`);
    }
    if (opts.branch !== void 0 && opts.remote === void 0) {
      throw new Error("pull branch requires a remote");
    }
    const args = ["pull"];
    if (mode === "ff") args.push("--ff-only");
    else if (mode === "merge") args.push("--no-rebase");
    else args.push("--rebase");
    if (opts.remote !== void 0) {
      assertSafeRef(opts.remote, "remote");
      args.push(opts.remote);
      if (opts.branch !== void 0) {
        assertSafeRef(opts.branch, "branch");
        args.push(opts.branch);
      }
    }
    return runWrite(repo, args, {
      timeoutMs: LONG_TIMEOUT,
      env: { GIT_EDITOR: "true" },
      conflicts: true,
      ...opts.signal ? { signal: opts.signal } : {}
    });
  });
}
async function push(repo, opts = {}) {
  return repoWrite(repo, () => {
    if (opts.branch !== void 0 && opts.remote === void 0) {
      throw new Error("push branch requires a remote");
    }
    const args = ["push"];
    if (opts.setUpstream) args.push("--set-upstream");
    if (opts.forceWithLease) args.push("--force-with-lease");
    if (opts.tags) args.push("--tags");
    if (opts.remote !== void 0) {
      assertSafeRef(opts.remote, "remote");
      args.push(opts.remote);
    }
    if (opts.branch !== void 0) {
      assertSafeRef(opts.branch, "branch");
      args.push(opts.branch);
    }
    return runWrite(repo, args, {
      timeoutMs: LONG_TIMEOUT,
      ...opts.signal ? { signal: opts.signal } : {}
    });
  });
}
async function merge(repo, branch, opts = {}) {
  return repoWrite(repo, () => {
    if (opts.abort) return runWrite(repo, ["merge", "--abort"], { conflicts: true });
    assertSafeRef(branch, "branch");
    const args = ["merge"];
    if (opts.noFf) args.push("--no-ff");
    if (opts.squash) args.push("--squash");
    args.push("--end-of-options", branch);
    return runWrite(repo, args, {
      env: { GIT_EDITOR: "true" },
      conflicts: true
    });
  });
}
async function rebase(repo, onto, opts = {}) {
  return repoWrite(repo, () => {
    const actions = [opts.abort, opts.continue, opts.skip].filter(Boolean).length;
    if (actions > 1) throw new Error("choose only one of abort/continue/skip");
    if (opts.abort) return runWrite(repo, ["rebase", "--abort"], { conflicts: true });
    if (opts.continue) {
      return runWrite(repo, ["rebase", "--continue"], {
        env: { GIT_EDITOR: "true" },
        conflicts: true
      });
    }
    if (opts.skip) return runWrite(repo, ["rebase", "--skip"], { conflicts: true });
    assertSafeRef(onto, "revision");
    return runWrite(repo, ["rebase", "--end-of-options", onto], {
      env: { GIT_EDITOR: "true" },
      conflicts: true
    });
  });
}
async function cherryPick(repo, shas, opts = {}) {
  return repoWrite(repo, () => {
    if (opts.abort && opts.continue) throw new Error("choose only one of abort/continue");
    if (opts.abort) return runWrite(repo, ["cherry-pick", "--abort"], { conflicts: true });
    if (opts.continue) {
      return runWrite(repo, ["cherry-pick", "--continue"], {
        env: { GIT_EDITOR: "true" },
        conflicts: true
      });
    }
    if (!Array.isArray(shas) || shas.length === 0) {
      throw new Error("at least one commit is required");
    }
    for (const sha of shas) assertSafeSha(sha);
    return runWrite(repo, ["cherry-pick", "--end-of-options", ...shas], { conflicts: true });
  });
}
async function revert(repo, shas, opts = {}) {
  return repoWrite(repo, () => {
    if (!Array.isArray(shas) || shas.length === 0) {
      throw new Error("at least one commit is required");
    }
    for (const sha of shas) assertSafeSha(sha);
    const args = ["revert", "--no-edit"];
    if (opts.noCommit) args.push("--no-commit");
    args.push("--end-of-options", ...shas);
    return runWrite(repo, args, { conflicts: true });
  });
}
function stashIndex(index) {
  const value = index ?? 0;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`invalid stash index: ${String(index)}`);
  }
  return value;
}
async function stash(repo, opts) {
  return repoWrite(repo, () => {
    switch (opts.action) {
      case "push": {
        const args = ["stash", "push"];
        if (opts.message !== void 0) {
          assertMessage(opts.message);
          args.push("-m", opts.message);
        }
        if (opts.includeUntracked) args.push("-u");
        if (opts.paths !== void 0 && opts.paths.length > 0) {
          args.push("--", ...sanitizePathspecs(opts.paths));
        } else if (opts.includeUntracked) {
          args.push("--", ".");
        }
        return runWrite(repo, args);
      }
      case "apply":
      case "pop":
        return runWrite(repo, ["stash", opts.action, `stash@{${stashIndex(opts.index)}}`], {
          conflicts: true
        });
      case "drop":
        return runWrite(repo, ["stash", "drop", `stash@{${stashIndex(opts.index)}}`]);
      case "show":
        return runWrite(repo, ["stash", "show", "-p", `stash@{${stashIndex(opts.index)}}`]);
      default:
        throw new Error(`unsupported stash action: ${String(opts.action)}`);
    }
  });
}
async function resolveWorktreePath(repo, input) {
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new Error("worktree path is required");
  }
  const repoReal = await fs4.realpath(repo);
  const parent = path5.dirname(repoReal);
  const target = path5.resolve(repoReal, input);
  const relToParent = path5.relative(parent, target);
  if (relToParent === "" || !isWithin(parent, target)) {
    throw new Error(`worktree path must be a directory under ${parent}: ${input}`);
  }
  if (isWithin(repoReal, target)) {
    throw new Error(`worktree path must be outside the repository: ${input}`);
  }
  if (relToParent.split(path5.sep).includes(".git")) {
    throw new Error(`worktree path must not point into a .git directory: ${input}`);
  }
  let probe = target;
  const missing = [];
  for (; ; ) {
    try {
      const realProbe = await fs4.realpath(probe);
      const realTarget = missing.length === 0 ? realProbe : path5.join(realProbe, ...missing);
      if (realTarget === parent || !isWithin(parent, realTarget)) {
        throw new Error(`worktree path escapes ${parent} through a symlink: ${input}`);
      }
      if (isWithin(repoReal, realTarget)) {
        throw new Error(`worktree path resolves inside the repository: ${input}`);
      }
      return realTarget;
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      const up = path5.dirname(probe);
      if (up === probe) {
        throw new Error(`cannot resolve worktree path: ${input}`);
      }
      missing.unshift(path5.basename(probe));
      probe = up;
    }
  }
}
async function worktreeAdd(repo, opts) {
  return repoWrite(repo, async () => {
    if (typeof opts.path !== "string" || opts.path.length === 0 || opts.path.includes("\0")) {
      throw new Error("worktree path is required");
    }
    if (opts.detached && opts.newBranch !== void 0) {
      throw new Error("detached worktree cannot create a new branch");
    }
    if (opts.newBranch !== void 0) await assertValidBranchName(opts.newBranch);
    if (opts.branch !== void 0) assertSafeRef(opts.branch, "branch");
    const target = await resolveWorktreePath(repo, opts.path);
    const args = ["worktree", "add"];
    if (opts.detached) args.push("--detach");
    if (opts.newBranch !== void 0) args.push("-b", opts.newBranch);
    args.push(target);
    if (opts.branch !== void 0) args.push(opts.branch);
    return runWrite(repo, args);
  });
}
async function worktreeRemove(repo, opts) {
  return repoWrite(repo, async () => {
    const target = await resolveWorktreePath(repo, opts.path);
    const args = ["worktree", "remove"];
    if (opts.force) args.push("--force");
    args.push(target);
    return runWrite(repo, args);
  });
}
async function createTag(repo, opts) {
  return repoWrite(repo, async () => {
    await assertValidTagName(opts.name);
    if (opts.message !== void 0) assertMessage(opts.message);
    if (opts.ref !== void 0) assertSafeRef(opts.ref, "revision");
    const annotated = opts.annotated === true || opts.message !== void 0;
    if (annotated && opts.message === void 0) {
      throw new Error("annotated tag requires a message");
    }
    const args = ["tag"];
    if (annotated) args.push("-a");
    if (opts.message !== void 0) args.push("-m", opts.message);
    args.push(opts.name);
    if (opts.ref !== void 0) args.push("--end-of-options", opts.ref);
    return runWrite(repo, args);
  });
}
async function deleteTag(repo, name) {
  return repoWrite(repo, async () => {
    await assertValidTagName(name);
    return runWrite(repo, ["tag", "-d", name]);
  });
}
function redactResult(result) {
  if (result.stdout) result.stdout = redactUrl(result.stdout);
  if (result.stderr) result.stderr = redactUrl(result.stderr);
  return result;
}
async function remoteAdd(repo, opts) {
  return repoWrite(repo, async () => {
    assertSafeRef(opts.name, "remote");
    assertSafeRemoteUrl(opts.url);
    return redactResult(await runWrite(repo, ["remote", "add", opts.name, opts.url]));
  });
}
async function remoteRemove(repo, name) {
  return repoWrite(repo, () => {
    assertSafeRef(name, "remote");
    return runWrite(repo, ["remote", "remove", name]);
  });
}

// src/sidecar-backend/routes.ts
var MAX_PATH_LEN = 4096;
var MAX_PATHS = 1e4;
var MAX_MESSAGE_LEN = 1e5;
var MAX_PROMPT_LEN = 2e4;
var RouteError = class extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = "RouteError";
    this.code = code;
  }
};
var ConfirmRequired = class extends Error {
  action;
  constructor(action) {
    super("confirm-required");
    this.name = "ConfirmRequired";
    this.action = action;
  }
};
function invalid(message) {
  throw new RouteError(message, "EINVAL");
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function reqString(data, key, maxLen = MAX_PATH_LEN) {
  const value = data[key];
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${key} must be a non-empty string`);
  }
  if (value.includes("\0")) invalid(`${key} contains a NUL byte`);
  if (value.length > maxLen) invalid(`${key} is too long`);
  return value;
}
function optString(data, key, maxLen = MAX_PATH_LEN) {
  const value = data[key];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "string") invalid(`${key} must be a string`);
  if (value.includes("\0")) invalid(`${key} contains a NUL byte`);
  if (value.length > maxLen) invalid(`${key} is too long`);
  return value;
}
function reqNullableString(data, key) {
  const value = data[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${key} must be a string or null`);
  }
  if (value.includes("\0") || value.length > MAX_PATH_LEN) invalid(`${key} is not a valid ref`);
  return value;
}
function optBool(data, key) {
  const value = data[key];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "boolean") invalid(`${key} must be a boolean`);
  return value;
}
function optInt(data, key, min, max) {
  const value = data[key];
  if (value === void 0 || value === null) return void 0;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}
function reqStringArray(data, key, opts = {}) {
  const value = data[key];
  if (!Array.isArray(value)) invalid(`${key} must be an array of strings`);
  const out = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      invalid(`${key} must contain non-empty strings`);
    }
    if (item.includes("\0")) invalid(`${key} contains a NUL byte`);
    if (item.length > MAX_PATH_LEN) invalid(`${key} entry is too long`);
    out.push(item);
  }
  if (out.length === 0 && opts.allowEmpty !== true) invalid(`${key} must not be empty`);
  if (out.length > MAX_PATHS) invalid(`${key} has too many entries`);
  return out;
}
function optStringArray(data, key) {
  if (data[key] === void 0 || data[key] === null) return void 0;
  return reqStringArray(data, key);
}
function reqEnum(data, key, allowed) {
  const value = data[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalid(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}
function optEnum(data, key, allowed) {
  if (data[key] === void 0 || data[key] === null) return void 0;
  return reqEnum(data, key, allowed);
}
function requireConfirmed(data, action) {
  if (data.confirmed !== true) throw new ConfirmRequired(action);
}
function coreCheck(fn) {
  try {
    fn();
  } catch (err) {
    invalid(err instanceof Error ? err.message : String(err));
  }
}
function checkRef(value, label) {
  if (value !== void 0) coreCheck(() => assertSafeRef(value, label));
}
function guarded(fn) {
  return async (raw) => {
    const body = isPlainObject(raw) ? raw : {};
    try {
      return await fn(body);
    } catch (err) {
      if (err instanceof ConfirmRequired) {
        return { error: "confirm-required", action: err.action };
      }
      if (err instanceof RouteError) {
        return { error: err.message, code: err.code };
      }
      return { error: err instanceof Error ? err.message : String(err), code: "GIT" };
    }
  };
}
async function requireRepo(registry2, body) {
  const input = reqString(body, "repo", MAX_PATH_LEN);
  const info = await registry2.resolveRepo(input);
  if (!info) throw new RouteError("repo is not registered", "ENOENT_REPO");
  return info.path;
}
function extractConversationId(result) {
  if (!isPlainObject(result)) return void 0;
  for (const key of ["conversationId", "conversation_id", "id"]) {
    const value = result[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return void 0;
}
function formatCommit(commit2) {
  if (!commit2) return "(no commits)";
  const lines = [
    `commit ${commit2.sha}`,
    `Author: ${commit2.author} <${commit2.authorEmail}>`,
    `Date: ${commit2.date}`,
    "",
    `    ${commit2.subject}`
  ];
  if (commit2.body) {
    lines.push("", ...commit2.body.split("\n").map((line) => `    ${line}`));
  }
  return lines.join("\n");
}
function registerApi(app2, deps) {
  const { registry: registry2 } = deps;
  const versionOf = deps.versionOf ?? (() => 0);
  app2.api(
    "/api/ping",
    guarded(async () => ({
      ok: true,
      ts: Date.now(),
      projectId: app2.config?.projectId ?? null
    })),
    "GET"
  );
  app2.api(
    "/api/context",
    guarded(async (body) => {
      const uris = reqStringArray(body, "workspaceUris", { allowEmpty: true });
      return registry2.setWorkspace(uris);
    })
  );
  app2.api(
    "/api/repos/list",
    guarded(async () => ({
      repos: await registry2.listRepos(),
      registered: registry2.registeredPaths()
    }))
  );
  app2.api(
    "/api/repos/add",
    guarded(async (body) => {
      const inputPath = reqString(body, "path");
      const info = await registry2.addRegistered(inputPath);
      if (!info) {
        throw new RouteError("not a git work tree", "EINVAL");
      }
      return info;
    })
  );
  app2.api(
    "/api/repos/remove",
    guarded(async (body) => {
      const inputPath = reqString(body, "path");
      const removed = await registry2.removeRegistered(inputPath);
      if (!removed) throw new RouteError("repo is not registered", "ENOENT_REPO");
      return { ok: true };
    })
  );
  app2.api(
    "/api/status",
    guarded(async (body) => getStatus(await requireRepo(registry2, body)))
  );
  app2.api(
    "/api/branches",
    guarded(async (body) => ({
      branches: await listBranches(await requireRepo(registry2, body))
    }))
  );
  app2.api(
    "/api/branch/create",
    guarded(async (body) => {
      const name = reqString(body, "name", 1024);
      coreCheck(() => assertSafeRef(name, "branch"));
      const startPoint = optString(body, "startPoint", 1024);
      checkRef(startPoint, "start point");
      const checkout = optBool(body, "checkout");
      const repo = await requireRepo(registry2, body);
      return createBranch(repo, {
        name,
        ...startPoint !== void 0 ? { startPoint } : {},
        ...checkout !== void 0 ? { checkout } : {}
      });
    })
  );
  app2.api(
    "/api/branch/checkout",
    guarded(async (body) => {
      const name = reqString(body, "name", 1024);
      coreCheck(() => assertSafeRef(name, "branch"));
      const repo = await requireRepo(registry2, body);
      return checkoutBranch(repo, name);
    })
  );
  app2.api(
    "/api/branch/rename",
    guarded(async (body) => {
      const oldName = reqString(body, "old", 1024);
      const newName = reqString(body, "new", 1024);
      coreCheck(() => assertSafeRef(oldName, "branch"));
      coreCheck(() => assertSafeRef(newName, "branch"));
      const repo = await requireRepo(registry2, body);
      return renameBranch(repo, oldName, newName);
    })
  );
  app2.api(
    "/api/branch/delete",
    guarded(async (body) => {
      const name = reqString(body, "name", 1024);
      coreCheck(() => assertSafeRef(name, "branch"));
      const force = optBool(body, "force");
      requireConfirmed(body, "/api/branch/delete");
      const repo = await requireRepo(registry2, body);
      return deleteBranch(repo, name, { ...force !== void 0 ? { force } : {} });
    })
  );
  app2.api(
    "/api/branch/set-upstream",
    guarded(async (body) => {
      const branch = reqString(body, "branch", 1024);
      coreCheck(() => assertSafeRef(branch, "branch"));
      const upstream = reqNullableString(body, "upstream");
      if (upstream !== null) coreCheck(() => assertSafeRef(upstream, "upstream"));
      const repo = await requireRepo(registry2, body);
      return setUpstream(repo, branch, upstream);
    })
  );
  app2.api(
    "/api/track-remote",
    guarded(async (body) => {
      const remoteBranch = reqString(body, "remoteBranch", 1024);
      coreCheck(() => assertSafeRef(remoteBranch, "remote branch"));
      const localName = optString(body, "localName", 1024);
      checkRef(localName, "branch");
      const repo = await requireRepo(registry2, body);
      return trackRemote(repo, remoteBranch, {
        ...localName !== void 0 ? { localName } : {}
      });
    })
  );
  app2.api(
    "/api/stage",
    guarded(async (body) => {
      const paths = reqStringArray(body, "paths");
      coreCheck(() => sanitizePathspecs(paths));
      const repo = await requireRepo(registry2, body);
      return stage(repo, paths);
    })
  );
  app2.api(
    "/api/unstage",
    guarded(async (body) => {
      const paths = reqStringArray(body, "paths");
      coreCheck(() => sanitizePathspecs(paths));
      const repo = await requireRepo(registry2, body);
      return unstage(repo, paths);
    })
  );
  app2.api(
    "/api/stage-all",
    guarded(async (body) => stageAll(await requireRepo(registry2, body)))
  );
  app2.api(
    "/api/unstage-all",
    guarded(async (body) => unstageAll(await requireRepo(registry2, body)))
  );
  app2.api(
    "/api/discard",
    guarded(async (body) => {
      const paths = reqStringArray(body, "paths");
      coreCheck(() => sanitizePathspecs(paths));
      const staged = optBool(body, "staged");
      const deleteUntracked = optBool(body, "deleteUntracked");
      requireConfirmed(body, "/api/discard");
      const repo = await requireRepo(registry2, body);
      return discard(repo, paths, {
        ...staged !== void 0 ? { staged } : {},
        ...deleteUntracked !== void 0 ? { deleteUntracked } : {}
      });
    })
  );
  app2.api(
    "/api/diff",
    guarded(async (body) => {
      const filePath = optString(body, "path");
      if (filePath !== void 0) coreCheck(() => sanitizePathspec(filePath));
      const staged = optBool(body, "staged");
      const ref = optString(body, "ref", 1024);
      const ref2 = optString(body, "ref2", 1024);
      checkRef(ref, "revision");
      checkRef(ref2, "revision");
      if (ref2 !== void 0 && ref === void 0) invalid("ref2 requires ref");
      if (staged === true && (ref !== void 0 || ref2 !== void 0)) {
        invalid("staged cannot be combined with ref/ref2");
      }
      const context = optInt(body, "context", 0, 1e4);
      const maxBytes = optInt(body, "maxBytes", 1, 64 * 1024 * 1024);
      const repo = await requireRepo(registry2, body);
      const opts = {
        ...staged !== void 0 ? { staged } : {},
        ...ref !== void 0 ? { ref } : {},
        ...ref2 !== void 0 ? { ref2 } : {},
        ...context !== void 0 ? { context } : {},
        ...maxBytes !== void 0 ? { maxBytes } : {}
      };
      if (filePath !== void 0) {
        return getFileDiff(repo, { ...opts, path: filePath });
      }
      return getDiff(repo, opts);
    })
  );
  app2.api(
    "/api/commit",
    guarded(async (body) => {
      const message = reqString(body, "message", MAX_MESSAGE_LEN);
      coreCheck(() => assertMessage(message));
      const amend = optBool(body, "amend");
      const signoff = optBool(body, "signoff");
      const repo = await requireRepo(registry2, body);
      return commit(repo, {
        message,
        ...amend !== void 0 ? { amend } : {},
        ...signoff !== void 0 ? { signoff } : {}
      });
    })
  );
  app2.api(
    "/api/fetch",
    guarded(async (body) => {
      const remote = optString(body, "remote", 1024);
      checkRef(remote, "remote");
      const all = optBool(body, "all");
      const prune = optBool(body, "prune");
      if (all === true && remote !== void 0) invalid("remote cannot be combined with all");
      const repo = await requireRepo(registry2, body);
      return fetch(repo, {
        ...remote !== void 0 ? { remote } : {},
        ...all !== void 0 ? { all } : {},
        ...prune !== void 0 ? { prune } : {}
      });
    })
  );
  app2.api(
    "/api/pull",
    guarded(async (body) => {
      const mode = optEnum(body, "mode", ["ff", "merge", "rebase"]) ?? "ff";
      const repo = await requireRepo(registry2, body);
      return pull(repo, { mode });
    })
  );
  app2.api(
    "/api/push",
    guarded(async (body) => {
      const remote = optString(body, "remote", 1024);
      const branch = optString(body, "branch", 1024);
      checkRef(remote, "remote");
      checkRef(branch, "branch");
      const setUpstream2 = optBool(body, "setUpstream");
      const forceWithLease = optBool(body, "forceWithLease");
      if (forceWithLease === true) requireConfirmed(body, "/api/push");
      const repo = await requireRepo(registry2, body);
      return push(repo, {
        ...remote !== void 0 ? { remote } : {},
        ...branch !== void 0 ? { branch } : {},
        ...setUpstream2 !== void 0 ? { setUpstream: setUpstream2 } : {},
        ...forceWithLease !== void 0 ? { forceWithLease } : {}
      });
    })
  );
  app2.api(
    "/api/log",
    guarded(async (body) => {
      const skip = optInt(body, "skip", 0, 1e9);
      const maxCount = optInt(body, "maxCount", 1, 1e4);
      const path8 = optString(body, "path");
      if (path8 !== void 0) coreCheck(() => sanitizePathspec(path8));
      const textQuery = optString(body, "query", 1024);
      if (textQuery !== void 0 && textQuery.length === 0) invalid("query must not be empty");
      const repo = await requireRepo(registry2, body);
      return getLog(repo, {
        ...skip !== void 0 ? { skip } : {},
        ...maxCount !== void 0 ? { maxCount } : {},
        ...path8 !== void 0 ? { path: path8 } : {},
        ...textQuery !== void 0 ? { query: textQuery } : {}
      });
    })
  );
  app2.api(
    "/api/conflicts",
    guarded(async (body) => {
      const repo = await requireRepo(registry2, body);
      const [files, operation] = await Promise.all([
        listConflicted(repo),
        detectOperation(repo)
      ]);
      return { files, operation };
    })
  );
  app2.api(
    "/api/merge",
    guarded(async (body) => {
      const action = optEnum(body, "action", ["start", "abort"]) ?? "start";
      const branch = optString(body, "branch", 1024);
      if (branch !== void 0) coreCheck(() => assertSafeRef(branch, "branch"));
      const noFf = optBool(body, "noFf");
      const squash = optBool(body, "squash");
      const repo = await requireRepo(registry2, body);
      if (action === "abort") return merge(repo, branch ?? "", { abort: true });
      if (branch === void 0) invalid("branch is required to start a merge");
      return merge(repo, branch, {
        ...noFf !== void 0 ? { noFf } : {},
        ...squash !== void 0 ? { squash } : {}
      });
    })
  );
  app2.api(
    "/api/rebase",
    guarded(async (body) => {
      const onto = optString(body, "onto", 1024);
      checkRef(onto, "revision");
      const action = optEnum(body, "action", ["start", "abort", "continue", "skip"]) ?? "start";
      if (action === "start" && onto === void 0) invalid("onto is required to start a rebase");
      const repo = await requireRepo(registry2, body);
      const options = action === "abort" ? { abort: true } : action === "continue" ? { continue: true } : action === "skip" ? { skip: true } : {};
      return rebase(repo, onto ?? "", options);
    })
  );
  app2.api(
    "/api/cherry-pick",
    guarded(async (body) => {
      const action = optEnum(body, "action", ["start", "abort", "continue"]) ?? "start";
      const shas = optStringArray(body, "shas") ?? [];
      for (const sha of shas) coreCheck(() => assertSafeSha(sha));
      if (action === "start" && shas.length === 0) invalid("shas is required to start a cherry-pick");
      const repo = await requireRepo(registry2, body);
      const options = action === "abort" ? { abort: true } : action === "continue" ? { continue: true } : {};
      return cherryPick(repo, shas, options);
    })
  );
  app2.api(
    "/api/revert",
    guarded(async (body) => {
      const shas = reqStringArray(body, "shas");
      for (const sha of shas) coreCheck(() => assertSafeSha(sha));
      const noCommit = optBool(body, "noCommit");
      const repo = await requireRepo(registry2, body);
      return revert(repo, shas, { ...noCommit !== void 0 ? { noCommit } : {} });
    })
  );
  app2.api(
    "/api/stash",
    guarded(async (body) => {
      const action = reqEnum(body, "action", ["push", "apply", "pop", "drop", "show"]);
      const message = optString(body, "message", MAX_MESSAGE_LEN);
      if (message !== void 0) coreCheck(() => assertMessage(message));
      const includeUntracked = optBool(body, "includeUntracked");
      const index = optInt(body, "index", 0, 1e6);
      if (action === "drop") requireConfirmed(body, "/api/stash");
      const repo = await requireRepo(registry2, body);
      if (action === "push") {
        return stash(repo, {
          action: "push",
          ...message !== void 0 ? { message } : {},
          ...includeUntracked !== void 0 ? { includeUntracked } : {}
        });
      }
      if (action === "show") {
        const result = await stash(repo, {
          action: "show",
          ...index !== void 0 ? { index } : {}
        });
        if (!result.ok) return result;
        return { entries: await listStashes(repo), text: result.stdout ?? "" };
      }
      return stash(repo, {
        action,
        ...index !== void 0 ? { index } : {}
      });
    })
  );
  app2.api(
    "/api/stashes",
    guarded(async (body) => ({
      entries: await listStashes(await requireRepo(registry2, body))
    }))
  );
  app2.api(
    "/api/worktrees",
    guarded(async (body) => ({
      worktrees: await listWorktrees(await requireRepo(registry2, body))
    }))
  );
  app2.api(
    "/api/worktree/add",
    guarded(async (body) => {
      const worktreePath = reqString(body, "path");
      const branch = optString(body, "branch", 1024);
      const newBranch = optString(body, "newBranch", 1024);
      checkRef(branch, "branch");
      checkRef(newBranch, "branch");
      const detached = optBool(body, "detached");
      const repo = await requireRepo(registry2, body);
      return worktreeAdd(repo, {
        path: worktreePath,
        ...branch !== void 0 ? { branch } : {},
        ...newBranch !== void 0 ? { newBranch } : {},
        ...detached !== void 0 ? { detached } : {}
      });
    })
  );
  app2.api(
    "/api/worktree/remove",
    guarded(async (body) => {
      const worktreePath = reqString(body, "path");
      const force = optBool(body, "force");
      requireConfirmed(body, "/api/worktree/remove");
      const repo = await requireRepo(registry2, body);
      return worktreeRemove(repo, {
        path: worktreePath,
        ...force !== void 0 ? { force } : {}
      });
    })
  );
  app2.api(
    "/api/remotes",
    guarded(async (body) => ({
      remotes: await listRemotes(await requireRepo(registry2, body))
    }))
  );
  app2.api(
    "/api/remote/add",
    guarded(async (body) => {
      const name = reqString(body, "name", 1024);
      const url = reqString(body, "url", 4096);
      coreCheck(() => assertSafeRef(name, "remote"));
      coreCheck(() => assertSafeRemoteUrl(url));
      const repo = await requireRepo(registry2, body);
      return remoteAdd(repo, { name, url });
    })
  );
  app2.api(
    "/api/remote/remove",
    guarded(async (body) => {
      const name = reqString(body, "name", 1024);
      coreCheck(() => assertSafeRef(name, "remote"));
      requireConfirmed(body, "/api/remote/remove");
      const repo = await requireRepo(registry2, body);
      return remoteRemove(repo, name);
    })
  );
  app2.api(
    "/api/tags",
    guarded(async (body) => ({
      tags: await listTags(await requireRepo(registry2, body))
    }))
  );
  app2.api(
    "/api/tag/create",
    guarded(async (body) => {
      const name = reqString(body, "name", 1024);
      coreCheck(() => assertSafeRef(name, "tag"));
      const ref = optString(body, "ref", 1024);
      checkRef(ref, "revision");
      const message = optString(body, "message", MAX_MESSAGE_LEN);
      if (message !== void 0) coreCheck(() => assertMessage(message));
      const annotated = optBool(body, "annotated");
      if (annotated === true && message === void 0) {
        invalid("annotated tag requires a message");
      }
      const repo = await requireRepo(registry2, body);
      return createTag(repo, {
        name,
        ...ref !== void 0 ? { ref } : {},
        ...message !== void 0 ? { message } : {},
        ...annotated !== void 0 ? { annotated } : {}
      });
    })
  );
  app2.api(
    "/api/tag/delete",
    guarded(async (body) => {
      const name = reqString(body, "name", 1024);
      coreCheck(() => assertSafeRef(name, "tag"));
      requireConfirmed(body, "/api/tag/delete");
      const repo = await requireRepo(registry2, body);
      return deleteTag(repo, name);
    })
  );
  app2.api(
    "/api/ai/send-to-conversation",
    guarded(async (body) => {
      const kind = reqEnum(body, "kind", ["diff", "commit"]);
      const ref = optString(body, "ref", 1024);
      checkRef(ref, "revision");
      const paths = optStringArray(body, "paths");
      if (paths !== void 0) coreCheck(() => sanitizePathspecs(paths));
      if (kind === "commit" && paths !== void 0) invalid("paths only applies to kind=diff");
      const staged = optBool(body, "staged");
      if (kind === "commit" && staged !== void 0) invalid("staged only applies to kind=diff");
      const prompt = optString(body, "prompt", MAX_PROMPT_LEN);
      const repo = await requireRepo(registry2, body);
      const agent = deps.agent;
      if (!agent) throw new RouteError("agent API is unavailable", "EAGENT");
      const diffOpts = {
        ...ref !== void 0 ? { ref } : {},
        ...staged !== void 0 ? { staged } : {}
      };
      let content;
      if (kind === "diff") {
        const diff = paths ? await getDiffForPaths(repo, paths, diffOpts) : await getDiff(repo, diffOpts);
        content = diff.hunks.trim() ? `\`\`\`diff
${diff.hunks.trimEnd()}
\`\`\`` : "(no changes)";
      } else {
        const page = await getLog(repo, {
          maxCount: 1,
          all: false,
          ...ref !== void 0 ? { ref } : {}
        });
        content = formatCommit(page.commits[0]);
      }
      const message = prompt !== void 0 ? `${prompt.trim()}

${content}` : content;
      let result;
      try {
        result = await agent.startConversation(message, {
          ...agent.projectId !== void 0 ? { projectId: agent.projectId } : {}
        });
      } catch (err) {
        throw new RouteError(
          `agent API failed: ${err instanceof Error ? err.message : String(err)}`,
          "EAGENT"
        );
      }
      const conversationId = extractConversationId(result);
      return conversationId !== void 0 ? { conversationId } : {};
    })
  );
  app2.api(
    "/api/version",
    guarded(async (body) => {
      const repo = await requireRepo(registry2, body);
      return { v: versionOf(repo) };
    })
  );
  app2.api(
    "/api/prefs",
    guarded(async () => ({ prefs: registry2.getPrefs() })),
    "GET"
  );
  app2.api(
    "/api/prefs",
    guarded(async (body) => {
      if (body.prefs !== void 0) {
        if (!isPlainObject(body.prefs)) invalid("prefs must be an object");
        const bytes = Buffer.byteLength(JSON.stringify(body.prefs), "utf8");
        if (bytes > MAX_PREFS_BYTES) {
          invalid(`prefs exceed the ${MAX_PREFS_BYTES}-byte limit`);
        }
        await registry2.setPrefs(body.prefs);
      }
      return { ok: true, prefs: registry2.getPrefs() };
    })
  );
}

// src/sidecar-backend/watch.ts
import fs5 from "node:fs";
import path6 from "node:path";
function resolveGitDir(repo) {
  const dotGit = path6.join(repo, ".git");
  try {
    const stat = fs5.statSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    const content = fs5.readFileSync(dotGit, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/m.exec(content);
    if (match?.[1]) return path6.resolve(repo, match[1].trim());
  } catch {
  }
  return null;
}
var RepoWatcher = class {
  debounceMs;
  #entries = /* @__PURE__ */ new Map();
  #onVersion;
  #closed = false;
  constructor(opts = {}) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.#onVersion = opts.onVersion;
  }
  /** Reconcile the watched set with `repos`: open new, close removed. */
  sync(repos) {
    if (this.#closed) return;
    const next = new Set(repos.map((repo) => path6.resolve(repo)));
    for (const repo of [...this.#entries.keys()]) {
      if (!next.has(repo)) this.#closeEntry(repo);
    }
    for (const repo of next) {
      if (!this.#entries.has(repo)) this.#open(repo);
    }
  }
  version(repo) {
    return this.#entries.get(path6.resolve(repo))?.version ?? 0;
  }
  lastChangeAt(repo) {
    return this.#entries.get(path6.resolve(repo))?.lastChangeAt ?? null;
  }
  state(repo) {
    const entry = this.#entries.get(path6.resolve(repo));
    if (!entry) return { watched: false, version: 0, lastChangeAt: null };
    return { watched: true, version: entry.version, lastChangeAt: entry.lastChangeAt };
  }
  get watchedCount() {
    return this.#entries.size;
  }
  /** Close every watcher (repo removed / process exit). */
  closeAll() {
    for (const repo of [...this.#entries.keys()]) this.#closeEntry(repo);
    this.#closed = true;
  }
  #open(repo) {
    const entry = { version: 0, lastChangeAt: null, timer: null, closers: [] };
    this.#entries.set(repo, entry);
    const bump = () => {
      entry.lastChangeAt = Date.now();
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.version += 1;
        try {
          this.#onVersion?.(repo, entry.version, entry.lastChangeAt ?? Date.now());
        } catch (err) {
          console.warn("[git-controls] watcher callback failed:", err);
        }
      }, this.debounceMs);
      entry.timer.unref();
    };
    const attach = (target, options) => {
      try {
        const watcher2 = fs5.watch(target, options, bump);
        watcher2.on("error", (err) => {
          console.warn(`[git-controls] watch error for ${repo}:`, err);
          this.#closeEntry(repo);
        });
        entry.closers.push(() => {
          try {
            watcher2.close();
          } catch {
          }
        });
        return true;
      } catch {
        return false;
      }
    };
    if (attach(repo, { recursive: true })) return;
    const gitDir = resolveGitDir(repo);
    const targets = gitDir ? [
      path6.join(gitDir, "index"),
      path6.join(gitDir, "HEAD"),
      path6.join(gitDir, "refs"),
      path6.join(gitDir, "refs", "heads")
    ] : [];
    let any = false;
    for (const target of targets) {
      if (!fs5.existsSync(target)) continue;
      if (attach(target, {})) any = true;
    }
    if (!any) {
      this.#entries.delete(repo);
      console.warn(`[git-controls] cannot watch ${repo}; version stays 0`);
    }
  }
  #closeEntry(repo) {
    const entry = this.#entries.get(repo);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    for (const close of entry.closers) {
      try {
        close();
      } catch {
      }
    }
    this.#entries.delete(repo);
  }
};

// src/sidecar-backend/main.ts
var __dirname = path7.dirname(fileURLToPath2(import.meta.url));
var UI_FILE = path7.join(__dirname, "ui", "index.html");
var DEBOUNCE_MS = 500;
function log(...args) {
  console.log("[git-controls]", ...args);
}
process.on("uncaughtException", (err) => {
  console.error("[git-controls] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[git-controls] unhandledRejection:", reason);
});
var app = new SidecarApp();
var dataDir = process.env.PLUGIN_DATA ?? path7.join(os.tmpdir(), "agy-git-controls-data");
if (!process.env.PLUGIN_DATA) {
  log(`PLUGIN_DATA is not set; using temporary state dir ${dataDir}`);
}
var registry = new RepoRegistry({ dataDir });
await registry.load();
var watcher = new RepoWatcher({ debounceMs: DEBOUNCE_MS });
var syncChain = Promise.resolve();
function syncWatchers() {
  syncChain = syncChain.then(async () => {
    const repos = await registry.listRepos();
    watcher.sync(repos.map((repo) => repo.path));
  }).catch((err) => {
    console.warn("[git-controls] watcher sync failed:", err);
  });
  return syncChain;
}
registry.subscribe(() => {
  void syncWatchers();
});
await syncWatchers();
app.page("/", () => {
  if (!fs6.existsSync(UI_FILE)) {
    return new Response("UI not built \u2014 run pnpm build", { status: 500 });
  }
  return new Response(fs6.readFileSync(UI_FILE, "utf-8"), { contentType: "text/html" });
});
registerApi(app, {
  registry,
  versionOf: (repo) => watcher.version(repo),
  agent: {
    startConversation: (message, opts) => app.startConversation(message, opts),
    ...app.config.projectId !== void 0 ? { projectId: app.config.projectId } : {}
  }
});
process.once("exit", () => {
  watcher.closeAll();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log(`received ${signal}; shutting down`);
    watcher.closeAll();
    void app.close().finally(() => process.exit(0));
  });
}
try {
  await app.run();
  log(`ready (${watcher.watchedCount} repo watcher(s), data dir ${dataDir})`);
} catch (err) {
  console.error("[git-controls] failed to start:", err);
  watcher.closeAll();
  process.exitCode = 1;
}
