# HANDOFF — TS 版接力点（一次性文件）

> 用途：跨会话交接。**M4 收尾后并入 `docs/TS-EDITION-PLAN.md` 并删除本文件**。
> 更新：2026-09-20（M3 完成后重写）。技术结论一律不在这里重述，只给指针，避免出现第二个事实源。

## 1. 现在在哪

- **路线**：Bun + OpenTUI（`docs/TS-EDITION-PLAN.md` §1）。`docs/TS-EDITION-PLAN-NODEJS.md` + 整棵 `ts-nodejs/` 是**另一会话在跑的未采纳 Node 路线**，勿动、勿 `git add -A`。
- **已完成**（全部本地 commit、未 push）：M1 core（已过双视角 review，见 §5）；M2 dashboard 渲染层（`02f3a99`）；M3 三视图 + 全键盘路由 + 缩窗（`f62d0f3` 代码 / `7468d56` 文档）；M4 打包 + 文档同步（`76cfceb`）。自动化证据：`bun run test` 256 绿、`bun run parity` 逐字节一致、`ts/dist/kpt-tui.exe` 与 Rust exe 也逐字节一致。
- **未完成**：① **真终端验收一轮**（待验清单在 `docs/SPEC-TS-DIFF.md` §6 末尾，工具 `ts/test/console-probe.ts`，`--shrink` 才会真的改窗口）；② `docs/REVIEW-M1.md` 的 5 Major + 7 Minor **仍未修**；③ 覆盖 M3+M4（+ 若修的 M1 清单）的**一次独立 code review**。
- **M4 收口时的两处结论**：`--use-system-ca` 无法固化进编译产物、且本机 ESET TLS 拦截已不复现（兜底 = README 注明"仅 GitHub API 兜底静默降级为 checkFailed"，探针 `ts/test/system-ca-probe.ts`）；M2 的 `console.ts` 把 raw mode 打在了输出句柄上（`0xfffffff5` = `(HANDLE)-11`），M3 已改为 `(HANDLE)-10`，**该修正待真终端复测**——M2 当时"回显消失"的归因可能不成立。


## 2. 验收命令（M3 收口时全绿，开工先复现基线）

```bash
cd ts
bun run test     # 256 pass / 0 fail；TZ 由脚本固定，直接 `bun test` 会因时区炸掉 golden
bun run parity   # 与 rust/target/debug/kimi-planbar-tui.exe 背靠背，除 fetchedAt 值外逐字节一致
bun run test/parity/diff.ts --ts-exe dist/kpt-tui.exe   # 比对编译产物
```

**parity 的 Rust 参照物固定是 debug 那个 exe；TS 任务里不要 `cargo build`**（含 `--release`）——那是 Rust 版自己的验收范围，用户 2026-09-20 明确划的界。临时换 exe 用 `KPT_RUST_EXE=<path>`。

**真终端启动务必定向到 OpenTUI 版**：`cd ts && bun run dev`（= `bun ... src/main.ts`）。`ts-nodejs/` 的 `node ... src/main.ts` 会渲染**同名** "Kimi Planbar TUI" 窗口——自动化截图/焦点在两会话窗口间极易混。人工验收前先确认进程是 bun 且 cwd 是 `ts/`。
本机 Kimi token 时效很短（数十分钟）。token 有效时 `--test-fetch`/parity 走真实成功路径、证据最强；过期时两版都退 `no-token` 分支。要复现成功路径先 `kimi login` 再跑。

## 3. 指针（结论都在这里，不要在此文件复核）

