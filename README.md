# dsh-open-workspace

在浏览器之外添加并激活 DSH Web 工作区：可以来自命令行，也可以来自 Windows 资源管理器的右键菜单。

这里不修改 DeepSeek Harness 源码树。整个功能只是用户补丁层里的一行，加上这个目录：

| 文件 | 作用 |
|---|---|
| `host.mjs` | 宿主半侧：HTTP 端点、激活轮询、会合文件 |
| `lib/client.js` | 浏览器半侧：轮询激活，打开工作区 |
| `cli.mjs` | `dsh-open`：找到或启动一个实例，然后调用宿主半侧 |
| `focus-window.ps1` | Windows：把显示 Web GUI 的浏览器窗口提到前台，或新开一个页签 |
| `dsh-open.cmd` | CLI 的 Windows 包装 |
| `install-context-menu.ps1` | 添加/移除资源管理器右键项（仅 HKCU） |
| `cordis.patch.example.yml` | 需要追加到你的 profile 的补丁行 |

## 安装

1. 把这个目录放在 harness 检出之外，例如 `%USERPROFILE%\.dsh\plugins\dsh-open-workspace\`。

2. 让这个目录能以包名 `dsh-open-workspace` 被解析，然后把 `cordis.patch.example.yml` 里的那一行追加到你的 profile 补丁层（`$DSH_HOME/profiles/web/cordis.patch.yml`，初始内容是 `[]`）。两种做法任选其一——装成 profile 依赖：

   ```powershell
   npx -y @deepseek-ai/dsh plugin --profile web add "link:$env:USERPROFILE\.dsh\plugins\dsh-open-workspace"
   ```

   或者自己把它链接进安装回退目录（不需要管理员权限）：

   ```powershell
   New-Item -ItemType Junction -Force -Target "$env:USERPROFILE\.dsh\plugins\dsh-open-workspace" `
     -Path "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-open-workspace"
   ```

   两种做法都让 `node_modules/dsh-open-workspace` 成为指向插件目录的链接，因此改动直接生效，不需要重新安装；重跑链接命令用 `-Force`，它会替换已有链接（包括指向旧位置的）。要写成 `link:` 而不是 `file:`：`file:` 会把包复制进 pnpm 的虚拟 store，此后再编辑这个目录就不影响已安装的那一份。`dsh` 已经在 `PATH` 上时，第一条命令里的 `npx -y @deepseek-ai/dsh` 可以直接写成 `dsh`。

   补丁行里要写**包名**而不是路径：插件页用模块短名做每一行的标题，写路径就会把路径原样当成标题。web profile 的补丁层是实时重载的，所以正在运行的 `dsh web` 不需要重启就能挂上这一行。

3. 可选：把这个目录本身加进 `PATH`，这样任意 shell 里都能直接用 `dsh-open`。注意 `dsh-open.cmd` 是用 `%~dp0cli.mjs` 调用同目录的 CLI 的，所以它不能单独复制到别处——要在别处放一个入口，就让那个入口指向本目录里的绝对路径。

4. 可选，Windows 资源管理器：`powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\plugins\dsh-open-workspace\install-context-menu.ps1"`

用 `dsh-open --status` 验证（有实例在运行时退出码 0 并打印一行），或用 `dsh-open --no-start .`（补丁行缺失时会明确报错）；还没把这个目录加进 `PATH` 时，用 `.\dsh-open.cmd --status`。

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

## 已知限制

- 最后一跳——`openWorkspace` 真正切换可见页签——属于 harness 的导航代码，需要真实浏览器才能观察。
- 保留期内的激活会送达每一个来问的浏览器半侧，所以在这两分钟里因为任何原因新开的页签都会落到那个工作区。
- GUI 每个页签都长期持有一条用于热重载的 HTTP 连接，而浏览器对同一个源只允许六条，所以页签足够多时，新开页签和刷新会一起卡住。插件自己不再占用连接，但它也没法替页面让出一条。
- 插件页用模块短名做标题，并会去掉开头的 `dsh-`，所以那一行显示的是 `open-workspace`，尽管包名是 `dsh-open-workspace`；它下面的条目 id 带着完整名字。
- 焦点步骤只在 Web GUI 是某个窗口的活动页签时才能找到它。没有窗口显示它时 CLI 会新开页签，所以把 GUI 一直放在后台页签里，每运行一次就多一个页签。
- 焦点功能仅限 Windows。其他平台上 CLI 用 `open` 或 `xdg-open` 打开 URL，由它们自己把浏览器调起来。
- 每个 `$DSH_HOME` 只有一个会合文件：同一个 home 下不同端口上的多个实例，最后启动的那个拥有发现权。
- 这个插件面向的是 pre-stable 阶段的 harness API（`webServer.register`、`workspaceRegistry.create`、`uiWorkspace.openWorkspace`、`webserver/index-inject`）。harness 升级后这里可能需要跟着改；CLI 会明确失败，而不是悄悄降级。
