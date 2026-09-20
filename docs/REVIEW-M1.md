# M1 代码审查清单（TS core 层）

> 审查对象：commit `b0e168c..13d37e4` 引入的 `ts/src/core/*`、`ts/src/main.ts`、`ts/test/*`。
> 方法：两个独立 code-reviewer subagent 各审一轮（① 1:1 parity 正确性 ② 安全与健壮性），只读、以证伪为导向，两边都自行重跑了验收命令。
> 结论：**无 Blocker**；5 个 Major、7 个 Minor。
> 验收基线（审查时实测）：`bun run test` 全绿、`bun run parity` 与 Rust exe 逐字节一致。
> **修复时机：M2 渲染层完整构建之后**（用户决定，避免与并行 WIP 同树踩踏）。
> **修复原则：能对齐 Rust 行为的全对齐 Rust**；只有物理上不可能对齐的（如 `setTimeout` 的 32 位上限）才做 TS 侧收敛，并在 SPEC 第 22 章补一条条文。（本文成文于 SPEC-TS-DIFF.md 时代；该文件已并入 SPEC 第 22 章。）

## Major（进 M3 前应全部关闭）

### A. `refreshMinutes` 过大 → `setTimeout` 溢出 → 带 token 的 HTTP 热循环
- 位置：`ts/src/core/polling.ts` `periodMs()` + `ts/src/core/settings.ts` `parseSettingsJson`
- 触发：`settings.json` 里 `RefreshMinutes` ≥ 35792（例：把秒当分钟误填 `30000`，或手填 i64 内的任意大数）→ `max(1,minutes)*60_000` 超过 `2^31-1` ms → Bun 打 `TimeoutOverflowWarning` 并把延迟**改成 1 ms** → tick → fetch → 再 1 ms re-arm，无限紧循环刷 `api.kimi.com`（每次都带用户 token）。Rust 侧 `tokio::time::sleep` 是正常长眠，行为分叉。
- 修法方向：`periodMs()` 结果 clamp 到 `2_147_483_647`（保持 Rust「大数=长眠」的语义方向），**不要**在 load 时把 `refreshMinutes` 校验进 {1,5,10,30} 枚举——Rust 不做该校验，加了就破坏 `settings.json` 跨版本等价。补一条 polling 单测：`refreshMinutes = 9223372036854775807` 时不产生 1 ms 排程。

### B. skills 扫描整文件读入，违背 Rust 的 4 KiB 上限
- 位置：`ts/src/core/skills.ts` `readFileBytes` / `collectSkills`
- 问题：`readFileSync(path)` 全量读盘，`parseFrontmatterFromBytes` 的 4096 截断发生在**读完之后**。Rust 原件 `rust/src/skills.rs:40` 用 `f.take(4096).read_to_end`，物理上只读 4 KiB。被扫的三个根目录含 `<kimi>/plugins/managed/<plugin>/skills`（第三方内容），放一个数百 MB 的 `SKILL.md` 即可打爆仪表盘内存。也说明差异登记里「1:1 移植」的说法在这点上不成立。
- 修法：`openSync` + `readSync(fd, buf, 0, 4096, 0)` 镜像 `take(4096)`；加一个「大文件只读前 4 KiB」的用例（可用稀疏文件或直接断言读取字节数）。

### C. 畸形时间被 `Date.UTC` 静默进位，chrono 会拒绝
- 位置：`ts/src/core/quota.ts` `instantOf()`
- 实测：`parseResetTime("2030-01-01T00:61:00+08:00")` → TS 有值（61 分进位成次日 01:01）；`"…T00:00:00+0899"` → TS 有值（偏移分 99 被算成 +09:39）。Rust 的 `parse_from_rfc3339` 与格式阶梯对分/秒 ≥60、偏移分 ≥60 一律 `None` → `resetAt: null`。后果：服务端字段畸形时 TS 显示一个貌似合理的错误倒计时，Rust 隐藏该字段。
- 修法：`instantOf` 除日期外再校验 `getUTCHours()/getUTCMinutes()/getUTCSeconds()` 与输入一致，且偏移分钟 `< 60`；失败则落到下一阶梯或 `null`。补 golden 驱动的畸形时间用例（让 oracle 也跑一遍这些串，拿权威答案）。

