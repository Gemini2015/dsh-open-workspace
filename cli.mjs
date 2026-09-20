#!/usr/bin/env node
/**
 * `dsh-open` — register and activate a DSH Web workspace from a shell.
 *
 * Finds a running `dsh web` instance carrying the open-workspace plugin (via
 * its rendezvous file), starts one when none is running, then calls the host
 * half. Nothing here touches the harness source tree.
 *
 * Usage:
 *   dsh-open .                       add + activate the current directory
 *   dsh-open C:\work\project         add + activate that directory
 *   dsh-open --status                report the running instance
 *   dsh-open --forget .              unregister a directory
 *   dsh-open --no-start .            fail instead of starting a server
 *   dsh-open --launch "dsh web" .    choose the command that starts the server
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's directory, so the browser-focus helper is found beside the CLI. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/** Harness home, resolved the way the shipped plugins resolve it. */
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME
  : join(homedir(), '.dsh')

/** Default rendezvous file: the same path the host half writes. */
const STATE_FILE = join(DSH_HOME, 'open-workspace.json')

/** Where a started server's own output goes, so a failed launch is diagnosable. */
const LOG_FILE = join(DSH_HOME, 'dsh-open-server.log')

/**
 * Launch commands tried in order when none is given. `dsh` covers a shell with
 * the CLI on PATH; `npx` covers a machine where it is only reachable through
 * the package, which is how the published `dsh web` is usually started.
 */
const DEFAULT_LAUNCHERS = ['dsh web', 'npx -y @deepseek-ai/dsh web']

/** How long one launcher gets to publish its rendezvous file. */
const DEFAULT_START_TIMEOUT_MS = 60_000

/** How often the start-up wait reports that it is still waiting. */
const PROGRESS_INTERVAL_MS = 5000

/** Route prefix the host half owns, and the port its launcher serves by default. */
const BASE_PATH = '/dsh-open'
const DEFAULT_PORT = 3080

/** How long the focus step waits for a page that is still loading to get a title. */
const FOCUS_WAIT_SECONDS = 4

function usage() {
  return [
    'usage: dsh-open [options] <directory>',
    '',
    '  --status              print the running instance and exit',
    '  --stop                shut the running instance down and exit',
    '  --forget              unregister the directory instead of opening it',
    '  --no-start            do not start a server when none is running',
    '  --launch <command>    command that starts the server',
    '                        (default: "dsh web", then "npx -y @deepseek-ai/dsh web")',
    '  --timeout <seconds>   start-up wait per launcher (default: 60)',
    '  --focus <mode>        browser focus after opening: auto (raise the window',
    '                        already showing the GUI, else open a tab), tab, off',
    '  --state <file>        rendezvous file (default: $DSH_HOME/open-workspace.json)',
    '  --json                machine-readable output',
  ].join('\n')
}

function parseArgs(argv) {
  const options = {
    status: false,
    stop: false,
    focus: 'auto',
    forget: false,
    start: true,
    launch: undefined,
    timeoutMs: DEFAULT_START_TIMEOUT_MS,
    stateFile: STATE_FILE,
    logFile: LOG_FILE,
    json: false,
    target: undefined,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--status': options.status = true; break
      case '--stop': options.stop = true; break
      case '--focus': options.focus = argv[++index]; break
      case '--forget': options.forget = true; break
      case '--no-start': options.start = false; break
      case '--json': options.json = true; break
      case '--launch': options.launch = argv[++index]; break
      case '--timeout': options.timeoutMs = Number(argv[++index]) * 1000; break
      case '--state': options.stateFile = argv[++index]; break
      case '--log': options.logFile = argv[++index]; break
      case '--help': case '-h': options.help = true; break
      default:
        if (argument.startsWith('-')) throw new Error(`unknown option ${argument}`)
        options.target = argument
    }
  }
  return options
}

function readState(stateFile) {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    // Absent, unreadable, or half-written: treated as no instance.
    return undefined
  }
}

function authHeaders(state) {
  return { authorization: `Bearer ${String(state.token)}` }
}

