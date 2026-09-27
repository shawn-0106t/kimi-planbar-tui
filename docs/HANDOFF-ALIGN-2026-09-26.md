# HANDOFF — Rust 对齐移植（Go 第二批 + TS 两版全量）：评审与收尾

> **归档声明（2026-09-27）**：本交接的执行清单（§6）已全部完成——① 三个 code-reviewer 并行评审 + 两轮修复复审闭环（发现与修复：go `1c97a97`/`38e9395`/`fdd71d8`、ts `daae588`、ts-nodejs `579e075`/`c584dda`，渲染层用户实机缺陷追加 `2b62629`/`0c8d985`/`deab34f`，均入库并 push）；② 门禁复跑全绿（go test/vet/gofmt/parity、bun 293→294 pass/parity、npm 274→276 pass/typecheck 0 错/parity，parity 均与 Rust debug exe 逐字节一致）；③ 文档同步完成（SPEC §22.7 新增 + §20/22.3/22.5/22.6 修订、PLAN-GO 对齐小节与头部状态、HANDOFF §11/§12、README 双语与 AGENTS.md 补 Go 版条目；随后按维护者决定**不设各栈子目录 README**，`ts/README.md` 删除、用户文档统一根 README）；④ 向维护者汇报完毕（Node 版移植项 ④ N/A 已确认成立）；⑤ 联合发版为独立后续步骤（checklist 在 `HANDOFF.md` §12，待维护者拍板版本号取向）。本文件就此归档为历史交接记录，行为契约与机制差异的最新登记以 `docs/SPEC.md` 第 20/22 章（含 22.7）为准，发版状态以 `HANDOFF.md` §12 为准；未随发版的人工验收项见下文 §5（CTRL_CLOSE 关窗恢复、旧 conhost 目检等）。

> 2026-09-26 晚会话交接。移植主体已由 dynamic workflow 完成且三棵树门禁全绿，**卡在 code-review 之前**。
> 新对话恢复方式：读本文件 §6 执行清单，从第 1 步（code-reviewer ×3）继续。
> 本文件是新建文件，未动任何现有文档；PLAN-GO / SPEC 22.7 / HANDOFF.md 的正式更新是评审后的待办（§6 第 3 步）。

## 1. 任务与已定决策

- 任务：把 rust/ `1779e33`（REVIEW-RUST 台账全部闭环）的行为修正移植进 `go/` 与两棵 TS 树；**rust/ 严格只读**（parity 只读运行其 debug exe）。
- 维护者 2026-09-26 已拍板：
  - 执行方式：dynamic workflow（已执行完毕，run `dwfrun-1dadbeae-e573-4e4f-b465-a3890febd404`）；
  - M5/22.7 ctrl-handler：**Go 补 `SetConsoleCtrlHandler`**（对齐 Rust，覆盖 CTRL_C/BREAK/CLOSE，恢复序列后返回 FALSE 走默认终止；已落地）；
  - 发版：联合发版（待 ts/go 就绪一起发），版本号取向见 `HANDOFF.md` §12 增补——Rust bump 0.1.3 vs `rust-v*` tag 仍待发版时二选一。

## 2. 已完成状态（已入库为 3 个本地 commit，未 push；评审修复走后续 commit）

| 树 | 落地 | commit | 门禁（主会话权威复跑，第 1 轮全绿） |
| --- | --- | --- | --- |
| `go/` | 第一批 6 + 第二批 4 + SetConsoleCtrlHandler（含上会话第一批） | `1ba11fb`（16 文件 +1132/−75，含新增 ctrlhandler/shrink/probe） | go test（全绿）/ vet / gofmt -l（空）/ go parity（逐字节一致） |
| `ts/`（Bun） | 第一批 6 + 第二批 4（10/10） | `2715a6c`（17 文件 +621/−101，含新增 vt-shrink-probe） | bun run test 273 通过 / parity 一致 |
| `ts-nodejs/`（Node） | 9/10；**第一批-④（缩窗先开 VT）not-applicable** | `e27056f`（11 文件 +322/−53） | npm test 272 通过 / typecheck 0 错 / parity 一致 |

