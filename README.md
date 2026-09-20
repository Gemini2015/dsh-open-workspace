# dsh-open-workspace

在浏览器之外添加并激活 DSH Web 工作区：可以来自命令行，也可以来自 Windows 资源管理器的右键菜单。

[中文](README.md) | [English](README.en.md)

这里不修改 DeepSeek Harness 源码树。整个功能就是这个包：一个宿主半侧、一个浏览器半侧、一个 CLI 和一个焦点助手。

| 文件 | 作用 |
|---|---|
| `host.mjs` | 宿主半侧：HTTP 端点、激活轮询、会合文件 |
| `lib/client.js` | 浏览器半侧：轮询激活，打开工作区 |
| `cli.mjs` | `dsh-open`：找到或启动一个实例，然后调用宿主半侧 |
| `focus-window.ps1` | Windows：把显示 Web GUI 的浏览器窗口提到前台，或新开一个页签 |
| `dsh-open.cmd` | `dsh-open` 的 Windows 包装 |
| `cordis.patch.yml` | 本包的 bundle 补丁：挂载两半的那一行 |
| `install.ps1` | 离线安装：建链接 + 写加载行（`-Remove` 卸载） |
| `install-context-menu.ps1` | 添加/移除资源管理器右键项（仅 HKCU） |

## 安装

前提：Node ≥ 22，以及可用的 dsh CLI（下面统一用 `npx -y @deepseek-ai/dsh` 调用；`dsh` 已经在 `PATH` 上时可以把它换成 `dsh`）。焦点提升只在 Windows 有效，其他平台照常可用，只是不去提升窗口。

### 方式一：从 GitHub 安装（推荐）

```sh
npx -y @deepseek-ai/dsh plugin --profile web add github:Gemini2015/dsh-open-workspace
```

包内自带 `cordis.patch.yml`，并在 `package.json` 里声明了 `dsh.bundle.patch`，所以 profile 会**自动把它挂成一层**——不需要手改任何补丁文件。它没有 `prepare` 构建脚本（纯 JS，装完即用），也没有任何依赖，因此不需要 pnpm ≥10 的 `allowBuilds` 批准。建议按官方做法钉住提交：`github:Gemini2015/dsh-open-workspace#<commit-sha>`。

### 方式二：从本地目录安装（开发）

```sh
git clone https://github.com/Gemini2015/dsh-open-workspace C:\dev\dsh-open-workspace
cd C:\dev\dsh-open-workspace
npx -y @deepseek-ai/dsh plugin --profile web add .
```

本地目录是**链接**安装：改完源码直接生效，不用重新安装（重启 `dsh web` 让宿主半侧换新）。本包没有依赖，所以不需要先跑 `pnpm install`。

### 方式三：离线压缩包（不需要 pnpm，也不需要联网）