async function call(state, route, body) {
  const basePath = typeof state.basePath === 'string' ? state.basePath : '/dsh-open'
  const response = await fetch(`http://127.0.0.1:${String(state.port)}${basePath}${route}`, {
    method: 'POST',
    headers: { ...authHeaders(state), 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000),
  })
  const text = await response.text()
  let value
  try {
    value = JSON.parse(text)
  } catch {
    value = { ok: false, error: text }
  }
  return { status: response.status, value }
}

/**
 * A live instance is one whose rendezvous file answers the health probe.
 * @param stateFile - rendezvous file to read.
 * @returns the state and health payload, or undefined when nothing answers.
 */
async function liveInstance(stateFile) {
  const state = readState(stateFile)
  if (state === undefined || typeof state.port !== 'number' || typeof state.token !== 'string') return undefined
  try {
    const response = await fetch(
      `http://127.0.0.1:${String(state.port)}${String(state.basePath ?? '/dsh-open')}/health`,
      { headers: authHeaders(state), signal: AbortSignal.timeout(5000) },
    )
    if (response.status !== 200) return undefined
    const health = await response.json()
    if (health.ok !== true) return undefined
    // A rendezvous file left behind by an earlier process is not this one, even
    // where a configured token would otherwise authenticate against it.
    return health.pid === state.pid ? { state, health } : undefined
  } catch {
    // Connection refused, timed out, or answered by something else.
    return undefined
  }
}

/**
 * Stop a running instance: through the host's own orderly shutdown when it has
 * that route, otherwise by terminating the pid that just answered its health
 * probe.
 * @param instance - state and health of the live instance.
 * @returns how the process was stopped.
 */
async function stopInstance(instance) {
  try {
    const response = await call(instance.state, '/stop')
    if (response.status === 200) return 'orderly shutdown'
  } catch {
    // A host half without the route, or one that dropped the connection while
    // stopping; the pid check below decides whether it is still there.
  }
  if (instance.health.pid !== instance.state.pid) {
    throw new Error(`refusing to kill pid ${String(instance.state.pid)}:`
      + ` port ${String(instance.state.port)} answered as pid ${String(instance.health.pid)}`)
  }
  process.kill(instance.state.pid)
  return 'terminated'
}

/**
 * Character length of the log so far, used to isolate one launch's output.
 * @param logFile - file receiving the server's output.
 * @returns the current character count, or zero when there is no log yet.
 */
function logLength(logFile) {
  try {
    return readFileSync(logFile, 'utf8').length
  } catch {
    // No log yet: this launch is the first writer.
    return 0
  }
}

/**
 * Last lines of one launch's captured output, for a failure report.
 * @param logFile - file receiving the server's output.
 * @param from - character offset where this launch's output starts.
 * @param lines - how many trailing lines to keep.
 * @returns the tail, or an empty string when this launch produced nothing.
 */
function logTail(logFile, from, lines = 12) {
  try {
    const text = readFileSync(logFile, 'utf8').slice(from).trimEnd()
    return text === '' ? '' : text.split('\n').slice(-lines).join('\n')
  } catch {
    // The file vanished between the write and the read; the caller reports the
    // failure reason without output rather than masking it.
    return ''
  }
}

/**
 * Start one launcher, with its output captured to a log file.
 *
 * `detached` keeps the server alive after this CLI exits and out of the
 * launching console's process group. A restricted environment can refuse that
 * spawn outright (`STATUS_DLL_INIT_FAILED` on Windows), which is why the caller
 * retries the same launcher undetached before calling it failed.
 *
 * @param launch - command line handed to the platform shell.
 * @param cwd - directory the server should treat as its starting point.
 * @param logFile - file receiving the server's stdout and stderr.
 * @param detached - whether the child gets its own process group.
 * @returns the child process and the log offset this launch writes from.
 */
