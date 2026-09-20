# dsh-open-workspace

Add and activate a DSH Web workspace from outside the browser: from a shell, or
from a Windows Explorer right-click.

[中文](README.md) | [English](README.en.md)

Nothing here modifies the DeepSeek Harness source tree. The whole feature is this
package: a host half, a browser half, a CLI, and a window-focus helper.

| File | Role |
|---|---|
| `host.mjs` | Host half: HTTP endpoints, the activation poll, the rendezvous file |
| `lib/client.js` | Browser half: polls for an activation, opens the workspace |
| `cli.mjs` | `dsh-open`: finds or starts an instance, then calls the host half |
| `focus-window.ps1` | Windows: raises the browser window showing the GUI, or opens a tab |
| `dsh-open.cmd` | Windows shim for `dsh-open` |
| `cordis.patch.yml` | This package's bundle patch: the row mounting both halves |
| `install.ps1` | Offline install: link plus loader row (`-Remove` uninstalls) |
| `install-context-menu.ps1` | Adds/removes the Explorer right-click entry (HKCU only) |

## Install

Requirements: Node ≥ 22 and a working dsh CLI (written below as
`npx -y @deepseek-ai/dsh`; with `dsh` already on `PATH`, use `dsh` instead). The
focus step is Windows-only; everywhere else the plugin works and simply does not
raise a window.

### From GitHub (recommended)

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:Gemini2015/dsh-open-workspace
```

The package ships `cordis.patch.yml` and declares `dsh.bundle.patch` in
`package.json`, so the profile mounts it as a layer by itself — no patch file has
to be edited by hand. It has no `prepare` build script (plain JS, usable as
installed) and no dependencies at all, so no pnpm ≥10 `allowBuilds` approval is
needed. Pinning to a commit is recommended as in the official docs:
`github:Gemini2015/dsh-open-workspace#<commit-sha>`.

### From a local directory (development)

```sh
git clone https://github.com/Gemini2015/dsh-open-workspace C:\dev\dsh-open-workspace
cd C:\dev\dsh-open-workspace
npx -y @deepseek-ai/dsh plugin --profile web add .
```

A local directory is installed as a **link**: edits take effect directly and no
reinstall is needed (restart `dsh web` to swap the host half). This package has no
dependencies, so `pnpm install` is not required first.

### From an offline archive (no pnpm, no network)

Unpack the directory anywhere (for example `C:\dev\dsh-open-workspace`), then:

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\dsh-open-workspace\install.ps1
```

The script does two things: it links
`$DSH_HOME\profiles\node_modules\dsh-open-workspace` to that directory, and writes
the loader row into `$DSH_HOME\profiles\web\cordis.patch.yml`. Both steps are
idempotent, a user file is backed up before it is edited, and no administrator
rights are needed. `-ContextMenu` adds the Explorer entry too; `-Remove` uninstalls.

> Pick **one** of the three routes. The first two mount the loader row through the
> bundle; the third writes it into the user patch layer. Using both inserts the
> same plugin id twice.

### Verify

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config   # the composed tree should list dsh-open-workspace
```

Or `dsh-open --status`: exit 0 and one line while an instance is running (use
`.\dsh-open.cmd --status` before the directory is on `PATH`).

### Optional: command line and context menu

Adding the plugin directory to `PATH` makes `dsh-open` available in any shell.
`dsh-open.cmd` calls the CLI beside it through `%~dp0cli.mjs`, so it cannot be
copied elsewhere on its own — an entry point elsewhere has to name this
directory's absolute path.

