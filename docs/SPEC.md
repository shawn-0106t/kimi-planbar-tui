# Kimi Planbar TUI — 项目技术规格（SPEC）

> English version: [SPEC_EN.md](SPEC_EN.md)（章节编号一致，可交叉对照）
>
> 本文档是整个项目的**唯一权威规格**（single source of truth），分两篇：
> - **第一篇 项目规格**（第 1–9 章）：目标、架构、数据流、安全、构建发布、维护边界
> - **第二篇 UI 与行为规格**（第 10–22 章）：配色、布局、API 解析、持久化等全部数值细则；第 22 章登记两个 TS 版与 Rust 版不等价的实现机制
>
> 章节编号与托盘版（kimi-planbar-tray）的 SPEC 保持一致，便于交叉对照；其中 **第 10 章（窗口规格）、第 14 章（托盘行为）、第 15 章（动画）对 TUI 版不适用**，以短章声明原因。其余章节内容相同的，本文档仍完整重述契约——本文档可独立成立，不依赖托盘版 SPEC。
>
> 代码注释中的 `SPEC x.y` 引用均指本文档章节号；修改行为前必须先查第二篇对应章节，改行为必须同步改对应章节。

---

# 第一篇 项目规格

## 1. 概述

### 1.1 目标

Windows 终端常驻仪表盘（无托盘、无窗口、无动画），让 Kimi Code 套餐用量在终端里一目了然：5 小时窗口与每周用量进度行、重置倒计时、Extra Usage（加油包）余额与月度用量，以及 Kimi Code CLI 版本更新提示、Skills 只读速览、Console / Releases 浏览器跳转。

### 1.2 功能范围

- 读取本机 Kimi Code CLI 凭证，调用 `GET https://api.kimi.com/coding/v1/usages` 获取配额
- 三个终端视图：主仪表盘（dashboard）、设置表单（settings）、Skills 只读列表（skills）
- 主题跟随系统（Moonlit 亮 / Moondark 暗，终端 truecolor）、可配置刷新间隔、开机自启（HKCU）、便携模式（portable.dat）
- CLI 版本检查（changelog 优先，GitHub API 兜底）
- 无头自检命令（`--test-fetch` / `--test-update`）

### 1.3 非目标

- **非官方社区工具**，与 Moonshot AI 无隶属关系（logo / 品牌版权归 Moonshot AI）
- 不修改 Kimi Code CLI 的任何文件（凭证只读）
- 无遥测、无数据上报、无第三方分析
- 仅 Windows 10/11，不做 macOS / Linux
- 不做托盘常驻与桌面窗口——那是姊妹项目 kimi-planbar-tray 的领域；本仓库是纯终端应用

## 2. 术语

| 术语 | 含义 |
|---|---|
| Moonlit / Moondark | 亮 / 暗双主题（色值见第 11 章） |
| Extra Usage / booster wallet | 加油包钱包；余额单位陷阱见 16.3 |
| portable mode | exe 旁存在空 `portable.dat` 时设置文件改存 exe 目录（见 18.1） |
| 视图（view） | TUI 内全屏切换的界面：dashboard / settings / skills，等价于托盘版的"窗口" |
| `SPEC x.y` | 代码注释对本文档章节号的引用 |

## 3. 系统架构

### 3.1 仓库结构

Monorepo 布局（参照托盘版 kimi-planbar-tray）：Rust 版 crate 位于 `rust/`（非 workspace）；TS 版有两个并行实现——Bun + OpenTUI 版位于 `ts/`，Node 24 + 手写 ANSI 版位于 `ts-nodejs/`，三者共享同一行为契约（本规格）：

- `rust/Cargo.toml` / `rust/Cargo.lock` — 包名与二进制名均为 `kimi-planbar-tui`
- `rust/src/` — 后端 core 模块（自托盘版 `rust/src-tauri/src/` 去 Tauri 化移植）+ `rust/src/format.rs`（格式化 helper，移植自托盘版前端 `src/common.ts`）+ `rust/src/app.rs` 与 `rust/src/ui/`（全新代码：事件循环与 ratatui 视图层）
- `ts/package.json` / `ts/tsconfig.json` — 包名 `kimi-planbar-tui-ts`，版本独立从 0.1.0 起步
- `ts/src/core/` — 与 Rust core 行为 1:1 的十个模块（凭证链、quota、polling、settings、skills、update、format、theme、state、严格 JSON）；禁止 import 任何 `@opentui` 符号
- `ts/src/tui/` — OpenTUI 渲染层（line / dashboard / settingsView / skillsView / renderer / app / console / shrink），与 core 严格分层，可整体替换
- `ts-nodejs/package.json` — 包名 `kimi-planbar-tui-ts-nodejs`，版本独立从 0.1.0 起步
- `ts-nodejs/src/core/` — 自 `ts/src/core/` 平移的同一套十个模块（仅把 3 处 `Bun.*` 调用换成 `node:child_process`，其余逐字节一致）
- `ts-nodejs/src/tui/` — 手写 ANSI 渲染层（ansi / wcwidth / screen / terminal）+ 视图（dashboard / settingsView / skillsView / app），无任何 TUI 库
- `docs/` — 本规格（`SPEC.md` / `SPEC_EN.md`）三版共享；**两个 TS 版与 Rust 版不等价的实现机制统一登记在第 22 章**，按本规格章节号归档
- 根目录：`AGENTS.md`、`README.md`、`README_CN.md`、`LICENSE`、`NOTICE`

### 3.2 进程与视图模型

单进程、单终端。启动时进入终端 raw mode + alternate screen，运行一个 `tokio::select!` 事件循环；三个视图（dashboard / settings / skills）为全屏切换的状态机状态，不存在窗口句柄、层级或显隐概念。

**无单实例互斥锁**：与托盘三版本（共用 `KimiPlanbarTray.SingleInstance`）不同，TUI 版允许多实例并存（每个终端窗口各跑一个是正常用法），不创建任何命名互斥锁。

事件循环架构：

```
tokio::select! {
    crossterm EventStream（键盘/resize） → App 状态机 → ratatui 重绘
    polling mpsc（配额结果/失败）        → 更新状态 → 重绘 + footer 时间戳
    update mpsc（版本检查结果）          → 版本行徽标
    theme 轮询 tick（30s）               → system 模式下换调色板
}
```

重绘为事件驱动：每个事件处理后立即在循环顶部重绘一帧；另有一个 250ms 心跳 tick 在无事件时唤醒循环，保证倒计时文案持续刷新。倒计时文案随每次重绘重算（`format_reset` 输入为 `reset_at - now`），无需独立秒级定时器（见第 20 章）。

### 3.3 后端模块（`rust/src/`）