function spawnServer(launch, cwd, logFile, detached) {
  mkdirSync(dirname(logFile), { recursive: true })
  const from = logLength(logFile)
  appendFileSync(
    logFile,
    `\n=== ${new Date().toISOString()} dsh-open: ${launch} (cwd ${cwd}, detached ${String(detached)})\n`,
  )
  const fd = openSync(logFile, 'a')
  const child = spawn(launch, {
    cwd,
    detached,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
  child.unref()
  return { child, from }
}

const sleep = (ms) => new Promise((resolvePromise) => { setTimeout(resolvePromise, ms) })

/**
 * Wait for a started launcher to publish a live rendezvous file.
 * @param stateFile - rendezvous file to watch.
 * @param child - the started launcher.
 * @param timeoutMs - how long this launcher gets.
 * @param onWait - progress callback, called with the elapsed seconds.
 * @returns the live instance, or the reason it never appeared.
 */
async function awaitInstance(stateFile, child, timeoutMs, onWait) {
  const startedAt = Date.now()
  let exit
  child.on('exit', (code, signal) => { exit = signal ?? code ?? 0 })
  child.on('error', (error) => { exit = `spawn failed: ${error.message}` })
  let reported = startedAt
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(500)
    const instance = await liveInstance(stateFile)
    if (instance !== undefined) return instance
    if (exit !== undefined) return { failed: `the launcher exited (${String(exit)})` }
    if (Date.now() - reported >= PROGRESS_INTERVAL_MS) {
      reported = Date.now()
      onWait(Math.round((Date.now() - startedAt) / 1000))
    }
  }
  return { failed: `no rendezvous file after ${String(Math.round(timeoutMs / 1000))}s` }
}

/**
 * The launch token for this port, when `dsh-open` started the server and so has
 * its output: a tab opened with it authenticates even in a browser that has no
 * session cookie for this instance yet.
 * @param logFile - captured server output.
 * @param port - the instance's port.
 * @returns the token, or undefined when the log has none.
 */
function launchTokenFor(logFile, port) {
  try {
    const matches = [...readFileSync(logFile, 'utf8')
      .matchAll(new RegExp(`127\\.0\\.0\\.1:${String(port)}/\\?token=([A-Za-z0-9_-]+)`, 'g'))]
    return matches.length === 0 ? undefined : matches[matches.length - 1][1]
  } catch {
    // No log: the instance was started elsewhere, so its session cookie is the only credential.
    return undefined
  }
}

/**
 * Run the window-focus helper and report what it did.
 * @param options - parsed CLI options, for the log file.
 * @param script - the helper's path.
 * @param mode - `auto` or `tab`.
 * @param url - GUI URL opened when no window can be raised.
 * @param waitSeconds - how long the helper looks for a window before opening one.
 * @returns the helper's exit code, or undefined when it could not run.
 */
async function runFocusHelper(options, script, mode, url, waitSeconds) {
  const fd = openSync(options.logFile, 'a')
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Mode', mode, '-OpenUrl', url, '-WaitSeconds', String(waitSeconds),
  ], { stdio: ['ignore', fd, fd], windowsHide: true })
  return new Promise((resolveCode) => {
    child.on('exit', (code) => resolveCode(code ?? 0))
    child.on('error', () => resolveCode(undefined))
  })
}

/**
 * The URL that brings the GUI up in a browser tab.
 *
 * The running server mints its own launch token, which authenticates a browser
 * that holds no session cookie and works whoever started that server. A host
 * half too old to answer falls back to the token in the launch log, and then to
 * the plain origin, which a browser with the cookie already accepts.
 *
 * @param options - parsed CLI options, for the log file.
 * @param instance - the live instance.
 * @returns an absolute GUI URL.
 */
async function guiUrl(options, instance) {
  const plain = `http://127.0.0.1:${String(instance.state.port)}/`
  try {
    const { status, value } = await call(instance.state, '/url')
    if (status === 200 && typeof value.url === 'string' && value.url.startsWith('http')) return value.url
  } catch {
    // An older host half has no /url route; the launch log covers its token.
  }
  const token = launchTokenFor(options.logFile, instance.state.port)
  return token === undefined ? plain : `${plain}?token=${token}`
}

/**
 * Put the browser in front of the user after a workspace was opened.
 *
 * `auto` raises a window already showing the GUI and falls back to a new tab;
 * `tab` always opens one. A page cannot raise its own window, so the process
 * the user's own action started does it, which is where that permission lives.
 *
 * @param options - parsed CLI options.
 * @param instance - the live instance that was just called.
 * @returns what happened, for the caller to report.
 */
