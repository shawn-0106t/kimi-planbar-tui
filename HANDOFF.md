# HANDOFF — Bun 版（`ts/`）"无法使用"故障排查交接

> 日期：2026-09-25 · 排查人：ZCode（用户委托：code-reviewer 全量审查 + 真实终端实测）
> **状态更新（同日）**：经用户确认，§2/§3 的修复已全部落地并通过端到端验收（见文末「修复落地记录」）；`ts/` 已解冻恢复维护，版本升到 0.1.2。下文保留排查当时的事实记录。
> 结论有效性基于本机实测环境：Bun 1.4.2 / @opentui/core 0.5.11（lockfile 钉住）/ Windows Terminal 1.24.11911.0 / Windows 10.0.26200 / conhost 与 WT 双验证

## TL;DR

**"bun 版无法使用"的首要根因已实锤：`ts/src/tui/shrink.ts` 的 bun:ffi 函数签名声明错误，导致"独占 console 启动"（双击 exe / `start` / 开机自启指向 Bun exe 的场景）时进程在启动瞬间原生崩溃（segfault at 0x0，退出码 3），窗口一闪而过。** 所有能在终端会话内运行的验证路径（`bun run dev`、`--test-fetch`、bun test、管道运行）都被 SPEC 20 的 guard 短路跳过了这段代码，因此 270 个测试全绿、自检全过、CI 无感。

次要确定缺陷：OpenTUI 渲染器默认开启 mouse tracking（真实终端下鼠标被完全劫持，无法选择/复制文本，且鼠标事件流可绕过 raw-mode 重断言造成回显污染）。