| 模块 | 职责 |
|---|---|
| `main.rs` | 入口；`--test-fetch` / `--test-update` 自检打印后退出；终端初始化/恢复（raw mode + alternate screen + panic hook） |
| `credentials.rs` | 凭证链（credentials json → config.toml 兜底），只读 |
| `quota.rs` | usages API 拉取 + 防御性 JSON 解析（+ 解析单测） |
| `polling.rs` | 刷新调度：启动 2s 首刷、失败 30s 快重试、成功回正常间隔、保留上次成功数据；以 `tokio::sync::mpsc` 通知 UI |
| `settings.rs` | settings.json 持久化、portable.dat 探测、HKCU 自启 |
| `skills.rs` | 本地 skills 只读扫描（首开扫描一次并缓存；含 frontmatter 解析单测） |
| `update.rs` | `kimi --version` + changelog Range 请求 + GitHub API 兜底 |
| `theme.rs` | Moonlit/Moondark 调色板（ratatui `Color::Rgb`）；系统主题 = 启动读一次注册表 + 30s 轮询 |
| `state.rs` | AppState 共享状态（last-good 缓存、skills 缓存、手动刷新防抖） |
| `app.rs` | TUI 启动引导 + 事件循环（`tokio::select!`；全新代码） |
| `format.rs` | 格式化 helper：`format_reset`（12.3）、`fmt_yuan`（12.5）、百分比显示规则（移植自托盘版前端 `src/common.ts`） |
| `ui/` | ratatui 视图层（全新代码）：dashboard、settings 表单、skills 列表 |

### 3.4 前后端边界

无 IPC、无前端进程：core 模块与视图层同进程，通过 mpsc 消息与共享状态通信。托盘版 Tauri IPC 命令的对应物：

| 托盘版 IPC | TUI 版对应 |
|---|---|
| `get_state` / `refresh_now` | 直接读 AppState / `r` 键触发刷新（2s 防抖） |
| `save_settings` | 设置表单 Save：写 JSON → 自启 → 主题 → 重排定时器 |
| `get_skills(refresh)` | skills 视图首开取缓存，重扫键强制重扫 |
| `open_releases` / `open_console` | `g` / `c` 键调浏览器打开对应 URL |
| `quit_app` | `q` 键退出（恢复终端后退出进程） |

### 3.5 视图层

`rust/src/ui/` 下按视图分文件。所有颜色取自 `theme.rs` 调色板（Moonlit/Moondark 唯一色彩来源）。外部数据（skills 名称/描述、API 字段）一律经 ratatui 文本 widget 渲染，禁止把外部字符串拼进终端转义序列。

## 4. 技术栈与关键依赖

- **ratatui** — TUI 框架（布局、widget、样式）
- **crossterm** — 跨平台终端后端与事件源（键盘 / resize）
- **tokio / reqwest / serde(_json)** — 异步运行时、HTTP、JSON
- **winreg** — 注册表（自启 HKCU Run、系统主题 `AppsUseLightTheme`）
- **windows 0.61**（Win32_Foundation + Win32_System_Console）— 启动时最小窗口的 conhost 序列（见第 20 章）
- **regex / chrono** — 版本号解析、重置倒计时计算

不引 Tauri、不引 WebView、不引 YAML 库（frontmatter 手写行解析）。全部依赖与托盘版 `rust/src-tauri/Cargo.toml` 同源，零新增生态风险。

## 5. 数据流

```
~/.kimi-code 凭证（只读）
   → credentials.rs 取 token
   → quota.rs 拉取 + 解析（陷阱见 16.3）
   → AppState（保留上次成功值）
   → polling mpsc 通知 UI
   → dashboard 渲染各行 + footer 时间戳
```

- 设置：settings 表单 Save → `settings.rs` 写 JSON（路径见 18.1）→ 应用主题/自启/重排定时器
- Skills：进入 skills 视图 → 首次扫描本地目录并缓存于 AppState；不写回任何文件
- 版本检查：后台异步，结果经 mpsc 推送到版本行

## 6. 安全与隐私

- OAuth token / api_key 仅从本机 Kimi Code CLI 文件**只读**，仅作为 Bearer 发往 `https://api.kimi.com/coding/v1/usages`；不打印日志、不另行持久化、不发往任何其他端点
- 不需要管理员权限：自启仅写 `HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`（键 `KimiPlanbarTui`），不碰 HKLM / Program Files
- exe 未代码签名，SmartScreen 提示属预期（README 已注明）
- 品牌素材为 Kimi 官方 logo（版权归 Moonshot AI）；保留 `LICENSE`（MIT © Shawn Qi）与 `NOTICE`（部分 © baigong-ai / kimi-planbar）归属声明，不可移除

## 7. 构建、测试与发布

### 7.1 构建

前提：Windows + Rust stable（MSVC）。无 Node.js、无 WebView2、无其他运行时。

```bash
cd rust
cargo build --release   # 单静态 exe → rust/target/release/kimi-planbar-tui.exe（~3–5 MB）
cargo run               # 开发运行（debug 构建可直接用——没有内嵌前端的概念）
```

运行终端要求：**Windows Terminal / VS Code 集成终端为基准**；legacy conhost 需先 `chcp 65001`（切 UTF-8 代码页），否则方框字符与中文乱码。

release exe 由 `rust/build.rs`（`winresource` build-dependency）嵌入 Windows VERSIONINFO 资源与应用图标 `rust/assets/icon.ico`（Kimi logo，归属声明见 NOTICE）：FileDescription / ProductName / CompanyName / LegalCopyright / Comments 为固定字符串，FileVersion/ProductVersion 自动取自 `CARGO_PKG_VERSION`——**版本号唯一来源仍是 `rust/Cargo.toml`**。嵌入失败只输出 `cargo:warning`，不使构建失败（无 Windows SDK rc.exe 的机器也能正常编译，只是 exe 缺元数据）。

**TS 版**（前提：Windows + Bun ≥ 1.3，无 Cargo 依赖）：

```bash
cd ts
bun install
bun run dev          # 开发运行（bun ... src/main.ts）
bun run build:exe    # 单文件 exe → ts/dist/kpt-tui.exe（内嵌 Bun 运行时，~90 MB）
```

产物同样受"终端要求"约束（Windows Terminal / VS Code 集成终端为基准）。`ts/dist/` 已 gitignore，不分发进仓库。

### 7.2 测试

- `cargo test`：skills frontmatter 解析单测（自托盘版移植）+ quota JSON 解析单测（字符串/数字混排、`isEnabled=false`、单位四舍五入、除零）——本项目族首个真正的解析测试套件
- **TS 版（Bun）**：`cd ts && bun run test`（`bun:test`，用例对照 `rust/src/` 单测 1:1 移植，并额外对 Rust oracle golden 做全等断言；时区由脚本固定为 `Asia/Shanghai`，直接 `bun test` 会因时区使 golden 失败）。跨版本一致性：`bun run parity` 与本机 Rust exe 背靠背比对两个无头自检；`bun run test/parity/diff.ts --ts-exe dist/kpt-tui.exe` 比对编译产物。验证方法与豁免项见 22.1
- **TS 版（Node）**：`cd ts-nodejs && npm test`（`node:test` + 内置 `bun-shim`，用例与 Bun 版同源；TZ 由 `scripts/run-tests.mjs` 固定）。`npm run parity` 与 `node test/parity/diff.ts --ts-exe dist/kpt-tui-node.exe` 同上；`npm run typecheck` 保持 0 error。同一 golden 集与背靠背方法（22.1）
- 无头自检（详见第 19 章）：`--test-fetch` / `--test-update`，无互斥锁，天然可与运行中实例并存
- 一致性验证：与托盘版同机背靠背跑 `--test-fetch`，JSON 逐字段 diff
- 视觉验证：在 Windows Terminal 双主题下人工对照第 11/12 章
- 交付前按用户全局规范派独立 subagent 做 code review

