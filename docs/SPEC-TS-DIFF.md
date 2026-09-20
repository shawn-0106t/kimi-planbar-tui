# TS 版实现差异条文（SPEC-TS-DIFF）

> 定位：`docs/SPEC.md` 是两版共享的唯一权威行为契约；本文件只登记 **TS 版（Bun + OpenTUI）实现层面与 Rust 版不等价的机制**，按 SPEC 章节号归档，避免把主 SPEC 改成一版一份。
> 结论来源：M1 阶段的实测与 Rust oracle（`ts/test/parity/make-oracle.ts` → `ts/test/golden/`），全部条目都有测试锁定。
> 状态：M1（core 层）已实现并逐字节验证；M2 渲染层条文见 §5；M3（三视图 + 键盘路由 + 缩窗）条文见 §5、§6，其中真终端实测项在 §6 末尾逐条列出，尚未打勾。

## 1. 验证方法（对应 SPEC 7.2 / 19）

- **`--test-fetch` 字节 parity 契约**：两版输出除 `fetchedAt` 的**值**以外必须逐字节相同。该字段是唯一豁免项——Rust 用 100 ns 精度的系统时钟、chrono 固定打印 9 位小数，JS `Date` 只有毫秒。比对时两侧都归一化为 `"fetchedAt": "<NOW>"`（`ts/test/parity/diff.ts` 实现）。
- **两套证据**：
  1. **Rust oracle golden**（纯解析与文本格式）：临时 cargo 工程原样复用 `rust/src/quota.rs` 的 DTO 与解析函数，产出 `ts/test/golden/`（浮点文本表、chrono 时间戳表、`from_str` 矩阵、30 个 `QuotaResult` 文档、`settings.json` 文档）。TS 测试对 golden 做**全等**断言。
  2. **同机背靠背**（含真实网络）：`bun run parity` 跑 Rust exe 与 TS 自检各两遍并 diff。M1 收口时实测：`--test-fetch` 19 行全等、`--test-update` 1 行全等（成功路径，非 `no-token` 分支）。
- `bun test` 用 `TZ=Asia/Shanghai`（见 `ts/package.json`）：golden 里的时间戳是 `DateTime<Local>`，换时区需重新生成 golden。

## 2. 数据与 API（对应 SPEC 16.2 / 16.3 / 16.4）

| Rust 机制 | TS 等价实现 | 锁定点 |
|---|---|---|
| `str::parse::<f64/i64>()` | `parseF64Strict` / `parseI64Strict`（`core/json.ts`），按 Rust 语法整串匹配 | `""`、`68abc`、`0x10`、`1_000`、`1 000` → 失败；`1.`、`.5`、`1e5`、`+68`、`inf`、`NaN` → 成功；`i64` 不接受小数与指数；越界即失败 |
| `str::trim()` | `rustTrim`，Unicode White_Space 集：**含 U+0085、不含 U+FEFF**（JS 原生 `trim()` 恰好相反） | golden `parse_matrix` |
| `serde_json::Number::as_i64()` | `jAsI64`：只有**整数形态的 number token** 才有值，`1.0` / `1e5` / `-0.0` 一律视为无值 | golden `as_i64` |
| `i64` 范围 | 全程 `bigint`（`balanceCents`、`monthlyUsedCents`、`monthlyLimitCents`、`(raw+500000)/1000000`），整除截断与 `saturating_add` 精确 | `quota.test.ts` |
| `f64` 文本 | `formatF64`：serde_json/ryu 形态——恒带小数点或指数；十进制指数 ∈ [-5,15] 用定点，否则 `1e+16` / `1e-7` 形态；`-0.0` 保号；非有限值由序列化器写 `null` | golden `floats` + `float_grid` |
| `chrono` 的 `DateTime<Local>` 文本 | `RustDateTime{ms,nanos}` + `autoSiFraction`：小数位为 9 位文本按整组 `000` 从右剥离（`.500000000`→`.500`），零则完全省略；偏移恒为 `±HH:MM`，绝不出现 `Z` | golden `datetime` + `reset_time` |
| `resp.json()` 失败 | 自带严格 JSON 解析器（`parseJsonValue`）：`1e400` 触发 `number out of range` → `JsonException`；非 2xx 不读 body；headers 之后的 body 超时同样归 `JsonException` | `quota.test.ts` |
| 数值精度 | 超过 2^53 的 JSON 整数字面量：TS 用 token 走 `BigInt` 保持精确；`as_f64` 侧与 Rust 同为 double，无额外偏差 | — |

