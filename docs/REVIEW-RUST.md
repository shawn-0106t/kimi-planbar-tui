# Rust 版全量代码审查清单（REVIEW-RUST）

> 审查对象：commit `53d519d`（2026-09-25）时的 `rust/src/` 全部 14 个源文件、`rust/src/ui/` 三视图、`rust/build.rs`、`rust/Cargo.toml` 及内嵌单元测试。
> 方法：独立 code-reviewer subagent 一轮（只读、以证伪为导向，假设至少存在 2 处缺陷），自行重跑验收命令并对 vendored 依赖源码取证。
> 结论：**无 Blocker**；2 个 Major、9 个 Minor、13 个 Suggestion（9–10 为 2026-09-25 复核新增，11–14 为 2026-09-26 复审新增，Major B + 15–18 为 2026-09-26 第三轮独立审查新增，19–21 为 2026-09-26 第四轮独立审查新增，见文末四节"复核记录"）。
> 验收基线（审查时实测）：`cargo test` **15/15 通过**；`--test-fetch` 返回真实 19 行数据（当时 token 有效）；`--test-update` `local=2.1.1 latest=2.1.1 updateAvailable=False checkFailed=False`。
> 依赖取证基线：windows-0.61.3 / crossterm-0.28.1 / ratatui-0.29.0 / tokio-1.53.1。`cargo clippy` 未运行（本机 toolchain 未装该组件）。
> **修复时机**：Major A + Minor 1–5 + Suggestion 6–9 已于 2026-09-26 修复并经独立复审逐条核验属实（见"修复状态回填"及文末 2026-09-26 复核记录）；Suggestion 10 登记不修；Minor 11–12、Suggestion 13–14 已于 2026-09-26 第二批次修复（Minor 12 走改文档方向，见回填表）；Major B + Minor 15 + Suggestion 15/16/18 已于 2026-09-26 第三批次修复（Suggestion 17 经维护者拍板登记待跨版统一，见回填表）；Minor 19 系台账自身行号漂移，已于 2026-09-26 第四轮文档批次就地更正；Suggestion 20–21 已于 2026-09-26 收尾批次修复（见回填表，至此台账全部条目闭环）。

## Major（建议尽快关闭）

### A. `fmt_yuan` 对 `i64::MIN` 取负溢出 → 无限递归 → 栈溢出搁浅终端

- 位置：`rust/src/format.rs:30-32`（触发点 `rust/src/ui/dashboard.rs:138` 月度子行；数据入口 `rust/src/quota.rs:153-159` + `246-247`）
- 触发：API 返回 `boosterWallet.monthlyChargeLimitEnabled == true`、`monthlyChargeLimit.priceInCents > 0`、`monthlyUsed.priceInCents == "-9223372036854775808"`——`get_i64` 的 `parse::<i64>()` 恰好接受该字符串，`fmt_yuan` 负数分支的 `-cents` 在 release 构建（未开 `overflow-checks`）下回绕仍为 `i64::MIN`，按负数再次取负 → **无限递归 → 栈溢出 abort**。debug 构建则为取负溢出 panic。
- 危害：栈溢出**不执行 panic hook**——raw mode + alternate screen 被搁浅，正是 SPEC 20 定义的"最严重事故"。且同一份 hostile payload 下 ts-nodejs 移植版存活（`ts-nodejs/src/core/format.ts:41` 用 bigint，取负永不溢出）——**oracle 比自己的移植版更脆**，违反 SPEC 20"绝不 panic"与 16.3 防御性解析基调（同文件对 `1e999`、`saturating_add` 均已设防，唯独漏此）。
- 实证：独立 rustc 脚本验证 `wrapping_neg(i64::MIN) == i64::MIN`。
- 修法：负数分支改 `checked_neg()`（`None` 时按 `i64::MAX` 处理）或以 `i128` 取绝对值计算；补 `fmt_yuan(i64::MIN)` 回归测试（顺带补 `format_reset` 阶梯与 `fmt_percent` 用例，见覆盖缺口）。止损选项（复核补充）：`[profile.release]` 加 `overflow-checks = true`——取负溢出立即 panic，而 `panic = "abort"` 下 panic hook 仍先于 abort 执行，"栈溢出搁浅终端"降级为"恢复终端后崩溃"；代价是全 crate 算术溢出由回绕变 panic，启用前需评估其余算术路径。

### B. 设置视图在应用自定的最小窗口（72×13）下被裁掉 4 行——Save、自启复选框、页脚全部不可见

- 位置：`rust/src/ui/settings_view.rs:45-50`（布局）、`:60-65`（inner 计算）、`:79-126`（13 行内容）；尺寸常量在 `rust/src/app.rs:46-47`（`MIN_WIN_ROWS = 13`，注释明确"按线框布局定尺寸"），缩窗入口 `:396`
- 问题：设置表单内容为 13 行（Theme 标题 + 空行 + 3 单选 + 空行 + Interval 标题 + 空行 + pills + 空行 + checkbox + 空行 + Save）。在 13 行高的终端中，`Layout::vertical([Length(3), Min(10), Length(1)])` 的求解结果是标题 3 / 中部 10 / **页脚 0**，inner 高仅 9——只渲染到 pills 行（索引 8），**`[ ] Launch at Windows startup`（索引 10）、`Save`（索引 12）与页脚提示全部在视口外**。且该视图无滚动支持，选中不可见行时高亮也随之一同消失（`settings_sel` 2/3 时屏幕无任何反馈）。
- 证据：仓库外用 ratatui `TestBackend::new(72,13)` 逐行复刻 `settings_view` 布局实测——渲染帧中 `1 min` 可见、`Launch at Windows startup` 与 `Save` 均不可见，页脚行被挤为 0 高；对照实验证实 dashboard@13 与 skills@13 页脚均正常（仅 settings 受害）。要完整显示 13 行内容需帧高 ≥ 18。触发场景并非极端：SPEC 20 规定的独占控制台缩窗（双击启动即缩到 72×13）**必然**命中。
- 修法：三选一——(a) 精简 settings_view 空行使内容 ≤ 9 行（去掉 4 个空行后恰好 9 行，13 行窗口可完整显示）；(b) `MIN_WIN_ROWS` 提到 18 并同步 SPEC 20；(c) 为设置视图加滚动。建议 (a)，最小改动且不改规格。（2026-09-26 第三轮审查新增，TestBackend 实证复现；"8 行"系原稿算术笔误，2026-09-26 复审更正）