### 7.3 发布

1. 版本号同步：`rust/Cargo.toml`（目前唯一的版本号来源；后续若加打包脚本再同步）
2. `cd rust && cargo build --release` 出单 exe
3. 手动上传 GitHub Releases；**不要把二进制提交进仓库**（发布产物已 gitignore）
4. 版本号独立于托盘版（kimi-planbar-tray），从 0.1.0 起步

## 8. 运行环境要求

- Windows 10 / 11
- 终端：Windows Terminal 或 VS Code 集成终端（基准）；legacy conhost 需 `chcp 65001`；需支持 truecolor（上述终端均支持）
- 已安装并登录 Kimi Code CLI，且为 Kimi For Coding 套餐用户
- 网络可达 `api.kimi.com`

## 9. 维护边界与文档地图

- 本仓库独立维护，与托盘版（kimi-planbar-tray）仅共享数据契约（凭证链、settings.json schema、API 解析规则）；行为歧义时以本文档第二篇为准
- core 模块与托盘版 `rust/src-tauri/src/` 保持行为一致；托盘版仓库为参考实现

| 文档 | 定位 |
|---|---|
| `README.md` / `README_CN.md` | 面向用户：功能、安装、按键、构建 |
| `docs/SPEC.md`（本文档） | 唯一权威规格：项目级 + UI/行为细则 |
| `docs/SPEC_EN.md` | 本文档的英文版（章节编号一致，便于交叉对照） |
| `AGENTS.md` | AI 编码助手上手索引（结构、命令、陷阱摘要） |

---

# 第二篇 UI 与行为规格

> 所有"坐标/尺寸"均为终端字符行列（cell），不是像素。所有文案为英文（术语对齐 Kimi console：Weekly usage / 5-hour usage / Extra Usage）。

---

## 10. 窗口规格

**本章节不适用于 TUI 版。** TUI 版无桌面窗口：没有无边框窗体、透明背景、置顶、任务栏、尺寸（DIP）、阴影、失焦收起、窗口单例复用等概念。终端中与之对应的"视图切换"模型见 3.2；dashboard 布局见第 12 章，settings 表单见第 13 章，skills 列表见第 21 章。

---

## 11. 配色方案

### 11.1 调色板（终端 truecolor 映射）

托盘版 SPEC 11.1 的十个画刷色（ARGB 中的 alpha 恒为 `FF`，直接剥离）映射为 ratatui `Color::Rgb`，色值不变：

| 调色板键 | Light（Moonlit） | Dark（Moondark） |
|---|---|---|
| `accent`（强调色/进度条填充） | `#1A88FF` | `#1A88FF` |
| `window_bg`（屏幕底） | `#F3F4F6` | `#17191E` |
| `card_bg`（卡片底——线框 UI 无卡片底色，当前未使用，保留于调色板规格） | `#FFFFFF` | `#23262D` |
| `text_primary`（主文字） | `#1F2329` | `#F2F3F5` |
| `text_secondary`（次文字） | `#6B7280` | `#9AA0A8` |
| `progress_track`（进度条轨道） | `#E5E7EB` | `#3A3E47` |
| `button_bg`（按钮/焦点行底） | `#E9ECF0` | `#2C3039` |
| `button_hover`（悬停/高亮行底） | `#DCE2E9` | `#3A404B` |
| `badge_bg`（新版本徽标底） | `#FFF0E0` | `#3D2E1A` |
| `badge_fg`（新版本徽标字） | `#E06D00` | `#F0A040` |

- 强调色（Moonshot 蓝）两主题相同：`#1A88FF`。
- 选中态（设置表单光标行、skills 列表高亮行）：`text_primary` 文字配 `button_hover` 底；白字（`#FFFFFF`）配 `accent` 底只用于"当前值"指示（刷新间隔的激活 pill、获得焦点的 Save 动作行）——对应托盘版"选中丸/复选勾文字固定 White"的约定。
- 终端需支持 truecolor（Windows Terminal / VS Code 终端均支持）；不支持 truecolor 的终端不保证观感。

### 11.2 进度条颜色

- **无用量区间变色逻辑**：进度条填充恒为 `accent`（`#1A88FF`），轨道恒为 `progress_track`。不存在按百分比切换绿/黄/红的代码。
- 进度条为纯文本 span：`█`（填充）+ `░`（轨道）；填充格数 = `round(clamp(percent, 0, 100) / 100 × 条宽)`，条宽自适应终端宽度（见 12.2）。

---

## 12. 主仪表盘 UI 结构（dashboard 视图）

整体为 `ratatui::Layout` 纵向约束的纯文本线框布局：**无卡片边框、无卡片底色**（设计目标为 kimi CLI `/usage` 风格的极简线框——用户决策，取代了初版的卡片式区块设计）。每个数据行固定占 1 行字符高度，短终端不会再把内容挤压掉；整屏底色仍为 `window_bg`（由视图层统一填充）。文案与格式规则与托盘版 SPEC 12 完全一致，仅载体从 WebView 卡片换成终端文本行。

```
Kimi Planbar TUI                                    Updated HH:mm

5-hour usage   21%  █████░░░░░░░░░░░░░░░  Resets in 4h 30m
Weekly usage   18%  ████░░░░░░░░░░░░░░░░  Resets in 5d 15h

Extra Usage    ¥12.34
  Used ¥45.67 this month / ¥100 limit       （仅月度限额开启时显示）

Kimi Code CLI  2.0.1   Update available

r Refresh · s Settings · k Skills · c Console · g Releases · q Quit
```

### 12.1 标题行（1 行）

- 左侧标题 `"Kimi Planbar TUI"`，`text_primary`，加粗
- 右侧上次更新时间，`text_secondary`，右对齐：
  - 无数据：空字符串
  - 有错误：`"Update failed"`
  - 正常：`"Updated HH:mm"`（`fetched_at` 本地时间，24 小时制）

### 12.2 用量行（两行，各固定 1 行）

「5-hour usage」在前、「Weekly usage」在后，结构相同：

- 标签：固定 14 字符宽，`text_secondary`
- 百分比：默认 `"--"`，`text_primary`，加粗；数据到达后为 `{percent:0}%`（显示用原始 percent 未 clamp，进度条用 clamp 后值）
- 进度条：纯文本 span——`█`（填充，`accent`）+ `░`（轨道，`progress_track`），见 11.2；宽度自适应终端（取标签 + 百分比 + 倒计时文案之后的剩余宽度），剩余宽度不足 5 字符时整条省略（极窄终端）
- 重置倒计时：`text_secondary`，位于行尾，格式见 12.3；无 `resetTime` 时省略，进度条占满余宽

### 12.3 重置倒计时格式（`FormatReset`，`span = at - now`）