| 内容 | 位置 |
|---|---|
| M2/M3 渲染层实现差异：适配器三条陷阱、Bun/Windows raw mode（含 M3 发现的输入句柄写错一事）、CJK 格宽、underline、skills 扫描放宏任务 | `docs/SPEC-TS-DIFF.md` §5 |
| 缩窗：`GetConsoleProcessList` 经 `bun:ffi` 可用（守卫与 Rust 同判据）、两条通道传参打包方式、**待实测四项清单** | `docs/SPEC-TS-DIFF.md` §6 |
| S0 四条 API 陷阱（就地改 `content` 不重绘、`position:absolute` 被忽略、底纹不铺满、测试渲染器 `resize()` 崩） | `docs/TS-EDITION-PLAN.md` §2.6 |
| 渲染层落点与模块边界（line/dashboard/settingsView/skillsView/renderer/app/console/shrink 八文件） | `ts/src/tui/`，注释引用 SPEC 章节 |
| M3 键盘路由与 Rust `handle_key` 的 1:1 对照测试 | `ts/test/appRouting.test.ts` |
| golden 再生方式（临时 cargo 工程复用真实 `rust/src/quota.rs`） | `ts/test/parity/make-oracle.ts` 头部注释 |
| M4 收尾步骤与已实测结论（打包、`--use-system-ca`、文档同步） | `docs/TS-EDITION-PLAN.md` §4 M4 |
| M1 审查清单（5 Major + 7 Minor，修复原则） | `docs/REVIEW-M1.md` |
| `--use-system-ca` / TLS 拦截复测结论 | `docs/SPEC-TS-DIFF.md` §4 + `ts/test/system-ca-probe.ts` |

## 4. 下一步（按此顺序，或按你的重排）

1. **先复现基线**（§2 三条命令），确认 `ts/` 环境未变。
2. **M1 清单修复**（待你定范围，见 §5）：只动 `ts/src/core/*` 与 M1 测试，改完 `bun run test` + `bun run parity` 必须仍绿。
3. **真终端一轮**（`SPEC-TS-DIFF.md` §6 末尾四项 + SPEC 11/12/13/21 三视图走查 + `bun run dev` 与编译产物各跑一次）：这轮同时决定 `console.ts` 的 raw mode 到底谁在做、以及 conhost 缩窗通道 (b) 的手工打包是否被 kernel32 接受。
4. **一次独立 code-reviewer 审查**，范围 = M3 + M4（+ 若做了第 2 步则含 M1 修复）。

## 5. 挂起事项（等你拍板，别默认执行）

- **M1 的 5 个 Major + 7 个 Minor**（`docs/REVIEW-M1.md`，无 Blocker）：从 M2 拖到 M3、再拖到 M4，**至今未修，待你定范围**（只修 Major / Major+Minor 全修 / 先不修直接进 review）。Major A（`refreshMinutes` 过大致 `setTimeout` 溢出 → 带 token 热循环）与 B（skills 整文件读入，违背 4 KiB 上限）建议优先。修只动 `ts/src/core/*` 与 M1 测试。
- **并行 Node 会话**：`ts-nodejs/` 由另一会话在跑（未采纳路线），本会话全程未触碰；它还会往仓库根丢截图脚本与 png（`launch-tui.ps1`、`shot-*.png` 等），别误提交。是否收敛是你的决定。
- ~~`--use-system-ca` 与分发体积~~：M4 已收口——前者结为"无法固化 + 当前不需要"（`SPEC-TS-DIFF.md` §4），后者已写进两个 README 与发布流程。

## 6. 工作树边界（改 ts/ 时务必遵守）

- 只 `git add <具体路径>`，**绝不 `git add -A` / `git add .`**，以免把 `ts-nodejs/`、`docs/TS-EDITION-PLAN-NODEJS.md` 等并行/存档 WIP 一起提交。
- M3 的改动全部落在 `ts/src/tui/` + `ts/test/`（`line.ts` 的格宽改动会影响 dashboard 快照，改前先跑 `bun run test`）。
- `docs/TS-EDITION-PLAN-NODEJS.md` 头部写着「取代 OpenTUI 路线」，与已定方案冲突，但按 AGENTS.md 规矩改既有文件前先问——**未得许可谁都不要动它**。