async function focusBrowser(options, instance) {
  if (options.focus === 'off') return 'skipped'
  const url = await guiUrl(options, instance)
  const script = join(PLUGIN_DIR, 'focus-window.ps1')
  if (process.platform === 'win32' && existsSync(script)) {
    // Opening the tab goes through the same helper: PowerShell's ShellExecute
    // path is what reaches a browser that is already running. A page has no
    // title until it has loaded, and a server that just started has one still
    // loading, so that is the one case worth waiting for.
    const wait = instance.health.browsers === 0 ? FOCUS_WAIT_SECONDS : 0
    const code = await runFocusHelper(options, script, options.focus, url, wait)
    if (code === 0) return 'raised'
    // The window is in front but the OS kept focus elsewhere; a window showing
    // the GUI is what the caller wants, and it is not worth another tab.
    if (code === 5) return 'front'
    if (code === 4) return 'tab'
    return 'unknown'
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  const child = spawn(opener, [url], { stdio: 'ignore' })
  child.unref()
  // Let the opener hand the URL over before this process exits.
  await sleep(700)
  return 'tab'
}

/**
 * Whether something already answers on a port a new instance would use.
 * @param port - port to probe.
 * @returns `plugin` when this plugin family answers there, `other` for any
 * other listener, and undefined when nothing is listening.
 */
async function probePort(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}${BASE_PATH}/health`, {
      signal: AbortSignal.timeout(1500),
    })
    const status = response.status
    await response.text()
    if (status === 401 || status === 403 || response.ok) return 'plugin'
    return 'other'
  } catch {
    // Connection refused, or nothing that speaks HTTP.
    return undefined
  }
}

/**
 * Ports a launched instance would try, most likely first: the one the stale
 * rendezvous file names, then the launcher's default.
 * @param stateFile - rendezvous file path.
 * @returns candidate ports.
 */
function candidatePorts(stateFile) {
  const ports = []
  const state = readState(stateFile)
  if (typeof state?.port === 'number') ports.push(state.port)
  if (!ports.includes(DEFAULT_PORT)) ports.push(DEFAULT_PORT)
  return ports
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const say = (message) => { if (!options.json) process.stdout.write(`${message}\n`) }
  if (options.help === true) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  if (options.status) {
    const instance = await liveInstance(options.stateFile)
    if (options.json) process.stdout.write(`${JSON.stringify(instance ?? null, null, 2)}\n`)
    else if (instance === undefined) {
      say('no running dsh web instance with the open-workspace plugin')
    } else {
      say(`running: pid ${String(instance.state.pid)} at ${String(instance.state.url)}`
        + ` (browsers: ${String(instance.health.browsers ?? 'unknown')})`)
    }
    return instance === undefined ? 1 : 0
  }

  if (options.stop) {
    const running = await liveInstance(options.stateFile)
    if (running === undefined) {
      say('no running dsh web instance with the open-workspace plugin')
      return 1
    }
    // What answered the token-authenticated health probe is what gets stopped,
    // never a pid taken from the rendezvous file on its own.
    say(`dsh-open: stopping pid ${String(running.state.pid)} on port ${String(running.state.port)}`
      + ` (${String(running.health.browsers ?? 0)} browser(s) connected)`)
    const how = await stopInstance(running)
    let stopped = false
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      await sleep(250)
      if (await liveInstance(options.stateFile) === undefined) {
        stopped = true
        break
      }
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: stopped, how, pid: running.state.pid }, null, 2)}\n`)
    } else if (stopped) {
      say(`stopped (${how})`)
    } else {
      process.stderr.write(`dsh-open: ${how}, but the port still answers; check pid ${String(running.state.pid)}\n`)
    }
    return stopped ? 0 : 1
  }

  if (options.target === undefined) {
    process.stderr.write(`${usage()}\n`)
    return 2
  }
  const target = resolve(options.target)
  if (!isAbsolute(target)) {
    process.stderr.write(`dsh-open: cannot resolve ${options.target}\n`)
    return 2
  }

  let instance = await liveInstance(options.stateFile)
  let started = false
  if (instance === undefined) {
    if (!options.start) {
      process.stderr.write('dsh-open: no running instance and --no-start was given\n')
      return 1
    }
    // A second server onto a live port cannot come up — the Web server reports
    // the failed fiber rather than serving — and the caller would be left with a
    // rendezvous file for a process that never listened. Say so instead, unless
    // the user named the launcher, which is an explicit instruction to run it.
    if (options.launch === undefined) {
      for (const port of candidatePorts(options.stateFile)) {
        const occupant = await probePort(port)
        if (occupant === undefined) continue
        process.stderr.write(
          `dsh-open: port ${String(port)} already answers (${occupant === 'plugin' ? 'this plugin, under another token' : 'another listener'}),`
          + ` and ${options.stateFile} does not authenticate against it.\n`
          + `  A second dsh web cannot take a live port, so nothing was started.`
          + ` Restart the server on port ${String(port)}, or delete that file if it is stale, then retry.\n`,
        )
        return 1
      }
    }
    const launchers = options.launch === undefined ? DEFAULT_LAUNCHERS : [options.launch]
    // A restricted environment can refuse the detached spawn itself, so each
    // launcher gets one undetached retry before it is reported as failed.
    const modes = process.platform === 'win32' ? [true, false] : [true]
    const failures = []
    for (const launcher of launchers) {
      for (const detached of modes) {
        say(`dsh-open: starting "${launcher}" in ${target}${detached ? '' : ' (without a new process group)'}`)
        const { child, from } = spawnServer(launcher, target, options.logFile, detached)
        const result = await awaitInstance(
          options.stateFile, child, options.timeoutMs,
          seconds => say(`dsh-open: still waiting for the server (${String(seconds)}s)…`),
        )
        if (result.state !== undefined) {
          instance = result
          started = true
          say(`dsh-open: server is up (pid ${String(instance.state.pid)}, port ${String(instance.state.port)})`
            + '; stop it with: dsh-open --stop')
          break
        }
        if (detached && modes.length > 1) {
          say(`dsh-open: that spawn failed (${String(result.failed)}); retrying`)
          continue
        }
        const tail = logTail(options.logFile, from)
        failures.push(`${launcher}: ${String(result.failed)}${tail === '' ? '' : `\n${tail}`}`)
        say(`dsh-open: ${launcher} did not come up (${String(result.failed)})`)
      }
      if (instance !== undefined) break
    }
    if (instance === undefined) {
      process.stderr.write(
        `dsh-open: no instance came up.\n${failures.join('\n')}\n`
        + `  Full output: ${options.logFile}\n`
        + '  If the server did start, the open-workspace plugin row is missing from the profile patch layer (see README.md).\n',
      )
      return 1
    }
  }

  const route = options.forget ? '/remove' : '/open'
  const { status, value } = await call(instance.state, route, { path: target })
  if (options.json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
  else if (status === 200) {
    say(`${options.forget ? 'removed' : value.created === true ? 'added' : 'already present'}: ${value.path ?? target}`)
    say(`workspace ${String(value.workspaceId)}`)
    if (!options.forget && instance.health.browsers === 0) {
      say('note: the Web UI is not connected yet, so the host holds this activation')
      say('      and opens the workspace as soon as a page loads (2 minutes).')
    }
  } else {
    process.stderr.write(`dsh-open: ${String(value.error ?? status)}\n`)
  }
  if (status === 200 && !options.forget) {
    // Best effort: the workspace is registered and activated either way.
    const how = await focusBrowser(options, instance)
    if (!options.json) {
      if (how === 'raised') say('dsh-open: brought the browser window showing the GUI to the front')
      if (how === 'front') say('dsh-open: moved the browser window showing the GUI in front of the other windows')
      if (how === 'tab') say('dsh-open: opened the GUI in a browser tab')
      if (how === 'unknown') say('dsh-open: could not tell the browser to come forward')
    }
  }
  return status === 200 ? 0 : 1
}

main().then(
  (code) => { process.exitCode = code },
  (error) => {
    process.stderr.write(`dsh-open: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  },
)