- `span < 0`：`"Resets soon"`
- `>= 1 天`：`"Resets in {int(TotalDays)}d {Hours}h"`（例：`Resets in 4d 3h`）
- `>= 1 小时`：`"Resets in {int(TotalHours)}h {Minutes}m"`
- `< 1 小时`：`"Resets in {max(1, Minutes)}m"`（至少显示 1 分钟）
- 无 `resetTime`：空字符串
- 倒计时随每次重绘重算（重绘机制见第 20 章），无独立秒级定时器

### 12.4 Extra Usage 行（1–2 行）

- 行：标签 `"Extra Usage"`（14 字符标签列，`text_secondary`）+ 余额（默认 `"--"`，加粗，`text_primary`）
- 余额文案三态（`ExtraState`）：
  - `Ready`：有 `balance_cents` 显示 `FmtYuan`（见 12.5），否则 `"--"`
  - `NoData`：`"No data"`
  - 其他（`NotActivated`）：`"Not activated"`
- 月度子行（缩进 2 空格，`text_secondary`）：仅当 `monthly_enabled && monthly_limit_cents > 0 && monthly_used_cents.is_some()` 时显示；纯文本一行 `"Used {FmtYuan(used)} this month / {FmtYuan(limit)} limit"`（线框布局无月度进度条）

### 12.5 金额格式化（`FmtYuan`，单位：分 → 元）

- 负数：`"-" + FmtYuan(-cents)`
- `¥{cents/100}`，余数 > 0 时追加 `.{frac:00}`；整元省略小数。例：`1234 → "¥12.34"`，`10000 → "¥100"`

### 12.6 版本行（1 行）

- 标签 `"Kimi Code CLI"`（14 字符标签列，`text_secondary`）；其后：
  - 本地版本：默认 `"--"`，显示本地版本号或 `"Not detected"`，`text_primary`
  - 新版本徽标：默认隐藏；有更新时显示 `" Update available "`，底 `badge_bg`、字 `badge_fg`
- 按 `g` 键打开浏览器：`https://github.com/MoonshotAI/kimi-code/releases`（异常静默吞掉）——对应托盘版"整行可点击"

### 12.7 footer（1 行）与按键

- 固定提示行：`"r Refresh · s Settings · k Skills · c Console · g Releases · q Quit"`，`text_secondary`
- 按键全集：

| 键 | 行为 |
|---|---|
| `r` | 手动刷新配额 + 版本检查，**2 秒防抖**（距上次手动刷新不足 2 秒的重复触发被静默忽略） |
| `s` | 进入设置表单（第 13 章） |
| `k` | 进入 Skills 只读列表（第 21 章） |
| `c` | 浏览器打开 `https://www.kimi.com/code/console?from=kfc_overview_topbar`（异常静默吞掉） |
| `g` | 浏览器打开 kimi-code Releases 页（异常静默吞掉） |
| `q` | 恢复终端并退出 |
| `↑/↓` | 列表/表单内移动 |
| `Enter` | 确认 |
| `Esc` | 返回上一级视图 |

---

## 13. 设置表单（settings 视图）

托盘版设置窗转译为终端表单：选项与默认值不变，控件语义一一对应（单选丸→选项列表、复选框→checkbox 行、按钮→动作行）。

### 13.1 表单结构

全屏视图，标题 `"Kimi Planbar TUI Settings"`；`↑/↓` 在字段间移动，`←/→` 或 `Enter` 切换当前字段取值，`Esc` 放弃更改返回 dashboard。

### 13.2 设置项（选项与默认值与托盘版 SPEC 13.2 完全一致）

| 设置项 | 控件形态 | 选项 | 默认值 |
|---|---|---|---|
| 主题 | 三选一列表 | `"System default"`=system、`"Moonlit (light)"`=light、`"Moondark (dark)"`=dark | `"system"` |
| 刷新间隔 | 四选一列表 | `"1 min"`、`"5 min"`、`"10 min"`、`"30 min"` | `5` |
| 开机自启 | checkbox 行 `"Launch at Windows startup"` | bool | `false` |
| 保存 | 动作行 `"Save"`（`Enter` 触发） | — | — |

- 保存动作顺序不变：写 `settings.json` → 应用自启（18.3）→ 应用主题 → 重排刷新定时器 → 返回 dashboard。
- 打开表单时按当前设置回填选中状态。

---

## 14. 托盘行为

**本章节不适用于 TUI 版。** TUI 版无系统托盘：没有托盘图标、tooltip、左键 toggle、右键菜单、hover-to-refresh。托盘版 SPEC 14 中"悬停预取配额（10s 节流）"在 TUI 版没有对应物——配额新鲜度由固定间隔轮询（16.5）与 `r` 手动刷新（12.7）保证。

---

## 15. 动画

**本章节不适用于 TUI 版。** TUI 版无任何动画：没有滑入滑出、淡入淡出、悬停光晕。终端视图切换与焦点高亮均为瞬时；进度条宽度变化直接设置，无过渡。

---

## 16. 数据与 API（quota）

> 本章与托盘版 SPEC 16 完全一致，完整重述如下。

### 16.1 请求

- URL：`GET https://api.kimi.com/coding/v1/usages`
- 头：`Authorization: Bearer {token}`、`Accept: application/json`
- HTTP 超时 **10 秒**；非 2xx → 进入失败路径

### 16.2 凭证读取优先级链（`load_token`）

- `<kimi_home>` 默认为 `%USERPROFILE%/.kimi-code/`，支持 `KIMI_CODE_HOME` 环境变量覆盖（与 21.2 同一约定）。
1. **`<kimi_home>/credentials/kimi-code.json`**：
   - 读取 `access_token`（字符串）
   - 校验 `expires_at`（Unix 秒，数字）> 当前 UTC 时间 + **30 秒**余量，过期则视为无效继续下一步
   - 解析异常静默吞掉
2. **兜底 `<kimi_home>/config.toml`**（手写逐行解析，非完整 TOML parser）：
   - 按 `[section]` 分节；正则 `^(base_url|api_key)\s*=\s*"([^"]*)"` 提取键值
   - 匹配条件：节名以 `"providers."` 开头 **且** `base_url` 包含 `"api.kimi.com/coding"` **且** `api_key` 非空 → 返回该 `api_key`
   - 遇到新节时先结算上一节；文件结束再结算最后一节
3. 两者皆无 → 返回 `error = "no-token"` 的结果

### 16.3 响应 JSON 解析

- **5 小时段**：`root.limits`（数组，取第 0 个元素的 `detail` 对象）→ `parse_segment`
- **周段**：`root.usage`（对象）→ `parse_segment`
- `parse_segment`：`percent = used/limit*100`（`used`、`limit` 兼容数字或数字字符串，缺失按 0；`limit<=0` 时按 1 防除零）；`resetTime`（字符串，RFC 3339 解析）→ `reset_at`
- **Extra Usage**：`root.boosterWallet`（对象）：
  - 非对象/缺失 → `state = NotActivated`（"Not activated"）
  - `isEnabled == false` → `NotActivated`（防御：booster 未启用时 `amountLeft` 是"月度上限-已用"估算值而非真实余额，必须视为未开通）
  - `balance.amountLeft`（字符串数字，兼容数字型）可解析 → `state = Ready`；单位 **1e-8 元**，换算分：`balance_cents = (raw + 500000) / 1000000`（四舍五入）
  - 否则 → `state = NoData`（"No data"）
  - `monthlyChargeLimitEnabled == true` → `monthly_enabled=true`，`monthlyUsed.priceInCents` → `monthly_used_cents`，`monthlyChargeLimit.priceInCents` → `monthly_limit_cents`（单位分，字符串数字）
