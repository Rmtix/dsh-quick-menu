/**
 * dsh-quick-menu 鈥?host half.
 *
 * Owns the three caption-dropdown actions that cannot be done from the page:
 *
 *  - `GET  /dsh-quick-menu/web-url`  the authenticated Web GUI URL (same trick
 *    as harness-webui, so the Desktop's forwarded origin and Host-issued
 *    session cookie decide who may read it).
 *  - `GET  /dsh-quick-menu/diagnose` a read-only report of the profile's
 *    package-lock state: the recorded plugin-operation run (`run.json`), the
 *    interrupted-update journal, and stray temp files.
 *  - `POST /dsh-quick-menu/repair`   clear the three conditions that make the
 *    plugin manager answer `another plugin operation is running` (exit 127)
 *    forever: a Windows-reused pid in `run.json`, a `step: removing` record in
 *    `.dsh-market/pending-updates.json`, and leftover lock/temp files.
 *  - `POST /dsh-quick-menu/restart`  relaunch the exact DSH invocation that
 *    booted this host, through a detached helper, and SIGTERM this process.
 *
 * Every mutating route is same-origin only and every file it touches lives
 * under the profile directory `profileContext.dir` reports.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Cordis function-plugin name. */
export const name = 'dsh-quick-menu';

/** The HTTP carrier plus the trust fence guarding it. */
export const inject = ['webServer', 'connection'];

/** Route answering with the authenticated Web GUI URL. */
const WEB_URL_PATH = '/dsh-quick-menu/web-url';
/** Route reporting the profile's lock state. */
const DIAGNOSE_PATH = '/dsh-quick-menu/diagnose';
/** Route clearing the profile's lock state. */
const REPAIR_PATH = '/dsh-quick-menu/repair';
/** Route relaunching this host. */
const RESTART_PATH = '/dsh-quick-menu/restart';
/** Route re-publishing this plugin's bundles in place. */
const RELOAD_PATH = '/dsh-quick-menu/reload';

/** Name of the per-profile plugin-operation record. */
const RUN_FILE = 'run.json';
/** Market's interrupted-update journal, relative to the profile. */
const PENDING_UPDATES = join('.dsh-market', 'pending-updates.json');
/** Market's own event log, relative to the profile. */
const MARKET_LOG = join('.dsh-market', 'log.ndjson');
/** Files that hold a profile write lock while an operation runs. */
const LOCK_FILES = ['package.json.lock', 'pnpm-lock.yaml.lock', '.dsh-market.lock'];
/** Temp siblings pnpm leaves behind when a run is killed. */
const TEMP_FILE = /^(?:package\.json\.lock|pnpm-lock\.yaml\.[0-9a-f]{12}\.tmp|\.pnpm-store\.tmp)$/u;

/** Marker the client half posts so an email-style cross-site form cannot fake it. */
const ORIGIN_HEADER = 'x-dsh-quick-menu';

/**
 * Answer one request with a small JSON body.
 * @param res - response to own.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * Whether two `stat`-able files are the same bytes.
 * @param left - first path.
 * @param right - second path.
 * @returns true when both exist and hold identical bytes.
 */
function sameFile(left, right) {
  try {
    return readFileSync(left).equals(readFileSync(right));
  } catch {
    return false;
  }
}

/**
 * Whether `dir` already holds an installed copy of this plugin.
 *
 * pnpm never links a `file:` dependency back over its own source, so the
 * profile copy is a real copy; editing this plugin then needs one re-install
 * to take effect, and the diagnose route reports exactly that.
 * @param selfRoot - this plugin's package directory.
 * @param profileDir - the profile directory.
 * @param packageName - this plugin's package name.
 * @returns true when the installed copy differs from the source.
 */
function installedCopyStale(selfRoot, profileDir, packageName) {
  const installed = join(profileDir, 'node_modules', packageName);
  for (const file of ['package.json', 'lib/index.js', 'client/client.js']) {
    if (!sameFile(join(selfRoot, file), join(installed, file))) return true;
  }
  return false;
}
/**
 * Content digest of the installed copy, so the client can prove it is running
 * the same bytes the Host would serve.
 * @param profileDir - the profile directory.
 * @param packageName - this plugin's package name.
 * @returns a short hex digest, or the empty string when the copy is absent.
 */