**该故障不是 Bun 本身的 bug，是本仓库 `ts/` 的代码 bug**（FFI 签名把指针参数当按值结构体传）；但 Bun 生态的不成熟放大了它：bun:ffi 对原生 segfault 零防护、无法被 JS `try/catch` 捕获，崩溃信息只印在闪退的窗口里，用户视角就是"无声闪退"。详见 [§6 Bun 生态判定](#6-bun-生态判定)。

---

## 1. 故障现象（用户视角）

- 双击 `ts/dist/kpt-tui.exe`（或任何独占 console 的启动方式）：**窗口闪一下立即消失，或根本看不到窗口**。无任何错误输出。
- 在终端会话里跑（`bun run dev` / `bun run selfcheck:*`）：一切正常——这也是它长期未被发现的原因。

## 2. 已实锤根因：`shrink.ts` FFI 签名错误 → NULL 指针解引用

### 2.1 缺陷定位

`ts/src/tui/shrink.ts:52`（声明）与 `ts/src/tui/shrink.ts:115,117`（调用）：

```ts
// 声明：第三参声明为按值 u64 —— 错误
SetConsoleWindowInfo: { returns: FFIType.u8, args: [FFIType.i64, FFIType.u32, FFIType.u64] },

// 调用：把打包好的 SMALL_RECT 位串当"值"传给 kernel32
lib.symbols.SetConsoleWindowInfo(out, 1, packSmallRect(0, 0, 0, 0));  // 首次调用 = 传 0
```

Win32 原型是 `BOOL SetConsoleWindowInfo(HANDLE, BOOL, const SMALL_RECT *lpConsoleWindow)` —— **第三参是指针，不是按值结构体**。`shrink.ts:16-17` 的注释（"COORD and SMALL_RECT are passed by value, packed into an integer register per the x64 ABI"）对 ABI 的理解有误：`SetConsoleScreenBufferSize` 的 `COORD` 确实按值传（该行声明正确），但 `SetConsoleWindowInfo` 的参数表本身就是指针。

首次调用 `packSmallRect(0,0,0,0)` 打包结果为 `0` → kernel32 解引用地址 0x0 → **native segfault**。即便传非零位串，也是把数据当地址，同样崩溃。`shrinkViaWin32` 外层的 `try/catch`（shrink.ts:109-122）拦不住原生崩溃。

### 2.2 证据链（全部为本机实测，2026-09-25）

| # | 实验 | 结果 |
|---|------|------|
| 1 | WT 标签页跑 `bun run dev`（共享 console，`WT_SESSION` → guard 跳过 shrink） | ✅ 正常渲染、k/s/Esc/q/Ctrl+C 全部工作、退出干净恢复 |
| 2 | 同一 exe 用 `cmd /k` 宿主启动（同 console 2 个进程 → guard 跳过 shrink） | ✅ TUI 正常运行，q 退出正常 |
| 3 | `start /wait "" dist\kpt-tui.exe`（独占 console，`GetConsoleProcessList()==1` → shrink 执行） | ❌ **立即崩溃，EXIT=3** |
| 4 | 最小探针（无条件调用 `shrinkViaWin32(72,13)`，与 guard 无关） | ❌ `panic(main thread): Segmentation fault at address 0x0` + `oh no: Bun has crashed`（崩溃帧指向 KERNELBASE.dll，即 SetConsoleWindowInfo 实现层），EXIT=3 |
| 5 | 对照：`rust/target/release/kimi-planbar-tui.exe` 同样独占启动 | ✅ 存活（Rust 版 winapi 正确传指针）——崩溃为 Bun 版特有 |

注：实测期间 dev 模式下 dashboard、skills（102 个 skills 中文渲染无乱码）、settings、刷新倒计时、250ms heartbeat、退出恢复（alternate screen / cursor / cooked mode）全部正常。

### 2.3 修复方案（一行声明 + 三行调用）

```ts
// 声明改为指针
SetConsoleWindowInfo: { returns: FFIType.u8, args: [FFIType.i64, FFIType.u32, FFIType.ptr] },

// 调用改为传 8 字节 Buffer 指针（SMALL_RECT = 4 × i16，小端）
const rect = Buffer.alloc(8);
rect.writeInt16LE(left, 0); rect.writeInt16LE(top, 2);
rect.writeInt16LE(right, 4); rect.writeInt16LE(bottom, 6);
lib.symbols.SetConsoleWindowInfo(out, 1, ptr(rect));
```

`SetConsoleScreenBufferSize`（COORD 按值）保持不变。回归测试建议：mock `lib` 断言第三参被 `ptr()` 包装过（纯 JS 可测），另加一条真实终端的双击启动人肉验收项。

**注意：`ts/` 在排查当时是 frozen 状态（experimental & frozen；当时的 ts/README.md 与 AGENTS.md 均为冻结口径，现已改为解冻）。解封修复是维护决策，须由仓库所有者拍板**；若决定解封，建议顺带处理 §3 与 §4 的发现并同步更新 SPEC 22 / AGENTS.md 陷阱表（§7）。

## 3. 次要确定缺陷：mouse tracking 劫持（code-reviewer Major #1）

`ts/src/tui/renderer.ts:136` 只传了 `exitOnCtrlC: false`，而 OpenTUI 0.5.11 内部默认 `useMouse ?? true` → 启动即发送 `ESC[?1000h ?1002h ?1003h ?1006h`（审查中在启动字节流实测捕获）。`ts/src` 全目录无任何代码消费鼠标事件。真实终端下用户可见后果：

1. **鼠标完全被 app 劫持**：点击/拖动/选择/复制 dashboard 文本全部失效（只读 dashboard 的核心交互破坏；Rust 版 crossterm 不启用鼠标，SPEC 12.7 键表也无鼠标定义——契约外行为泄漏）。
2. `?1003` any-motion 模式下鼠标移动产生持续事件流；该事件流不经过 `ensureRawMode()`（app.ts:432 keypress 路径 / app.ts:360 draw 路径），叠加"Bun 每读一次 stdin 翻回 cooked"（SPEC 22.5 实测），鼠标移动期间 console 长时间停留 cooked，conhost 会把 VT mouse 序列回显上屏污染渲染。

修法一句话：`createCliRenderer({ exitOnCtrlC: false, useMouse: false })`。

## 4. code-reviewer 完整审查发现（2026-09-25，18 个源文件，71 次取证）

审查同时确认无恙的关键路径（供交叉核对）：q/s/ESC/k 按键路由（含模拟真实终端 capability 响应注入后仍存活：DA1/DA1-ext/XTVERSION/OSC10/11/DECRPM/kitty `ESC[?1u`/CPR/14t/focus，无死锁、kitty push/pop 对称、exit=0）、退出路径终端恢复序列（`?1049l`/`?25h`/`?2031l`）、polling epoch/串行化竞态防护、boosterWallet 1e-8 元转分（与 Rust trunc 语义一致）、凭据链 fallback、GBK 解码、bun:ffi number→i64 转换。

- **[Minor] app.ts:326-356 — 终端恢复保护注册在 terminal init 之后**：`uncaughtException`/`unhandledRejection`/SIGINT 处理器在 `await makeRenderer()` 之后才注册；Rust 版明确把 panic hook 装在终端初始化之前（`rust/src/app.rs:366-373`，"must be installed BEFORE terminal init"）。若 `createCliRenderer` 抛出，恢复完全依赖 OpenTUI 内部 partial destroy。修法：三个处理器移到 `makeRenderer()` 之前，destroy 闭包容忍 renderer 未就绪。
- **[Minor] app.ts:442-451 + core/theme.ts:80-93 — 主题轮询用同步 `Bun.spawnSync(reg.exe)`**：theme=system 时每 30 秒阻塞事件循环一次（数十 ms），期间渲染/按键/倒计时全部停顿。Rust 版是 async tokio task。修法：改异步 `Bun.spawn` + 回调写缓存。
- **[Minor] app.ts:451,454 — `themeTimer.unref()`/`heartbeat.unref()` 隐式依赖 OpenTUI 内部 keep-alive**：Bun 版事件循环存活实际靠 OpenTUI 的内部 60s `setInterval`（仅当 `stdin === process.stdin` 时创建），这一外部依赖在 ts/ 代码中零注释。ts-nodejs 版同类问题已写入 SPEC 22.5（"心跳不可 unref"）。修法：不 unref heartbeat 并加注释。
- **[Suggestion] renderer.ts:119-121**：keypress handler 链无本地 try/catch，任何 throw 冒到 OpenTUI 的 catch 后本次 `draw()` 被跳过。
- **[Suggestion] app.ts:398-413**：`requestSkills(true)` 在 loading 中静默丢弃（与 Rust 1:1，可补一帧提示）。
- **[备案] app.ts:463**：`openUrl` 每次向共享 console 瞬态 attach 一个 cmd 进程。
- **排除项**（SPEC 22 已登记的历史例外，不计为新发现）：Ctrl 组合键忽略（22.6）、编译产物无法固化 `--use-system-ca`（22.4）、Bun 翻 cooked 对策（22.5）。

## 5. 排查中的新实测发现（文档修订项）

1. **Ctrl+C 在 Bun 1.4.2 已能正常退出**（WT 1.24 实测：Ctrl+C → 优雅退出，EXITCODE=0，终端完整恢复）。**SPEC 22.6 与 AGENTS.md 陷阱表中"2026-09-20 实测 Bun 完全吞掉 Ctrl+C"的记录已过时**，code-reviewer 基于该记录把 Ctrl+C 列为根因 #1，实测不复现。文档若解封应一并更新（`ts/scripts/verify/` 的复现脚本结论需重测）。
2. **`c`（Console）/`g`（Releases）实测两次未打开浏览器**（Chrome 无新标签；`openUrl` = `Bun.spawn(["cmd","/c","start","",url], {stdout:"ignore",stderr:"ignore",windowsHide:true})`，失败静默）。**未定项**：可能是 `windowsHide:true` 下 `start` 失败、或 Bun.spawn 行为问题，待单独验证（错误被 SPEC 12.6/12.7 允许地吞掉了，属"无反馈"类缺陷）。
3. **编译 exe 的配额 fetch 疑似失败**：cmd 宿主实测中 8 秒后 quota 行仍为 `--` 且无 "Updated" 时间戳（dev 模式 2 秒即出数据）。**【已推翻】修复验收时独占启动的 exe 8 秒内即显示实时数据（23%/5%，"Updated 16:12"）——编译版 fetch 正常，当时的观察只是首启时序波动。**
4. **开机自启指向的是 Rust 版 exe**（HKCU Run `KimiPlanbarTui` = `rust\target\release\kimi-planbar-tui.exe`），故日常自启不受本故障影响；settings.json 为两版共享（`AutoStart: true`）。

## 6. Bun 生态判定（回应"是否 Bun 在 Windows 生态不成熟所致"）

**直接根因是本仓库代码 bug，不是 Bun 的 bug**；但有三点 Bun/Windows 生态因素实质参与了故障的成形与隐藏：

1. **bun:ffi 对原生崩溃零防护**：签名错误（调用方 bug）直接变成 segfault，JS `try/catch` 拦不住，进程无声死亡。Bun 的 crash banner 还写着 "This indicates a bug in Bun, not your code"，有误导性。同等错误在 Rust（编译期类型检查）或 Node N-API（参数校验）下都不会以"闪退"形式出现。
2. **平台行为在版本间漂移**：2026-09-20 实测"Ctrl+C 被 Bun 完全吞掉"（SPEC 22.6），今日 Bun 1.4.2 下已不复现——同一代码、不同 Bun 版本、关键交互行为反转。这种漂移正是该版本被冻结的合理理由，也说明其"实测记录"有半衰期。
3. **故障不可见性**：独占 console 崩溃时错误输出随窗口一起消失，无日志落盘；叠加崩溃发生在"所有自动化测试都不覆盖"的分支，形成了 270 测试全绿 + 真实使用即崩的落差。

结论：**修代码（shrink.ts 声明 + useMouse:false）即可恢复可用；Bun 生态因素是放大器不是根因**。若继续维护 Bun 版，建议把"独占 console 启动"加入人肉验收清单；若不再维护，本文件可作为冻结归档的事故记录。

## 7. 触发矩阵（速查）

| 启动方式 | console 归属 | shrink 分支 | 结果 |
|---|---|---|---|
| 双击 `dist\kpt-tui.exe` / `start` / 自启指向 Bun exe | 独占（==1 进程） | 执行 | ❌ segfault 闪退 |
| `bun run dev`（WT/VS Code/Git Bash 内） | 共享（guard 命中环境变量） | 跳过 | ✅ 正常 |
| `cmd /k` 宿主再跑 exe | 共享（≥2 进程） | 跳过 | ✅ 正常 |
| `--test-fetch` / `--test-update` / 管道 | 非 TTY | 跳过（`isTTY=false`） | ✅ 正常 |

## 8. 复现命令（供接手人再执行）

```bash
# 崩溃复现（独占 console；注意窗口会闪退，用 start /wait 取退出码）
cd ts
cmd /c "start /wait \"\" dist\\kpt-tui.exe & echo EXIT=%ERRORLEVEL%"   # 预期 EXIT=3

# 探针（无条件触发 shrinkViaWin32，共享 console 下即可复现 segfault）
# 临时脚本：import { shrinkViaWin32 } from "<repo>/ts/src/tui/shrink.ts"; shrinkViaWin32(72,13);
bun <probe>.ts    # 预期：panic(main thread): Segmentation fault at address 0x0, EXIT=3

# 正常路径对照
bun run dev       # WT 标签页内：渲染/按键/退出全部正常
bun run test      # 270 通过（证明测试盲区在 guard 分支）
```

## 9. 建议处理顺序（2026-09-25 已执行 ✅）

1. ✅ 修 `shrink.ts` FFI 签名（§2.3）——`packSmallRect` 改为返回 8 字节 Buffer 经 `ptr()` 传入；字节布局回归测试钉在 `ts/test/shrink.test.ts`。
2. ✅ `renderer.ts` 传 `useMouse: false`——启动序列不再含 `?1000h/?1002h/?1003h/?1006h`（管道实测）。
3. ✅ 恢复处理器前移到 `makeRenderer()` 之前，闭包对 renderer/raw-mode 还原句柄空值容忍。
4. ✅ 文档同步：SPEC.md / SPEC_EN.md（第 1/3/7/9/20/22 章相关条目、22.5 新增 mouse tracking 与恢复处理器条目、22.6 修订缩窗传参与 Ctrl+C 记录）、AGENTS.md（解冻、陷阱表、验收清单）、ts/README.md、版本 bump 0.1.2（`bun.lock` 不记录 workspace 版本，无需同步）。
5. 遗留（未修，属低优先级改进）：§4 的三个 Minor（主题轮询 `spawnSync` 阻塞、heartbeat `unref` 隐式依赖、keypress handler 无兜底 try/catch）与 §5-2（`openUrl` 本机未生效待查）——留待后续维护批次。

## 10. 修复落地记录（2026-09-25）

- 改动文件：`ts/src/tui/shrink.ts`、`ts/src/tui/renderer.ts`、`ts/src/tui/app.ts`、`ts/test/shrink.test.ts`（新增字节布局回归用例）、`ts/package.json`（0.1.2）、`ts/README.md`、`docs/SPEC.md`、`docs/SPEC_EN.md`、`AGENTS.md`、本文件。
- 验证结果：`bun run test` 全绿 0 失败（新增 2 例回归测试；pass 计数 270–271 浮动——两个 parity 用例是否计入 pass 随本机 `rust/target/debug` exe 是否在位浮动，判定标准为 0 失败）；管道启动序列 mouse tracking 转义为 0；`bun run build:exe` 后独占 console 启动（原崩溃场景）**进程存活**（修复前 EXIT=3）、72×13 缩窗生效、TUI 完整渲染且实时配额数据正常到达。
- 交付前已按用户全局规则将本 diff 委派 code-reviewer 子代理独立复审。

## 11. 后续计划（2026-09-25 用户拍板）：Go 版第四实现

用户决定启动 **Go + bubbletea v2 / lipgloss** 版本（仓库第四个实现，目录约定 `go/`，行为契约仍为 `docs/SPEC.md`，版本号独立）。选型依据来自 2026-09-25 的技术栈调研（bubbletea v2.0.10 / tcell v3.5.0 均为 stable 且发版密集；单文件 exe 8–15 MB、`CGO_ENABLED=0` 交叉编译零配置；Charm 一线维护 Windows 支持；本项目的 Win32 需求在 Go 生态有现成包：`golang.org/x/sys/windows/registry` 等）。

**移植顺序**（调研结论，按此执行）：

1. **core 层**（10 模块，约 1.5–2.5k 行 Go）：逻辑 100% 可移植、代码 0% 复用——难点不在 CRUD 而在**防御性解析语义逐条复刻**：Go 的 `encoding/json` ≠ serde_json，需要同等克制的自定义解析镜像 `ts/src/core/json.ts`（严格 RFC3339、string-or-number、128 层深度上限、DST 拒绝语义）；SPEC 16 系列陷阱逐条对表（1e-8 元转分、`isEnabled=false`、4 KiB skills 截断、凭据链 30 s 余量）。
2. **goldens 与 parity 原样复用**：7 个 Rust oracle golden 纯文本直接共享；自检输出做到 serde-identical JSON 后，`diff.ts` 只改 exe 路径——这是本仓库抗换栈的核心资产。
3. **TUI 层**：三个视图从 `rust/src/ui/`（约 500 行）直译行布局/颜色/裁剪规则；bubbletea/lipgloss 替代 ratatui。
4. **Win32 位逐项实测**：owned-console guard（`GetConsoleProcessList`）、缩窗双通道、HKCU Run、30 s 主题轮询——每个都要按 SPEC 20/22 陷阱表重新实测，成本集中在运行时行为差（raw mode、Ctrl+C、ConPTY），不在画界面。

**DoD（必须含，本次事故最大教训）**：`owned-console 双击启动人肉验收`写进验收清单——自动化测试够不到独占 console 分支（2026-09-25 segfault 事故正是 270 测试全绿仍闪退）；另加 `--test-fetch` / `--test-update` 与 Rust exe 背靠背 parity 全绿、双主题人肉验收。

**启动前检查**：确认 Go 工具链是否已安装（查 `C:\Users\rexxa\.kimi-code\env-snapshot\` 最新环境清单；快照 2026-09-19 未记录 Go 的话需先安装并重新盘点）。预算参考：2–4 周业余时间达 parity 全绿 + 双主题验收。

**定位**：Go 版与现有三版同为 SPEC 契约的受支持实现，SPEC 22 为其新开登记小节；`go/` 的构建/测试/发布条目在落地后补进 AGENTS.md 与 SPEC 第 7/19 章。