- **注意：服务端 JSON 数字一律按字符串建模**，解析时容忍数字型兜底。
- 上述规则由 `quota.rs` 单元测试覆盖（字符串/数字混排、`isEnabled=false`、单位四舍五入、除零）。

### 16.4 数据模型（Rust struct）

```rust
QuotaSegment { percent: f64, reset_at: Option<DateTime<Local>> }
ExtraState   { NotActivated, NoData, Ready }
ExtraInfo    { state, balance_cents: Option<i64>, monthly_enabled: bool,
               monthly_used_cents: Option<i64>, monthly_limit_cents: Option<i64> }
QuotaResult  { five_hour: Option<QuotaSegment>, week: Option<QuotaSegment>,
               extra: Option<ExtraInfo>, fetched_at: DateTime<Local>, error: Option<String> }
```

（错误时 `error` = 异常类型名，沿用参考实现的 .NET 风格命名以便跨版本 diff `--test-fetch` 输出：`"HttpRequestException"` / `"TaskCanceledException"`（超时）/ `"JsonException"` / `"no-token"`）

### 16.5 刷新调度与失败重试（polling）

- 周期 = `max(1, refresh_minutes)` 分钟；定时器首次延迟 **2 秒**（启动后 2s 首刷），之后按周期
- 每次刷新：
  1. 拉取 + 解析
  2. **失败时保留上次成功数据**：若本次 `error` 非空且存在上次成功值，用上次值补齐 `five_hour`/`week`/`extra` 中的空字段（界面不清空，仅标题行提示 `"Update failed"`）
  3. **失败后 30 秒快速重试**：下一次触发改为 30s（成功则回到正常周期）；周期配置本身不变
  4. 经 mpsc 通知 UI 重绘

---

## 17. CLI 版本检查（update）

> 本章与托盘版 SPEC 17 一致；仅 UI 表现小节按 TUI 适配（徽标在版本行，`g` 键代替整行点击）。

### 17.1 本地版本

- 起子进程：`kimi --version`（不经 shell，不弹窗，stdout/stderr 均重定向）
- **5000ms** 超时等待退出，超时 kill 返回 None
- 先等退出再读输出（输出仅一行不会撑满管道缓冲）
- 对 stdout+stderr 合并文本正则取首个 `\d+\.\d+\.\d+`
- 任何异常 → None（版本行显示 `"Not detected"`）

### 17.2 最新版本（两级 fallback）

1. **官方文档站 changelog**（优先，英文版最及时；绕开 GitHub API 限流与 hosts 屏蔽）：
   - `GET https://moonshotai.github.io/kimi-code/en/release-notes/changelog.md`
   - 请求头 `Range: bytes=0-4095`（只取前 4KB；GitHub Pages 可能忽略 Range 返回 200 全量，两种响应均兼容）
   - 正则 `^## (\d+\.\d+\.\d+)`（Multiline）首个匹配即最新版
2. **GitHub Releases API fallback**：
   - `GET https://api.github.com/repos/MoonshotAI/kimi-code/releases/latest`
   - 头 `User-Agent: KimiPlanbarTui`（必须，否则 GitHub 拒绝）
   - 取 `tag_name`（形如 `"@moonshot-ai/kimi-code@0.31.1"`），正则提取 `\d+\.\d+\.\d+`
- HTTP 超时 10 秒；两者皆失败 → `latest = None`

### 17.3 比较与状态

- `update_available = latest.is_some() && 两者均可解析为语义化版本 && latest > local`
- `check_failed = latest.is_none()`（网络不可达时静默降级，UI 不提示）
- 完成后经 mpsc 推送版本行更新
- 触发时机：启动时后台执行；`r` 手动刷新同步触发

### 17.4 UI 表现

- 版本行显示 `local ?? "Not detected"`
- `update_available == true` 时显示橙色徽标 `"Update available"`（颜色见 11.1 badge_bg/badge_fg）
- `g` 键跳转 `https://github.com/MoonshotAI/kimi-code/releases`

---

## 18. 设置持久化（settings）

> 本章与托盘版 SPEC 18 的机制完全一致；仅目录名与注册表键名换为 TUI 版自己的名字。

### 18.1 配置文件路径（便携模式逻辑）