function installDigest(profileDir, packageName) {
  const installed = join(profileDir, 'node_modules', packageName);
  const hash = createHash('sha256');
  for (const file of ['package.json', 'lib/index.js', 'client/client.js']) {
    try {
      hash.update(readFileSync(join(installed, file)));
    } catch {
      return '';
    }
  }
  return hash.digest('hex').slice(0, 16);
}
/**
 * Read the profile's plugin-operation record.
 * @param profileDir - the profile directory.
 * @returns the parsed record plus its path, or null when absent/unreadable.
 */
function readRun(profileDir) {
  const path = join(profileDir, '.plugin-manager', RUN_FILE);
  if (!existsSync(path)) return null;
  let record = null;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    record = null;
  }
  const pid = typeof record?.pid === 'number' ? record.pid : null;
  return { path, pid, alive: pid === null ? null : processAlive(pid) };
}

/**
 * Whether a pid still names a live process (Windows reuses pids, so a record
 * whose pid now belongs to an unrelated program is the classic false lock).
 * @param pid - process id.
 * @returns true when `kill(pid, 0)` reports the process as present.
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * Read the market's interrupted-update journal.
 * @param profileDir - the profile directory.
 * @returns the parsed journal plus its path, or null when absent/unreadable.
 */
function readPendingUpdates(profileDir) {
  const path = join(profileDir, PENDING_UPDATES);
  if (!existsSync(path)) return null;
  let journal = null;
  try {
    journal = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    journal = null;
  }
  const operations = Array.isArray(journal?.operations) ? journal.operations : [];
  return {
    path,
    operations: operations.map((operation) => ({
      name: typeof operation?.name === 'string' ? operation.name : '?',
      from: typeof operation?.from === 'string' ? operation.from : '',
      to: typeof operation?.to === 'string' ? operation.to : '',
      step: typeof operation?.step === 'string' ? operation.step : '',
      attempts: typeof operation?.attempts === 'number' ? operation.attempts : 0,
    })),
  };
}

/**
 * List stray lock and temp files under the profile root.
 * @param profileDir - the profile directory.
 * @returns absolute paths of files a killed operation left behind.
 */
function strayFiles(profileDir) {
  const found = [];
  for (const name of LOCK_FILES) {
    const path = join(profileDir, name);
    if (existsSync(path)) found.push(path);
  }
  try {
    for (const name of readdirSync(profileDir)) {
      if (TEMP_FILE.test(name)) found.push(join(profileDir, name));
    }
  } catch {
    /* unreadable profile: nothing to list */
  }
  return found;
}

/**
 * Tail of the market's event log, newest last.
 * @param profileDir - the profile directory.
 * @param limit - how many trailing events to return.
 * @returns recent events, or an empty list when the log is absent.
 */
function recentMarketEvents(profileDir, limit = 6) {
  const path = join(profileDir, MARKET_LOG);
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit).map((line) => {
      try {
        const event = JSON.parse(line);
        return { at: event.at ?? '', level: event.level ?? '', event: event.event ?? '', detail: String(event.detail ?? '').slice(0, 240) };
      } catch {
        return { at: '', level: '', event: 'raw', detail: line.slice(0, 240) };
      }
    });
  } catch {
    return [];
  }
}

/**
 * Build the full lock report for one profile.
 * @param profileDir - the profile directory.
 * @param selfRoot - this plugin's own package directory.
 * @param packageName - this plugin's package name.
 * @returns the report the client half renders.
 */
function diagnose(profileDir, selfRoot, packageName) {
  const run = readRun(profileDir);
  const pending = readPendingUpdates(profileDir);
  const strays = strayFiles(profileDir);
  return {
    profileDir,
    profileName: profileDir.split(/[\\/]/u).pop() ?? '',
    run: run === null ? { present: false } : { present: true, pid: run.pid, alive: run.alive, path: run.path },
    pending: pending === null
      ? { present: false }
      : { present: true, path: pending.path, operations: pending.operations },
    strays,
    busy: (run !== null && run.alive === true) || strays.length > 0 || (pending?.operations.length ?? 0) > 0,
    staleInstall: installedCopyStale(selfRoot, profileDir, packageName),
    installVersion: installDigest(profileDir, packageName),
    node: process.version,
    recent: recentMarketEvents(profileDir),
  };
}

