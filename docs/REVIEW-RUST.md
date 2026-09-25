# Rust 版全量代码审查清单（REVIEW-RUST）

> 审查对象：commit `53d519d`（2026-09-25）时的 `rust/src/` 全部 14 个源文件、`rust/src/ui/` 三视图、`rust/build.rs`、`rust/Cargo.toml` 及内嵌单元测试。
> 方法：独立 code-reviewer subagent 一轮（只读、以证伪为导向，假设至少存在 2 处缺陷），自行重跑验收命令并对 vendored 依赖源码取证。
> 结论：**无 Blocker**；1 个 Major、5 个 Minor、3 个 Suggestion。
> 验收基线（审查时实测）：`cargo test` **15/15 通过**；`--test-fetch` 返回真实 19 行数据（当时 token 有效）；`--test-update` `local=2.1.1 latest=2.1.1 updateAvailable=False checkFailed=False`。
> 依赖取证基线：windows-0.61.3 / crossterm-0.28.1 / ratatui-0.29.0 / tokio-1.53.1。`cargo clippy` 未运行（本机 toolchain 未装该组件）。
> **修复时机：待维护者拍板**（建议 Major A 尽快——真实可触发的终端搁浅缺陷）。

## Major（建议尽快关闭）

### A. `fmt_yuan` 对 `i64::MIN` 取负溢出 → 无限递归 → 栈溢出搁浅终端

- 位置：`rust/src/format.rs:30-32`（触发点 `rust/src/ui/dashboard.rs:138` 月度子行；数据入口 `rust/src/quota.rs:153-159` + `246-247`）
- 触发：API 返回 `boosterWallet.monthlyChargeLimitEnabled == true`、`monthlyChargeLimit.priceInCents > 0`、`monthlyUsed.priceInCents == "-9223372036854775808"`——`get_i64` 的 `parse::<i64>()` 恰好接受该字符串，`fmt_yuan` 负数分支的 `-cents` 在 release 构建（未开 `overflow-checks`）下回绕仍为 `i64::MIN`，按负数再次取负 → **无限递归 → 栈溢出 abort**。debug 构建则为取负溢出 panic。
- 危害：栈溢出**不执行 panic hook**——raw mode + alternate screen 被搁浅，正是 SPEC 20 定义的"最严重事故"。且同一份 hostile payload 下 ts-nodejs 移植版存活（`ts-nodejs/src/core/format.ts:41` 用 bigint，取负永不溢出）——**oracle 比自己的移植版更脆**，违反 SPEC 20"绝不 panic"与 16.3 防御性解析基调（同文件对 `1e999`、`saturating_add` 均已设防，唯独漏此）。
- 实证：独立 rustc 脚本验证 `wrapping_neg(i64::MIN) == i64::MIN`。
- 修法：负数分支改 `checked_neg()`（`None` 时按 `i64::MAX` 处理）或以 `i128` 取绝对值计算；补 `fmt_yuan(i64::MIN)` 回归测试（顺带补 `format_reset` 阶梯与 `fmt_percent` 用例，见覆盖缺口）。

## Minor

