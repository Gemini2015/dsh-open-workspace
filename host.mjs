/**
 * Host half of `dsh-open-workspace`.
 *
 * Adds one authenticated, loopback-only endpoint family to a running `dsh web`
 * server so a process outside the browser can register a directory as a Web
 * Workspace and activate it there:
 *
 *   POST /dsh-open/open    {"path":"<absolute dir>"}   register + signal browsers
 *   POST /dsh-open/remove  {"workspaceId"|"path"}      unregister
 *   POST /dsh-open/stop                                shut this server down
 *   POST /dsh-open/poll    {"id":"<tab>","since":<n>}  browser-half activation poll
 *   GET  /dsh-open/health                              liveness probe
 *   GET  /dsh-open/url                                 authenticated browser URL
 *
 * The browser half polls for an activation instead of subscribing to a stream: a
 * page gets six concurrent HTTP/1.1 connections per origin, and this one already
 * spends one on a never-completing hot-reload stream. A second permanent one per
 * tab leaves too few for the page's own requests, which stalls a newly opened tab
 * and a reload while the server stays perfectly healthy. A poll answers at once.
 *
 * The plugin also writes a rendezvous file (port, token, pid) so an outside
 * process can find a running instance. It imports node builtins only, so it
 * resolves from any profile directory without installation.
 *
 * Loaded as an ordinary Loader row from a user patch layer; see README.md.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { appendFileSync, chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** Stable Cordis plugin name. */
export const name = 'open-workspace'

/** Services required before routes can be registered. */
export const inject = ['webServer', 'workspaceRegistry']

/** Route prefix owned by this plugin. */
const BASE_PATH = '/dsh-open'

/** Largest accepted JSON request body. */
const MAX_BODY_BYTES = 64 * 1024

/** How long an undelivered activation stays claimable by a late browser half. */
const PENDING_TTL_MS = 120_000

/** How long a browser half counts as connected after its last poll. */
const POLLER_TTL_MS = 10_000

/** Socket peer addresses that count as this machine. */
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** Host-header hostnames that count as this machine (the DNS-rebinding fence). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Resolve the harness home the same way the shipped plugins do.
 * @returns the absolute harness home path.
 */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Constant-time comparison of a presented token against the process token.
 * @param presented - value read from the request, possibly undefined.
 * @param expected - this process's token.
 * @returns whether the two are equal.
 */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string') return false
  const left = Buffer.from(presented)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * Apply the loopback peer fence and the Host fence.
 * @param request - incoming node:http request.
 * @returns whether the request can only have come from this machine.
 */
