# Kimi Planbar TUI

[English](README.md)

一个终端常驻的仪表盘，让 [Kimi Code](https://www.kimi.com/code/) 套餐额度在终端里一目了然——5 小时窗口和每周用量，带重置倒计时。无托盘、无窗口、无动画，只是一个可以留在终端标签页里的轻量 TUI。

## 截图

仪表盘布局如下：

```
Kimi Planbar TUI                                    Updated 14:32

5-hour usage   21%  █████░░░░░░░░░░░░░░░  Resets in 4h 30m
Weekly usage   18%  ████░░░░░░░░░░░░░░░░  Resets in 5d 15h

Extra Usage    ¥12.34
  Used ¥45.67 this month / ¥100 limit

Kimi Code CLI  2.0.1   Update available

r Refresh · s Settings · k Skills · c Console · g Releases · q Quit
```

## 功能

- **终端常驻**——基于 ratatui 的全屏 TUI 仪表盘，任何现代终端都能跑；允许多实例（每个终端标签页开一个完全没问题）
- **额度一目了然**——5-hour 与 Weekly usage 两行文本进度条 + 重置倒计时，kimi CLI `/usage` 风格线框；数据与 CLI 的 `/usage` 同源
- **亮暗双主题**——Moonlit / Moondark truecolor 调色板，可跟随 Windows 系统主题（每 30 秒轮询一次），也可在设置里固定；强调色 `#1A88FF`
- **抗抖动刷新**——按设定间隔自动刷新（1/5/10/30 分钟）；失败时保留上一次成功的数据，30 秒后快速重试
- **CLI 版本检测**——显示本机 `kimi --version`；[kimi-code Releases](https://github.com/MoonshotAI/kimi-code/releases) 有新版时出现橙色徽章（按 `g` 直达发布页）。版本信息优先取自官方 changelog（GitHub API 兜底），GitHub 不可达也能正常工作
- **Extra Usage 行**——显示 booster 钱包余额（¥）与本月已用/上限；未充值过时优雅显示 "Not activated / No data"
- **Skills 速览**——按 `k` 打开只读列表：按来源分组展示 `~/.kimi-code/skills`、`~/.agents/skills` 与插件 skills 的名称和描述；只在打开时扫描一次并缓存，无后台轮询
- **绿色免 UAC**——单静态 exe（约 3–5 MB），仅操作用户域（自启走 HKCU，不碰 HKLM 和 Program Files）；在 exe 旁放一个空的 `portable.dat` 即切换为配置随身携带的便携模式（设置存到 exe 旁而非 `%APPDATA%\KimiPlanbarTui\`）

## 下载

从 [Releases](../../releases) 获取最新 `kimi-planbar-tui.exe`，或从源码构建（见下文）。同一页另有两个 **TS 版**：`kpt-tui.exe`（Bun + OpenTUI，内嵌 Bun 运行时，约 90 MB）与 `kpt-tui-node.exe`（Node 24 + 手写 ANSI，内嵌 Node 运行时，约 88.7 MB）——行为与界面完全一致。已装 Bun 或 Node ≥ 24.6 的用户也可以直接从源码运行，不下载 exe。

> exe 未做代码签名，首次运行 Windows SmartScreen 可能提示"已保护你的电脑"——点"更多信息 → 仍要运行"即可，这是未签名个人作品的正常提示。

## 使用前提

- Windows 10 / 11
- 现代终端——**Windows Terminal** 或 **VS Code 集成终端**为基准（truecolor + UTF-8）。legacy conhost 也能用，但需先 `chcp 65001`，否则方框字符和中文会乱码
- 已安装并登录 [Kimi Code](https://www.kimi.com/code/) CLI，且为 **Kimi For Coding** 套餐用户（程序从 `~/.kimi-code/credentials/kimi-code.json` 读取 CLI 的本地 OAuth token，兜底读 `~/.kimi-code/config.toml` 里的明文 api_key；两者均支持 `KIMI_CODE_HOME` 覆盖）
- 能访问 `api.kimi.com`

凭证不会被存储或发送到官方 `api.kimi.com/coding/v1/usages` 接口以外的任何地方。

## 使用说明

在终端里启动 `kimi-planbar-tui.exe`。按键：

> 双击 exe 会打开一个按线框最小尺寸（72×13 字符）收缩的新窗口。从已有终端会话（cmd / pwsh / Git Bash / 其他 Windows Terminal 标签页）启动时控制台是共享的，不会改动你的窗口。

| 键 | 行为 |
|---|---|
| `r` | 立即刷新额度 + 版本检查（2 秒防抖） |
| `s` | 设置——主题（System default / Moonlit / Moondark）、刷新间隔、开机自启 |
| `k` | Skills——本机 Kimi Code skills 只读列表 |
| `c` | 在浏览器中打开 [Kimi Code 控制台](https://www.kimi.com/code/console) |
| `g` | 打开 kimi-code [Releases](https://github.com/MoonshotAI/kimi-code/releases) 页面 |
| `↑` / `↓` | 在列表和表单中移动 |
| `Enter` | 确认 |
| `Esc` | 返回 |
| `q` | 退出（退出时终端一定会被恢复原状） |

## 便携模式

在 exe 旁放一个名为 `portable.dat` 的空文件，`settings.json` 就会存到 exe 所在目录，而不是 `%APPDATA%\KimiPlanbarTui\`。

## 开机自启

在设置（`s`）里开启 "Launch at Windows startup"。只会写入一条 per-user 注册表值 `KimiPlanbarTui`（位于 `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`）——不需要管理员权限，不碰 HKLM。

## 从源码构建

### Rust 版（默认）

需要 Windows + Rust（stable，MSVC 工具链）。无需 Node.js，无需 WebView2。

```bash
cd rust
cargo build --release   # 单静态 exe 产出于 rust/target/release/kimi-planbar-tui.exe
```

### TS 版（Bun + OpenTUI）

需要 Windows + Bun ≥ 1.3（本机装法：`npm install -g --allow-scripts=bun bun`，普通 `npm i -g bun` 会被 npm 的 allowScripts 策略跳过 postinstall）。不需要 Cargo。

```bash
cd ts
bun install
bun run dev             # 直接从 src/main.ts 起 TUI
bun run build:exe       # 单文件 exe → ts/dist/kpt-tui.exe（内嵌 Bun 运行时，~90 MB）
bun run test            # bun:test 套件（脚本会固定 TZ=Asia/Shanghai）
bun run parity          # 与 Rust 版 exe 背靠背比对 --test-fetch / --test-update 输出
```

> **Bun 版退出请用 `q`**：实测（WT 1.24 / conhost，2026-09-20）Bun 运行时会吞掉 Ctrl+C 的 console 事件，既不送达按键也不触发 SIGINT，因此该版 Ctrl+C 无效（Rust 版正常）。详见 SPEC 22.6。

### TS 版（Node 24 + 手写 ANSI）

需要 Windows + Node.js ≥ 24.6（源码直接由 Node 原生 type stripping 运行；`--use-system-ca` 自 24.6 起可用）。不需要 Bun，也不需要 Cargo。

```bash
cd ts-nodejs
npm install
npm run dev             # 直接从 src/main.ts 起 TUI
npm run build:exe       # SEA 单文件 exe → ts-nodejs/dist/kpt-tui-node.exe（内嵌 Node 运行时，~88.7 MB）
npm test                # node:test 套件（scripts/run-tests.mjs 固定 TZ=Asia/Shanghai）
npm run parity          # 与 Rust 版 exe 背靠背比对 --test-fetch / --test-update 输出
```

三版共享同一行为契约 `docs/SPEC.md`；TS 版与 Rust 版机制不等价之处统一登记在 SPEC 第 22 章（例如：TLS 检查类安全软件环境下，脚本运行需 `--use-system-ca` 才能走通 GitHub API 兜底；Bun 版编译产物无法内嵌该开关、会静默降级为 `checkFailed`，Node 版 SEA 产物则经 `execArgv` 固化，不受影响；额度与 changelog 主路径均不受影响）。

无头自检（适合 CI 或改动后验证）：

```bash
kimi-planbar-tui.exe --test-fetch    # 拉取一次额度，打印 JSON 后退出
kimi-planbar-tui.exe --test-update   # 打印本地/最新版本与 updateAvailable 后退出
```

`cargo test` 运行单元测试套件（skills frontmatter 解析 + 配额 JSON 解析）。

## 安装为命令行命令

在仓库根目录：

```bash
cargo install --path rust   # 安装 release exe 到 ~/.cargo/bin（Rust 用户的 PATH 里已有）
```

之后任意终端里直接敲 `kimi-planbar-tui` 即可。备选：把 `rust/target/release/kimi-planbar-tui.exe` 复制到 `PATH` 上的任意目录。

## 安全与隐私

- OAuth token / API key 仅从本机 Kimi Code CLI 文件**只读**读取，仅作为 Bearer token 发往 `https://api.kimi.com/coding/v1/usages`——不打日志、不另行持久化、不发往任何其他端点
- 无遥测、无数据分析、无需管理员权限

## 技术说明

- 单 Rust crate 位于 `rust/`：ratatui + crossterm（TUI），tokio + reqwest + serde（异步/HTTP/JSON），winreg（注册表），windows 0.61（Win32 控制台），regex + chrono
- 另有一份行为等价的 TS 版位于 `ts/`：Bun + `@opentui/core`（命令式渲染，不用 React），注册表走 `reg.exe` 子进程，Win32 控制台能力（raw mode / 控制台独占判定 / 缩窗）经 `bun:ffi` 调 kernel32
- 第二份行为等价的 TS 版位于 `ts-nodejs/`：Node 24 + 手写 ANSI 渲染层（不引 TUI 库——行级 diff 写屏、内嵌 wcwidth 码点表、外部字符串一律过 `sanitize()`），注册表走 `reg.exe`，以 Node SEA 打包且 `--use-system-ca` 经 `execArgv` 固化进产物
- release exe 通过 `rust/build.rs`（`winresource` build-dependency）嵌入 Windows VERSIONINFO 资源与应用图标（`rust/assets/icon.ico`）；FileVersion/ProductVersion 自动取自 `CARGO_PKG_VERSION`，嵌入失败只告警不中断构建（无 Windows SDK rc.exe 的机器也能编译）
- 后端模块自姊妹项目托盘版 [kimi-planbar-tray](https://github.com/shawn-0106t/kimi-planbar-tray)（Tauri 版）去掉 Tauri 后 1:1 移植；共享行为契约见 `docs/SPEC.md`
- 额度逻辑移植自 [kimi-planbar](https://github.com/baigong-ai/kimi-planbar)（MIT）——token 来源、接口与缓存/重试策略一致
- UI 设计源流：[KimiCodeBar](https://github.com/xifandev/KimiCodeBar)（MIT），作者 [@xifandev](https://github.com/xifandev)；Skills 功能参考自 [kimi-code-dashboard](https://github.com/perinchiang/kimi-code-dashboard)，作者 [@perinchiang](https://github.com/perinchiang)
- Kimi logo 与品牌版权归 **Moonshot AI** 所有——本项目为非官方社区工具，与 Moonshot AI 无隶属关系

## License

[MIT](LICENSE) © 2026 Shawn Qi (shawn-0106t)，部分内容 © baigong-ai (kimi-planbar)——详见 [NOTICE](NOTICE)