## 3. 设置与系统集成（对应 SPEC 18.1 / 18.2 / 18.3）

- **`current_exe()` 的等价物是 `process.execPath`**：`bun run src/main.ts` 下它是 `bun.exe`，`bun build --compile` 产物下才是 `kpt-tui.exe`。因此 **便携模式与开机自启只对编译产物有意义**；开发模式下 `portable.dat` 会被去 Bun 安装目录找，自启值会写成 bun.exe 的路径。Rust 版无此歧义。
- `settings.json` 写入与 Rust 完全同字节：PascalCase、2-space 缩进、**无尾随换行**；读取遵循「整体失败回落默认、仅缺键才逐键默认」。M1 用机器上由 Rust 版写的真实文件做了字节回归断言。
- 注册表一律 `spawn reg.exe` 并按 **GBK** 解码；自启仍只做写/删、不回读。`AppsUseLightTheme` 取 `REG_DWORD` 文本（`0x0`/`0x1`），任何异常 → light，与 Rust 的 `unwrap_or(1)` 同义。
- 主题解析保持纯函数：`effectiveTheme(configured, system)`，系统值由 30 s 轮询写进缓存，渲染路径同步读取（Rust 在事件循环里同样是轮询）。

## 4. 版本检查（对应 SPEC 17.1 / 17.2）

- changelog 的 Range 请求必须带 **`Accept-Encoding: identity`**：GitHub Pages 返回 206 + gzip 时 Bun 解压分片会抛 `ZlibError`。Rust 的 reqwest 不受影响。
- 本机 ESET 曾做 TLS 拦截、其根证书不在 Bun 自带的 Mozilla CA 库内 → 跑 GitHub API 兜底需要运行时 **`--use-system-ca`**（已写进 `ts/package.json` 的脚本）。**M4 复测（2026-09-20）：该拦截当前不复现**——不带任何开关的 `bun run src/main.ts --test-update` 与编译产物 `dist/kpt-tui.exe` 都能正常拿到 `api.github.com`（`checkFailed=False`），复测脚本留在 `ts/test/system-ca-probe.ts`（可 `bun build --compile` 后分别带/不带 `NODE_USE_SYSTEM_CA`、`BUN_USE_SYSTEM_CA` 跑）。结论：`bun build --compile` **没有**把该开关固化进产物的手段（编译期无此参数、bunfig 无此键、两个环境变量在本机因无失败样本而不可证），因此按 TS-EDITION-PLAN §7 的兜底方案处理——README 注明「TLS 检查类安全软件环境下，编译产物的 GitHub API 兜底会静默降级为 checkFailed，额度与 changelog 主路径不受影响」，脚本运行路径继续带 `--use-system-ca`。`moonshotai.github.io` 与 `api.kimi.com` 不受拦截。
- `kimi --version` 经 `Bun.spawn`（实测不走 shell 即可拿到版本号），5 s 超时后 `kill()`，stdout+stderr 按此顺序 lossy 拼接后取首个 `\d+\.\d+\.\d+`。

## 5. 配色与渲染层（对应 SPEC 11.1 / 20）

