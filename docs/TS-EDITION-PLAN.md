# Kimi Planbar TUI — TS 版（Bun + OpenTUI）实施计划

> 状态：待实施（M0 仓库重组与 Bun 环境安装已于 2026-09-19 完成）
> 行为契约：`docs/SPEC.md`（与 Rust 版共享；TS 版实现差异点见本文 §6，实现验证后需回写 SPEC 对应章节）
> 前身：托盘版仓库的 `docs/TUI-PLAN-TS-BUN.md`（候选方案，当时未实施；本文档取代之并适配 monorepo 落点）

## 1. 已确认决策（不再变更）

- **落点**：本仓库 `ts/` 子目录（monorepo，Rust 版已在 `rust/` 归位，布局参照 kimi-planbar-tray）
- **运行时**：Bun ≥ 1.3（本机已装 1.4.2）。不选 Node.js：OpenTUI 要求 Node ≥ 26.4 + `--experimental-ffi`（Node 26 现为 Current，2026-10-28 才转 LTS），且 Node SEA 打包 OpenTUI 需资产清单抽取，流程远比 `bun build --compile` 繁琐
- **渲染层**：`@opentui/core` 命令式 API，不引 React
- **测试**：`bun:test` 内置
- **版本**：`ts/package.json` 独立从 0.1.0 起步
- **数据契约**：与 Rust 版完全一致——凭证链、`settings.json` schema、`portable.dat`、HKCU Run 键名 `KimiPlanbarTui`、app-data 目录 `%APPDATA%\KimiPlanbarTui\`（两版同装时自启键后写覆盖，与托盘三版共享互斥名同思路，有意为之）
- **零其他运行时依赖**：HTTP 用内置 `fetch` + `AbortSignal.timeout(10_000)`；子进程用 `Bun.spawn`；注册表只走 spawn `reg.exe`

## 2. 环境冒烟实测结论（2026-09-19，Bun 1.4.2 / 中文 Windows 11 / ESET）

实现前必读，对策已验证有效：

1. **fetch + Range 的 ZlibError 坑**：GitHub Pages 对 Range 请求返回 206 且带 gzip 内容编码，Bun 解压分片流报 `ZlibError`。
   → 对策：**Range 请求一律加 `Accept-Encoding: identity`**（实测返回 206 正常）。SPEC 17.2 的 changelog 拉取必须照此实现。
2. **api.github.com TLS 验证失败**（`unable to verify the first certificate`）：本机 ESET 做 TLS 检查并用自有根证书重签，该根在 Windows 系统 CA 库而不在 Bun 自带的 Mozilla CA 库（`api.kimi.com` 与 `moonshotai.github.io` 未被拦截，故只有 GitHub API 兜底路径受影响）。
   → 对策：运行时加 **`--use-system-ca`**（实测通过）。注意 `BUN_USE_SYSTEM_CA` 环境变量**无效**（实测）；`bun build --compile` 产物如何固化该开关为开放问题（§7 风险表）。
3. **`Bun.spawn` 调 `reg.exe` + `TextDecoder('gbk')` 解码正常**（中文系统 reg 输出为 GBK；`AppsUseLightTheme` 正确读出）。自启只做写/删、不做读回校验，规避乱码面。
4. **stdin raw mode**：管道/非 TTY 下 `process.stdin.setRawMode` 不可用属预期；OpenTUI 通过自己的 FFI 设置控制台模式，不依赖它。
5. Bun 安装注意：`npm i -g bun` 会被 npm allowScripts 策略拦截 postinstall，需 `npm install -g --allow-scripts=bun bun`。

## 3. 目录与模块设计

```
ts/
├── package.json              # name: kimi-planbar-tui-ts, version: 0.1.0, type: module
├── tsconfig.json             # strict; moduleResolution: bundler
├── src/
│   ├── core/                 # UI 无关，逐模块对应 SPEC；禁止 import 任何 @opentui 符号
│   │   ├── credentials.ts    # 16.2 凭证链：kimi-code.json（expires_at > now+30s）→ config.toml 手写逐行解析；KIMI_CODE_HOME 覆盖
│   │   ├── quota.ts          # 16.1/16.3/16.4：fetch + 防御性解析；JSON 数字一律 string 建模、容忍数字兜底
│   │   ├── polling.ts        # 16.5：2s 首刷 / 失败 30s 快重试 / keep-last-good 补齐；事件通知 UI
│   │   ├── settings.ts       # 18：settings.json + portable.dat + HKCU Run 自启（spawn reg.exe；只写/删不回读）
│   │   ├── skills.ts         # 21.2：三目录扫描 + SKILL.md 前 4KiB frontmatter 手写解析（去 BOM、容忍截断多字节）+ 首开缓存
│   │   ├── update.ts         # 17：kimi --version（5s kill）+ changelog Range 4KB（带 Accept-Encoding: identity，见 §2.1）+ GitHub API 兜底
│   │   ├── format.ts         # 12.3 formatReset / 12.5 fmtYuan / clampPercent + 全部 DTO 类型（移植自 rust/src/format.rs）
│   │   └── theme.ts          # 11.1 十色调色板（Moonlit/Moondark #RRGGBB）；reg query 启动读一次 + 30s 轮询（SPEC 20）
│   ├── tui/                  # OpenTUI 渲染层（与 core 严格分层，可整体替换）
│   │   ├── app.ts            # 装配：布局、双主题、键盘路由、事件循环（事件驱动重绘 + 250ms 心跳，SPEC 20）
│   │   ├── dashboard.ts      # 主视图（SPEC 12 线框布局）
│   │   ├── settingsView.ts   # 设置表单（13.2 选项/默认值/保存顺序）
│   │   └── skillsView.ts     # 分组可滚动只读列表（21.3）
│   └── main.ts               # 入口；--test-fetch / --test-update 自检先于一切初始化（SPEC 19）
└── test/                     # bun:test，用例对照 rust/src/ 的单测 1:1 移植
```

## 4. 实施步骤

### M1：core 八模块 + 单测

1. 建 `ts/` 骨架：`package.json`（独立 0.1.0）、`tsconfig.json`；`bun install`
2. 按依赖顺序移植 core（注释引用 SPEC 章节号，与 Rust 版同风格）：`format.ts` → `credentials.ts` → `quota.ts` → `settings.ts` → `theme.ts` → `skills.ts` → `update.ts` → `polling.ts`；对照 `rust/src/*.rs` 1:1 行为移植
3. `test/` 单测钉死陷阱（对照 Rust 版测试用例）：
   - SPEC 16.3：`amountLeft` 1e-8 元 → `(raw + 500000) / 1000000` 分（四舍五入）；字符串/数字混排兜底；`isEnabled=false` → NotActivated；`limit<=0` 防除零
   - SPEC 16.2：token 过期（expires_at ≤ now+30s）回退 config.toml；节结算顺序
   - SPEC 12.3 / 12.5：formatReset 各时间档边界、fmtYuan 负数/整元/零
   - skills frontmatter：BOM 剥离、引号去除、缺省回退目录名、4KiB 截断
4. `main.ts` 先只实现 `--test-fetch` / `--test-update`（打印缩进 JSON / 单行，输出后退出，SPEC 19）
5. 验收：`bun test` 全绿；`bun run src/main.ts --test-fetch` 与 `rust/target/debug/kimi-planbar-tui.exe --test-fetch` 同机背靠背 **JSON 逐字段 diff 一致**

### M2：dashboard 视图

1. `bun add @opentui/core`；`tui/app.ts` 装配 renderer + 根布局；`tui/dashboard.ts` 按 SPEC 12 线框：标题行 / 两行用量行（14 字符标签列 + 百分比 + `█`/`░` 进度条 + 倒计时）/ Extra Usage 行（含月度子行）/ 版本行 / footer
2. 调色板按 SPEC 11.1 十色直给 `#RRGGBB`；`theme=system` 由 `core/theme.ts` 30s 轮询注册表决定
3. 事件驱动重绘 + 250ms 心跳：倒计时文案每次重绘重算（`reset_at - now`），无独立秒级定时器
4. 先用 mock 数据渲染；进度条宽度自适应终端宽度、不足 5 字符整条省略（12.2）
5. 验收：Windows Terminal 下亮/暗双主题人工对照 SPEC 11/12

### M3：交互与系统集成

1. 键盘路由全集（12.7）：`r`（2s 防抖，静默忽略）/ `s` / `k` / `c` / `g` / `q` / `↑↓` / `Enter` / `Esc`；`c`/`g` 用 `Bun.spawn(["cmd", "/c", "start", ...])` 或 `rundll32 url.dll` 打开浏览器，异常静默吞掉
2. 设置表单（13.2）：打开时按当前设置回填；Save 顺序 = 写 JSON → 自启 → 主题 → 重排定时器 → 返回 dashboard
3. skills 视图（21.3）：首开取缓存、重扫键强制重扫；组内名称不区分大小写排序；描述超宽截断
4. polling 接入：2s 首刷、失败 30s 快重试、keep-last-good 补齐、footer 时间戳（12.1 三态）
5. 后台版本检查（17）：启动一次 + `r` 联动；changelog 主路径带 `Accept-Encoding: identity`；GitHub API 兜底失败静默降级 `checkFailed`
6. **终端恢复（最高优先级，SPEC 20）**：每条退出路径恢复 alternate screen + 关 raw mode + 显示光标——正常 `q`、以及 `process.on('uncaughtException'/'unhandledRejection')` 先恢复再退出
7. **启动缩窗 72×13（TS 版差异点）**：无原生 Win32 binding，`GetConsoleProcessList` 独占守卫改用环境变量启发式——存在 `WT_SESSION` / `TERM_PROGRAM` / `ConEmuPID` 等终端变量 = 从已有终端启动 → 绝不缩窗；缺失 = 双击/新窗口 → 发 `ESC[8;13;72t`（Windows Terminal 1.22+ 支持）。实测验证后回写 SPEC 20 补充 TS 版条文
8. 验收：三视图交互走查；`q` 与异常强杀后终端完全恢复；共享终端窗口尺寸不被改动

### M4：打包、文档与审查

1. `bun build --compile ./src/main.ts --outfile kpt-tui.exe`（~90 MB，内嵌 Bun 运行时）；验证 exe 的 `--test-fetch` / `--test-update` 与 Rust 版 diff 一致
2. 查证并解决 `--use-system-ca` 在编译 exe 上的固化方式（编译参数 / bunfig / 代码内设置；均不可行则 README 注明 ESET 类 TLS 检查软件下 GitHub API 兜底会静默降级，changelog 主路径不受影响）
3. 文档同步：SPEC.md / SPEC_EN.md 增补 TS 版差异条文（缩窗启发式等）；AGENTS.md 仓库布局去 "planned" 并补 ts/ 说明；README × 2 增加 TS 版构建/分发说明
4. 按用户全局规范派独立 code-reviewer subagent 审查（只给需求与代码路径，以证伪为导向）
5. 验收：三版（rust 调试版、rust release、ts exe）`--test-fetch` 两两 diff 一致；全部文档与实现一致

## 5. 一致性验证基线

- 功能与 UI 以 Rust 版为参照实现；行为歧义以 `docs/SPEC.md` 为准
- `--test-fetch` 输出字段（camelCase JSON：`fiveHour/week/extra/fetchedAt/error`）与错误类型命名（`"HttpRequestException"` 等 .NET 风格，SPEC 16.4）必须逐字符对齐，保证跨版本可 diff

## 6. TS 版实现差异点清单（实现后回写 SPEC）

| 差异 | 原因 | SPEC 章节 |
|---|---|---|
| 缩窗守卫用终端环境变量启发式替代 `GetConsoleProcessList` | 无原生 Win32 binding | 20 |
| changelog Range 请求带 `Accept-Encoding: identity` | Bun fetch 解压 206+gzip 报 ZlibError | 17.2 |
| TLS 信任走 `--use-system-ca`（ESET 类 TLS 检查环境） | Bun 自带 Mozilla CA 库不含本地重签根 | 17.2 / 8 |
| 注册表操作全部 spawn `reg.exe`（GBK 解码） | 无 winreg 等价物 | 18.3 / 20 |

## 7. 风险

- **OpenTUI 年轻**：官方曾自称未 production-ready（opencode 生产在用）；对策 = core/tui 严格分层，渲染层可整体替换为手写 ANSI 而不动 core
- **分发体积**：`--compile` ~90 MB，远大于 Rust 版 3–5 MB；README 注明，或改为要求用户装 Bun
- **Bun Windows 边角**：TTY/spawn/fetch 三件套已冒烟通过；M1 先 core 后 TUI，问题早暴露
- **`--use-system-ca` 固化未解**：兜底方案见 M4.2；最坏情况仅 GitHub API 兜底路径在 TLS 检查环境下静默降级（changelog 主路径正常），不阻塞发布