1. **缩窗 xterm 转义在 VT processing 启用前写入 stdout**（`rust/src/app.rs:343`）：crossterm 0.28.1 的 VT 启用是惰性的（首次 ANSI `execute!` 才发生），conhost 场景（Win10 默认终端或 Win11 设 conhost 为默认时双击启动，`GetConsoleProcessList==1` 恰好放行）输出模式无 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`，`ESC[8;13;72t` 被当字面文本回显进主屏缓冲——退出后用户看到一行乱码残留。WT 下无害。修法：写转义前自行启用 VT（失败则跳过通道 (a) 只走 Win32 序列）。
2. **settings.json 非原子覆写 + 与注册表无对账**（`rust/src/settings.rs:58-63`）：truncate-then-write，写入中途崩溃留下截断 JSON，下次启动 `unwrap_or_default()` 静默回落默认；更糟的是 HKCU Run 值不回退——注册表残留 `true` 照常自启，settings.json 回落 `AutoStart=false`，设置界面与实际行为背离且无提示。修法：同目录临时文件 + `rename` 覆盖；启动时可选做一次 Run 值对账。
3. **parse_reset_time 是 SPEC 16.3 的超集**（`rust/src/quota.rs:161-185`）：实际接受 RFC3339 之外的宽松形状（空格分隔、紧凑偏移、naive 本地时间）。行为已被 ts golden（`reset_time.txt` 29 行）锁定为事实契约，属 **SPEC 文本滞后**而非代码错误。修法：SPEC 16.3 措辞更新为"RFC3339 + DateTimeOffset.TryParse 阶梯（以 golden 为准）"。
4. **percent ≥ 1000% 时 `%` 后缀被截断**（`rust/src/ui/dashboard.rs:78` `chars().take(4)`）：`limit<=0 → 1` 的防御分支恰可制造大 percent（如 5000.0 → 显示 `5000` 而非 `5000%`），与 SPEC 12.2 `{percent:0}%` 不符。修法：列预算加宽至 5 字符或截断保留尾缀。
5. **panic hook 全局生效**（`rust/src/app.rs:368-373`）：任意 tokio 后台任务 panic 同样执行"恢复终端"，但 tokio 吞掉任务 panic 让 app 继续运行——结果是存活状态下拆除 alternate screen、退出 raw mode。审查者核查了最可疑路径（tokio-1.53.1 `sleep` 对超大 Duration 走 `far_future()` 不 panic），**当前无可达触发路径**，列防御纵深缺口。修法：hook 内 thread-local 标记仅主循环线程生效，或任务 panic 触发统一退出。

## Suggestion

6. `rust/src/state.rs:17` `AppState.update` 只写不读（UI 读 `App.update`），死字段。
7. `rust/src/credentials.rs:71-79` `[ providers.kimi ]`（括号内侧带空格）剥括号后节名残留空格，误判非 provider——真实 kimi CLI 写紧凑格式不受影响，可登记为已知限制或对节名再 `trim()`。
8. `rust/src/quota.rs:78-83` 与 `rust/src/update.rs:24-29` 各持独立 `OnceLock<Client>`，可共享连接池；纯整理。

## 已核对通过（不必重做）

- **防御性解析密度**：字符串/数字混排、除零钳位、inf/NaN 归零、`saturating_add` 防溢出（唯 A 项漏网）。
- **并发模型**：单事件循环线程 + 短临界区 RwLock；`Notify` permit 语义到位——`polling.rs:49-53` 排干 stale hint 的注释经逐场景推演（reschedule/retime/手动刷新三方交错）未发现漏洞。
- **终端纪律**：RAII guard 在 `enable_raw_mode` 与 `EnterAlternateScreen` 之间声明；panic hook 先于终端初始化；`resize_owned_console` 的 `SetConsoleWindowInfo` **指针传参正确**（windows-0.61.3 签名核实——ts 版抄错致 segfault 的参照实现无误）；`GetConsoleProcessList` slice 形态、`GetStdHandle` 双重空值防御均正确。
- **安全面**：token 只进 `Authorization` 头、只发往常量端点；自检输出不含凭证。
- **SPEC 契约逐项核对一致**：11.1 九色色值、12.3 FormatReset 阶梯、12.5 FmtYuan（除 A）、12.7 footer 与防抖、13.2 保存顺序、16.1–16.5、17.1–17.4（含 UA/Range/fallback）、18.1–18.3、19 自检、20 缩窗守卫与恢复、21 skills 三根目录扫描。

## 测试覆盖缺口（防御性路径无测试）

- **format.rs**：`format_reset` 阶梯与 `fmt_percent` 在 oracle 侧零测试（ts-nodejs 反而有）；`fmt_yuan` 无负数极限用例——正是 Major A 的洞。
- **credentials.rs**：config.toml 逐行解析（节结算时机、首个匹配、`KIMI_CODE_HOME`、`expires_at > now+30s` 边界）零测试。
- **settings.rs**：portable.dat 优先级、APPDATA 回落、PascalCase 往返、整体/逐键默认语义零测试。
- **polling.rs**：reschedule/retime 交错、keep-last-good 传递链、30 s 快重试/成功回周期零测试（ts 侧反而有）。
- **update.rs**：`parse_semver`、fallback 次序、`check_failed` 边界零测试。
- **quota.rs**：`fill_missing_from` 链、fetch 错误归类（无 HTTP mock 基建）、`get_i64` 极值字符串。
- **纯逻辑 UI 函数**：`usage_line` 宽度预算、`bar_spans` 边界、skills_view 滚动不变量。
- **终端纪律**（hook 安装顺序、各退出路径恢复、缩窗守卫）：难以自动化，建议至少以集成测试钉住结构性事实。

## 修复状态回填

| 条目 | 状态 | 实测位置 |
|---|---|---|
| Major A（`fmt_yuan` i64::MIN） | 未修 | — |
| Minor 1（缩窗转义 conhost 回显） | 未修 | — |
| Minor 2（settings 非原子写） | 未修 | — |
| Minor 3（SPEC 16.3 文本滞后） | 未修 | — |
| Minor 4（percent ≥1000% 吞 `%`） | 未修 | — |
| Minor 5（panic hook 全局生效） | 未修（无可达路径，防御纵深） | — |
| Suggestion 6–8 | 未修（整理级） | — |

> 修复完成后请在本表回填状态与实测位置（参照 REVIEW-M1.md 的回填惯例）。