- **便携模式**：exe 同目录存在 `portable.dat` 文件（内容任意，仅检测存在性）→ 配置目录 = exe 所在目录
- **否则**：`%APPDATA%\KimiPlanbarTui\`
- 配置文件：`<ConfigDir>\settings.json`

### 18.2 JSON schema（缩进格式序列化）

```json
{
  "Theme": "system",
  "RefreshMinutes": 5,
  "AutoStart": false
}
```

- `Theme`：`"system" | "light" | "dark"`，默认 `"system"`
- `RefreshMinutes`：int，可选值 1/5/10/30，默认 5
- `AutoStart`：bool，默认 false
- 加载：文件不存在或反序列化失败 → 全部回落默认值（异常静默吞掉）
- 保存：先创建目录再整体覆写（异常静默吞掉）

### 18.3 开机自启

- 注册表：`HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Run`（per-user，不触发 UAC）
- 键名：`KimiPlanbarTui`
- `AutoStart=true` → 值 = `"{exe 完整路径}"`（带引号）
- `AutoStart=false` → 删除该值（不存在不报错）
- 异常静默吞掉

---

## 19. 测试/自检命令（命令行参数）

自检模式打印到 stdout 后退出。本版**无单实例互斥锁**，自检天然可与运行中实例并存（托盘版"先于互斥锁执行"的规则在此无对应物）。

| 参数 | 行为 | 输出 |
|---|---|---|
| `--test-fetch` | 拉取一次额度，打印 JSON | `QuotaResult` 的 JSON（缩进格式、不转义非 ASCII） |
| `--test-update` | 执行一次版本检查 | 单行：`local={x} latest={y} updateAvailable={bool} checkFailed={bool}` |

- 无 `--test-ui`（无窗口可构造；视图层验证靠在终端人工对照第 11/12 章）。
- 未识别的参数直接忽略，正常启动 TUI。
- 一致性验证：与托盘版同机背靠背跑 `--test-fetch`，JSON 逐字段 diff 应一致。

---

## 20. 其他实现细节（TUI 专有）

- **终端恢复（最高优先级）**：启动进入 raw mode + alternate screen 并隐藏光标；**每一条退出路径都必须恢复终端**（离开 alternate screen、关 raw mode、显示光标）——正常 `q` 退出如此，panic 亦如此（通过 panic hook 先恢复再打印）。终端被留在 raw mode 是 TUI 最严重的事故。两个 TS 版的等价机制（Bun 版需 `bun:ffi SetConsoleMode` 并在每次输入/重绘前重申；Node 版由 Node 自身处理 raw mode，但须保证恢复处理器先于终端初始化注册）见 22.5。
- **启动时最小窗口（72×13）**：`run()` 起始、终端初始化之前，把窗口收缩到线框布局的最小尺寸（72 列 × 13 行，常量 `MIN_WIN_COLS`/`MIN_WIN_ROWS`）。**守卫**：仅当进程独占控制台时执行——`GetConsoleProcessList` 返回恰好 1 个附加进程（双击/新开窗口启动）；从已有终端会话（cmd / pwsh / Git Bash / 其他 WT 标签页）启动时控制台是共享的，绝不改动用户窗口。两条 best-effort 通道，异常静默吞掉：(a) xterm 窗口操作转义 `ESC [ 8 ; 13 ; 72 t`（Windows Terminal 1.22+ 支持）；(b) conhost Win32 序列：先 `SetConsoleWindowInfo` 缩视口到 1×1 → `SetConsoleScreenBufferSize(72,13)` → `SetConsoleWindowInfo` 设为完整 72×13 矩形。**TS 版（Bun）同判据同通道**：`GetConsoleProcessList` 经 `bun:ffi` 调用，FFI 不可用时退回终端环境变量启发式（结构体按值传参的手工打包见 22.6）。**TS 版（Node）**：无 Win32 binding，守卫只用环境变量启发式（`WT_SESSION`/`TERM_PROGRAM`/`ConEmuPID` 全缺才缩），通道仅 (a)——且经实测当前 ConPTY 不透传该窗口操作转义，在本机为优雅 no-op（见 22.6）。
- **事件驱动重绘 + 250ms 心跳**：每个事件（键盘、配额 mpsc、版本 mpsc、skills mpsc、主题 tick、resize）处理后立即在事件循环顶部重绘一帧——不存在合并/节流（任意事件都会即时出帧）。另有一个 250ms 心跳 tick（`draw_tick`）在无事件时唤醒循环，保证倒计时文案持续刷新；倒计时文案随每次重绘重算（输入 `reset_at - now`），无独立 1Hz 定时器。
- **系统主题 30s 轮询**：crossterm 无系统事件源，`theme=system` 时以 30s 间隔轮询注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize` 的 `AppsUseLightTheme`（DWORD，0=dark，1=light，缺失默认 1），替代托盘版的 `WM_SETTINGCHANGE` 实时监听；`theme=light|dark` 时该轮询不影响配色。
- **无单实例互斥锁**：允许多实例并存（每个终端一个），不创建 `KimiPlanbarTray.SingleInstance` 或任何命名互斥锁。
- **启动顺序**：解析命令行（自检分支先执行并退出）→ 收缩自有窗口（仅独占控制台时，见上条）→ 加载设置 → 应用主题 → 初始化终端 → 启动事件循环 → 2s 后首刷配额 → 后台版本检查。
- **异常处理基调**：所有 IO、注册表、外部进程、HTTP 调用均静默吞掉，失败路径以 UI 文案（"Update failed"/"Not detected"）或状态字段表达，绝不 panic、绝不打断 TUI。
- **金额单位陷阱**：`amountLeft` 是 1e-8 元（换算分需 `(raw + 500000) / 1000000` 四舍五入），`priceInCents` 才是分；JSON 中数字均为字符串。
- **`isEnabled=false` 陷阱**：booster 未启用时 `amountLeft` 并非真实余额，必须整体判为 "Not activated"。
- **终端兼容**：Windows Terminal / VS Code 集成终端为基准（truecolor + UTF-8）；legacy conhost 需 `chcp 65001`，否则方框字符与中文乱码；不支持 truecolor 的终端不保证观感。

---

## 21. Skills 只读视图

> 机制与托盘版 SPEC 21 一致（只读、零后台开销、首开扫描一次并缓存）；呈现转译为终端滚动列表。

### 21.1 视图

- 全屏视图，标题 `"Kimi Skills"`；按 `k` 进入，`Esc` 返回 dashboard。
- 只读：无任何启用/禁用操作。

### 21.2 数据源与性能

- 三处根目录：`<kimi_home>/skills`（标签 "Kimi Code"）、`~/.agents/skills`（"Agents"）、`<kimi_home>/plugins/managed/<plugin>/skills`（"Plugin: <名>"）；`<kimi_home>` 支持 `KIMI_CODE_HOME` 覆盖。
- 每个 `<dir>/<id>/SKILL.md` 只读前 4 KiB 解析 YAML frontmatter 的 `name` / `description`（手写行解析、去首尾引号，缺省回退目录名；不引 YAML 依赖）。字节读取后 `from_utf8_lossy` 解码，容忍 4 KiB 截断处切断的多字节字符与 GBK 混杂字节，并剥离 `---` 前的 UTF-8 BOM。
- 无启用/禁用状态可展示：Kimi Code 不持久化 per-skill 禁用状态；`~/.agents/.skill-lock.json` 是 lark-cli 的安装锁文件（`{version, skills, dismissed}`，无 `disabled` 键），一律不读取。
- **零后台开销**：不轮询、不监视文件；只在视图首次打开时扫描一次并缓存进 AppState；视图内的重扫键传 `refresh=true` 强制重扫。

### 21.3 呈现

- 顶部汇总行：`N skills` + 重扫键提示。
- 列表按来源分组（组内按名称不区分大小写排序），`↑/↓` 滚动只读；每项：名称（加粗）+ 描述（超出终端宽度的描述截断显示）。
- 全部颜色走 `theme.rs` 调色板，自动跟随 Moonlit/Moondark。
- 外部数据（skill 名称/描述）一律经 ratatui 文本 widget 渲染，不拼终端转义序列。

---

## 22. TS 各版实现差异登记

> 本章集中登记两个 TS 版——Bun 版（`ts/`，Bun + OpenTUI）与 Node 版（`ts-nodejs/`，Node 24 + 手写 ANSI）——在实现机制上与 Rust 版不等价之处，按本规格章节号归档。前述各章描述的行为契约以 Rust 版为基准；本章条目均为实现层面的等价机制或已知偏差，全部有测试锁定。

### 22.1 验证方法（对应 7.2 / 19）

- **`--test-fetch` 字节 parity 契约**：各版输出除 `fetchedAt` 的**值**以外必须逐字节相同。该字段是唯一豁免项——Rust 用 100 ns 精度的系统时钟、chrono 固定打印 9 位小数，JS `Date` 只有毫秒。比对时两侧都归一化为 `"fetchedAt": "<NOW>"`（`ts/test/parity/diff.ts`、`ts-nodejs/test/parity/diff.ts`）。
- **两套证据**：
  1. **Rust oracle golden**（纯解析与文本格式）：临时 cargo 工程原样复用 `rust/src/quota.rs` 的 DTO 与解析函数，产出 `ts/test/golden/`（浮点文本表、chrono 时间戳表、`from_str` 矩阵、30 个 `QuotaResult` 文档、`settings.json` 文档；`ts-nodejs/test/golden/` 为同一组文件的副本）。TS 测试对 golden 做**全等**断言。
  2. **同机背靠背**（含真实网络）：`bun run parity` / `npm run parity` 跑 Rust exe 与 TS 自检各两遍并 diff。实测：`--test-fetch` 19 行全等、`--test-update` 1 行全等（成功路径，非 `no-token` 分支），编译产物同样通过（`--ts-exe`）。
- 两版 TS 测试都把时区固定为 `Asia/Shanghai`（Bun 版在 `ts/package.json` 脚本里，Node 版在 `ts-nodejs/scripts/run-tests.mjs`）：golden 里的时间戳是 `DateTime<Local>`，换时区需重新生成 golden。

### 22.2 数据与 API（对应 16.2 / 16.3 / 16.4）

两个 TS 版同源（Node 版平移自 Bun 版），机制本应一致。**当前状态限定（2026-09-20）**：本轮 M1 审查的 core 修复（JSON 深度上限、非 2xx 排空 body、resetTime 阶梯、`RefreshMinutes` 钳位、polling clamp、skills 4 KiB 读）**只落在 `ts/`**，`ts-nodejs/` 尚未平移（其实测仍是修复前版本，含 13 行的旧 `reset_time.txt`）。下表描述的是 `ts/` 的行为，对 Node 版待平移后方成立；平移前 Node 版与 Rust 的差异另见 22.6 与本表逐条对照。

| Rust 机制 | TS 等价实现 | 锁定点 |
|---|---|---|
| `str::parse::<f64/i64>()` | `parseF64Strict` / `parseI64Strict`（`core/json.ts`），按 Rust 语法整串匹配 | `""`、`68abc`、`0x10`、`1_000`、`1 000` → 失败；`1.`、`.5`、`1e5`、`+68`、`inf`、`NaN` → 成功；`i64` 不接受小数与指数；越界即失败 |
| `str::trim()` | `rustTrim`，Unicode White_Space 集：**含 U+0085、不含 U+FEFF**（JS 原生 `trim()` 恰好相反） | golden `parse_matrix` |
| `serde_json::Number::as_i64()` | `jAsI64`：只有**整数形态的 number token** 才有值，`1.0` / `1e5` / `-0.0` 一律视为无值 | golden `as_i64` |
| `i64` 范围 | 全程 `bigint`（`balanceCents`、`monthlyUsedCents`、`monthlyLimitCents`、`(raw+500000)/1000000`），整除截断与 `saturating_add` 精确 | quota 测试 |
| `f64` 文本 | `formatF64`：serde_json/ryu 形态——恒带小数点或指数；十进制指数 ∈ [-5,15] 用定点，否则 `1e+16` / `1e-7` 形态；`-0.0` 保号；非有限值由序列化器写 `null` | golden `floats` + `float_grid` |
| `chrono` 的 `DateTime<Local>` 文本 | `RustDateTime{ms,nanos}` + `autoSiFraction`：小数位为 9 位文本按整组 `000` 从右剥离（`.500000000`→`.500`），零则完全省略；偏移恒为 `±HH:MM`，绝不出现 `Z` | golden `datetime` + `reset_time` |
| `resp.json()` 失败 | 自带严格 JSON 解析器（`parseJsonValue`）：`1e400` 触发 `number out of range` → `JsonException`；非 2xx 会先 `arrayBuffer()` **排空** body 再返回（Bun 只有消费完 body 才把 keep-alive 连接归还连接池，Rust reqwest 则直接丢弃连接——机制差异，输出不变）；headers 之后的 body 超时同样归 `JsonException` | quota 测试 |
| 数值精度 | 超过 2^53 的 JSON 整数字面量：TS 用 token 走 `BigInt` 保持精确；`as_f64` 侧与 Rust 同为 double，无额外偏差 | — |

### 22.3 设置与系统集成（对应 18.1 / 18.2 / 18.3）

- **`current_exe()` 的等价物是 `process.execPath`**：Bun 版在 `bun run src/main.ts` 下是 `bun.exe`、`bun build --compile` 产物下才是 `kpt-tui.exe`；Node 版在 `node src/main.ts` 下是 `node.exe`、SEA 产物下是 `kpt-tui-node.exe`。因此**便携模式与开机自启只对编译产物有意义**；开发模式下 `portable.dat` 会被带去运行时安装目录找，自启值会写成运行时二进制的路径。Rust 版无此歧义。
- `settings.json` 写入与 Rust 完全同字节：PascalCase、2-space 缩进、**无尾随换行**；读取遵循「整体失败回落默认、仅缺键才逐键默认」。
- **`RefreshMinutes` 超出 2^53 会被钳到 `Number.MAX_SAFE_INTEGER`**：i64 边界判定全程走 `BigInt`（越出 i64 → 整体回落默认，与 Rust 的类型错误一致），但 `Number(bigint)` 在 2^53 之外会失真，故取值时钳到可精确表示的区间；Rust 侧原样保留 i64。这条差异延伸到轮询：Rust 用 `saturating_mul(60)`，极端值等于「几乎永不再刷」；TS 的延迟还要再被 `setTimeout` 的 32 位上限钳一次（`2_147_483_647` ms ≈ 24.8 天）。两版在任何合理取值（1/5/10/30）下完全一致。
- 注册表一律 `spawn reg.exe` 并按 **GBK** 解码；自启仍只做写/删、不回读。`AppsUseLightTheme` 取 `REG_DWORD` 文本（`0x0`/`0x1`），任何异常 → light，与 Rust 的 `unwrap_or(1)` 同义。
- 主题解析保持纯函数：`effectiveTheme(configured, system)`，系统值由 30 s 轮询写进缓存，渲染路径同步读取（Rust 在事件循环里同样是轮询）。

### 22.4 版本检查（对应 17.1 / 17.2）

- changelog 的 Range 请求必须带 **`Accept-Encoding: identity`**：GitHub Pages 返回 206 + gzip 时 Bun 解压分片会抛 `ZlibError`；Node 版保留同一头部作为防御性一致措施。Rust 的 reqwest 不受影响。
- TLS 信任：本机 ESET 曾做 TLS 拦截、其根证书不在运行时自带的 CA 库内。
  - **Bun 版**：脚本路径带 `--use-system-ca`；`bun build --compile` 无法把该开关固化进产物，编译产物在 TLS 拦截环境下 GitHub API 兜底静默降级为 `checkFailed`（额度与 changelog 主路径不受影响）。M4 复测（2026-09-20）：该拦截当前不复现。
  - **Node 版**：`--use-system-ca` 需要 Node ≥ 24.6（`engines` 已锁 `>=24.6.0`），亦可用 `NODE_USE_SYSTEM_CA=1` 环境变量；SEA 打包经 `execArgv` 把 `--use-system-ca` **固化进产物**（无 Bun 版的降级问题）。
- `kimi --version` 经子进程拉起（不走 shell），5 s 超时后强杀，stdout+stderr 按此顺序 lossy 拼接后取首个 `\d+\.\d+\.\d+`。

### 22.5 配色与渲染层（对应 11.1 / 20）

**两版共有**：

- SPEC 11.1 列十色，`Palette` 实现只有九槽（`card_bg` 仅存在于规格）。
- 格宽按 East Asian Width 计算：CJK/全角/Hangul/emoji 记 2 格、组合符号与变体选择符记 0 格、Ambiguous（`█ ░ · ¥ ● →`）记 1 格。裁剪按码点迭代，2 格字形放不进剩余 1 格时整体丢弃（对齐 ratatui 缓冲区行为），代理对不会被切断。Rust 侧由 unicode-width 自动处理。
- 下划线属性：SPEC 13.2 选中 interval 行时 Rust 加 `Modifier::UNDERLINED`；Bun 版用 OpenTUI `underline()` style，Node 版直接发 SGR 4。
- Skills 扫描放在下一个宏任务：先出 `Scanning...` 帧再异步跑扫描，对应 Rust 的 `spawn_blocking` + mpsc 回调；同步扫描会卡住重绘。设置保存的 `reg.exe` 自启写入仍同步（SPEC 13.2 的保存顺序要求它先返回）。

**Bun 版（OpenTUI 渲染层）**：

- 选中态文字：Rust 走 crossterm `Color::White` → SGR `37`（终端调色板白），OpenTUI 的 `"white"` 解析为 `#FFFFFF`。观感差异仅在用户自定义终端白时可见。
- 整屏底色靠逐 span 合成：OpenTUI 无等价于 ratatui 整屏 `Block::bg` 的填充，未显式给 bg 的文本 run 会落到终端默认底色。故适配器把 `window_bg` 作为 base bg 合成到每个无自有 bg 的 span 上，并在每行右侧补 window_bg 空白 run 铺到满宽、行间补满宽空行铺到满高。
- OpenTUI 实测约束：内容 write-once（变更行销毁重建）、测试渲染器无绝对定位（流式从上到下）、`resize()` 在测试渲染器崩溃（快照 `TuiLine[]` 代替）、键事件挂在 `renderer.keyInput`（`renderer.on("keypress")` 收不到）。
- **raw mode 差异（重要）**：Bun 的 `process.stdin.setRawMode()` 在 Windows 下不改动 OS 控制台模式，且 Bun 每读一次 stdin 会把模式翻回 cooked。对策：`ts/src/tui/console.ts` 用 `bun:ffi` 直接 `SetConsoleMode`（清 `ENABLE_PROCESSED_INPUT|ENABLE_LINE_INPUT|ENABLE_ECHO_INPUT`、置 `ENABLE_WINDOW_INPUT`；其中清 `PROCESSED_INPUT` 只为与 crossterm 对齐，**不会**让 Ctrl+C 可用，见 22.6），并在每次输入事件与每次重绘前重申 raw；退出路径还原原模式。注意输入句柄是 `(HANDLE)-10` = `0xfffffff6`（`0xfffffff5` 是输出句柄，M2 曾写错）；`bun:ffi` 对 `i64` 返回 `bigint`，比较前须 `Number()` 归一。

**Node 版（手写 ANSI 渲染层）**：

- 渲染层为手写 ANSI（`tui/ansi.ts`、`wcwidth.ts`、`screen.ts`、`terminal.ts`），无任何第三方 TUI 库。帧模型 = `TuiLine[]`；写屏为**行级 diff**：与上一帧逐行比对，仅对变化行发 `\x1b[{row};1H` + 行内容；首帧 `\x1b[2J\x1b[H` 全清；帧首尾包 DEC 2026 同步输出（不支持的终端静默忽略私有模式）；底行不写满最后一格（防右下角 cell 触发整屏上滚，配合启动时 DECAWM 关 `\x1b[?7l` 双保险）。
- **sanitize 是注入防线的唯一关卡**：没有 widget 级免疫，一切外部字符串（skill 名称/描述、API 文案）进帧前过 `sanitize()`（先整段剥 ANSI 序列 CSI/OSC，再剥残余控制符）；测试含注入用例。
- wcwidth 为内嵌码点区间表（`tui/wcwidth.ts`），不引 npm 包。
- raw mode 与 VT 输入/输出模式由 Node 在 TTY 上自动处理（`ENABLE_VIRTUAL_TERMINAL_PROCESSING` / `ENABLE_VIRTUAL_TERMINAL_INPUT`），无需 Win32 调用；但恢复处理器必须在终端初始化**之前**注册（对齐 Rust panic hook 先于终端初始化），且 `createTerminal()` 自身对 ENTER 之后的步骤做 try/catch——失败先写 LEAVE 再抛。
- **250 ms 心跳定时器不可 `unref`**：Node 中 pending promise 不保活事件循环，非 TTY stdin 也不持有句柄——该定时器是事件循环的保活锚点，退出时由统一销毁路径清除。Rust/Bun 版无此约束。
- TS 执行依赖 Node 原生 type stripping，只允许可擦除语法（无 enum/namespace/参数属性）；`tsc --noEmit` 须保持 0 error。

### 22.6 无单实例互斥与启动缩窗（对应 20）

- **无单实例互斥**：三版一致，允许多实例并存，不建任何命名互斥锁。
- **Bun 版缩窗与 Rust 同判据**：`bun:ffi` 调 `kernel32!GetConsoleProcessList` 可用，按「附加到本控制台的进程数恰好为 1」判定独占；环境变量启发式只在 FFI 不可用时兜底；`stdout` 非 TTY 时一律不缩。两条缩窗通道与 Rust 同名同序（(a) `ESC [ 8 ; 13 ; 72 t`；(b) conhost Win32 序列），差别只在传参方式：`COORD`/`SMALL_RECT` 按值传参，bun:ffi 无结构体参数，故按 x64 调用约定手工打包进整数寄存器（`COORD = (y<<16)|x`，`SMALL_RECT` 四个 i16 依次占 0/16/32/48 位）。
- **Node 版缩窗为环境变量启发式**：无 Win32 binding，`WT_SESSION`/`TERM_PROGRAM`/`ConEmuPID` 任一存在 → 共享终端，绝不缩窗；三者全缺 → 进入 alternate screen 之前向 stdout 发 `ESC[8;13;72t`（异常静默吞掉）。**实测结论（2026-09-20，WT 1.24 / conhost，经 Start-Process 新窗口 + 回读 `stdout.columns` 探针）**：当前 ConPTY 不透传窗口操作转义——CSI 8、CSI 4（像素）、`mode con` 三条通道均不生效，该序列在本机为优雅 no-op，窗口保持默认尺寸；未来 ConPTY 若转发窗口操作则自动生效。
- **Bun 版 Ctrl+C 不能退出（实测 2026-09-20，WT 1.24 / conhost）**：`ts/src/tui/console.ts` 清 `ENABLE_PROCESSED_INPUT` 是为与 crossterm 对齐（同时让 Ctrl+B/Ctrl+H 以字节送达），但 Bun 运行时下 Ctrl+C **既不作为按键送达、也不作为 JS SIGINT 送达**，置位/清零两条路都实测过：裸 bun 进程（不改 console mode、不注册 handler、不读 stdin）对 Ctrl+C 无反应；同一窗口、同一注入方式下 Rust 版（crossterm）正常退出；OpenTUI 解析器对 `0x03` 能正确产出 `{name:"c",ctrl:true}`（`ts/scripts/verify/parse-ctrlc.ts`）。可见事件被 Bun 侧吞掉。故 **Bun 版的退出键以 `q` 为准**；`app.ts` 的 SIGINT/SIGBREAK handler 与 `handleKey` 的 ctrl+c 分支保留（当前不改变行为，运行时若修复即自动生效）。复现脚本见 `ts/scripts/verify/`。
