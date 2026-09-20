# HANDOFF — TS 版接力点（一次性文件）

> 用途：跨会话交接。**M4 收尾后并入 `docs/TS-EDITION-PLAN.md` 并删除本文件**。
> 更新：2026-09-20（M2 完成后重写）。技术结论一律不在这里重述，只给指针，避免出现第二个事实源。

## 1. 现在在哪

- **路线**：Bun + OpenTUI（`docs/TS-EDITION-PLAN.md` §1）。`docs/TS-EDITION-PLAN-NODEJS.md` + 整棵 `ts-nodejs/` 是**另一会话在跑的未采纳 Node 路线**，勿动、勿 `git add -A`。
- **已完成**：M1 core（已 commit + 已过双视角 code review，见 §5）；**M2 dashboard 渲染层**（2026-09-20 commit `02f3a99`，本地未 push）。
- **未完成**：M3（settings/skills 视图 + 全键盘路由 + 启动缩窗 + 终端恢复补全）、M4（打包 + 文档同步 + 独立 review）。步骤见 `docs/TS-EDITION-PLAN.md` §4。

## 2. 验收命令（M2 收口时全绿，开工先复现基线）

```bash
cd ts
bun run test     # 194 pass / 0 fail（含 dashboard 行快照 + OpenTUI 适配器集成）；TZ 由脚本固定
bun run parity   # 与 rust/target/debug/kimi-planbar-tui.exe 背靠背，除 fetchedAt 值外逐字节一致
```

**真终端启动务必定向到 OpenTUI 版**：`cd ts && bun run dev`（= `bun ... src/main.ts`）。`ts-nodejs/` 的 `node ... src/main.ts` 会渲染**同名** "Kimi Planbar TUI" 窗口——自动化截图/焦点在两会话窗口间极易混。人工验收前先确认进程是 bun 且 cwd 是 `ts/`。
本机 Kimi token 时效很短（数十分钟）。token 有效时 `--test-fetch`/parity 走真实成功路径、证据最强；过期时两版都退 `no-token` 分支。要复现成功路径先 `kimi login` 再跑。

## 3. 指针（结论都在这里，不要在此文件复核）

| 内容 | 位置 |
|---|---|
| M2 渲染层三条实现差异：OpenTUI 适配器（每行 Text 销毁重建、window_bg 逐 span 合成）、**Bun/Windows `setRawMode` 是空操作 → conhost 回显按键，须 `bun:ffi SetConsoleMode` 进 raw 且每次输入/重绘前重申**、键事件挂 `renderer.keyInput` | `docs/SPEC-TS-DIFF.md` §5 |
| S0 四条 API 陷阱（就地改 `content` 不重绘、`position:absolute` 被忽略、底纹不铺满需按行补宽、测试渲染器 `resize()` 崩） | `docs/TS-EDITION-PLAN.md` §2.6 |
| 渲染层落点与模块边界（line/dashboard/renderer/app/console 五文件） | `ts/src/tui/`，注释引用 SPEC 章节 |
| golden 再生方式（临时 cargo 工程复用真实 `rust/src/quota.rs`） | `ts/test/parity/make-oracle.ts` 头部注释 |
| M3/M4 步骤 | `docs/TS-EDITION-PLAN.md` §4 |

## 4. 下一步开工前三步

1. **先复现基线**（§2 两条命令），确认 `ts/` 环境未变。
2. **M3 渲染层续建**：`ts/src/tui/` 加 settings/skills 视图（对照 `rust/src/ui/settings_view.rs`、`skills_view.rs`）+ 全键盘路由（SPEC 12.7）。注意 §2.6：真终端会投 `keyrelease`，路由器须忽略；`R` = `name:"r"+shift:true`，复刻 Rust 只认小写须自行判 shift。终端恢复（SPEC 20，最高优先级）：`q`/Ctrl+C/`uncaughtException`/`unhandledRejection` 全部走 `destroyRenderer()`（已含 `renderer.destroy()` + console.ts 的 `restore()`）。
3. **启动缩窗 72×13（TS 差异点，SPEC 20）**：无 Win32 binding，用终端环境变量启发式（`WT_SESSION`/`TERM_PROGRAM`/`ConEmuPID` 存在=共享终端不缩；缺失=双击新窗发 `ESC[8;13;72t`）。实测后回写 `docs/SPEC-TS-DIFF.md` §6。

## 5. 挂起事项（等你拍板，别默认执行）

- **M1 的 5 个 Major + 7 个 Minor**（`docs/REVIEW-M1.md`，无 Blocker）：你之前决定推迟到 M2 之后修，修复原则「能对齐 Rust 的全对齐，对不齐的补写 SPEC-TS-DIFF」。Major A（`refreshMinutes` 过大致 `setTimeout` 溢出 → 带 token 热循环）与 B（skills 整文件读入，违背 4 KiB 上限）建议优先。**现 M2 已完成——待你确认是接着修 Major 还是先推 M3。**
- **统一人工验收**：你倾向把双主题 + 交互走查合并到"全部构建完成后"一轮做（因两会话窗口易混）。M2 这轮只做了 OpenTUI 渲染层定向确认（回显修复前后对比即证据）。M4 前需补一轮完整人工对照 SPEC 11/12/13/21。
- **并行 Node 会话**：`ts-nodejs/` 由另一会话在跑（未采纳路线）。是否停掉/收敛是你的决定——本会话全程未触碰。

## 6. 工作树边界（改 ts/ 时务必遵守）

- 只 `git add <具体路径>`，**绝不 `git add -A` / `git add .`**，以免把 `ts-nodejs/`、`docs/TS-EDITION-PLAN-NODEJS.md` 等并行/存档 WIP 一起提交。
- 修 M1 清单时只动 `ts/src/core/*` 与 M1 测试文件；M3 只在 `ts/src/tui/` 增量。
- `docs/TS-EDITION-PLAN-NODEJS.md` 头部写着「取代 OpenTUI 路线」，与已定方案冲突，但按 AGENTS.md 规矩改既有文件前先问——**未得许可谁都不要动它**。