### D. 恒真断言：U+FFFD 字面量在写盘时丢了
- 位置：`ts/test/skills.test.ts:60`（`expect(gbkSkill?.description.includes("")).toBe(true)`）
- 问题：对应 Rust 的 `assert!(gbk.description.contains('\u{fffd}'))`。引号之间实际是空串 → 对任何内容都为真，**「GBK 字节有损解码为 U+FFFD」这条行为其实完全没被验证**。这是本轮「测试是否真在断言」方向唯一命中的实例（且是作者侧工具链把不可见字符写丢造成的，教训：断言里的不可见字符一律写转义）。
- 修法：改成 `includes("\uFFFD")`。同类风险点自查：`json.test.ts` / `credentials.test.ts` / `skills.test.ts` 里所有含 BOM、NEL、U+FFFD 的字面量，一并换成 `\u` 转义。

### E. 跨版本比对会被裸 `return` 静默跳过
- 位置：`ts/test/parity.test.ts`（live-token 判定、`existsSync(RUST_EXE)` 判定，约 :65/:70/:90）
- 问题：换一台机器（有 token 或没有 debug build）时，该文件的跨版本断言整段不执行却依然全绿；而 `test/parity/diff.ts` 在缺 Rust build 时是 `exit(2)` 的——两处标准不一。
- 修法：no-token 分支改为构造性断言（`fetchQuota({token:null})` → `quotaResultToSerde` 直接对 golden 比对），不依赖本机凭证；依赖外部 exe 的用例改为显式 `test.skip` 或打 `console.warn`，让跳过可见。

## Minor（顺手可修，或按需登记为已知差异）

1. `ts/src/core/json.ts` `parseJsonValue` 无递归深度上限；serde_json 默认 128 层即报错 → 敌意深嵌套响应在 TS 判成功、Rust 判 `JsonException`，敌意输入下 parity 破裂。修法：加 depth 计数，>128 抛 `RustJsonError`。
2. `ts/src/core/quota.ts` 非 2xx 不消费 body 就返回 → keep-alive 连接不回池，30 s 一次的重试可能堆 socket。修法：返回前 `void response.arrayBuffer().catch(() => {})`。（Rust reqwest 会丢弃连接，属机制差异，可与第 1 条一起在 SPEC 第 22 章记一笔。）
3. `ts/src/core/json.ts` `localizeNaiveSingle` 是死代码（逻辑在 `quota.ts` 内联了一份），且与 Rust 的 `.single()` 语义并不一致。修法：删掉或在 `quota.ts` 复用它。
4. `ts/src/core/quota.ts` resetTime 正则与 chrono 阶梯双向不重合：naive 路径接受小写 `t`（chrono 字面量 `T` 大小写敏感）；时间项与偏移间只允许 0–1 个空格（chrono 的空白字面量匹配 0 个或多个）。修法：naive 改 `[T ]`、空格改宽松匹配，或登记为可接受形状。
5. `ts/src/core/settings.ts` `Number(bigint)` 往返：`RefreshMinutes: 9223372036854775807` 回写会变 `…808`（Rust 精确保留）。修法：内部保留 bigint，或 clamp 后序列化；现有测试因 JS 字面量同样舍入而没暴露。
6. catch 全为裸 `catch {}`（`quota.ts` / `update.ts` / `theme.ts` / `settings.ts` / `credentials.ts`）：`TypeError` 会被归类成 `HttpRequestException` 之类的 IO 失败，排障时无法区分编程错误与真实网络故障。SPEC 要求静默，故保留行为，但可在 catch 内对非网络异常 `console.error` 到 stderr（不污染 stdout 的逐字节比对）。
7. `ts/test/settings.test.ts` / `ts/test/skills.test.ts` 的临时目录只在成功路径清理；`credentials.test.ts` 已有 `afterEach` 模式，照搬即可。另 `ts/test/parity/make-oracle.ts` 的 `%TEMP%\kpt-oracle` 是固定名，并行再生 golden 会互相踩踏，加随机后缀。

## 已核对通过（不必重做）