把目录解压到任意位置（例如 `C:\dev\dsh-open-workspace`），然后：

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\dsh-open-workspace\install.ps1
```

脚本做两件事：在 `$DSH_HOME\profiles\node_modules` 下建一个指向该目录的链接，并把加载行写进 `$DSH_HOME\profiles\web\cordis.patch.yml`。两者都幂等，修改用户文件前会先备份；不需要管理员权限。`-ContextMenu` 顺带装资源管理器右键项，`-Remove` 卸载。

> 三种方式**只选一条**。方式一和方式二由 bundle 自动挂载加载行，方式三写的是用户补丁层；两条同时存在会插入重复的插件 id。

### 验证

```sh
npx -y @deepseek-ai/dsh --profile web --dump-config   # 组合树里应出现 dsh-open-workspace
```

或者 `dsh-open --status`：有实例在运行时退出码 0 并打印一行（还没把目录加进 `PATH` 时用 `.\dsh-open.cmd --status`）。

### 可选：命令行与右键菜单

把插件目录加进 `PATH`，任意 shell 里就能直接用 `dsh-open`。`dsh-open.cmd` 用 `%~dp0cli.mjs` 调用同目录的 CLI，所以它不能单独复制到别处——要在别处放一个入口，就让那个入口指向本目录里的绝对路径。

Windows 资源管理器右键项：

```powershell
powershell -ExecutionPolicy Bypass -File C:\dev\dsh-open-workspace\install-context-menu.ps1
```

## 使用

```sh
cd C:\work\some-project
dsh-open .                    # 注册并激活当前目录
dsh-open C:\work\other        # 注册并激活另一个目录
dsh-open --status             # 是否已有带插件的实例在运行？
dsh-open --stop               # 关掉那个实例
dsh-open --forget .           # 取消注册
dsh-open --no-start .         # 绝不启动服务器，直接失败
dsh-open --launch "dsh web" . # 指定启动命令
dsh-open --focus tab .        # 总是新开页签，不去提升已有窗口
```

没有带插件的实例在运行时，`dsh-open` 会在目标目录里启动 `dsh web`，等它的会合文件（rendezvous file）出现，并在等待期间报告进度。它先试 `dsh web`，再回退到 `npx -y @deepseek-ai/dsh web`。启动命令退出、无法创建、或始终没有写出会合文件时，会连同它自己捕获的输出一起报告（`$DSH_HOME/dsh-open-server.log`），而不是无声地等下去。用 `--launch` 换命令，用 `--timeout` 改单个启动命令的等待时长，用 `--no-start` 禁止启动。

添加一个已经是工作区的目录是空操作：注册表先做规范路径解析，所以大小写、结尾分隔符以及 `.` 或 `..` 片段都会落到同一个工作区，`dsh-open` 报告 `already present`。不是已存在目录的路径会被拒绝。

激活不会因为时序而丢失。宿主把最后一次激活保留两分钟，在这段时间里向**每一个**来问的浏览器半侧都发一份——无论是服务器自己打开的那个页面，还是焦点步骤随后移到前面的那个页签，谁先来问都算。已经动作过的半侧会带上它动作过的版本号，因此不会被每一拍都送回同一个工作区。浏览器半侧另外还会把 `openWorkspace` 重试几秒，因为 `connectWorkspace` 会拒绝页面还没同步到的工作区 id。于是两种顺序都成立：先有页面，或先有工作区。

浏览器半侧按秒轮询，而不是长期持有一条事件流——这不是风格问题。一个页面在同一个源上只有六条并发 HTTP/1.1 连接，而 Web 界面已经用掉其中一条给永不结束的热重载流；每个页签再长期占用一条，页面自己的请求就不够用了，新开的页签和刷新会双双卡住，而服务器对所有探针都照常应答。这也是多余页签值得关掉的原因：每个页签都要占一条连接。

`dsh-open` 绝不会往一个活着的端口上再起第二个服务器。端口已经有人应答、而会合文件又通不过它的认证，说明文件是陈旧的，或者运行中的服务器里没有这个插件——CLI 会报告这一点并停下，而不是去启动一个绑不上端口、还会让会合文件指向一个从未监听的进程的 `dsh web`。`--launch` 会跳过这项检查，因为自己写出命令就是要明确地运行它。

服务器离场时会把离场方式记在 `$DSH_HOME/dsh-open-host.log`：收到的信号、终结它的故障，或退出码。被操作系统直接杀掉时不会写任何东西——这本身就是答案。

`--stop` 关闭会合文件指向的那个实例，无论它是谁启动的。由 `dsh-open` 启动的服务器是刻意脱离终端的——它们比启动它们的那个终端活得更久——这也是在那个终端里按 Ctrl+C 管不到它们的原因。想让服务器留在自己的终端下，就自己启动 `dsh web`，再运行 `dsh-open .`：它会找到正在运行的实例，而不是另起一个。

打开成功后，`dsh-open` 会把浏览器送到你面前。页面自己做不到这件事——浏览器拒绝跨应用焦点——所以由 CLI 来做，因为它是你自己的操作启动的进程。`--focus auto`（默认）把标题显示 Web GUI 的那个浏览器窗口提到前台，没有任何窗口显示它时就新开一个页签；`--focus tab` 总是新开页签；`--focus off` 两者都不做。判断依据是窗口标题，而浏览器只把**活动页签**的标题写在那里，所以同一窗口里被别的页签挡住的 GUI 页签，与完全没有 GUI 页签无法区分——这种情况会新开页签。页面在加载完成之前没有标题，因此在还没有任何浏览器半侧连上时，助手会先找四秒再决定是否开页签；那正是刚启动的服务器还在把自己的页面拉起来的窗口期。只匹配浏览器进程，所以文档或编辑器窗口不会被误提升。它新开的页签带着宿主为它签发的令牌（bearer token），所以即使浏览器没有会话 cookie 也能通过认证。

提升被拒绝时——在右键菜单之后这是常态，因为 Windows 前台锁不接受这个进程的抢占——助手改为把窗口抬到 Z 序最前并如实报告，而不是去开页签。用户要的就是一个显示 Web GUI 的窗口，而多一个页签要多占一条连接；只有完全没有窗口显示它时才开页签。

在资源管理器里右键一个文件夹（或其空白处）→ **通过 DSH 打开**。

## 用 harness 的话说，它做了什么

- `POST /dsh-open/open` 调用 `ctx.workspaceRegistry.create(path)`——与 GUI 的目录选择器是同一次调用。它要求一个已存在的绝对目录，按规范路径幂等，新工作区会立刻通过普通的工作区推送出现在每个打开的侧边栏里。
- 浏览器半侧调用 `ctx.uiWorkspace.openWorkspace(id)`——与侧边栏执行的是同一次导航，包括复用或创建该工作区的空白会话。
- `POST /dsh-open/poll` 是宿主到浏览器的通道；它存在是因为 harness 没有服务端推送的导航原语。最后一次激活会被保留，并在保留期内发给每一个来问的半侧，这正是"先启动服务器、再打开工作区"两种顺序都成立的原因。每个半侧会带上它上次动作过的版本号，所以每一拍都不会重复。
- `GET /dsh-open/url` 返回 `ctx.connection.authenticatedUrl(origin)`，也就是启动器打印的那个带令牌的 URL。CLI 在必须新开页签时打开的就是它，因此那个页签无需会话 cookie 即可认证，也不要求服务器是 CLI 自己启动的。

## 安全

这个端点能把任意本地目录注册为工作区，而工作区正是 agent 以写权限运行的地方。因此它被这样围起来：

- 对端地址必须是回环（loopback）地址，且 `Host` 头必须是回环权威（DNS rebinding 防护），所以 `--host 0.0.0.0` 的部署不会把它暴露出去；
- 每个请求都需要本进程的 bearer 令牌，同时任何路由也接受 `?token=`，供无法设置请求头的调用方使用（例如浏览器地址栏）；
- 令牌保存在 `$DSH_HOME/open-workspace.json`，以 `0600` 写入，插件卸载时删除；
- 令牌还会作为 `__DSH_OPEN_WORKSPACE__` 注入到所服务的索引里，因此任何已经能在 GUI 里执行脚本的页面都能读到它。这不是新的权限，但它正是这个端点还要拒绝非回环对端、而不只依赖令牌的原因。

## 疑难

- **`dsh-open` 拒绝启动服务器，说端口已经有人应答。** 这是故意的：往活着的端口上再起一个 `dsh web` 绑不上端口，只会留下一个指向从未监听的进程的会合文件。按提示重启那个服务器，或删掉陈旧的 `$DSH_HOME/open-workspace.json` 再试；确实知道自己在做什么时用 `--launch` 跳过这项检查。
- **新开的页签一直转圈、刷新也转圈，但服务器明明在跑。** 浏览器对同一个源只给六条并发 HTTP/1.1 连接，而 GUI 每个页签都要长期占用一条热重载连接；页签足够多就把配额用光，此后任何新请求都排不上队（服务器本身对所有探针照常应答）。关掉多余页签即可；插件自己已经不占用连接。
- **右键之后窗口没到前台。** 在资源管理器右键菜单之后这是常态：Windows 前台锁不允许这个进程抢焦点。助手会改为把窗口抬到 Z 序最前（日志里是 `could not take focus; brought it to the front`），并且不会为此新开页签。
- **从 GitHub 安装报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。** 那是 git/curl 校验 GitHub 证书链失败（系统时钟不对、git 用了 OpenSSL 后端而 CA 不全、或有代理拦截 TLS），与插件无关。可以先试 `git config --global http.sslBackend schannel`；跳不过去就改用方式二（本地 clone）、方式三（解压后跑脚本），或打上 tag 之后用 tarball 安装（见"开发与发布"）。

## 已知限制

- 最后一跳——`openWorkspace` 真正切换可见页签——属于 harness 的导航代码，需要真实浏览器才能观察。
- 保留期内的激活会送达每一个来问的浏览器半侧，所以在这两分钟里因为任何原因新开的页签都会落到那个工作区。
- GUI 每个页签都长期持有一条用于热重载的 HTTP 连接，而浏览器对同一个源只允许六条，所以页签足够多时，新开页签和刷新会一起卡住。插件自己不再占用连接，但它也没法替页面让出一条。
- 插件页用模块短名做标题，并会去掉开头的 `dsh-`，所以那一行显示的是 `open-workspace`，尽管包名是 `dsh-open-workspace`；它下面的条目 id 带着完整名字。
- 焦点步骤只在 Web GUI 是某个窗口的活动页签时才能找到它。没有窗口显示它时 CLI 会新开页签，所以把 GUI 一直放在后台页签里，每运行一次就多一个页签。
- 焦点功能仅限 Windows。其他平台上 CLI 用 `open` 或 `xdg-open` 打开 URL，由它们自己把浏览器调起来。
- 每个 `$DSH_HOME` 只有一个会合文件：同一个 home 下不同端口上的多个实例，最后启动的那个拥有发现权。
- 这个插件面向的是 pre-stable 阶段的 harness API（`webServer.register`、`workspaceRegistry.create`、`uiWorkspace.openWorkspace`、`webserver/index-inject`）。harness 升级后这里可能需要跟着改；CLI 会明确失败，而不是悄悄降级。

## 开发与发布

- 本地开发：`git clone https://github.com/Gemini2015/dsh-open-workspace C:\dev\dsh-open-workspace`，再 `npx -y @deepseek-ai/dsh plugin --profile web add C:\dev\dsh-open-workspace`。链接安装，改完源码重启 `dsh web` 即生效。
- 仓库结构：`host.mjs` 与 `lib/client.js` 是插件的两半，`cordis.patch.yml` 是挂载它们的 bundle 补丁，`cli.mjs` + `focus-window.ps1` + `dsh-open.cmd` 是浏览器之外的入口，`install.ps1` 是离线安装。
- 发布：推上 GitHub 后给仓库加上 `dsh-plugin` 话题（便于被发现），然后打 tag：`git tag v0.1.0 && git push origin v0.1.0`。有了 tag，既能用上面"钉住提交"的写法，也能用 tarball 安装：`npx -y @deepseek-ai/dsh plugin --profile web add https://github.com/Gemini2015/dsh-open-workspace/archive/refs/tags/v0.1.0.tar.gz`。
- 可选：`npm publish` 之后，别人可以直接 `dsh plugin --profile web add dsh-open-workspace`。

## 许可

[MIT](LICENSE)
