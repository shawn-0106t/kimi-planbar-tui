# HANDOFF — ts/（Bun 版）审查修复中点交接（一次性文件）

> 生成：2026-09-20。用途：跨会话交接 **ts/ 审查修复**的续作。修复由用户决定暂停并自行规划，本文档是唯一事实源。
> 修完并验证后删除本文件。

## 1. 三版现状

| 版本 | 状态 |
|---|---|
| `rust/` | 基准实现，未动 |
| `ts-nodejs/`（Node 24 + 手写 ANSI） | **已完整交付**：M1–M4 完成，242 测试 + `npm run typecheck` 全绿，与 Rust parity 逐字节一致，独立 code review Approve，SEA exe 已出（`dist/kpt-tui-node.exe` 88.7 MB，`npm run build:exe`）。文档已归并（SPEC 第 22 章、AGENTS.md、README ×2） |
| `ts/`（Bun + OpenTUI） | 功能完整（exe 已出、256 测试曾全绿、parity 曾逐字节一致），但经独立 code review 发现 **1 Critical + 4 Major + 若干 Minor**；修复进行到一半被停止，**当前树是中间态：254 pass / 2 fail** |

## 2. ts/ 审查结论（全文见本节，reviewer: 独立 code-reviewer subagent）

### Critical C-1：Ctrl+C 在真实 Windows 控制台失效 + FFI raw mode 永不恢复（SPEC 20）
- 根因链：`console.ts` rawMode 未清 `ENABLE_PROCESSED_INPUT`（crossterm 会清）→ Ctrl+C 变 console control event → `app.ts` 的 ctrl+c 分支成死代码 → OpenTUI 的 SIGINT handler 只 destroy renderer 不退进程 → 进程卡死；强杀则控制台滞留无回显状态
- 修法：(a) rawMode 清 `ENABLE_PROCESSED_INPUT`；(b) `app.ts` 注册 SIGINT/SIGBREAK → 统一销毁路径 + exit(0)

### Major（全部沿用 `docs/REVIEW-M1.md` 旧账，修复原则：对齐 Rust）
- M-1 `polling.ts` periodMs 无 clamp → setTimeout 溢出 → 带 token 1ms 热循环（Rust 无此问题）
- M-2 `skills.ts` 整文件读入（Rust 物理只读 4 KiB）
- M-3 `quota.ts` instantOf 畸形时间被 Date.UTC 静默进位（chrono 拒绝）
- M-4 `skills.test.ts:60` 恒真断言 + `parity.test.ts` 裸 return 静默跳过

### Minor：json.ts 无 128 层深度上限 / 非 2xx 不消费 body / localizeNaiveSingle 死代码 / resetTime 正则与 chrono 不重合 / settings Number(bigint) 往返失真 / update.test 名实不符 / 测试临时目录清理 / oracle 固定 %TEMP% 名 / dashboard 窄屏分栏 / 主题 tick 不主动重绘 / console-probe dlopen 无降级。M1 Minor 6（裸 catch）维持不修（SPEC 静默基调）。

## 3. 修复进度（被停止时已落盘的部分，用 grep 标记实测确认）

已修（实现侧）：M-1（polling clamp ✓）、M-2（skills readSync ✓）、M-3（quota getUTCHours 回校验 ✓）、M-4a（skills.test \uFFFD ✓）、C-1a（console.ts PROCESSED_INPUT ✓）、C-1b（app.ts SIGINT ✓）、Minor 1（json.ts depth ✓）、Minor 2/5（见下方失败测试）。

**当前 2 个失败测试 = 钉住旧行为的测试还没随实现更新**：
- `quota.test.ts:250` "non-2xx ... the body is never read"（实现已改为消费 body，Minor 2）
- `settings.test.ts:72` "a number out of i64 range is a type error"（实现已改 bigint 处理，Minor 5）

## 4. 续作清单（按序）

1. 更新上述 2 个测试到新行为 → `cd ts && bun run test` 回绿
2. 核对 Minor 4/7/8/9/10 与 M-4b（parity.test.ts）是否已修，未修补齐（清单见 §2 与 REVIEW-M1.md）
3. **C-1 真实终端验证**（必须）：用 `ts-nodejs/scripts/verify/launch-tui-conhost.cmd` 同款模式（本机 wt.exe 命令行有 bug，只能 `start "t" cmd /k "..."` 批处理）起 `bun run dev`，注入 Ctrl+C，确认进程退出且终端恢复
4. `bun run parity` 复核逐字节一致
5. `docs/REVIEW-M1.md` 逐条标注修复状态；SPEC 第 22 章补/改条文（如 Minor 2/4 选择登记为差异）
6. 完成后派 code-reviewer 复审（可 resume 本会话审查 agent）

## 5. ts-nodejs 待决事项

- core 三条同源问题（polling clamp / skills 4KiB / quota 畸形时间）**ts-nodejs 仍携带**。用户已确认 Rust 版无此问题、属 TS 移植偏差；是否同步修复及修复时机待用户规划。ts/ 修完后以 ts/ 为准平移即可（两版 core 本同源）
- ts-nodejs 的恒真断言已在自身审查中修过，无需再动

## 6. 本机环境备忘（排查时勿重蹈）

- `wt.exe` 命令行接管在本机损坏：任何 `wt new-window ... -- cmd ...` 都把参数串当 exe 名报 0x80070002；起新终端窗口用 `start "title" cmd /k "..."` 批处理（经 conhost 由 WT 托管）
- kimi-cu 的 `get_app_state` 参数传输故障（list_apps 正常）；窗口截图/按键验证用 `ts-nodejs/scripts/verify/` 下的 PowerShell 脚本（capture-wt-window.ps1 按 HWND 截屏，SendKeys 前有前台守卫）
- P/Invoke 记得 `CharSet.Unicode`，否则宽字符标题被按 ANSI 截成首字符