function isLoopbackRequest(request) {
  const peer = request.socket?.remoteAddress
  if (peer === undefined || !LOOPBACK_PEERS.has(peer)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return LOOPBACK_HOSTS.has(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}

/**
 * Read and parse one bounded JSON request body.
 * @param request - incoming node:http request.
 * @returns the parsed body, or an empty object for an empty body.
 */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${String(MAX_BODY_BYTES)} bytes`)
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Write one JSON response.
 * @param response - response to complete.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Keep a peer that disappears mid-response from ending the server: a write to a
 * dropped socket reports as an 'error' event on the response, and an 'error'
 * event with no listener is thrown out of the response object.
 * @param response - response the calling handler is about to write to.
 */
function surviveDisconnect(response) {
  response.on('error', () => {
    // The peer is gone; the reply has nowhere to go and nothing else to do.
  })
}

/**
 * Register the endpoint family, the browser event stream, and the rendezvous
 * file; every part is released together with this plugin's fiber.
 * @param ctx - host context carrying the Web server and Workspace registry.
 * @param config - optional `token` and `statePath` overrides.
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  const token = typeof settings.token === 'string' && settings.token !== ''
    ? settings.token
    : randomBytes(32).toString('base64url')
  const stateFile = typeof settings.statePath === 'string' && settings.statePath !== ''
    ? settings.statePath
    : join(resolveDshHome(), 'open-workspace.json')
  const registry = ctx.workspaceRegistry
  /** Browser halves that polled recently, keyed by the id each reports. */
  const pollers = new Map()
  /**
   * The last activation, held for every browser half that asks while it is fresh.
   *
   * A server started for this request is usually still loading its page when the
   * caller asks for a workspace, and the caller may also raise a second page
   * afterwards; holding the activation is what makes "start the server, then
   * open the workspace" independent of which page arrives first.
   */
  let pending
  /** Version of the last activation, so a poller can tell it has already acted. */
  let activationVersion = 0

  /**
   * Browser halves that polled within the connection window.
   * @returns how many browser halves are connected.
   */
  const livePollers = () => {
    const cutoff = Date.now() - POLLER_TTL_MS
    for (const [id, at] of pollers) {
      if (at < cutoff) pollers.delete(id)
    }
    return pollers.size
  }

  /**
   * Hold one activation for the browser halves that ask for it next.
   * @param workspace - the activated workspace.
   */
  const holdActivation = (workspace) => {
    activationVersion += 1
    pending = {
      version: activationVersion,
      at: Date.now(),
      payload: {
        type: 'open',
        workspaceId: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
      },
    }
  }

  /**
   * Reject a request that is not a token-bearing loopback call.
   * @param request - incoming node:http request.
   * @param response - response the rejection is written to.
   * @returns whether the request may proceed.
   */
  const guard = (request, response) => {
    // Every route starts here, so a dropped peer can never throw into the server.
    surviveDisconnect(response)
    if (!isLoopbackRequest(request)) {
      response.writeHead(403)
      response.end('forbidden')
      return false
    }
    const header = request.headers.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
    // The query form covers callers that cannot set a header, such as a browser
    // opened on the URL `GET /url` returns.
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined
    if (!tokenMatches(bearer, token) && !tokenMatches(query, token)) {
      response.writeHead(401)
      response.end('unauthorized')
      return false
    }
    return true
  }

  const handleOpen = async (request, response) => {
    if (!guard(request, response)) return
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'use POST' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const path = body?.path
    if (typeof path !== 'string' || path.trim() === '' || !isAbsolute(path)) {
      sendJson(response, 400, { ok: false, error: 'body must be {"path":"<absolute directory>"}' })
      return
    }
    // `create` is idempotent per canonical path; membership is decided by the
    // registry order before the call, so `created` reports this call's effect.
    const known = new Set(registry.list().map(workspace => String(workspace.id)))
    try {
      const workspace = await registry.create(path)
      const created = !known.has(String(workspace.id))
      holdActivation(workspace)
      sendJson(response, 200, {
        ok: true,
        created,
        workspaceId: String(workspace.id),
        path: workspace.path,
        title: workspace.title,
      })
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleRemove = async (request, response) => {
    if (!guard(request, response)) return
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'use POST' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    let id = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined
    if (id === undefined && typeof body?.path === 'string') {
      const match = registry.list().find(workspace => workspace.path === body.path)
      id = match === undefined ? undefined : String(match.id)
    }
    if (id === undefined) {
      sendJson(response, 404, { ok: false, error: 'no such workspace' })
      return
    }
    const removed = await registry.delete(id)
    // The workspace left again before any browser half acted on it.
    if (removed && pending !== undefined && pending.payload.workspaceId === id) pending = undefined
    sendJson(response, removed ? 200 : 404, { ok: removed, workspaceId: id })
  }

  const handleHealth = (request, response) => {
    if (!guard(request, response)) return
    // `browsers` lets a caller tell "added, and a UI is listening" apart from
    // "added, but nobody is there to switch" — the second needs a page reload.
    sendJson(response, 200, { ok: true, pid: process.pid, port: ctx.webServer.port, browsers: livePollers() })
  }

  const handleStop = (request, response) => {
    if (!guard(request, response)) return
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'use POST' })
      return
    }
    sendJson(response, 200, { ok: true, pid: process.pid, port: ctx.webServer.port })
    // The launcher turns SIGTERM into an orderly teardown that exits 0, so the
    // caller gets its reply first and the process leaves after it.
    setTimeout(() => { process.emit('SIGTERM') }, 100)
  }

  const handlePoll = async (request, response) => {
    if (!guard(request, response)) return
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'use POST' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    }
    const id = typeof body?.id === 'string' && body.id !== '' ? body.id : 'anonymous'
    pollers.set(id, Date.now())
    // The hold expires on its own. A half that already acted reports the version
    // it acted on and is told nothing new, so no page re-navigates on every beat.
    if (pending !== undefined && Date.now() - pending.at > PENDING_TTL_MS) pending = undefined
    const since = typeof body?.since === 'number' && Number.isFinite(body.since) ? body.since : 0
    const activation = pending !== undefined && pending.version > since
      ? { ...pending.payload, version: pending.version }
      : null
    sendJson(response, 200, { ok: true, browsers: livePollers(), version: activationVersion, activation })
  }

  const handleUrl = (request, response) => {
    if (!guard(request, response)) return
    // The connection service mints this process's launch token into the URL, so
    // a browser without a session cookie still authenticates. Without that
    // service the plain origin works for a browser that already has the cookie.
    const base = `http://127.0.0.1:${String(ctx.webServer.port)}/`
    const connection = ctx.get('connection')
    let url = base
    if (connection !== undefined && typeof connection.authenticatedUrl === 'function') {
      try {
        url = connection.authenticatedUrl(base)
      } catch (error) {
        ctx.logger.warn(`open-workspace: could not mint an authenticated URL: ${String(error)}`)
      }
    }
    sendJson(response, 200, { ok: true, url })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/open`, handler: handleOpen }),
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/remove`, handler: handleRemove }),
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/stop`, handler: handleStop }),
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/poll`, handler: handlePoll }),
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/health`, handler: handleHealth }),
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/url`, handler: handleUrl }),
    ]
    const port = ctx.webServer.port
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify({
        version: 1,
        pid: process.pid,
        port,
        host: ctx.webServer.host,
        basePath: BASE_PATH,
        url: `http://127.0.0.1:${String(port)}${BASE_PATH}`,
        token,
        startedAt: Date.now(),
      }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      if (process.platform !== 'win32') chmodSync(stateFile, 0o600)
    } catch (error) {
      ctx.logger.warn(`open-workspace: could not write ${stateFile}: ${String(error)}`)
    }
    ctx.logger.info(`open-workspace: listening on http://127.0.0.1:${String(port)}${BASE_PATH}`)
    return () => {
      for (const dispose of disposers) dispose()
      pollers.clear()
      try {
        rmSync(stateFile, { force: true })
      } catch (error) {
        ctx.logger.warn(`open-workspace: could not remove ${stateFile}: ${String(error)}`)
      }
    }
  }, 'open-workspace: routes')

  // The browser half authenticates with this token, injected into the served
  // index ahead of the shell bundle.
  ctx.on('webserver/index-inject', (table) => {
    table.push({
      kind: 'global',
      name: '__DSH_OPEN_WORKSPACE__',
      value: { poll: `${BASE_PATH}/poll`, token },
    })
  })

  // A server that leaves without a word is otherwise undiagnosable from the
  // outside: this records the signal, the fault, or the plain exit beside the
  // rendezvous file. Registered as an effect, so a reload takes it with the fiber.
  ctx.effect(() => {
    const exitLog = join(dirname(stateFile), 'dsh-open-host.log')
    const record = (kind, detail) => {
      try {
        appendFileSync(exitLog, `${new Date().toISOString()} pid ${String(process.pid)} ${kind}: ${detail}\n`)
      } catch {
        // Losing the diagnostic is not worth failing the server over.
      }
    }
    const onExit = (code) => { record('exit', String(code)) }
    const onFault = (fault) => {
      record('fault', fault instanceof Error ? (fault.stack ?? fault.message) : String(fault))
      // Step aside so node's own reporting and exit status are unchanged.
      process.off('uncaughtException', onFault)
      process.off('unhandledRejection', onFault)
      throw fault
    }
    // node calls a signal listener with no arguments, so the name is closed over.
    const signalListeners = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].map(signal => [
      signal,
      () => { record('signal', signal) },
    ])
    process.on('exit', onExit)
    process.on('uncaughtException', onFault)
    process.on('unhandledRejection', onFault)
    for (const [signal, listener] of signalListeners) process.on(signal, listener)
    return () => {
      process.off('exit', onExit)
      process.off('uncaughtException', onFault)
      process.off('unhandledRejection', onFault)
      for (const [signal, listener] of signalListeners) process.off(signal, listener)
    }
  }, 'open-workspace: diagnostics')
}