- **quota 主解析**：`isEnabled===false` / `monthlyChargeLimitEnabled===true` 严格布尔、`fillMissingFrom` 只补三字段、`parseSegment` 的 `limit<=0` 钳位且 NaN 放行后 percent 归零、四种错误归类（含「headers 到达后的 body 超时算 `JsonException`」与 reqwest `.json()` 语义一致）。
- **credentials**：config.toml 的节结算时机（新节开启时 + EOF）、首个匹配即返回、`[[…]]` 与 `[providers."a:b"]` 剥括号、同节重复键后者胜、严格 UTF-8 读。
- **settings**：「任一键类型错→整体默认」vs「仅缺键→逐键默认」、未知键忽略、重复键留后值、`reg.exe` argv 引号形状。
- **json 文本层**：serde pretty 转义表、`formatF64` 定点/科学边界与 `-0.0`、AutoSi 三位组剥离、Rust White_Space 集、`lines`/`runes`/`trim_matches`、`parseF64Strict` 饱和到 ±inf。
- **golden 完整性**：`goldenPairs` 抽取数与 golden 内 tuple 数一致（floats 19/19、float_grid 85/85、datetime 6/6）；31 个 quota golden 全部有对应 payload 或显式构造分支；TZ 守卫是 throw（不会假绿）。
- **theme / skills / format / update / polling**：调色板字节一致、frontmatter 栅栏与引号剥离顺序、`rustRound` 半数远离零、formatReset 阶梯、changelog `Range` + `Accept-Encoding: identity`、2s/30s/周期与 reschedule 排干 stale hint。skills 排序仅在非 BMP 名称上有 UTF-16 与码点序的理论差异。
- **安全面**：token 只在内存里进 `Authorization` 头、发往常量端点；`--test-fetch` 输出不含 token；golden 与测试 fixture 无真实凭证残留；spawn 全走 argv 数组不经 shell；只写 HKCU；路径条目名无法穿越；正则均线性无回溯爆炸。
- 两条验收硬指标由审查者本人重跑通过（非采信作者声明）。

## 修复状态回填（2026-09-20 实测，非采信声明）

> 验收基线（本轮在当前工作树实测）：`bun run test` **262 pass / 0 fail**；`bun run parity` 与 `rust/target/debug` exe 逐字节一致。注意 `--test-fetch` 的行数取决于本机凭证：有 live token 时为成功路径 19 行，凭证过期/缺失时为 `no-token` 分支 7 行——两者都与 Rust 逐字节一致，换机器复跑时不要把它当成 parity 破裂。

