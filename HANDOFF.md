# HANDOFF — TS 版接力点（一次性文件）

> 用途：跨会话交接。**M2 开工后并入 `docs/TS-EDITION-PLAN.md` §4 并删除本文件**。
> 生成：2026-09-19 深夜。技术结论一律不在这里重述，只给指针，避免出现第二个事实源。

## 1. 现在在哪

- **路线已定：Bun + OpenTUI**（`docs/TS-EDITION-PLAN.md` §1 已记二次确认）。
  `docs/TS-EDITION-PLAN-NODEJS.md` 是同日起草的**未采纳备选存档**，不要当生效方案读。
- **已完成**：S0 OpenTUI 能力冒烟（GO）→ M1 core 十模块 + 177 个 `bun:test` 用例 + 无头自检 `--test-fetch` / `--test-update` + 与 Rust 版跨版本字节级 parity。
- **未完成**：M1 审查发现的 5 个 Major + 7 个 Minor **尚未修**（用户决定：等 M2 完整构建后再修，修复原则「能对齐 Rust 的全对齐 Rust」）。清单见 `docs/REVIEW-M1.md`。

## 2. 三条验收命令（当前全绿，明天开工先跑一遍确认环境没变）

```bash
cd ts
bun run test        # 177 pass / 0 fail；TZ=Asia/Shanghai 由脚本固定（golden 内嵌本地时区时间戳）
bun run parity      # 与 rust/target/debug/kimi-planbar-tui.exe 背靠背，除 fetchedAt 的值外逐字节一致
bun run selfcheck:fetch
```

今晚两种分支都验过：**成功路径**（有真实 token 时，`--test-fetch` 输出 19 行，含 `percent: 3.0` 这类浮点文本与 `resetAt` 时间戳）与 **`no-token` 分支**（token 一失效就变 7 行）。行数以明天实际输出为准，判定只看"两版是否一致"。

## 3. 指针（结论都在这里，不要在此文件复核）

| 内容 | 位置 |
|---|---|
| S0 实测：格宽/per-span bg/硬裁剪/键事件/reg.exe 引号/kimi spawn，**以及 M2 必须绕开的 4 条 API 陷阱**（就地改 `content` 不重绘、`position:absolute` 被忽略、底纹不铺满需按行补宽、测试渲染器 `resize()` 崩） | `docs/TS-EDITION-PLAN.md` §2.6 |
| TS↔Rust 实现差异条文：`fetchedAt` 是唯一字节豁免字段、严格 `from_str` 等价表、`i64` 用 `bigint`、`Number::as_i64` 需整数 token 形态、`process.execPath` 与 `portable.dat`/自启的关系、`Accept-Encoding: identity`、`--use-system-ca`、九槽调色板与 `white` 的 SGR 偏差 | `docs/SPEC-TS-DIFF.md` |
| golden 再生方式（临时 cargo 工程复用真实 `rust/src/quota.rs` 解析代码） | `ts/test/parity/make-oracle.ts` 头部注释 |
| 里程碑 M1–M4 步骤与状态 | `docs/TS-EDITION-PLAN.md` §4 |

## 4. 明天开工前三步

1. **M1 审查已完成**（两个视角各一轮，审查者自行重跑过验收）：结论无 Blocker，5 Major + 7 Minor 记在 `docs/REVIEW-M1.md`，其中 Major A（`refreshMinutes` 过大致 `setTimeout` 溢出 → 带 token 热循环）与 B（skills 整文件读入，违背 4 KiB 上限）建议优先。按约定**等 M2 完整构建后**再修，修的时候能对齐 Rust 的全对齐 Rust，对不齐的补进 `docs/SPEC-TS-DIFF.md`。
2. `cd ts && bun add @opentui/core`（0.5.11 已验证 win32-x64 可装可跑）→ 若并行会话已做过则跳过；`bun.lock` 建议提交。
3. 按 §2.6 的 4 条陷阱先定 `ts/src/tui/line.ts`（`Line[]` 纯模型）与 `ts/src/tui/renderer.ts`（OpenTUI 适配器 / 兜底 ANSI painter）的边界，再写 dashboard 纯视图 + 行快照测试，**最后**才接真渲染器到 Windows Terminal 里人工对照 SPEC 11/12 双主题。

## 5. 并行工作与工作树边界

- 2026-09-19 深夜，同一工作树里另有**并行推进的未提交改动**（用户另一窗口）：`ts/src/tui/{line,renderer,dashboard,app}.ts` + `ts/test/{dashboard,renderer}.test.ts` + `ts/bun.lock` + `ts/package.json` / `ts/src/main.ts` 的修改（M2 雏形），以及整棵 `ts-nodejs/`（Node.js 备选路线的平行实现）。本会话（M1）**只提交到 `ts/src/core/*`、`ts/src/main.ts`、`ts/test/*`（M1 那批）与 docs**，没有碰上述任何文件。
- 修 M1 清单时同理：只动 `ts/src/core/*` 与 M1 的测试文件，逐项 `git add <具体路径>`，不要用 `git add -A`，以免把并行 WIP 一起提交。

## 6. 待你决定的杂项

- `docs/TS-EDITION-PLAN-NODEJS.md` 头部现在写着「取代同文件上一版的 OpenTUI 路线」，与已定路线冲突。建议加一行「未采纳，仅存档」的更正——按 AGENTS.md 规矩，改既有文件前先问你，**未得许可前谁都不要动它**。
- 本机 Kimi token 时效很短（今晚半小时内从有效变回过期）。token 有效时 `--test-fetch` 走**真实成功路径**、证据强度最高；过期时两版都只输出 `no-token` 分支。想复现成功路径 diff，先 `kimi login`（或跑一次 `kimi`）再 `bun run parity`。