/**
 * Clear everything that pins the plugin manager to "another operation is
 * running": the recorded run, the interrupted-update journal, and strays.
 * @param profileDir - the profile directory.
 * @returns what was removed.
 */
async function repair(profileDir) {
  const removed = [];
  const runPath = join(profileDir, '.plugin-manager', RUN_FILE);
  if (existsSync(runPath)) {
    await rm(runPath, { force: true });
    removed.push(runPath);
  }
  const pendingPath = join(profileDir, PENDING_UPDATES);
  const pending = readPendingUpdates(profileDir);
  if (pending !== null && pending.operations.length > 0) {
    writeFileSync(pendingPath, `${JSON.stringify({ version: 1, operations: [] }, null, 2)}\n`);
    removed.push(`${pendingPath} (emptied)`);
  }
  for (const path of strayFiles(profileDir)) {
    await rm(path, { force: true });
    removed.push(path);
  }
  return { removed };
}

/**
 * Read a small JSON body from a POST.
 * @param req - incoming request.
 * @returns the parsed body, or null when it is absent or not JSON.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Re-publish the Web plugin bundles so a changed copy on disk reaches the page
 * without restarting DSH.
 *
 * The Host rebuilds its bundle table when the server it publishes is rebound;
 * the service registration itself is left alone, which is what keeps the
 * profiles and sibling plugins in place.
 * @param ctx - the plugin context owning `webServer`.
 * @param packageName - this plugin's package name, to check the copy is fresh.
 * @returns whether the host actually rebound.
 */
function republish(ctx, packageName) {
  try {
    // The module table republishes one entry from disk (`rebuilt`), which is
    // exactly what its own HMR watch calls after a rebuild. A Host that does not
    // expose it still gets the profile-level answer.
    const modules = ctx.get('clientModules');
    if (modules !== undefined && modules !== null && typeof modules.rebuilt === 'function') {
      const rev = modules.rebuilt(packageName);
      return typeof rev === 'string' && rev !== '';
    }
    const server = ctx.get('webServer');
    if (server !== undefined && server !== null) {
      const loader = server.loader ?? server.bundles;
      if (loader !== undefined && typeof loader.invalidate === 'function') {
        loader.invalidate(packageName);
        return true;
      }
    }
    return false;
  } catch (error) {
    ctx.logger?.warn?.('dsh-quick-menu: republish failed', error);
    return false;
  }
}
/**
 * The Node binary that should run the replacement host.
 * @returns an absolute executable path.
 */
