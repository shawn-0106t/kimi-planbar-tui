# TS 版实现差异条文（SPEC-TS-DIFF）

> 定位：`docs/SPEC.md` 是两版共享的唯一权威行为契约；本文件只登记 **TS 版（Bun + OpenTUI）实现层面与 Rust 版不等价的机制**，按 SPEC 章节号归档，避免把主 SPEC 改成一版一份。
> 结论来源：M1 阶段的实测与 Rust oracle（`ts/test/parity/make-oracle.ts` → `ts/test/golden/`），全部条目都有测试锁定。
> 状态：M1（core 层）已实现并逐字节验证；渲染层条文随 M2 补入。

## 1. 验证方法（对应 SPEC 7.2 / 19）

- **`--test-fetch` 字节 parity 契约**：两版输出除 `fetchedAt` 的**值**以外必须逐字节相同。该字段是唯一豁免项——Rust 用 100 ns 精度的系统时钟、chrono 固定打印 9 位小数，JS `Date` 只有毫秒。比对时两侧都归一化为 `"fetchedAt": "<NOW>"`（`ts/test/parity/diff.ts` 实现）。
- **两套证据**：
  1. **Rust oracle golden**（纯解析与文本格式）：临时 cargo 工程原样复用 `rust/src/quota.rs` 的 DTO 与解析函数，产出 `ts/test/golden/`（浮点文本表、chrono 时间戳表、`from_str` 矩阵、30 个 `QuotaResult` 文档、`settings.json` 文档）。TS 测试对 golden 做**全等**断言。
  2. **同机背靠背**（含真实网络）：`bun run parity` 跑 Rust exe 与 TS 自检各两遍并 diff。M1 收口时实测：`--test-fetch` 19 行全等、`--test-update` 1 行全等（成功路径，非 `no-token` 分支）。
- `bun test` 用 `TZ=Asia/Shanghai`（见 `ts/package.json`）：golden 里的时间戳是 `DateTime<Local>`，换时区需重新生成 golden。

## 2. 数据与 API（对应 SPEC 16.2 / 16.3 / 16.4）

| Rust 机制 | TS 等价实现 | 锁定点 |
|---|---|---|
| `str::parse::<f64/i64>()` | `parseF64Strict` / `parseI64Strict`（`core/json.ts`），按 Rust 语法整串匹配 | `""`、`68abc`、`0x10`、`1_000`、`1 000` → 失败；`1.`、`.5`、`1e5`、`+68`、`inf`、`NaN` → 成功；`i64` 不接受小数与指数；越界即失败 |
| `str::trim()` | `rustTrim`，Unicode White_Space 集：**含 U+0085、不含 U+FEFF**（JS 原生 `trim()` 恰好相反） | golden `parse_matrix` |
| `serde_json::Number::as_i64()` | `jAsI64`：只有**整数形态的 number token** 才有值，`1.0` / `1e5` / `-0.0` 一律视为无值 | golden `as_i64` |
| `i64` 范围 | 全程 `bigint`（`balanceCents`、`monthlyUsedCents`、`monthlyLimitCents`、`(raw+500000)/1000000`），整除截断与 `saturating_add` 精确 | `quota.test.ts` |
| `f64` 文本 | `formatF64`：serde_json/ryu 形态——恒带小数点或指数；十进制指数 ∈ [-5,15] 用定点，否则 `1e+16` / `1e-7` 形态；`-0.0` 保号；非有限值由序列化器写 `null` | golden `floats` + `float_grid` |
| `chrono` 的 `DateTime<Local>` 文本 | `RustDateTime{ms,nanos}` + `autoSiFraction`：小数位为 9 位文本按整组 `000` 从右剥离（`.500000000`→`.500`），零则完全省略；偏移恒为 `±HH:MM`，绝不出现 `Z` | golden `datetime` + `reset_time` |
| `resp.json()` 失败 | 自带严格 JSON 解析器（`parseJsonValue`）：`1e400` 触发 `number out of range` → `JsonException`；非 2xx 不读 body；headers 之后的 body 超时同样归 `JsonException` | `quota.test.ts` |
| 数值精度 | 超过 2^53 的 JSON 整数字面量：TS 用 token 走 `BigInt` 保持精确；`as_f64` 侧与 Rust 同为 double，无额外偏差 | — |

## 3. 设置与系统集成（对应 SPEC 18.1 / 18.2 / 18.3）

- **`current_exe()` 的等价物是 `process.execPath`**：`bun run src/main.ts` 下它是 `bun.exe`，`bun build --compile` 产物下才是 `kpt-tui.exe`。因此 **便携模式与开机自启只对编译产物有意义**；开发模式下 `portable.dat` 会被去 Bun 安装目录找，自启值会写成 bun.exe 的路径。Rust 版无此歧义。
- `settings.json` 写入与 Rust 完全同字节：PascalCase、2-space 缩进、**无尾随换行**；读取遵循「整体失败回落默认、仅缺键才逐键默认」。M1 用机器上由 Rust 版写的真实文件做了字节回归断言。
- 注册表一律 `spawn reg.exe` 并按 **GBK** 解码；自启仍只做写/删、不回读。`AppsUseLightTheme` 取 `REG_DWORD` 文本（`0x0`/`0x1`），任何异常 → light，与 Rust 的 `unwrap_or(1)` 同义。
- 主题解析保持纯函数：`effectiveTheme(configured, system)`，系统值由 30 s 轮询写进缓存，渲染路径同步读取（Rust 在事件循环里同样是轮询）。

## 4. 版本检查（对应 SPEC 17.1 / 17.2）

- changelog 的 Range 请求必须带 **`Accept-Encoding: identity`**：GitHub Pages 返回 206 + gzip 时 Bun 解压分片会抛 `ZlibError`。Rust 的 reqwest 不受影响。
- 本机 ESET 做 TLS 拦截、其根证书不在 Bun 自带的 Mozilla CA 库内 → 跑 GitHub API 兜底需要运行时 **`--use-system-ca`**（已写进 `ts/package.json` 的脚本）。`bun build --compile` 产物如何固化该开关仍是 M4 开放问题；`moonshotai.github.io` 与 `api.kimi.com` 不受拦截，故主路径不依赖它。
- `kimi --version` 经 `Bun.spawn`（实测不走 shell 即可拿到版本号），5 s 超时后 `kill()`，stdout+stderr 按此顺序 lossy 拼接后取首个 `\d+\.\d+\.\d+`。

## 5. 配色与渲染层（对应 SPEC 11.1，M2 补全其余条文）

- SPEC 11.1 列十色，`rust/src/theme.rs` 的 `Palette` 只有九槽（`card_bg` 仅存在于规格），TS 同样实现九槽。
- 选中态文字：Rust 走 crossterm `Color::White` → SGR `37`（终端调色板白），TS/OpenTUI 的 `"white"` 解析为 `#FFFFFF`（实测 `rgba(1,1,1,1)`）。SPEC 字面写的是 `#FFFFFF`，故 TS 与 SPEC 一致、与 Rust 实际字节不一致——观感差异仅在用户自定义终端白时可见。
- OpenTUI 能力实测结论（格宽、per-span bg、硬裁剪、键事件、resize 崩溃、就地改内容不重绘等）见 `docs/TS-EDITION-PLAN.md` §2.6；M2 落渲染层后在此登记最终采用的渲染适配器与残余偏差。

## 6. 无单实例互斥、启动缩窗（对应 SPEC 20）

缩窗守卫的替代实现（终端环境变量启发式）属 M3，实测结论未出，此处暂不登记条文。