- 三个 commit 均为本地 main，**未 push**；push 与否随明天评审结果一起由维护者定。
- `1ba11fb` **同时含上一会话的第一批 6 项**（原子写、ReconcileAutoStart、VT 先行、PCT_W 4→5、config.toml strip、保草稿）——评审范围要一并覆盖。
- Node 版 ④ 的 N/A 理由：该树无任何 Win32/FFI 通道（仅 node: 内建 + reg.exe spawn），转义在全部可达路径下 ConPTY no-op（SPEC §22.6 实测），为它引新原生依赖不成比例。**此判定待维护者明天确认**。
- 各项落地明细（文件、测试名、说明）在 workflow 报告 artifact「对齐移植报告」里；run 明细任意新会话可用 `GetWorkflowRun("dwfrun-1dadbeae-e573-4e4f-b465-a3890febd404")` 回读（同项目可查）。

## 3. workflow 独立核实员已证实的发现（medium ×2）

1. **Go ctrl-handler 验证缺口**：三个分支只有单元级证据（`ctrlhandler_test.go` 防重/路由/安装冒烟三项 PASS）。实测本机 ConPTY 吸收信号形式 Ctrl+C（探针 `signal sent=true` 但 TUI 存活，EXIT=PASS 实由 key 形式达成）；探针 `-exit` 不支持 CTRL_BREAK；探针 `code==0` 判定与 handler 路径退出码 `0xC000013A`（STATUS_CONTROL_C_EXIT）天然不兼容。核实员补充实验证明"信号触达 handler"在共享 console + CREATE_NEW_PROCESS_GROUP 场景可自动化实证——**是现有验证集的缺口，非绝对不可测**。Rust 侧 `send-ctrl-break.ps1` 同为人工探针，属跨版同类盲区。
2. **ts-nodejs `saveDraft`/`settingsSaveFailed` 接线无单测**：`runTui` 是无参闭包不可注入、本版无 TestBackend 等价物；纯函数层（saveSettings 布尔、失败页脚文案、72×13 行数预算）各有 pin。注意接线代码本身是本次新增（HEAD 为无条件 saveSettings），属新代码带着与旧代码同等的覆盖缺口。

## 4. 机制偏差登记（low ×12，自报未复核，明天 code-reviewer 顺带复核；正式去处是 SPEC 22.7 / §22.x）

- Go：① Save failed 页脚变体 Go 原本整体缺失（SPEC 13.2 契约行有），已按 Rust 一并移植字段+生命周期；② terminalRestore 恢复序列抽为可注入 `body func()` 供单测 once-guard（生产行为不变）；③ handler 的 CTRL_C/CTRL_BREAK 分支未被真实触发观察（见 §3-1）。
- Bun：④ 注册表经 reg.exe（Rust winreg）：`reg query /v KimiPlanbarTui` 退出码 ≡ `get_raw_value().is_ok()`；⑤ runValueExists 启动期一次性 spawnSync（属 SPEC §22.3 已登记的启动探测同步类别）；⑥ writeSettingsAtomic / writeSizeEscapeIfVt 抽可注入 seam 供测试（仓库既有模式）；⑦ 72×13 回归经 renderFrame 断言（Rust 用 TestBackend），断言集逐条对应；⑧ reset 预算 runeLen（code point）≡ Rust `chars().count()`（旧 `.length` 是 UTF-16）。
- Node：⑨ reg.exe 同型语义；探针失败按"不存在"处理 → AutoStart=true 会再试一次 apply 并静默失败（Rust 直接 return），净效果一致；⑩ ⑦ 布局为行预算模型（顶锚内容+底部钉页脚）vs Rust 约束求解器，等价不变量由测试钉住（内容 12 行 + 页脚 = 13）；⑪ ⑧ 未引入 u16::MAX 钳位（TS 数组 slice 无 u16 上界；对应 Rust Suggestion 14）；⑫ ⑤ padStart 按 UTF-16 补位 vs Rust 按字符——当前输出全 ASCII 逐字节相同。

## 5. notCovered / 需真人实机验收（明天汇报时交给维护者）