- SPEC 11.1 列十色，`rust/src/theme.rs` 的 `Palette` 只有九槽（`card_bg` 仅存在于规格），TS 同样实现九槽。
- 选中态文字：Rust 走 crossterm `Color::White` → SGR `37`（终端调色板白），TS/OpenTUI 的 `"white"` 解析为 `#FFFFFF`（实测 `rgba(1,1,1,1)`）。SPEC 字面写的是 `#FFFFFF`，故 TS 与 SPEC 一致、与 Rust 实际字节不一致——观感差异仅在用户自定义终端白时可见。
- OpenTUI 能力实测结论（格宽、per-span bg、硬裁剪、键事件、resize 崩溃、就地改内容不重绘等）见 `docs/TS-EDITION-PLAN.md` §2.6。
- **M2 采用的渲染适配器**：`ts/src/tui/` 分三层——`line.ts` 是纯 `TuiLine[]` 模型（视图产出、可脱离终端快照测试），`dashboard.ts` 是 SPEC 12 的纯视图（逐行对照 `rust/src/ui/dashboard.rs`，行序即 ratatui 纵向约束的屏幕行号），`renderer.ts` 是 OpenTUI 适配器。适配器按 §2.6 四条陷阱实现：每行一个 `TextRenderable`、内容 write-once 故变更行销毁重建（`root.add(child, index)` 挂载后原位插入已实测保序）、纯流式布局（footer 前用等高的 window_bg 空行充当 `Constraint::Min(0)` spacer）。
- **整屏底色靠逐 span 合成**：OpenTUI 无等价于 ratatui 整屏 `Block::bg` 的填充，且**未显式给 bg 的文本 run 会落到终端默认底色**（真机实测：标签/倒计时背后出现黑条）。故适配器把 `window_bg` 作为 base bg 合成到每个无自有 bg 的 span 上（badge 保留自有 bg），并在每行右侧补 window_bg 空白 run 铺到满宽、行间补满宽空行铺到满高。Rust 侧整屏底色由 ratatui 后端统一清屏，无此逐 span 处理。
- **Bun/Windows 控制台 raw mode 差异（重要）**：Rust 靠 crossterm `enable_raw_mode` 关 echo；但 **Bun 1.4.2 的 `process.stdin.setRawMode()` 在 Windows 下不改动 OS 控制台模式**（FFI 实测 `ENABLE_ECHO_INPUT` 位前后不变），而 OpenTUI 的 `setupTerminal` 又把 raw 调用包在 `if (stdin.setRawMode)` 里——于是控制台停在 cooked 态，conhost 把每次按键回显到光标处（实测 `Resets in 2r'r'r`）。对策：`ts/src/tui/console.ts` 用 `bun:ffi` 直接 `SetConsoleMode`（清 `ENABLE_LINE_INPUT|ENABLE_ECHO_INPUT`、置 `ENABLE_WINDOW_INPUT`），且**因 Bun 每读一次 stdin 会把模式翻回 cooked，须在每次输入事件与每次重绘前重申 raw**（`ensureRawMode`），退出路径 `restore` 还原原模式。这是 TS 版相对 Rust 的额外机制，Rust 无对应代码。
- 渲染层键事件挂在 `renderer.keyInput`（非 `renderer` 本身，实测 `renderer.on("keypress")` 收不到）；`keyrelease` 不订阅（真终端会投递，路由器须忽略）。
- **M3 续建的三视图与行模型**：`tui/settingsView.ts`（SPEC 13）、`tui/skillsView.ts`（SPEC 21.3）、`tui/app.ts` 的 `handleKey`/`UiApp`（SPEC 12.7 状态机，对照 `rust/src/app.rs::handle_key`）。三点实现差异：
  1. **格宽改为按 East Asian Width 计算**：`line.ts#displayWidth` 取代 M2 的 `text.length`。ratatui 走 `unicode-width`，CJK/全角/Hangul/emoji 记 2 格、组合符号与变体选择符记 0 格，Ambiguous（`█ ░ · ¥ ● →`）按默认宽度 1 格（与 §2.6 实测一致）。裁剪按码点迭代，2 格字形放不进剩余 1 格时整体丢弃（对齐 ratatui 缓冲区行为），代理对不会被切断。Rust 侧由 unicode-width 自动处理，无对应代码。
  2. **下划线属性**：SPEC 13.2 选中 interval 行时 Rust 加 `Modifier::UNDERLINED`，TS 用 OpenTUI `underline()` style（实测落到 `attributes` 位 8）。
  3. **Skills 扫描放在下一个宏任务**：`app.ts#requestSkills` 先出 `Scanning...` 帧再 `setTimeout(0)` 跑 `scanSkills()`（实测本机 102 项 28 ms），对应 Rust 的 `spawn_blocking` + mpsc 回调；Rust 的 winreg 读是同步的，TS 若在事件回调里同步扫描会卡住重绘。设置保存的 `reg.exe` 自启写入仍同步（实测 11–21 ms，且 SPEC 13.2 的「写 JSON → 自启 → 主题 → 重排」顺序要求它先返回）。
