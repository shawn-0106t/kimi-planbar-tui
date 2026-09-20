# M1 代码审查清单（TS core 层）

> 审查对象：commit `b0e168c..13d37e4` 引入的 `ts/src/core/*`、`ts/src/main.ts`、`ts/test/*`。
> 方法：两个独立 code-reviewer subagent 各审一轮（① 1:1 parity 正确性 ② 安全与健壮性），只读、以证伪为导向，两边都自行重跑了验收命令。
> 结论：**无 Blocker**；5 个 Major、7 个 Minor。
> 验收基线（审查时实测）：`bun run test` 全绿、`bun run parity` 与 Rust exe 逐字节一致。
> **修复时机：M2 渲染层完整构建之后**（用户决定，避免与并行 WIP 同树踩踏）。
> **修复原则：能对齐 Rust 行为的全对齐 Rust**；只有物理上不可能对齐的（如 `setTimeout` 的 32 位上限）才做 TS 侧收敛，并在 `docs/SPEC-TS-DIFF.md` 补一条条文。

## Major（进 M3 前应全部关闭）

### A. `refreshMinutes` 过大 → `setTimeout` 溢出 → 带 token 的 HTTP 热循环
- 位置：`ts/src/core/polling.ts` `periodMs()` + `ts/src/core/settings.ts` `parseSettingsJson`
- 触发：`settings.json` 里 `RefreshMinutes` ≥ 35792（例：把秒当分钟误填 `30000`，或手填 i64 内的任意大数）→ `max(1,minutes)*60_000` 超过 `2^31-1` ms → Bun 打 `TimeoutOverflowWarning` 并把延迟**改成 1 ms** → tick → fetch → 再 1 ms re-arm，无限紧循环刷 `api.kimi.com`（每次都带用户 token）。Rust 侧 `tokio::time::sleep` 是正常长眠，行为分叉。
- 修法方向：`periodMs()` 结果 clamp 到 `2_147_483_647`（保持 Rust「大数=长眠」的语义方向），**不要**在 load 时把 `refreshMinutes` 校验进 {1,5,10,30} 枚举——Rust 不做该校验，加了就破坏 `settings.json` 跨版本等价。补一条 polling 单测：`refreshMinutes = 9223372036854775807` 时不产生 1 ms 排程。

### B. skills 扫描整文件读入，违背 Rust 的 4 KiB 上限
- 位置：`ts/src/core/skills.ts` `readFileBytes` / `collectSkills`
- 问题：`readFileSync(path)` 全量读盘，`parseFrontmatterFromBytes` 的 4096 截断发生在**读完之后**。Rust 原件 `rust/src/skills.rs:40` 用 `f.take(4096).read_to_end`，物理上只读 4 KiB。被扫的三个根目录含 `<kimi>/plugins/managed/<plugin>/skills`（第三方内容），放一个数百 MB 的 `SKILL.md` 即可打爆仪表盘内存。也说明 SPEC-TS-DIFF 里「1:1 移植」的说法在这点上不成立。
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
2. `ts/src/core/quota.ts` 非 2xx 不消费 body 就返回 → keep-alive 连接不回池，30 s 一次的重试可能堆 socket。修法：返回前 `void response.arrayBuffer().catch(() => {})`。（Rust reqwest 会丢弃连接，属机制差异，可与第 1 条一起在 SPEC-TS-DIFF 记一笔。）
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
