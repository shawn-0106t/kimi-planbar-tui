# HANDOFF — TS 版接力点（一次性文件）

> 用途：跨会话交接。**M4 收尾后并入 `docs/TS-EDITION-PLAN.md` 并删除本文件**。
> 更新：2026-09-20（M3 完成后重写）。技术结论一律不在这里重述，只给指针，避免出现第二个事实源。

## 1. 现在在哪

- **路线**：Bun + OpenTUI（`docs/TS-EDITION-PLAN.md` §1）。`docs/TS-EDITION-PLAN-NODEJS.md` + 整棵 `ts-nodejs/` 是**另一会话在跑的未采纳 Node 路线**，勿动、勿 `git add -A`。
- **已完成**：M1 core（已过双视角 review，见 §5）；M2 dashboard 渲染层（`02f3a99`）；**M3 三视图 + 全键盘路由 + 缩窗代码**（本次 commit，本地未 push）。
- **M3 的边界**：只有自动化证据（`bun test` 256 绿 + parity 逐字节）。**真终端那一轮没跑**——待验清单在 `docs/SPEC-TS-DIFF.md` §6 末尾，探针 = `ts/test/console-probe.ts`（用法见文件头注释）。这三项里包含对 M2 既有结论的复测（`console.ts` 输入句柄修正）。
- **未完成**：M4（打包 + `--use-system-ca` 固化 + 文档同步 + 独立 review）。步骤见 `docs/TS-EDITION-PLAN.md` §4。

## 2. 验收命令（M3 收口时全绿，开工先复现基线）

```bash
cd ts
bun run test     # 256 pass / 0 fail；TZ 由脚本固定，直接 `bun test` 会因时区炸掉 golden
bun run parity   # 与 rust/target/debug/kimi-planbar-tui.exe 背靠背，除 fetchedAt 值外逐字节一致
```

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
| M4 步骤 | `docs/TS-EDITION-PLAN.md` §4 |

## 4. 下一步开工前三步

1. **先复现基线**（§2 两条命令），确认 `ts/` 环境未变。
2. **补真终端轮**（`SPEC-TS-DIFF.md` §6 末尾四项 + SPEC 11/12/13/21 三视图走查）：这轮同时决定 `console.ts` 的 raw mode 到底谁在做、以及 conhost 缩窗通道 (b) 的手工打包是否被 kernel32 接受。用户倾向把它与 M4 的完整人工对照合成一轮，顺序由你定。
3. **M4 打包**：`bun build --compile`（脚本 `bun run build:exe`）；`--use-system-ca` 在编译产物上的固化方式是 M4 唯一开放技术问题（`SPEC-TS-DIFF.md` §4）。

## 5. 挂起事项（等你拍板，别默认执行）

- **M1 的 5 个 Major + 7 个 Minor**（`docs/REVIEW-M1.md`，无 Blocker）：从 M2 拖到 M3、现在仍待你确认是否修。Major A（`refreshMinutes` 过大致 `setTimeout` 溢出 → 带 token 热循环）与 B（skills 整文件读入，违背 4 KiB 上限）建议优先。修只动 `ts/src/core/*` 与 M1 测试。
- **并行 Node 会话**：`ts-nodejs/` 由另一会话在跑（未采纳路线），本会话全程未触碰。是否收敛是你的决定。
- **`--use-system-ca` 与分发体积**（~90 MB）都归 M4 记录到 README。

## 6. 工作树边界（改 ts/ 时务必遵守）

- 只 `git add <具体路径>`，**绝不 `git add -A` / `git add .`**，以免把 `ts-nodejs/`、`docs/TS-EDITION-PLAN-NODEJS.md` 等并行/存档 WIP 一起提交。
- M3 的改动全部落在 `ts/src/tui/` + `ts/test/`（`line.ts` 的格宽改动会影响 dashboard 快照，改前先跑 `bun run test`）。
- `docs/TS-EDITION-PLAN-NODEJS.md` 头部写着「取代 OpenTUI 路线」，与已定方案冲突，但按 AGENTS.md 规矩改既有文件前先问——**未得许可谁都不要动它**。