- **`console.ts` 的输入句柄修正（M3 复核 M2 时发现）**：M2 写的是 `STD_INPUT_HANDLE = 0xfffffff5`，而 `0xfffffff5` 是 `(HANDLE)-11` = **输出**句柄，`(HANDLE)-10`（输入）应为 `0xfffffff6`；`SetConsoleMode` 作用在输出句柄上只接受 `ENABLE_PROTECTED_CONSOLE_PROCESS`，因此 M2 的 raw 调用实际全部失败并被静默吞掉。M2 观察到的「回显消失」结论因此待重测：真终端那一轮须确认到底是 `console.ts` 生效还是 OpenTUI 自身的 `setupTerminal` 生效（`bun test/console-probe.ts` 会打印 `modes.inputAfterOpentui`）。同时 `GetStdHandle` 声明为 `i64` → Bun 返回 `bigint`，现统一 `Number()` 归一，避免 `=== 0` / `=== -1` 判定失效。

## 6. 无单实例互斥、启动缩窗（对应 SPEC 20）

- **无单实例互斥**：与 Rust 一致，允许多实例并存，不建任何命名互斥锁。
- **缩窗守卫用同一个 Win32 调用**：计划原稿（TS-EDITION-PLAN §4 M3）以为 TS 版没有 Win32 binding、只能用终端环境变量启发式；实测 `bun:ffi` 调 `kernel32!GetConsoleProcessList` 可用，故 `ts/src/tui/shrink.ts` 与 Rust 一样按「附加到本控制台的进程数恰好为 1」判定独占，行为与 Rust 对齐。环境变量启发式（`WT_SESSION`/`TERM_PROGRAM`/`TERM`/`ConEmuPID`/`MSYSTEM`/`TERMINUS_SUBLIME`）只在 FFI 不可用时兜底；`stdout` 非 TTY 时一律不缩。Rust 无这条兜底路径。
- **两条缩窗通道与 Rust 同名同序**：(a) `ESC [ 8 ; 13 ; 72 t`；(b) conhost 序列 `SetConsoleWindowInfo(1×1)` → `SetConsoleScreenBufferSize(72×13)` → `SetConsoleWindowInfo(72×13)`。差别只在传参方式：`COORD`/`SMALL_RECT` 按值传参，bun:ffi 无结构体参数，故按 x64 调用约定手工打包进整数寄存器（`COORD = (y<<16)|x`，`SMALL_RECT` 四个 i16 依次占 0/16/32/48 位）。
- **待真终端实测项**（本轮未做，`bun test/console-probe.ts [--shrink]` 即为验证它们而备）：
  1. 通道 (b) 的手工打包是否真被 kernel32 接受（失败是静默的，只能靠 `--shrink` 后回读窗口尺寸确认）；
  2. 共享终端（shell 里启动）确认不缩窗——已在非 TTY 与 `attachedProcessCount=5` 两种环境下验证判定为「不缩」；
  3. 独占新窗（双击 / `wt` 直接起程序）确认缩到 72×13 且 WT 与 conhost 两条通道各测一次；
  4. raw mode 与退出恢复（见 §5 的句柄修正条目）：进程序列无回显、`q`/Ctrl+C/异常三条退出路径后终端与窗口尺寸复原。