function nodeExecutable() {
  const argv0 = process.argv0;
  if (typeof argv0 === 'string' && argv0 !== '' && /^[A-Za-z]:[\\/]|^\//u.test(argv0) && existsSync(argv0)) return argv0;
  return process.execPath;
}

/**
 * The desktop host's own entry, when this profile shipped one. Replaying that
 * path beats trusting `process.argv[1]`, which the desktop shell may already
 * have rewritten to a packaged cli.
 * @param profileDir - the profile this host booted.
 * @returns the cli path, or null.
 */
function hostEntry(profileDir) {
  const candidates = [
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js'),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * The invocation that booted this host, with its own arguments.
 * @param profileDir - the profile this host booted.
 * @param port - the port the replacement should keep.
 * @returns file, args, cwd, and whether it must go through a shell shim.
 */
function restartLaunch(profileDir) {
  /** Append `--port` unless the recorded argv already pins one. */
  const withPort = (args) => {
    const pinned = args.indexOf('--port');
    if (pinned !== -1) {
      const value = args[pinned + 1];
      // `--port 0` is the desktop shell's way of saying "pick one and tell me
      // over IPC". A detached relaunch has no IPC parent, so a literal 0 would
      // leave the replacement listening nowhere: hand it a real free port.
      if (value !== undefined && /^[0-9]+$/u.test(value) && Number.parseInt(value, 10) > 0) {
        return { args, port: Number.parseInt(value, 10) };
      }
      const chosen = choosePort();
      const replaced = [...args];
      if (value !== undefined && !value.startsWith('--')) replaced.splice(pinned + 1, 1, String(chosen));
      else replaced.splice(pinned + 1, 0, String(chosen));
      return { args: replaced, port: chosen };
    }
    const chosen = choosePort();
    return { args: [...args, '--port', String(chosen)], port: chosen };
  };
  /** Drop any recorded port, then pin a fresh free one. */
  const randomPort = (args) => {
    const kept = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--port') {
        index += 1;
        continue;
      }
      if (args[index].startsWith('--port=')) continue;
      kept.push(args[index]);
    }
    return withPort(kept);
  };
  const own = hostEntry(profileDir);
  if (own !== null) {
    // A desktop shell owns the port: a random one is far safer to hand back
    // than `--port 0`, which the CLI reads as a closed door.
    const { args, port: fixed } = randomPort(process.argv.slice(2));
    return { file: nodeExecutable(), args: [...process.execArgv, own, ...args], cwd: undefined, viaShell: false, port: fixed };
  }
  const entry = process.argv[1];
  const desktopCli = typeof entry === 'string' && /[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-desktop-host[\\/]lib[\\/]cli\.js$/u.test(entry);
  const rest = process.argv.slice(2);
  if (typeof entry === 'string' && (desktopCli || /[\\/](?:bin\.(?:js|ts)|dsh)$/u.test(entry))) {
    const abs = resolve(entry);
    const { args, port: fixed } = withPort(rest);
    return {
      file: nodeExecutable(),
      args: [...process.execArgv, abs, ...args],
      cwd: desktopCli ? undefined : dirname(abs),
      viaShell: false,
      port: fixed,
    };
  }
  // A desktop shell (or any bundler) booted us by path: replay its exact argv
  // so the relaunch goes through whatever shim started this process.
  if (typeof entry === 'string' && existsSync(entry)) {
    const argv0 = process.argv0;
    const file = typeof argv0 === 'string' && /^[A-Za-z]:[\\/]|^\//u.test(argv0) && existsSync(argv0) ? argv0 : entry;
    const { args, port: fixed } = withPort(rest);
    return {
      file,
      args: file === entry ? args : [entry, ...args],
      cwd: process.cwd(),
      viaShell: false,
      port: fixed,
    };
  }
  return { file: 'dsh', args: rest, cwd: undefined, viaShell: process.platform === 'win32', port: null };
}

/**
 * A free loopback port, so a relaunch keeps the URL the user already has.
 * @returns a port number.
 */
function choosePort() {
  const server = createServer();
  try {
    server.listen(0, '127.0.0.1');
    return server.address()?.port ?? 0;
  } finally {
    server.close();
  }
}

/**
 * Platform-correct spawn shape for the replacement, so Windows gets a hidden
 * console instead of a visible one.
 * @param launch - result of `restartLaunch()`.
 * @returns file and args the helper spawns.
 */
function respawnInvocation(launch) {
  return { file: launch.file, args: launch.args, viaShell: launch.viaShell, detached: true };
}

/**
 * Source for the detached helper: wait for the listening port to go quiet,
 * start the replacement, then record whether it actually came up.
 *
 * Nothing here goes near the command line or an environment block: the helper
 * is handed a script path plus one ASCII-safe fingerprint, and reads the plan
 * from `plan.json` next to itself. Windows quoting mangles programming
 * punctuation (parentheses, quotes, colons) once an argument has been quoted,
 * and an unset process environment drops the payload silently.
 * @param planPath - where `scheduleRestart()` wrote the plan.
 * @param fingerprint - ASCII-safe marker proving this program really runs.
 * @returns a self-contained Node program.
 */
function helperSource(planPath, fingerprint) {
  return [
    "const { spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const earlyLog = ${JSON.stringify(`${planPath}.early`)}`,
    "const early = (stage) => { try { fs.appendFileSync(earlyLog, stage + ' ' + new Date().toISOString() + ' pid=' + process.pid + '\\n') } catch (ignored) { void ignored } }",
    `early('boot ${fingerprint} argv=' + process.argv.join(' | '))`,
    `const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planPath)}, 'utf8'))`,
    "early('plan loaded')",
    'const file = plan.file',
    'const args = plan.args',
    'const cwd = plan.cwd',
    'const logOut = plan.logs.out',
    'const logErr = plan.logs.err',
    'const port = plan.port',
    "const out = fs.openSync(logOut, 'a')",
    "const err = fs.openSync(logErr, 'a')",
    `const stamp = () => new Date().toISOString()`,
    // One statement per line: an arrow body must not be glued with `;`, which
    // would close the block instead of separating statements.
    'const note = (message) => {',
    `  try { fs.appendFileSync(logErr, '[quick-menu-restart ' + stamp() + '] ' + message + '\\n') } catch (ignored) { void ignored }`,
    '}',
    'const free = () => new Promise((settle) => {',
    '  if (port === null) { setTimeout(() => settle(true), 1200); return }',
    "  const probe = net.connect({ port, host: '127.0.0.1' })",
    '  probe.setTimeout(1500, () => { probe.destroy(); settle(false) })',
    "  probe.once('connect', () => { probe.destroy(); settle(false) })",
    "  probe.once('error', () => settle(true))",
    '})',
    'const run = async () => {',
    `  early('waiting for the port to clear')`,
    '  for (let i = 0; i < 120; i += 1) { if (await free()) break }',
    `  early('port clear, spawning')`,
    `  note('starting ' + file + ' ' + args.join(' '))`,
    "  const child = spawn(file, args, { cwd: cwd === null ? undefined : cwd, detached: true, stdio: ['ignore', out, err], windowsHide: true })",
    `  child.once('error', (error) => note('spawn failed: ' + error.message))`,
    '  child.unref()',
    `  early('replacement pid ' + String(child.pid ?? null))`,
    `  if (port === null) { note('started (no port to verify)'); return }`,
    '  for (let i = 0; i < 240; i += 1) {',
    '    await new Promise((r) => setTimeout(r, 250))',
    `    if (!(await free())) { note('replacement is listening on ' + port); return }`,
    '  }',
    `  note('replacement never listened on ' + port)`,
    '}',
    // An async IIFE alone lets Node exit the moment the microtask queue drains,
    // which on Windows kills the helper before it ever spawns the replacement.
    `const fail = (error) => {`,
    '  const text = error instanceof Error ? error.message : String(error)',
    `  note('helper failed: ' + text)`,
    `  early('failed: ' + text)`,
    '  process.exit(1)',
    '}',
    `run().then(() => { early('done'); process.exit(0) }, fail)`,
  ].join(';\n');
}

/**
 * Relaunch this host: spawn the detached helper, then SIGTERM ourselves once
 * it is running.
 * @param profileDir - the profile this host booted, so the relaunch can find the same runtime.
 * @returns the helper pid, the port that frees up, and the log paths.
 */
function scheduleRestart(profileDir) {
  const launch = restartLaunch(profileDir);
  const spawned = respawnInvocation(launch);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19);
  const logs = {
    out: join(tmpdir(), `dsh-quick-menu-restart-${stamp}.out.log`),
    err: join(tmpdir(), `dsh-quick-menu-restart-${stamp}.err.log`),
  };
  const plan = { file: spawned.file, args: spawned.args, cwd: launch.cwd ?? null, logs, port: launch.port ?? null };
  // The helper reads its plan from a file it is told about, so no quote,
  // backslash, parenthesis or newline ever crosses the Windows quoting
  // boundary, and no environment snapshot can drop it.
  const helperDir = join(tmpdir(), `dsh-quick-menu-restart-${stamp}`);
  mkdirSync(helperDir, { recursive: true });
  const planPath = join(helperDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const helper = spawn(nodeExecutable(), ['-e', helperSource(planPath, stamp)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  helper.unref();
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, 500);
  return { pid: process.pid, helperPid: helper.pid ?? null, ...logs, file: spawned.file, port: plan.port };
}

/**
 * The port this host listens on, when the origin names one.
 * @param origin - the listener origin, such as `http://127.0.0.1:57248`.
 * @returns the port number, or null.
 */
function portOf(origin) {
  try {
    const port = Number.parseInt(new URL(origin).port, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * Register the four routes.
 * @param ctx - host plugin context carrying `webServer` and `connection`.
 */
export function apply(ctx) {
  /** One reload per Host load, so the re-entry cannot loop. */
  const reloadState = { done: false };
  const selfRoot = dirname(dirname(fileURLToPath(import.meta.url)));  const selfName = (() => {
    try {
      return JSON.parse(readFileSync(join(selfRoot, 'package.json'), 'utf8')).name ?? 'dsh-quick-menu';
    } catch {
      return 'dsh-quick-menu';
    }
  })();

  /** The advertised Web root, or the listener origin when no Web app serves one. */
  const webRoot = () => {
    const webApp = ctx.get('webApp');
    const advertised = webApp && typeof webApp.getAdvertisedUrl === 'function' ? webApp.getAdvertisedUrl() : undefined;
    return typeof advertised === 'string' && advertised !== '' ? advertised : ctx.webServer.getOrigin();
  };

  /** The profile this host booted, as the launcher reported it. */
  const profileDir = () => {
    const dir = ctx.get('profileContext')?.dir;
    if (typeof dir === 'string' && dir !== '') return dir;
    throw new Error('this host published no profileContext.dir');
  };

  /**
   * Answer a route with the host's fence, the method rule, and a JSON body.
   * @param req - incoming request.
   * @param res - response to own.
   * @param method - the only method this route accepts.
   * @param body - producer of the success payload.
   */
  const route = (req, res, method, body) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    if (req.method !== method) {
      res.statusCode = 405;
      res.setHeader('allow', method);
      res.end();
      return;
    }
    if (method === 'POST') {
      // A JSON content type cannot be produced by a cross-site HTML form, and
      // the marker header cannot be set cross-origin without a preflight this
      // Host never answers. Together they keep CSRF out of these routes.
      if (req.headers[ORIGIN_HEADER] === undefined || !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        sendJson(res, 403, { code: 'dsh-quick-menu/cross-origin', message: 'this route only answers the caption menu' });
        return;
      }
    }
    Promise.resolve()
      .then(body)
      .then((payload) => {
        sendJson(res, 200, payload);
      })
      .catch((error) => {
        sendJson(res, 500, { code: 'dsh-quick-menu/failed', message: error instanceof Error ? error.message : String(error) });
      });
  };

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: WEB_URL_PATH,
        handler: (req, res) =>
          route(req, res, 'GET', () => ({ url: ctx.connection.authenticatedUrl(webRoot()) })),
      }),
    `dsh-quick-menu: GET ${WEB_URL_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: DIAGNOSE_PATH,
        handler: (req, res) => route(req, res, 'GET', () => diagnose(profileDir(), selfRoot, selfName)),
      }),
    `dsh-quick-menu: GET ${DIAGNOSE_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: REPAIR_PATH,
        handler: (req, res) =>
          route(req, res, 'POST', async () => ({
            ...(await repair(profileDir())),
            ...diagnose(profileDir(), selfRoot, selfName),
          })),
      }),
    `dsh-quick-menu: POST ${REPAIR_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RELOAD_PATH,
        handler: (req, res) =>
          route(req, res, 'POST', async () => {
            // Re-entry guard: this route tears down and re-creates the very
            // bundle table the answer is served from, so it is once per load.
            if (reloadState.done) {
              return { reloaded: false, reason: 'this Host already re-published its bundles' };
            }
            let wanted = '';
            try {
              const body = await readJsonBody(req);
              wanted = typeof body?.version === 'string' ? body.version : '';
            } catch {
              wanted = '';
            }
            const current = installDigest(profileDir(), selfName);
            if (wanted !== '' && current !== '' && wanted !== current) {
              return { reloaded: false, reason: 'the installed copy changed again; reload the page', installVersion: current };
            }
            const served = republish(ctx, selfName);
            reloadState.done = true;
            return { reloaded: served, reason: served ? '' : 'this Host exposes no Web bundle table', installVersion: current };
          }),
      }),
    `dsh-quick-menu: POST ${RELOAD_PATH}`,
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: RESTART_PATH,
        handler: (req, res) =>
          route(req, res, 'POST', async () => {
            const plan = { file: '', port: null };
            // Defer the launch past this response so the browser gets a body
            // before the process that owns the socket goes away.
            setTimeout(() => {
              try {
                Object.assign(plan, scheduleRestart(profileDir()));
              } catch (error) {
                ctx.logger?.warn?.('dsh-quick-menu: restart failed', error);
              }
            }, 300);
            return { restarting: true, port: portOf(ctx.webServer.getOrigin()), launched: restartLaunch(profileDir()).file };
          }),
      }),
    `dsh-quick-menu: POST ${RESTART_PATH}`,
  );
}