Windows Explorer entry:

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\dsh-open-workspace\install-context-menu.ps1
```

## Use

```sh
cd C:\work\some-project
dsh-open .                    # register + activate this directory
dsh-open C:\work\other        # register + activate another directory
dsh-open --status             # is an instrumented instance running?
dsh-open --stop               # shut that instance down
dsh-open --forget .           # unregister
dsh-open --no-start .         # never start a server; fail instead
dsh-open --launch "dsh web" . # choose the start command
dsh-open --focus tab .        # always open a browser tab, never raise one
```

When no instrumented instance is running, `dsh-open` starts `dsh web` in the
target directory and waits for its rendezvous file, reporting progress while it
waits. It tries `dsh web` first and falls back to
`npx -y @deepseek-ai/dsh web`. A launcher that exits, cannot be spawned, or never
publishes a rendezvous file is reported with its own captured output
(`$DSH_HOME/dsh-open-server.log`) instead of a silent wait. Override the command
with `--launch`, the per-launcher wait with `--timeout`, or disable starting with
`--no-start`.

Adding a directory that is already a workspace is a no-op: the registry resolves
the canonical path first, so casing, trailing separators, and `.` or `..` segments
all land on the same workspace and `dsh-open` reports `already present`. A path
that is not an existing directory is refused.

An activation is never lost to timing. The host holds the last activation for two
minutes and reports it to *every* browser half that asks while the hold is fresh —
the page the server opened, and the tab the focus step moves forward afterwards,
whichever of them asks first. A half that already acted reports the version it
acted on, so it is never sent back to the same workspace on every beat. The browser
half additionally retries `openWorkspace` for a few seconds, because
`connectWorkspace` refuses a workspace id the page has not synced yet. Both orders
therefore work: page first, or workspace first.

The browser halves poll once a second rather than holding a stream open, and that
is not a style choice. A page gets six concurrent HTTP/1.1 connections per origin,
and the Web UI already spends one of them on a hot-reload stream that never
completes; a second permanent connection per tab leaves too few for the page's own
requests, so a newly opened tab and a reload stall while the server keeps answering
every probe. It is also why extra tabs are worth closing: each one costs a
connection.

`dsh-open` never starts a second server onto a live port. A port that already
answers while the rendezvous file does not authenticate against it means the file
is stale or the running server has no plugin — the CLI reports that and stops
instead of launching a `dsh web` that cannot bind and would leave the file pointing
at a process that never listened. `--launch` skips this check, since naming the
command yourself is an explicit instruction to run it.

A server that leaves records how it left in `$DSH_HOME/dsh-open-host.log`: the
signal it received, the fault that ended it, or the exit code. Nothing is written
when the OS kills it outright, which is itself the answer.

`--stop` shuts down the instance the rendezvous file points at, whoever started it.
Servers started by `dsh-open` are deliberately detached — they outlive the terminal
that launched them — which is also why Ctrl+C in that terminal does not reach them.
To keep a server under your own terminal, start `dsh web` yourself and then run
`dsh-open .`: it finds the running instance instead of starting one.

After a successful open, `dsh-open` puts the browser in front of you. A page cannot
do that for itself — browsers refuse cross-application focus — so the CLI does it,
as the process your own action started. `--focus auto` (the default) raises the
browser window whose title shows the GUI, and opens the GUI in a new tab when no
window shows it; `--focus tab` always opens a tab; `--focus off` does neither.
Detection reads window titles, and a browser puts only the active tab's title
there, so a GUI tab sitting behind another tab in the same window is
indistinguishable from no GUI tab at all — that case opens the new tab. A page has
no title until it has loaded, so while no browser half is connected yet the helper
keeps looking for four seconds before it opens a tab; that is the window in which a
server that was just started is still bringing its own page up. Only browser
processes are matched, so a document or editor window cannot be raised by accident.
The tab it opens carries the token the host mints for it, so it authenticates even
in a browser with no session cookie.

When the raise is refused — the usual outcome behind a context menu, where the
Windows foreground lock does not accept this process's claim — the helper lifts the
window to the top of the Z-order instead and reports that, rather than opening a
tab. A window showing the GUI is what was wanted, and an extra tab costs a
connection; a tab is opened only when no window shows the GUI at all.

From Explorer, right-click a folder (or its background) → **通过 DSH 打开**.

## What it does, in harness terms

- `POST /dsh-open/open` calls `ctx.workspaceRegistry.create(path)` — the same call
  the GUI's directory picker makes. It requires an existing absolute directory, is
  idempotent per canonical path, and the new workspace reaches every open sidebar
  immediately through the ordinary workspace feed.
- The browser half calls `ctx.uiWorkspace.openWorkspace(id)` — the same navigation
  the sidebar performs, including reusing or creating that workspace's blank
  session.
- `POST /dsh-open/poll` is the host→browser channel; it exists because the harness
  has no server-push navigation primitive. The last activation is held and reported
  to every half that asks while the hold is fresh, which is what makes "start the
  server, then open the workspace" work in either order. Each half sends the version
  it last acted on, so a beat never repeats one.
- `GET /dsh-open/url` returns `ctx.connection.authenticatedUrl(origin)`, the same
  token-bearing URL the launcher prints. That is what the CLI opens when it has to
  raise the browser in a new tab, so the tab authenticates without a session cookie
  and without the CLI having started the server itself.

## Security

The endpoint can register an arbitrary local directory as a workspace, and a
workspace is where an agent runs with write access. It is fenced accordingly:

- the peer address must be loopback, and the `Host` header must be a loopback
  authority (DNS-rebinding fence), so an `--host 0.0.0.0` deployment does not expose
  it;
- every request needs the per-process bearer token, and any route also accepts
  `?token=` for callers that cannot set a header (a browser address bar);
- the token lives in `$DSH_HOME/open-workspace.json`, written `0600` and removed
  when the plugin unloads;
- the token is also injected into the served index as `__DSH_OPEN_WORKSPACE__`, so
  any page that can already run script in the GUI can read it. That is not a new
  privilege, but it is the reason the endpoint also refuses non-loopback peers
  rather than relying on the token alone.

## Troubleshooting

- **`dsh-open` refuses to start a server, saying the port already answers.** That is
  deliberate: a second `dsh web` onto a live port cannot bind and would leave a
  rendezvous file pointing at a process that never listened. Restart that server, or
  delete a stale `$DSH_HOME/open-workspace.json` and retry; `--launch` skips the
  check when you know what you are doing.
- **A new tab spins forever, and so does a reload, while the server is clearly
  running.** A browser allows six concurrent HTTP/1.1 connections per origin and
  every GUI tab holds one of them open for hot reload; enough tabs exhaust the
  budget, and then every new request waits (the server itself still answers every
  probe). Close the extra tabs; the plugin no longer spends a connection of its own.
- **The window does not come forward after a right-click.** That is the usual outcome
  behind a context menu: the Windows foreground lock refuses this process's claim.
  The helper lifts the window to the top of the Z-order instead (the log says
  `could not take focus; brought it to the front`) and does not open a tab for it.
- **Installing from GitHub fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.** That is
  git/curl failing to validate GitHub's certificate chain (wrong system clock, git on
  the OpenSSL backend with an incomplete CA bundle, or a TLS-intercepting proxy) and
  is unrelated to this plugin. Try `git config --global http.sslBackend schannel`;
  if that does not help, use the local-clone or offline-archive route above, or
  install from a tarball once a tag exists (see Development and publishing).

## Known limitations

- The last hop — `openWorkspace` actually switching the visible tab — is harness
  navigation code and needs a real browser to observe.
- A held activation reaches every browser half that asks within its two minutes, so
  a tab opened for any reason in that window lands on that workspace.
- Every GUI tab holds a permanent HTTP connection for hot reload and a browser
  allows six per origin, so enough of them stall a new tab and a reload together.
  The plugin adds no connection of its own, but it cannot lend one either.
- The plugin page titles each row with the module short name and drops a leading
  `dsh-`, so the row reads `open-workspace` there even though the package is
  `dsh-open-workspace`; the entry id below it carries the full name.
- The focus step only finds the GUI while it is the active tab of some window. When
  no window shows it, the CLI opens a tab, so a GUI kept in a background tab
  accumulates one tab per run.
- Focus is Windows-only. Elsewhere the CLI opens the URL with `open` or `xdg-open`,
  which raises the browser on its own.
- One rendezvous file per `$DSH_HOME`: with several instances on different ports
  under one home, the last one to start owns discovery.
- The plugin targets pre-stable harness APIs (`webServer.register`,
  `workspaceRegistry.create`, `uiWorkspace.openWorkspace`,
  `webserver/index-inject`). A harness upgrade can require an update here; the CLI
  fails loudly rather than silently degrading.

## Development and publishing

- Local development: `git clone https://github.com/Gemini2015/dsh-open-workspace C:\dev\dsh-open-workspace`, then `npx -y @deepseek-ai/dsh plugin --profile web add C:\dev\dsh-open-workspace`. It installs as a link, so a source edit takes effect after restarting `dsh web`.
- Layout: `host.mjs` and `lib/client.js` are the two halves, `cordis.patch.yml` is the bundle patch mounting them, `cli.mjs` + `focus-window.ps1` + `dsh-open.cmd` are the out-of-browser entry points, and `install.ps1` is the offline installer.
- Publishing: after pushing to GitHub, add the `dsh-plugin` topic (discoverability) and tag a version: `git tag v0.1.0 && git push origin v0.1.0`. A tag enables both the pinned install above and a tarball install: `npx -y @deepseek-ai/dsh plugin --profile web add https://github.com/Gemini2015/dsh-open-workspace/archive/refs/tags/v0.1.0.tar.gz`.
- Optional: after `npm publish`, users can install with `dsh plugin --profile web add dsh-open-workspace`.

## License

[MIT](LICENSE)