- Go：CTRL_CLOSE_EVENT（关窗）无法探针自动触发——需真人双击 `dist/kpt-tui-go.exe` 后手动关窗，确认终端恢复、无残留备屏/raw 态。
- Bun：本机 Win11 26200 控制台默认输出模式已 0x7（VT 常开），"VT 未开 → conhost 回显转义"的原始故障环境不可复现；建议在旧 conhost（如 Win10）机器目检一次。
- Bun：双击/独立窗口缩窗后的 72×13 目检与双主题渲染需真机确认。
- Node：③ reconcile 与 ② 保存失败的真实端到端——真实终端 `s`→保存断言 Save failed 页脚一次。
- 通用：parity 只盖两个 headless self-check 的输出；PLAN-GO §7 人肉项不在自动化范围。

## 6. 明天的执行清单（按序）

1. **code-reviewer 子代理 ×3 并行**（用户 AGENTS.md 硬性要求，generic subagent 不能替代）：
   - 范围：`git show 1ba11fb`（go/，含新增文件与上会话第一批）、`git show 2715a6c`（ts/）、`git show e27056f`（ts-nodejs/）。
   - prompt 要点：只给需求（SPEC 章节号 + §2 的项清单 + 对应 Rust oracle 路径 `rust/src/...`）与代码路径，**以证伪为导向（假设至少存在 2 处错误），不转述作者预期**；只读评审；rust/ 是只读 oracle。
2. 修复评审发现（若有）→ 复跑 §7 门禁命令至全绿。
3. 文档同步（主会话做，勿派 subagent）：PLAN-GO 对齐小节回填状态（Go 第二批 done、TS 两版 done、Node ④ N/A 及理由、Suggestion 20 可选项仍 open）；SPEC 22.7 登记（Go SetConsoleCtrlHandler 已对齐 Rust + §4 的 12 条偏差按归属登记）；`HANDOFF.md` §12 追加一行状态。**改 PLAN-GO/SPEC/HANDOFF 前按用户偏好先问"直接改还是建副本"。**
4. 向维护者汇报：结论 + §3 发现处置 + §5 needs-human 清单；Node ④ N/A 请维护者确认。
5. 联合发版是**后续独立步骤**（版本号 bump、打包、SHA256SUMS、gh release——checklist 在 `HANDOFF.md` §12），需维护者拍板版本号取向后再动，今天不动。

## 7. 环境与命令备忘

- 工具链：go 1.27.0 / bun 1.4.2 / node 24.19.0 / gh 2.97.0 已认证；env snapshot 2026-09-26 新鲜（`~/.kimi-code/env-snapshot/`）。
- 门禁命令（Git Bash，仓库根执行）：
  `go test -C go ./...`；`go vet -C go ./...`；`gofmt -l go`（输出须为空）；`go run -C go ./scripts/parity`；
  `bun run --cwd ts test`（勿裸 `bun test`，TZ 由脚本钉）；`bun run --cwd ts parity`；
  `npm --prefix ts-nodejs test`；`npm --prefix ts-nodejs run typecheck`；`npm --prefix ts-nodejs run parity`。
- parity oracle = `rust/target/debug/kimi-planbar-tui.exe`（已验证含 1779e33 全部修复，二进制含 "q Quit" 页脚字符串）；`dist/kimi-planbar-tui-0.1.1-g1779e33.exe` 是 release 打包副本（20:49），日常 parity 不用它。
- 若再用 workflow 的 `world.run`：npm/bun shim 会 spawn ENOENT——bun 用全路径 `C:\Users\rexxa\AppData\Roaming\npm\node_modules\bun\bin\bun.exe`；npm 用 `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" --prefix ts-nodejs …`；`world.run` 第一参数必须是**内联字面量**（常量也不行）。
- workflow run 记录同项目任意会话可查：`ListWorkflowRuns` / `GetWorkflowRun("dwfrun-1dadbeae-e573-4e4f-b465-a3890febd404")`；报告/看板 artifact 卡片在 run 页面保留。
- `.zcodeignore` 已存在（上批会话建的，未跟踪）。
