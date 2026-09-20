/**
 * Browser half of `dsh-open-workspace`.
 *
 * Learns which workspace the host half wants activated, and opens it through the
 * `uiWorkspace` service (the same navigation the sidebar uses).
 *
 * The host half is served with this file, but it only changes when the server
 * restarts, so both generations of the channel are supported: the poll route,
 * and the event stream it replaced. Which one to use is decided by the global the
 * running host half injects, so the halves cannot disagree.
 *
 * Polling is the current channel because a page gets six concurrent HTTP/1.1
 * connections per origin and already spends one on a never-completing hot-reload
 * stream. A second permanent one per tab leaves too few for the page's own
 * requests, which stalls a newly opened tab and a reload while the server stays
 * perfectly healthy. A poll is a request that ends.
 *
 * Hand-written bundle in the client module format: the factory receives the
 * module-table require and returns the plugin exports, so this file needs no
 * build step and requests no shared module.
 */

window.__ModuleLoader__.load({
  id: 'dsh-open-workspace',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports

    exports.name = 'open-workspace-client'

    // Cordis resolves this service before apply runs; ui-workspace provides it.
    exports.inject = ['uiWorkspace']

    /** Beat between polls; a hidden tab is throttled by the browser, which is fine. */
    const POLL_INTERVAL_MS = 1000

    exports.apply = (ctx) => {
      const config = globalThis.__DSH_OPEN_WORKSPACE__
      if (config === undefined || config === null) return
      let stopped = false
      /** Version of the last activation acted on, so a beat cannot repeat it. */
      let seen = 0
      ctx.effect(() => () => { stopped = true }, 'open-workspace: channel')

      /**
       * Open the workspace, retrying briefly.
       * `uiWorkspace.connectWorkspace` refuses an id the page has not synced
       * yet, which is exactly the case when the host names a workspace created
       * moments before this page finished loading. A bounded retry covers that
       * window; the attempt count keeps a real failure from retrying forever.
       * @param workspaceId - workspace to open.
       * @param attempt - retries already spent.
       */
      const open = (workspaceId, attempt) => {
        void Promise.resolve(ctx.uiWorkspace.openWorkspace(workspaceId)).catch(() => {
          if (attempt >= 6 || stopped) return
          setTimeout(() => { open(workspaceId, attempt + 1) }, 500)
        })
      }

      /**
       * Poll the host half for an activation this page has not acted on.
       * @param url - absolute poll route.
       */
      const poll = (url) => {
        // Identifies this page only so the host can count the halves that are live.
        const id = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
        const tick = async () => {
          if (stopped) return
          try {
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${String(config.token)}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ id, since: seen }),
            })
            if (response.ok) {
              const value = await response.json()
              const activation = value === null || value === undefined ? null : value.activation
              if (activation !== null && activation !== undefined && typeof activation.workspaceId === 'string') {
                if (typeof activation.version === 'number') seen = Math.max(seen, activation.version)
                open(activation.workspaceId, 0)
              }
            }
          } catch {
            // One missed beat is covered by the next; the page may also be closing.
          }
          if (!stopped) setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
        }
        void tick()
      }

      /**
       * Subscribe to the host half's event stream, the channel before polling.
       * @param url - absolute stream route.
       */
      const subscribe = (url) => {
        const controller = new AbortController()
        ctx.effect(() => () => controller.abort(), 'open-workspace: event stream')
        const activate = (payload) => {
          if (payload === null || typeof payload !== 'object') return
          if (payload.type !== 'open' || typeof payload.workspaceId !== 'string') return
          // A superseded or failing navigation must not kill the stream.
          open(payload.workspaceId, 0)
        }
        const consume = async () => {
          while (!controller.signal.aborted) {
            try {
              const response = await fetch(url, {
                headers: { authorization: `Bearer ${String(config.token)}`, accept: 'text/event-stream' },
                signal: controller.signal,
              })
              if (!response.ok || response.body === null) throw new Error(`stream status ${String(response.status)}`)
              const reader = response.body.getReader()
              const decoder = new TextDecoder()
              let buffer = ''
              while (!controller.signal.aborted) {
                const { value, done } = await reader.read()
                if (done) break
                buffer += decoder.decode(value, { stream: true })
                let boundary = buffer.indexOf('\n\n')
                while (boundary !== -1) {
                  const frame = buffer.slice(0, boundary)
                  buffer = buffer.slice(boundary + 2)
                  for (const line of frame.split('\n')) {
                    if (!line.startsWith('data:')) continue
                    try {
                      activate(JSON.parse(line.slice(5).trim()))
                    } catch {
                      // A frame that is not JSON is not ours; keep reading.
                    }
                  }
                  boundary = buffer.indexOf('\n\n')
                }
              }
            } catch {
              if (controller.signal.aborted) return
            }
            // The host restarted or the connection dropped: retry after a beat.
            await new Promise(resolve => setTimeout(resolve, 2000))
          }
        }
        void consume()
      }

      if (typeof config.poll === 'string') poll(new URL(config.poll, globalThis.location.origin).href)
      else if (typeof config.events === 'string') subscribe(new URL(config.events, globalThis.location.origin).href)
    }

    return module.exports
  },
})