## Minor

1. **缩窗 xterm 转义在 VT processing 启用前写入 stdout**（`rust/src/app.rs:343`）：crossterm 0.28.1 的 VT 启用是惰性的（首次 ANSI `execute!` 才发生），conhost 场景（Win10 默认终端或 Win11 设 conhost 为默认时双击启动，`GetConsoleProcessList==1` 恰好放行）输出模式无 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`，`ESC[8;13;72t` 被当字面文本回显进主屏缓冲——退出后用户看到一行乱码残留。WT 下无害。修法：写转义前自行启用 VT（失败则跳过通道 (a) 只走 Win32 序列）。
2. **settings.json 非原子覆写 + 与注册表无对账**（`rust/src/settings.rs:58-63`）：truncate-then-write，写入中途崩溃留下截断 JSON，下次启动 `unwrap_or_default()` 静默回落默认；更糟的是 HKCU Run 值不回退——注册表残留 `true` 照常自启，settings.json 回落 `AutoStart=false`，设置界面与实际行为背离且无提示。修法：同目录临时文件 + `rename` 覆盖；启动时可选做一次 Run 值对账。复核补充两条同族背离路径：`settings::save` 吞错后 `save_settings`（`app.rs:222`）仍无条件跳回 Dashboard，写盘失败（如只读 portable 目录）时用户以为已保存、无任何提示；`apply_auto_start` 在 `current_exe()` 失败时静默跳过，`AutoStart=true` 而注册表无值。
3. **parse_reset_time 是 SPEC 16.3 的超集**（`rust/src/quota.rs:161-185`）：实际接受 RFC3339 之外的宽松形状（空格分隔、紧凑偏移、naive 本地时间）。行为已被 ts golden（`reset_time.txt` 29 行）锁定为事实契约，属 **SPEC 文本滞后**而非代码错误。修法：SPEC 16.3 措辞更新为"RFC3339 + DateTimeOffset.TryParse 阶梯（以 golden 为准）"。复核补充：`reset_time.txt` 实为 29 个内容行但无尾换行符（`wc -l` 计 28）——SPEC 22 状态注记的"28 行"与本清单的"29 行"系计数口径差异而非 golden 漂移，建议两处统一口径。
4. **percent ≥ 1000% 时 `%` 后缀被截断**（`rust/src/ui/dashboard.rs:78` `chars().take(4)`）：`limit<=0 → 1` 的防御分支恰可制造大 percent（如 5000.0 → 显示 `5000` 而非 `5000%`），与 SPEC 12.2 `{percent:0}%` 不符。修法：列预算加宽至 5 字符或截断保留尾缀。
5. **panic hook 全局生效**（`rust/src/app.rs:368-373`）：任意 tokio 后台任务 panic 同样执行"恢复终端"，但 tokio 吞掉任务 panic 让 app 继续运行——结果是存活状态下拆除 alternate screen、退出 raw mode。审查者核查了最可疑路径（tokio-1.53.1 `sleep` 对超大 Duration 走 `far_future()` 不 panic），**当前无可达触发路径**，列防御纵深缺口。修法：hook 内 thread-local 标记仅主循环线程生效，或任务 panic 触发统一退出。
11. **skills 视图滚动不变量只保证"名称行"可见，选中项描述行可被压出视口**（`rust/src/ui/skills_view.rs:96-105`，2026-09-26 复审新增）：每个 item 占两行（`:90` 名称、`:91` 描述），`scroll = (sel_line + 1).saturating_sub(viewport).min(max_scroll)` 只把名称行纳入视口——viewport=5、选中第 3 项（名称行 5、描述行 6）时 scroll=1，可见行 1..=5，描述行 6 恰在视口外；即向下翻页后高亮项的描述永远差一行看不到，而该视图存在的意义就是读描述。SPEC 21.3 未钉死滚动粒度，定 Minor。修法：滚动预算计入描述行（`(sel_line + 2).saturating_sub(viewport)`），并把滚动计算抽成纯函数补单测（呼应覆盖缺口表）。
12. **重扫键提示位置与 SPEC 21.3 字面不符**（`rust/src/ui/skills_view.rs:35-46`，对照 `:14`，2026-09-26 复审新增）：SPEC 21.3 规定"顶部汇总行：`N skills` + 重扫键提示"，当前汇总行仅 `Kimi Skills   N skills`（或 `Scanning...`），`r Rescan` 提示只出现在页脚。影响低（页脚仍可发现重扫键）。修法：汇总行追加 `· r Rescan`，或修订 SPEC 21.3 文本——二选一维持单一事实源。
15. **Ctrl+Break 等控制台强制终止路径绕过全部终端恢复机制**（`rust/src/app.rs:417-426` panic hook、`:329-336` `TerminalRestore`；全 crate 无 `SetConsoleCtrlHandler`，已 grep 证实；2026-09-26 第三轮审查新增）：SPEC 20 要求"每一条退出路径都必须恢复终端"。当前覆盖：正常 `q`/Ctrl+C 按键、绘制错误、EventStream 结束、panic（hook）。但 Ctrl+Break 在 Windows 上始终作为 `CTRL_BREAK_EVENT` 信号投递（不受 raw mode 的 `ENABLE_PROCESSED_INPUT` 清除影响），默认处理直接终止进程——不跑 RAII Drop、不跑 panic hook，raw mode + alternate screen 被搁置。SPEC 22.6 显示 Bun 版专门注册了 SIGBREAK handler，Rust 版无对应物。属健壮性缺口而非高频事故：触发键罕见，且进程死亡后 conhost/ConPTY 通常会自行清理（WT 关闭会话、cmd 重获控制台时重设自身模式），实际搁浅面有限；但严格对照 SPEC 20 的"每一条退出路径"措辞，该路径未被覆盖。修法：用 `windows` crate 注册 `SetConsoleCtrlHandler`，对 `CTRL_BREAK_EVENT`/`CTRL_CLOSE_EVENT` 执行与 panic hook 相同的恢复序列（handler 内需快速返回，避免死锁）；或在 SPEC 20 明确登记该路径为"依赖 OS 清理"的已知豁免。
19. **回填表「实测位置」行号漂移（台账自身失准，非代码缺陷）**（2026-09-26 第四轮审查新增）：Minor 5 回填称"按 panic strategy 分流"位于 `rust/src/app.rs:420`，实际 `:420` 现为 `unsafe {`（`SetConsoleCtrlHandler` 注册），分流逻辑在 `app.rs:445-454`（`skip_restore` 于 `:448`）——成因是第三批次在其前方插入 `console_ctrl_handler`（`:397-415`）与 2 行 import（`:34-35`），回填表未随行号更新。同批 +2 漂移（现落在 doc 注释行，尚可定位）：Minor 1 回填 `:382` → 函数实际在 `app.rs:384`（调用点 `:368`）；Suggestion 6 回填 `app.rs:173` → 函数实际在 `:175`；Minor 2 回填 `settings.rs:111` → 函数实际在 `:112`。危害仅影响台账可检索性，修复代码本身全部属实（见文末第四轮复核记录）。修法：回填表四处行号更正——已随第四轮文档批次落地。

## Suggestion

6. `rust/src/state.rs:17` `AppState.update` 只写不读（UI 读 `App.update`），死字段。
7. `rust/src/credentials.rs:71-79` `[ providers.kimi ]`（括号内侧带空格）剥括号后节名残留空格，误判非 provider——真实 kimi CLI 写紧凑格式不受影响，可登记为已知限制或对节名再 `trim()`。
8. `rust/src/quota.rs:78-83` 与 `rust/src/update.rs:24-29` 各持独立 `OnceLock<Client>`，可共享连接池；纯整理。
9. `rust/src/ui/dashboard.rs:94` `usage_line` 宽度预算用 `reset.len()`（字节数）——成立仅因 `format_reset` 输出纯英文 ASCII；倒计时文案一旦本地化（CJK 占 2 单元格），bar 宽度即被低估。TS 版 EAW 陷阱在 Rust 侧的休眠形态（复核新增）。
10. `rust/src/ui/settings_view.rs:94,122` accent 底文字硬编码 `Color::White` 未走 palette——SPEC 11.1 九色表无"accent 底文字"brush（规格空白而非违规）；accent 若改为浅色系将对比度失守（复核新增）。（2026-09-26 复审修正前提：SPEC 11.1（SPEC.md:264）明确"白字配 accent 底只用于刷新间隔激活 pill、获得焦点的 Save 动作行"——该两处恰为条款点名用法，属**合规**而非规格空白；登记不修处置不变。）
13. `rust/src/settings.rs:68-71` 写临时文件失败路径不清除半成品 `settings.json.<pid>.tmp`（rename 失败路径 `:72-75` 有 `remove_file` 清理）——磁盘满/AV 干扰时在配置目录残留一份残片，同进程复用同名、至多一份，危害极低。修法：写失败分支对称 `let _ = fs::remove_file(&tmp);` 一行收尾。（2026-09-26 复审新增）
14. `rust/src/ui/skills_view.rs:108` `scroll as u16` 理论性截断——滚动行数 >65535（约需 3.2 万个 skills）才回绕，现实不可达，仅登记。修法：`.min(u16::MAX as usize) as u16` 或注释钉住上界。（2026-09-26 复审新增）
15. **`polling.rs` 下次延迟计算存在两处同源逻辑 + 多余 clone**（`rust/src/polling.rs:28-35` `safe_refresh` 内计算 delay 并写 `retime_delay`，与 `:65-70` `run()` 在 `safe_refresh` 返回后用同一公式重算 `next`；`:24` `tx.send(r.clone()).await` 后又 `r.clone()` 返回；2026-09-26 第三轮审查新增）：`run()` 的直接赋值与 `safe_refresh` 的 retime hint 是两份手工保持一致的重 Delay 公式（当前数值一致，靠自觉维护）；每次调度刷新还会触发一次空转的 retime 分支循环。`r` 被 clone 两次（一次进 channel、一次作返回值），而 `run()` 只需读 `r.error`。修法：让 `run()` 只信 retime hint（删掉 `:65-70` 的重算），或在 send 前取 `let failed = r.error.is_some()` 以消去第二次 clone；一行级整理，非行为问题。
16. **设置视图中 `q` 静默丢弃草稿退出，页脚无提示**（`rust/src/app.rs:248-251` 全局 quit 分支；`rust/src/ui/settings_view.rs:14` 页脚未列 `q`；2026-09-26 第三轮审查新增）：`q` 在三个视图均为全局退出（注释标为刻意设计，skills 页脚也明示 `q Quit`），唯独 settings 页脚不提示；用户在编辑草稿时按 `q` 无任何预兆地丢弃修改并退出进程。与 SPEC 13.1"Esc 放弃更改返回 dashboard"对照，`q` 的语义（丢弃并退出应用）合理但不可发现。修法：settings 页脚追加 `· q Quit`（与 skills 页脚一致），或在设置视图让 `q` 等价于 Esc。
17. **skills frontmatter `name:` 显式为空字符串时不回退目录名**（`rust/src/skills.rs:66` `name = Some(value)` 接受空串、`:94` `unwrap_or_else(|| id.clone())` 仅对 `None` 回退；2026-09-26 第三轮审查新增）：`name: ""` 会被采信，列表里该 skill 名称渲染为空白行；SPEC 21.2 的"缺省回退目录名"未明确空串是否算缺省。已核对 `go/internal/core/skills.go:99-103` 行为逐字一致，故非 Rust 单方偏差，登记待跨版统一。修法：回退条件改为 `name.filter(|n| !n.is_empty()).unwrap_or_else(|| id.clone())`；若采纳需四版（Rust/Go/TS×2）同步。（2026-09-26 维护者拍板：登记不修、待四版统一批次，见回填表。）
18. **布局最小尺寸不变量缺乏测试钉住**（`rust/src/ui/settings_view.rs` 整文件无测试；2026-09-26 第三轮审查新增）：Major B 类的回归（内容行数超过最小窗口可见行数）本可由一个 `TestBackend` 渲染测试在 CI 拦截；覆盖缺口节已建议"以集成测试钉住结构性事实"，settings 在 72×13 下的可见性正是此类事实。修法：用 `ratatui::backend::TestBackend::new(72, 13)` 渲染 settings_view 并断言 `Save`、`Launch at Windows startup` 与页脚文案可见，纳入 `#[cfg(test)]`。
20. **dashboard 月度子行显示条件两处手工同步**（`rust/src/ui/dashboard.rs:141`（`extra_lines` 推送子行的条件）与 `:179-184`（`draw` 计算 `monthly_shown`/`monthly_h`）；2026-09-26 第四轮审查新增）：同一谓词 `monthly_enabled && monthly_limit_cents.unwrap_or(0) > 0 && monthly_used_cents.is_some()` 的两份拷贝。当前逐字一致、无行为问题；若未来只改一处，后果是布局预留行渲染空白或子行被丢弃（无 panic），属 Suggestion 15 同类的"手工同步漂移"隐患。修法：抽成共享小函数，或由 `extra_lines` 返回行数供 `draw` 推导 `monthly_h`。（2026-09-26 收尾批次已修，见回填表。）
21. **`console_ctrl_handler` 未覆盖 `CTRL_C_EVENT`（0）**（`rust/src/app.rs:407-410`；2026-09-26 第四轮审查新增）：handler 仅处理 `CTRL_BREAK_EVENT`(1)/`CTRL_CLOSE_EVENT`(2)。raw mode 下键盘 Ctrl+C 不产生该事件（`ENABLE_PROCESSED_INPUT` 已清，走按键分支正常退出），仅**进程外** `GenerateConsoleCtrlEvent(CTRL_C_EVENT, …)` 投递时可达——此时默认终止绕过 RAII guard 与 panic hook，终端搁浅；罕见但与 Minor 15 已覆盖的两条路径同属"强制退出"类。Go 版无任何 ctrl handler（已 grep 证实），故非跨版分歧；`rust/scripts/verify/send-ctrl-break.ps1` 亦只探 CTRL_BREAK。修法：条件追加 `ctrl == CTRL_C_EVENT`，一行改动。（2026-09-26 收尾批次已修，见回填表。）

## 已核对通过（不必重做）

- **防御性解析密度**：字符串/数字混排、除零钳位、inf/NaN 归零、`saturating_add` 防溢出（唯 A 项漏网）。
- **并发模型**：单事件循环线程 + 短临界区 RwLock；`Notify` permit 语义到位——`polling.rs:49-53` 排干 stale hint 的注释经逐场景推演（reschedule/retime/手动刷新三方交错）未发现漏洞。
- **终端纪律**：RAII guard 在 `enable_raw_mode` 与 `EnterAlternateScreen` 之间声明；panic hook 先于终端初始化；`resize_owned_console` 的 `SetConsoleWindowInfo` **指针传参正确**（windows-0.61.3 签名核实——ts 版抄错致 segfault 的参照实现无误）；`GetConsoleProcessList` slice 形态、`GetStdHandle` 双重空值防御均正确。
- **安全面**：token 只进 `Authorization` 头、只发往常量端点；自检输出不含凭证。
- **SPEC 契约逐项核对一致**：11.1 九色色值、12.3 FormatReset 阶梯、12.5 FmtYuan（除 A）、12.7 footer 与防抖、13.2 保存顺序、16.1–16.5、17.1–17.4（含 UA/Range/fallback）、18.1–18.3、19 自检、20 缩窗守卫与恢复、21 skills 三根目录扫描。
- **build.rs**（复核补充）：非 Windows 目标早退；`compile()` 失败仅 `cargo:warning` 不 fail 构建（与 AGENTS.md "warns, never fails" 一致）；VERSIONINFO 的 File/Product version 自动派生自 `CARGO_PKG_VERSION`，版本 bump 只需改 `Cargo.toml`。
- **测试分布**（复核补充）：15 个 `#[test]` = format 2 + quota 6 + app 5 + skills 2，供日后 diff 基线。

## 测试覆盖缺口（防御性路径无测试）

- **format.rs**：`format_reset` 阶梯与 `fmt_percent` 在 oracle 侧零测试（ts-nodejs 反而有）；`fmt_yuan` 无负数极限用例——正是 Major A 的洞。（2026-09-26 批次已补：阶梯/百分比/i64 极值用例，经 2026-09-26 复审确认）
- **credentials.rs**：config.toml 逐行解析（节结算时机、首个匹配、`KIMI_CODE_HOME`、`expires_at > now+30s` 边界）零测试。（2026-09-26 批次已补 4 断言：紧凑/带内边距节名、节结算、空 key；`KIMI_CODE_HOME` 与 `expires_at` 边界因环境依赖仍未测，经 2026-09-26 复审确认）
- **settings.rs**：portable.dat 优先级、APPDATA 回落、PascalCase 往返、整体/逐键默认语义零测试。
- **polling.rs**：reschedule/retime 交错、keep-last-good 传递链、30 s 快重试/成功回周期零测试（ts 侧反而有）。
- **update.rs**：`parse_semver`、fallback 次序、`check_failed` 边界零测试。
- **quota.rs**：`fill_missing_from` 链、fetch 错误归类（无 HTTP mock 基建）、`get_i64` 极值字符串。
- **纯逻辑 UI 函数**：`usage_line` 宽度预算、`bar_spans` 边界、skills_view 滚动不变量（复核补充：滚动计算内联在 `draw()` 中，`skills_view.rs:96-105`，需先提取为纯函数才可单测）。
- **终端纪律**（hook 安装顺序、各退出路径恢复、缩窗守卫）：难以自动化，建议至少以集成测试钉住结构性事实。复核补充另一例：`main.rs:31` `.expect("failed to build tokio runtime")` 位于 panic hook 安装之前，当前安全仅因终端尚未初始化——安全来自调用顺序而非机制，同样建议钉住（呼应 Minor 5）。

## 修复状态回填

> 2026-09-26 修复批次（v0.1.1，维护者拍板后执行）：Major A + Minor 1–5 + Suggestion 6–9 已修，Suggestion 10 登记；`cargo test` 23/23（原 15 + 新增 8）、debug/release 双构建无 warning、`--test-fetch`/`--test-update` 双自检通过（release exe 实测真实数据成功路径）。变更经 code-reviewer 子代理两轮独立审查（首轮 1 Major——panic hook 门控与 release `panic="abort"` 组合的反向回归——已按复核意见改为按 panic strategy 分流，次轮 Approve）。维护者人肉验收（2026-09-26）：双主题 TUI 目检、独占 console 启动缩窗均正常。
>
> 2026-09-26 第二批次（条目 11–14）：`cargo test` 26/26（+3 个 skills 滚动单测）、build 无 warning、双自检通过；code-reviewer 复审 Approve（台账自身 2 处完整性修正已随批落地）。
>
> 2026-09-26 第三批次（Major B + Minor 15 + Suggestion 15/16/18 修复，17 登记）：修法方向经维护者拍板（Major B 选方案 (a) 精简空行；Minor 15 实现恢复 handler；Suggestion 16 页脚加 q Quit；17 待四版统一）。`cargo test` 27/27（+1 个 TestBackend 72×13 回归测试）、build 无 warning、`--test-update` 通过（`--test-fetch` 本机 token 过期返回确定性 `no-token`，属环境态）。

| 条目 | 状态 | 实测位置 |
|---|---|---|
| Major A（`fmt_yuan` i64::MIN） | 已修 | `rust/src/format.rs:33` 负数分支改 i128 绝对值；回归测试 `fmt_yuan_negation_extremes`（含 i64::MIN/MAX）+ 数据入口测试 `quota.rs::monthly_extreme_cents_string_parses`；止损选项 `overflow-checks=true` 未采用（i128 修复已消除该溢出，避免全 crate 算术语义变化） |
| Minor 1（缩窗转义 conhost 回显） | 已修 | `rust/src/app.rs:384` `enable_vt_processing()`：写转义前自行 `SetConsoleMode` 启用 VT，失败则跳过通道 (a) 只走 Win32 序列（行号经 2026-09-26 第四轮核验更正，原填 `:382`） |
| Minor 2（settings 非原子写） | 已修 | `rust/src/settings.rs:62` 同目录 PID 后缀临时文件 + `rename` 原子替换，返回 bool；`app.rs:219` 写盘失败保留草稿、停留设置页，页脚临时提示 `Save failed`（SPEC 13.2 同步）；`settings.rs:112` `reconcile_auto_start()` 启动对账（按值名判存在性，不重指向已有值；SPEC 18.3 同步；行号经第四轮核验更正，原填 `:111`）。`apply_auto_start` 的 `current_exe()` 失败静默路径保留——运行中进程实际不可失败，无可修点 |
| Minor 3（SPEC 16.3 文本滞后） | 已修 | SPEC.md / SPEC_EN.md 16.3 改为"RFC 3339 优先 + 宽松阶梯（以 `reset_time.txt` golden 为准）"；22.2 行数口径统一为"29 内容行（文件无尾换行，`wc -l` 计 28）" |
| Minor 4（percent ≥1000% 吞 `%`） | 已修 | `rust/src/ui/dashboard.rs:34` 列预算 4→5（`PCT_W`），`5000%` 完整显示；更长值仍按预算截断数字（不伪造数字）。**跨版注记**：`ts/`（`dashboard.ts:69` `slice(0,4)`）、ts-nodejs、Go 版存在同款 4 格截断，待各自批次对齐 |
| Minor 5（panic hook 全局生效） | 已修 | `rust/src/app.rs:448` 按 panic strategy 分流：debug（unwind）仅主线程恢复；release（`panic="abort"`）无条件恢复——hook 恢复是 abort 前最后机会（行号经第四轮核验更正，原填 `:420`）。首轮实现曾无条件跳过非主线程恢复，code-reviewer 以 scratch crate 实证 release 下会反向滞留终端后纠正 |
| Suggestion 6（`AppState.update` 死字段） | 已修 | `rust/src/state.rs` 删除字段；`app.rs:175` `spawn_update_check` 去掉状态写入与 state 参数（行号经第四轮核验更正，原填 `:173`） |
| Suggestion 7（节名残留空格） | 已修 | `rust/src/credentials.rs:69` 解析抽为纯函数 `parse_config_provider`，剥括号后 `trim()`；补 4 断言测试（紧凑/带内边距节名、节结算、空 key） |
| Suggestion 8（双 `OnceLock<Client>`） | 已修 | 新增 `rust/src/http.rs` `shared_client()`，quota.rs / update.rs 共用同一连接池（配置逐字相同） |
| Suggestion 9（`usage_line` 字节宽度） | 已修 | `rust/src/ui/dashboard.rs:101` `reset.len()` → `reset.chars().count()`（当前 ASCII 输出下等值，CJK 本地化后不再低估 bar 宽度） |
| Suggestion 10（accent 底文字硬编码 `Color::White`） | 登记不修 | SPEC 11.1 九色表无"accent 底文字"brush，系规格空白而非违规；accent 双主题恒为 `#1A88FF`，白字对比度稳定。改动需新增 brush 并跨四版统一 SPEC 11.1，留待跨版规格批次 |
| Minor 11（skills 滚动只保名称行可见，描述行可被压出视口） | 已修 | `rust/src/ui/skills_view.rs` 滚动计算抽为纯函数 `scroll_for()`（预算 `+2` 计入描述行，选中项两行恒可见）；补 3 个单测（适配不滚动/翻页双行可见/max 钳位）；文件头注释同步（重扫提示在页脚）。**跨版注记**：`ts/src/tui/skillsView.ts:118` 与 `ts-nodejs/src/tui/skillsView.ts:118` 仍是旧 `+1` 滚动预算，滚动行为不在 parity harness 覆盖内，待各自批次对齐 |
| Minor 12（重扫键提示位置与 SPEC 21.3 字面不符） | 已修（改文档对齐实现） | SPEC.md / SPEC_EN.md 21.3 修订为"顶部汇总行仅 `N skills`（扫描中 `Scanning...`），重扫键提示位于页脚（`r Rescan`）"；代码与页脚未动，维持单一事实源 |
| Suggestion 13（写临时文件失败不清除半成品 tmp） | 已修 | `rust/src/settings.rs` 写失败分支对称补 `let _ = fs::remove_file(&tmp);`，与 rename 失败路径同款收尾 |
| Suggestion 14（`scroll as u16` 理论截断） | 已修 | `rust/src/ui/skills_view.rs` 渲染处改 `scroll.min(u16::MAX as usize) as u16` |
| Major B（设置视图 72×13 被裁 4 行） | 已修 | `rust/src/ui/settings_view.rs` 方案 (a)：表单精简为 9 行（删 4 个组间空行）+ 布局 `Min(10)→Min(8)`、去掉内容区 `+1` 位移，13 行窗口下 checkbox/Save/页脚全部可见；`App::new` 提为 `pub(crate)` 供测试构造 |
| Minor 15（Ctrl+Break 绕过终端恢复） | 已修 | `rust/src/app.rs` `console_ctrl_handler` + `SetConsoleCtrlHandler` 注册：对 CTRL_BREAK/CTRL_CLOSE 执行与 panic hook 相同恢复序列后返回 FALSE 交还默认终止；SPEC 20（中英）同步登记该路径 |
| Suggestion 15（polling 双份延迟公式 + 多余 clone） | 已修 | `rust/src/polling.rs` `safe_refresh` 改为无返回值（两个调用方均不消费）、单 clone 进 last-good 缓存、channel 消费原值；`run()` 删本地重算、只信 retime hint（单一公式源） |
| Suggestion 16（设置页 q 无提示丢弃草稿） | 已修 | `rust/src/ui/settings_view.rs` 页脚（含 Save failed 变体）追加 `· q Quit`；SPEC 13.1/13.2（中英）同步页脚文案 |
| Suggestion 17（skills 空 name 不回退目录名） | 登记不修 | 与 Go 版现状逐字一致、SPEC 21.2 未定义空串语义，单独修 Rust 将制造跨版分歧；待四版统一批次处理（同 Minor 4/11 跨版注记惯例） |
| Suggestion 18（布局最小尺寸无测试钉住） | 已修 | `rust/src/ui/settings_view.rs` `settings_form_fits_minimal_window`：TestBackend(72,13) 断言 interval pills、checkbox、Save 行与页脚全部可见——即 Major B 的回归测试 |
| Minor 19（回填表行号漂移） | 已修（文档回填） | 本表 Minor 1/2/5 与 Suggestion 6 四行实测位置经第四轮核验更正为 `app.rs:384`、`settings.rs:112`、`app.rs:448`、`app.rs:175`；纯台账修正，无代码改动 |
| Suggestion 20（dashboard 月度子行谓词双份拷贝） | 已修 | `rust/src/ui/dashboard.rs` 抽出共享谓词 `monthly_subline_shown()`，`extra_lines` 与 `draw` 同源消费；补单测 `monthly_subline_predicate`（启用/禁用/limit≤0/used 缺失/无钱包五态） |
| Suggestion 21（CTRL_C_EVENT 未覆盖） | 已修 | `rust/src/app.rs` handler 条件追加 `CTRL_C_EVENT`（进程外投递路径；raw mode 下键盘 Ctrl+C 仍走按键路径不受影响）；doc 注释与 SPEC 20（中英）同步 |

> 修复完成后请在本表回填状态与实测位置（参照 REVIEW-M1.md 的回填惯例）。

## 复核记录（2026-09-25，v0.1.1 / HEAD `7a6cd21`）

独立复核（只读，未执行构建与二进制）：

- `rust/src/` 与审查基线 `53d519d` 逐字节一致（`git diff` 为空 + `format.rs` md5 比对）；期间仅 `7a6cd21` 将 `Cargo.toml` 版本号 bump 至 0.1.1。
- 9 项发现全部复现，行号引用零偏差；上表"未修"判定复核时仍全部成立。
- Minor 1 的依赖取证下钻至 vendored crossterm-0.28.1 源码证实：VT 启用为 `ansi_support.rs` 内 `parking_lot::Once` 惰性触发（首个 ANSI 命令才发生），缩窗转义写入时输出模式确无 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`。
- Minor 3 的 SPEC 文本滞后复核时仍存在：`SPEC.md:421` 仍仅写"RFC 3339 解析"，未提宽松阶梯。
- 依赖版本基线与 `Cargo.lock` 一致：crossterm 0.28.1 / ratatui 0.29.0 / tokio 1.53.1 / windows 0.61.3。
- 复核新增内容已就地标注：Suggestion 9–10、Major A 止损选项、Minor 2 两条同族路径、Minor 3 golden 口径说明、覆盖缺口两条注记。
- 未复核项（运行时测量，本次未执行）：`cargo test` 实跑、两个自检的实时输出、conhost 实机回显乱码。

## 复核记录（2026-09-26，独立全量复审 / 修复批次核验）

> 独立 code-reviewer 复审（后台独立进程、默认模型 + max 思考强度，只读，证伪导向——假设至少存在 2 处真实缺陷）。审查对象 = HEAD `7a6cd21` + 未提交修复批次（10 个修改文件 + 新增 `rust/src/http.rs`），即"修复状态回填"表所述批次的工作区实况。复审全程仓库零改动（git status 复核确认）。

- **实证手段**：`cargo test` 23/23、`cargo build` 无警告；双自检实测通过（`--test-fetch` 返回真实 19 行 JSON、不含 token；`--test-update` `local=2.1.1 latest=2.1.1 updateAvailable=False checkFailed=False`）；vendored ratatui-0.29.0 源码取证（`paragraph.rs`/`buffer.rs`）；独立 rustc 脚本实证 Windows `fs::rename` 可覆盖已存在目标（std 走 `MoveFileExW + MOVEFILE_REPLACE_EXISTING`）；`unwrap`/`expect`/`unsafe` 全量枚举。
- **回填表逐条复核**：Major A、Minor 1–5、Suggestion 6–9 共 9 项修复**全部属实**（代码/测试/SPEC 文本三侧互证）；Suggestion 10 前提修正（属合规而非规格空白，见 Suggestion 10 就地标注）。
- **证伪记录（严重缺陷假设均被驳回）**：
  1. "极矮终端 ratatui 渲染越界 panic"——证伪：`Buffer::index_of` 越界确会 panic（buffer.rs:251-259）且 `Paragraph::render_ref` 不 intersect 传入 area（paragraph.rs:425-431），但 `set_style`/`Block::render` 各自内部 intersect（buffer.rs:402、block.rs:703），文本写入循环受 `LineTruncator` 宽度与 `y < area.height + scroll.y` 约束，Layout 求解器保证 chunk ⊆ 帧 area，`inner=(y+1, h-1)` 算术保持 containment（`settings_view.rs:60-65`、`skills_view.rs:52-57`），h=0 时 `is_empty()` 早退——越界不可达。
  2. "settings 原子写在 Windows 上 rename 不能覆盖已存在目标"——证伪：本机实证覆盖成功；目标被占用时 rename 失败 → `save()` 返回 false → UI 停留并提示，行为闭环正确。
  3. 终端搁浅面完整：6 条退出路径全部由 `TerminalRestore` RAII（app.rs:329-336）覆盖；panic hook 按 panic strategy 分流正确（release `panic="abort"` 下无条件恢复是 abort 前最后机会；debug 仅主线程恢复避免误拆存活终端）；Major A 修复后代码库内已无无界递归，栈溢出（不执行 hook 的唯一崩溃形态）无入口；全部 `unwrap` 均为锁获取（持锁区间皆纯赋值、不可 panic → 锁不可中毒）+ `main.rs:36` expect（终端初始化前，安全来自调用顺序且已注释钉住）。
  4. 安全面干净：token 仅进 `Authorization` 头、仅发往常量 `USAGES_URL`（quota.rs:83-99）；自检输出实测不含凭据；`open_url` 仅用编译期常量 URL；外部字符串一律经 ratatui widget 渲染，无转义序列拼接。
  5. 并发面干净：`tokio::select!` 六分支无遗漏，EventStream `None` 有退出分支（不会忙转）；reschedule/retime/手动刷新三方交错逐场景推演（含"重排+在途 refresh"两条时序）无丢唤醒、无错序；mpsc 容量与 `blocking_send` 位置（spawn_blocking 内）无死锁。
- **新发现**：2 Minor + 2 Suggestion，已就地编号 11–14；无 Critical/Major。
- **结论与建议**：修复批次质量高、未引入回归，复审不阻断合并。合并前可顺带处理 Minor 11 与 Suggestion 13（均一行改动）；Minor 12 需在"改代码"或"改 SPEC 21.3 文本"之间二选一以维持单一事实源。

## 复核记录（2026-09-26，第三轮独立全量审查）

> 独立 code-reviewer subagent（Agent 工具委派、默认模型，只读，证伪导向——假设至少存在 2 处真实缺陷）。审查对象 = `rust/` 全部源码（`rust/src/` 13 个 .rs + `rust/src/ui/` 4 个 .rs 共 2649 行）、`rust/Cargo.toml`、`rust/build.rs`，对照 `docs/SPEC.md` 逐条核验。工作区含未提交修改即此前修复批次（Major A + Minor 1–5、11–12 + Suggestion 6–9、13–14），本轮在其上以证伪为导向重新推演，未重复报告已修条目；审查全程仓库零改动（git status 复核确认）。

- **实证手段**：`cargo check` 无警告通过；`cargo test` **26/26 通过**；vendored 依赖源码取证（ratatui-0.29.0 `buffer.rs`/`paragraph.rs` 越界行为、crossterm-0.28.1）；在仓库外搭建 scratch crate（ratatui `TestBackend`）**实证**三视图在 72×13 下的渲染结果（Major B 的关键证据）；与 `go/internal/core/`（1:1 移植参照）交叉比对语义分歧点；`unwrap`/`expect`/`unsafe` 全量枚举（生产路径仅锁获取 + 1 处文档化 expect + 2 处已审 Win32 unsafe）。
- **新发现**：1 Major（B，设置视图 72×13 裁切，实证复现）+ 1 Minor（15，Ctrl+Break 恢复缺口）+ 4 Suggestion（15–18），已就地编号插入上文各区；无 Critical。
- **证伪记录（假设均被驳回）**：极矮终端 ratatui 越界 panic（`inner` 算术保持 containment，h=0 时 `is_empty()` 早退）；`expires_at: "1e999"` 绕过 30s 校验（SPEC 22.2 golden 明确 `inf → 成功`，为跨版契约行为且服务端兜底）；dashboard/skills 在 13 行下缺行（实测页脚均正常，仅 settings 受害）。
- **已核对通过（抽样）**：SPEC 契约逐项（11.1 九色值、12.1–12.7 文案逐字、12.3 倒计时阶梯、12.5 含 `i64::MIN`、13.2 保存顺序、16.1–16.5、17.1–17.4、18.1–18.3、19 自检格式、20 缩窗守卫、21.2 三目录扫描）；安全面（token 仅进 `Authorization` 头、仅发往常量 `USAGES_URL`；reqwest 校验 header 值使 CRLF 注入不可达；`--test-fetch` 输出无凭证；`open_url` 仅用编译期常量）；panic/资源（生产 `unwrap` 全为锁获取不可中毒、panic hook 按 panic strategy 分流正确、无 HTTP body 泄漏）；并发（reschedule/retime/手动刷新三方交错无丢唤醒、std 锁均无跨 await 持有、`Notify` permit 语义正确）。
- **结论**：**Request Changes**——Major B 建议合并前修复；Minor 15 与 Suggestion 15–18 可登记后排期。前轮 15 项发现修复属实，本轮未见回归。

## 复核记录（2026-09-26，第四轮独立全量审查）

> 独立 code-reviewer（后台独立进程 `KIMI_MODEL_THINKING_EFFORT=max kimi -p ... --agent code-reviewer`、默认模型 + max 思考强度，只读，证伪导向——假设至少存在 2 处真实缺陷）。审查对象 = HEAD `77166df` + 工作区未提交修复批次（即第三批次后的完整工作区实况），对照 `docs/SPEC.md` 逐条核验；审查全程仓库零改动（`git status` 前后一致，仅 `target/` 构建产物）。

- **实证手段**：`cargo test`（debug）**27/27**、`cargo test --release` **27/27**（无 overflow-checks 语义下 `i64::MIN` 极值用例仍过）；`cargo build` debug/release 均 0 warning；双自检实测——`--test-fetch` 返回真实 19 行 JSON（`"error": null`，输出不含 token；批次三时本机 token 过期返回 no-token，本机 token 已续期，两条确定性路径跨轮均观察到）、`--test-update` 与验收基线逐字一致；依赖版本基线不变（crossterm 0.28.1 / ratatui 0.29.0 / tokio 1.53.1 / windows 0.61.3）；三版 `reset_time.txt` golden 实测 29 内容行、无尾换行（`wc -l` 计 28），与 SPEC 22.2 口径一致；抽验 `go/internal/core/skills.go:99-103` 证实 Suggestion 17 的跨版一致性声明逐字属实。
- **回填表逐条核验**：20 条条目**全部属实**（修复代码存在且正确、回归测试存在且通过、声称的 SPEC/文档同步均已落地），唯 4 处行号漂移——登记为 Minor 19 并随本轮文档批次就地更正；未发现修复引入的回归。
- **新发现**：1 Minor（19，台账行号漂移）+ 2 Suggestion（20 dashboard 月度子行谓词双份拷贝、21 `console_ctrl_handler` 未覆盖 `CTRL_C_EVENT`），已就地编号插入上文各区；无 Blocker/Major。
- **证伪记录（严重假设均被驳回）**：① 极小终端 ratatui 渲染越界 panic——渲染区全部来自 Layout solver chunk（frame 子集），skills `inner` 用 `saturating_sub`、h=0 时渲染为空操作，72×13 由 TestBackend 测试实证钉住；② `scroll_for` 的 `max_scroll` 钳位藏住描述行——代数证明合法选中项恒有 `sel_line ≤ total-2`，钳位永不先于"双行可见"生效，3 单测覆盖边界；③ release 下 `fmt_yuan(i64::MIN)` 仍溢出——i128 取绝对值无溢出面，`cargo test --release` 含极值用例通过；④ reschedule/retime/手动刷新交错丢唤醒或错序——`Notify` permit + Mutex hint 排干序列正确，reschedule 后遗留 permit 空转一轮无害，尾写覆盖语义与 C# 参照 `timer.Change` 一致；⑤ save 失败状态机泄漏——`take()` 失败后 draft 复位、`save_failed=true`、停留设置页，Esc/重开/成功均复位，与 SPEC 13.2 新文本逐字一致；⑥ ctrl handler 引入死锁/回归——handler 线程内仅 `execute!`+`disable_raw_mode`，std stdout 锁逐次调用持有、可重入，返回 FALSE 交还默认终止，与 panic hook 序列同源。
- **安全面/资源面抽查**（前轮已核对通过项维持结论）：token 仅进 `Authorization` 头、仅发往常量 `USAGES_URL`；自检输出实测无凭据；生产 `unwrap` 全为不可中毒的锁获取 + 1 处文档化 `expect`（hook 安装前）；unsafe 仅 3 处已审 Win32 调用。
- **结论**：**Approve**——四个批次（Major A/B、Minor 1–5/11–12/15、Suggestion 6–18）的全部修复经逐条核验属实且无回归，27 个测试 debug/release 双跑通过，双自检输出与基线一致。Minor 19 已随本轮文档批次回填更正；Suggestion 20/21 均一行级改动，登记待排期，不阻断合并。