| 条目 | 状态 | 实测位置 |
|---|---|---|
| Major A（setTimeout 溢出） | 已修 | `ts/src/core/polling.ts:13,46` clamp 到 `TIMEOUT_MAX_MS = 2_147_483_647`；新增 `ts/test/polling.test.ts` 上限用例。原建议以 `9223372036854775807` 为输入，现 settings 层已先把 2^53 之外的值钳到 `MAX_SAFE_INTEGER`（Minor 5），故用例改用后者 |
| Major B（skills 整文件读入） | 已修（测试覆盖有边界，见右） | `ts/src/core/skills.ts:113-126` `openSync` + `readSync(fd, buf, 0, 4096, 0)` + `finally closeSync`。测试只钉到「文件路径与解析器在 4 KiB 窗口上一致」（`ts/test/skills.test.ts:99-113`，本轮新增文件路径版）；**物理读上限本身无法经公开 API 观测**——`parseFrontmatterFromBytes` 内部同样在 4096 截断，全量读与钳位读结果不可区分，故那一半属内存安全属性，仅代码审查确认 |
| Major C（畸形时间静默进位） | 已修 | `ts/src/core/quota.ts:145-159` 六字段 UTC 回校验、`:183-190` naive 分支同法、`:172` 偏移分 <60 且总偏移 <24 h；golden `ts/test/golden/reset_time.txt:13`（`2030-13-45T00:00:00+08:00\|None`）。原建议的「让 oracle 也跑畸形串」已收口：`ts/test/parity/make-oracle.ts` 扩到 16 例并实跑 Rust 本体 |
| Major D（恒真断言） | 已修 | `ts/test/skills.test.ts:65` → `includes("\uFFFD")` |
| Major E（裸 return 假绿） | 已修 | `ts/test/parity.test.ts` 三处改为声明期求值的 `test.skipIf` / `test.skip`（跳过会计数）。另：E 建议的「构造性断言」其实早已存在——`ts/test/quota.test.ts:197-201` 对 `quota-error-*` golden 直接构造 `QuotaResult` 比对，不依赖本机凭证 |
| Minor 1（JSON 深度上限） | 已修 + 本轮补测 | `ts/src/core/json.ts:384,400-406` `MAX_DEPTH = 128`；新增 `ts/test/json.test.ts` 「128 层通过 / 129 层抛 `RustJsonError`」 |
| Minor 2（非 2xx 不排空 body） | 已修 + 已登记 | `ts/src/core/quota.ts:287-291` 排空；SPEC 22.2 表格行已改写为「排空」，测试同步更新 |
| Minor 3（`localizeNaiveSingle` 死代码） | 已修 | 该符号已从工作树移除，逻辑内联于 `ts/src/core/quota.ts:183-190` |
| Minor 4（resetTime 正则与 chrono 不重合） | 已修（oracle 实测收口） | 用 `ts/test/parity/make-oracle.ts` 扩到 16 个边界输入实跑 Rust 本体取权威判定，分两轮修掉两处 TS 偏窄/偏宽：① 粘连日期 `2030-01-0100:00:00` Rust 接受而 TS 拒绝 → `NAIVE` 分隔由 ` +` 改 ` *`；② 小写 `t` 的接受集 TS 比 chrono 宽（`t…+0800`、`t… +08:00` Rust 均 None）→ `WITH_OFFSET` 拆成 `RFC3339_STRICT`（允许 `t`，但偏移须带冒号且前无空格）+ `WITH_OFFSET`（只认大写 `T`/空格，允许紧凑偏移与任意空白），先试前者。golden `reset_time.txt` 由 13 行扩到 29 行，`ts/test/quota.test.ts:88` 的 ladder 测试逐行比对全绿 |
| Minor 5（`Number(bigint)` 往返失真） | 已修 + 已登记 | `ts/src/core/settings.ts:52-59,86-91` i64 判定走 `BigInt`、取值钳到 `MAX_SAFE_INTEGER`；SPEC 22.3 新增条文（含与 Rust `saturating_mul(60)` 的轮询差异）；测试改为断言钳位，并保留「越出 i64 → 整体回落」 |
| Minor 6（裸 `catch {}`） | 维持不修 | 按 SPEC 静默基调保留行为，与原结论一致 |
| Minor 7（临时目录 / oracle 固定名） | 已修（credentials 本就正确） | `settings/skills.test.ts` 改为本轮新增的唯一命名 + `afterEach` 清理；`credentials.test.ts` 的 `afterEach` 模式早已存在（本轮未改，是照搬的来源，不计入本轮修复）；`ts/test/parity/make-oracle.ts:15` 随机后缀 + `KPT_ORACLE_DIR` 兜底（本轮实跑三次，目录名各不相同） |

## 后续 tui 层审查（C-1）的关联结论

C-1「Ctrl+C 在真实控制台失效」经真终端实测**无法按原方案修复**：Bun 运行时会吞掉 console control event——裸 bun 进程（不改 console mode、不注册 handler、不读 stdin）对 Ctrl+C 无反应，而同一 WT 1.24 窗口、同一注入方式下 Rust 版（crossterm）正常退出；OpenTUI 的解析器对 `0x03` 能正确产出 `{name:"c",ctrl:true}`，说明丢失发生在 Bun 侧。`ENABLE_PROCESSED_INPUT` 置位与清零两条路都实测过，均到不了 JS 层。故已登记为 Bun 版限制（SPEC 22.6），**Bun 版退出键以 `q` 为准**；`console.ts` 的清零保留（与 crossterm 对齐，且让 Ctrl+B/Ctrl+H 以字节送达），`app.ts` 的 SIGINT/SIGBREAK handler 保留作未来兜底。复现脚本：`ts/scripts/verify/`。
