# PLAN-GO — Go 版（`go/`）开发计划

> 日期：2026-09-25 · 状态：**进行中**（M0/M1/M2 已于 2026-09-25 完成：Go 1.27.0 装机、`go/` 脚手架、core 10 模块 + 99 测试全绿、自检 parity 双分支逐字节一致；**M3 TUI 层已于 2026-09-26 完成**，134 测试全绿；M4 Win32 集成待执行。计划成文时仓库尚无 Go 代码，现以 `go/` 目录为准）
> 决策来源：`HANDOFF.md` §11（2026-09-25 用户拍板：Go + bubbletea v2 / lipgloss，第四实现，目录 `go/`，版本号独立）
> 行为契约：`docs/SPEC.md`（唯一权威）；本计划不改契约，落地时按 §9 清单同步文档

---

## 0. 执行者须知（先读这些，再动手）

按顺序阅读，读完后应能复述 SPEC 16.3 的单位陷阱与 SPEC 20 的终端恢复纪律：

1. `AGENTS.md`（仓库根）——结构、命令、陷阱总表
2. `docs/SPEC.md`——重点第 3、7、11–13、16–22 章；**改行为必须先查第二篇对应章节**
3. `HANDOFF.md` §11（Go 版决策记录）与全文（2026-09-25 segfault 事故：270 测试全绿仍在独占 console 闪退——**自动化测试够不到的分支必须人肉验收**，这是本计划 DoD 的核心教训）
4. `docs/REVIEW-M1.md`——TS core 层 5 Major + 7 Minor 审查台账；Go 版 core 必须**从第一天就含这些修复语义**，不得移植"修复前"的行为
5. 参考实现优先级：语义歧义时以 `rust/src/` 为准；防御性解析的最完整可执行描述在 `ts/src/core/json.ts`（serde 语义的显式复刻，比 Rust 源码更适合当移植底本）

硬规则（违反即返工）：

- 代码、注释、commit message 用英文；`SPEC x.y` 注释引用保持准确
- 所有 IO / 注册表 / 子进程 / HTTP 失败**静默吞掉**，只经 UI 文案或状态字段表达；绝不 panic、绝不打断 TUI（SPEC 20）
- 不建单实例互斥锁（SPEC 20）；不启用鼠标（SPEC 12.7 无鼠标定义）；不引 YAML 库；无遥测；不提交二进制
- token 只读、只进 `Authorization: Bearer` 发往 `https://api.kimi.com/coding/v1/usages`，不打印、不持久化、不发往其他端点

---

## 1. 定位与目标

Go 版是仓库第四个受支持实现，与 Rust / Node / Bun 版共享同一行为契约（`docs/SPEC.md`），版本号独立（从 0.1.0 起步，唯一来源见 §6.4）。SPEC 第 22 章为其新开登记小节（暂定 **22.7**）。

选型（已定，不再议）：**Go + bubbletea v2 + lipgloss**。依据（HANDOFF §11 调研）：bubbletea v2.0.10 stable、Charm 一线维护 Windows 支持；单文件 exe 8–15 MB、`CGO_ENABLED=0` 交叉编译零配置；Win32 需求在 Go 生态有类型安全的一等包（`golang.org/x/sys/windows`），bun:ffi 那类"指针当值传"的陷阱在 Go 里由类型系统消灭。

关键映射直觉：bubbletea 的 Model/Update/View 天然等价于 Rust 版的「`tokio::select!` 事件循环 + 事件驱动重绘」——每个 Msg 触发 Update 后立即重绘，无需自行拼装事件泵；250 ms 心跳与 30 s 主题轮询用 `tea.Tick`，异步任务（配额拉取、版本检查、skills 扫描）用 `tea.Cmd`。

---

## 2. M0：环境与脚手架（约 0.5 天）

> ✅ **2026-09-25 已完成**。落地实况：winget 装机 `go1.27.0 windows/amd64`（满足 bubbletea v2.0.10 的最低要求）；本机 `proxy.golang.org` 不可达，用户级 `go env -w GOPROXY=https://goproxy.cn,direct`；import path 实证为 `charm.land/bubbletea/v2@v2.0.10` + `charm.land/lipgloss/v2@v2.0.6`（与 §11 HANDOFF 调研一致），`x/sys@v0.48.0`、`go-runewidth@v0.0.30`、`goversioninfo@v1.7.0`（经 `go.mod` 的 `tool` 指令固定，`go tool goversioninfo` 可调）。`go build ./...` / `go vet ./...` 全过、空壳 exe 冒烟退出码 0；env-snapshot 已重盘（`环境依赖清单_2026-09-25.md`）。注意：依赖当前以 `// indirect` 钉在 go.mod，M1 导入后 `go mod tidy` 自动转正。

1. **安装 Go 工具链**：本机当前无 Go（`go: command not found`；`C:\Users\rexxa\.kimi-code\env-snapshot\环境依赖清单_2026-09-19.md` 亦记录"Go：未安装"）。用 winget 安装最新 stable，装完按用户全局规则用 system-software-inventory skill 重新盘点快照。安装后核对 bubbletea v2 锁定版本的 `go.mod` 对 Go 的最低版本要求，不满足则升级。
2. **脚手架**：
   - `go/go.mod`：module path 用 `github.com/shawn-0106t/kimi-planbar-tui/go`（与 `git remote -v` 一致）
   - 依赖（`go get` 并提交 `go.sum`，版本钉死）：
     - `charmbracelet/bubbletea` **v2**（import path 以 kickoff 时官方 README 为准——v2 时代可能为 `charm.land/bubbletea/v2`，HANDOFF 调研记录为 v2.0.10）
     - `charmbracelet/lipgloss` 与所钉 bubbletea v2 配套的 major 版本
     - `golang.org/x/sys`（registry、console Win32 API）
     - `mattn/go-runewidth`（East Asian Width 格宽，lipgloss 同源）
     - `josephspurrier/goversioninfo`（仅构建期，生成 VERSIONINFO + 图标 `.syso`）
   - `go/VERSION`：内容 `0.1.0`（版本号唯一来源，见 §6.4）
   - `go/main.go` 空壳 + `go/internal/{core,tui}/` 包骨架
   - 根 `.gitignore` 追加：`go/dist/`、`go/*.syso`
3. DoD：`cd go && go build ./...` 通过、`go vet ./...` 0 问题、空壳 exe 能跑。

---

## 3. 目录布局与模块映射

镜像 `rust/` 的单 crate 扁平布局（不搞 `cmd/` 多层嵌套，与仓库既有风格一致）：

```
go/
├── go.mod / go.sum / VERSION
├── main.go                     # 入口；--test-fetch / --test-update 自检先执行并退出
├── buildinfo.json              # goversioninfo 输入（VERSIONINFO + 图标元数据）
├── assets/icon.ico             # 从 rust/assets/icon.ico 复制（Kimi logo，NOTICE 归属不变）
├── scripts/
│   ├── build-exe.ps1 或 .sh    # release 构建（§6.4）
│   └── parity/main.go          # parity 工具（§5.2）
├── testdata/golden/            # 自 ts/test/golden 复制的全套 golden（§5.1）
└── internal/
    ├── core/                   # UI 无关 10 模块 + 防御性 JSON；禁止 import tui 包
    │   ├── credentials.go      # ← rust/src/credentials.rs (101 行)
    │   ├── quota.go            # ← rust/src/quota.rs (367)
    │   ├── json.go             # ← ts/src/core/json.ts（防御层最完整底本）
    │   ├── polling.go          # ← rust/src/polling.rs (72)
    │   ├── settings.go         # ← rust/src/settings.rs (85)
    │   ├── skills.go           # ← rust/src/skills.rs (219)
    │   ├── update.go           # ← rust/src/update.rs (117)
    │   ├── theme.go            # ← rust/src/theme.rs (98)
    │   ├── state.go            # ← rust/src/state.rs (47)
    │   └── format.go           # ← rust/src/format.rs (71)
    └── tui/                    # bubbletea 渲染层，与 core 严格分层
        ├── app.go              # ← rust/src/app.rs (552)：Model/Update/View、按键路由
        ├── dashboard.go        # ← rust/src/ui/dashboard.rs (227)
        ├── settingsview.go     # ← rust/src/ui/settings_view.rs (134)
        ├── skillsview.go       # ← rust/src/ui/skills_view.rs (116)
        ├── line.go             # ← ts/src/tui/line.ts：EAW 格宽裁剪 + sanitize 关卡
        └── shrink.go           # ← rust/src/app.rs 缩窗段 + ts/src/tui/shrink.ts
```

规模估算：core 约 1.6–2.2k 行，tui 约 0.8–1.1k 行，测试约 1.2–1.8k 行（含 golden 断言）。

---

## 4. 关键技术决策（落地后逐条登记进 SPEC 22.7）

每条都标注了与 Rust 基准的关系；**凡与 Rust 不等价的机制，必须进 SPEC 22.7 并写明锁定测试**。

### 4.1 JSON 与文本 parity（M1 最大难点，HANDOFF §11 已预警）

Go 的 `encoding/json` ≠ serde_json。自检输出须与 Rust exe 逐字节一致（唯一豁免 `fetchedAt` 的值，SPEC 22.1）。逐条要求：

- **防御性解析镜像 `ts/src/core/json.ts`**（不是镜像 serde 源码）：`parseF64Strict` / `parseI64Strict`（Rust `str::parse` 语法整串匹配：`""`/`68abc`/`0x10`/`1_000` 失败，`1.`/`.5`/`1e5`/`+68`/`inf`/`NaN` 成功；i64 拒小数与指数、越界即失败）、`rustTrim`（Unicode White_Space 集，含 U+0085、不含 U+FEFF）、`jAsI64`（只有整数形态 number token 有值，`1.0`/`1e5`/`-0.0` 无值）。
- **深度上限 128 层**（serde 默认）：`encoding/json` 解码后自行 walk 计数，>128 → `JsonException`（REVIEW-M1 Minor 1）。
- **JSON 字面量 `1e400` → `JsonException`**（"number out of range"）：用 `decoder.UseNumber()` 保住字面量，`strconv.ParseFloat` 返回 `ErrRange` 即判定失败。注意与字符串字段的 `parseF64Strict` 区分——后者对 `"1e400"` **饱和到 ±Inf 不报错**（Rust `str::parse` 语义）。
- **f64 文本格式 `formatF64`**：serde/ryu 形态——恒带小数点或指数；十进制指数 ∈ [-5,15] 用定点，否则 `1e+16`/`1e-7` 形态（指数**不补零**、带号）；`-0.0` 保号；非有限值序列化为 `null`。Go 的 `strconv.FormatFloat(f,'g',-1,64)` 会把指数补成两位（`1e-07`）且 `1.0` 打成 `"1"`——**不能直接用作输出**，以 `ts/src/core/json.ts` 的 `formatF64` 为算法底本移植（其输入可取 Go 的最短表记再整形）。锁定：golden `floats.txt`（19 组）+ `float_grid.txt`（85 组）全等断言。
- **`DateTime<Local>` 文本**：chrono 形态 `YYYY-MM-DDTHH:MM:SS[.fraction]±HH:MM`——小数位按 9 位文本整组 `000` 从右剥离（`.500000000`→`.500`，全零省略）；偏移恒 `±HH:MM`，绝不出现 `Z`。移植 `RustDateTime`/`autoSiFraction`。锁定：golden `datetime.txt` + `reset_time.txt`。
- **resetTime 解析阶梯**：与 chrono 接受集精确对齐（REVIEW-M1 Major C / Minor 4 的全部结论：分/秒 ≥60、偏移分 ≥60 拒绝；naive 分隔 `[T ]`、空白宽松；小写 `t` 仅 RFC3339_STRICT 分支接受且偏移须带冒号；畸形串不得被 `time.Parse` 静默进位）。Go 的 `time.Parse` 本身严格，但 naive 分支与偏移分支的组合阶梯要按 `ts/src/core/quota.ts` 的 ladder 复刻，golden `reset_time.txt`（29 行）逐行钉死。
- **自检序列化手写**：`QuotaResult` 的 pretty JSON 不用 `json.MarshalIndent` 通用反射——按固定字段顺序手工拼（camelCase、2 空格缩进、非 ASCII 不转义、无 HTML 转义），对齐 `ts` 版 `quotaResultToSerde`；`fetchedAt` 由 parity 工具归一化。`settings.json` 写入为 PascalCase、2 空格缩进、**无尾随换行**（SPEC 22.3 同字节要求）。
- **整数全程 `int64`**：Go 原生 int64 无 TS 的 2^53 失真问题——`balanceCents` 换算 `(raw + 500000) / 1000000`、saturating 语义直接对齐 Rust，**无需** SPEC 22.3 的 TS clamp 条文（在 22.7 登记"Go 与 Rust 一致、无 clamp"）。

### 4.2 Windows 系统集成（机制差异登记点）

- **注册表**：用 `golang.org/x/sys/windows/registry` 直读 Win32 API（UTF-16 → UTF-8），**不经 `reg.exe` 子进程，无 GBK 解码问题**（TS 版的 GBK 陷阱在 Go 不存在）。30 s 主题轮询因此是进程内微秒级调用，同步执行即可——不存在 TS 版"同步 spawn 阻塞事件循环"问题（22.7 登记机制差异）。`AppsUseLightTheme` 缺失/异常 → light（对齐 Rust `unwrap_or(1)`）。
- **`os.Executable()` ≡ Rust `current_exe()`**：无 TS `process.execPath` 的"开发模式下指向运行时"歧义——`go run` 场景同样指向临时 exe，便携模式与自启语义与 Rust 一致（22.7 登记）。
- **TLS 信任**：Go ≥1.18 在 Windows 走系统根证书库——ESET 类 TLS 拦截场景原生兼容，**不需要** `--use-system-ca` 类开关，无 Bun 版的编译产物降级问题（22.7 登记）。
- **启动缩窗（SPEC 20）**：判据与 Rust 完全相同——`GetConsoleProcessList` 返回恰好 1 个附加进程（独占 console）才缩；环境变量启发式仅作 Win32 不可用时的兜底；`stdout` 非 TTY 一律不缩。双通道同序：(a) `ESC[8;13;72t`（WT 1.22+；ConPTY 不透传时优雅 no-op）；(b) conhost Win32 序列：`SetConsoleWindowInfo` 缩视口 1×1 → `SetConsoleScreenBufferSize(72,13)` → `SetConsoleWindowInfo` 完整 72×13。Go 的 `x/sys/windows` 里 `SetConsoleWindowInfo` 参数就是 `*SmallRect` 指针类型——bun:ffi 那类崩溃在编译期被类型系统拦截，但仍需按 §7 触发矩阵人肉验收。
- **子进程**：`kimi --version` 用 `exec.CommandContext`（5 s 超时强杀，不走 shell，stdout+stderr 合并后取首个 `\d+\.\d+\.\d+`）；`openUrl` 用 `exec.Command("cmd","/c","start","",url)` + `SysProcAttr{HideWindow:true}`，异常静默（与 Rust 1:1 的 `start` 通道，勿改道 `explorer.exe`——HANDOFF §5-2 结案）。
- **HTTP 错误归类**（SPEC 16.4 沿用 .NET 风格名以便跨版本 diff）：连接/头部阶段超时 → `TaskCanceledException`；其他网络错误与非 2xx → `HttpRequestException`；**头部到达后的 body 读取失败/超时 → `JsonException`**（与 reqwest `.json()` 语义一致）。实现：`http.Client{Timeout: 10s}`，`Do()` 返回错误按前两类归类；`resp` 已返回时 `io.ReadAll(resp.Body)` 出错 → `JsonException`。非 2xx 时排空 body 再关闭（对齐 Bun 版 keep-alive 回池语义，Rust 为丢连接——机制差异、输出不变，22.7 登记）。
- **changelog Range 请求**：带 `Accept-Encoding: identity`（SPEC 22.4 的跨版防御措施，Go 同样保留）；GitHub API fallback 必须带 `User-Agent: KimiPlanbarTui`。

### 4.3 TUI 层（bubbletea v2）

- **事件模型**：`tea.Model` + `Update` 承载 Rust `app.rs` 的状态机；异步任务全部走 `tea.Cmd` + 自定义 Msg（quota 结果 / update 结果 / skills 结果 / theme tick）。**任何耗时操作不得阻塞 `Update`**（skills 扫描也要包成 Cmd，先出 `Scanning...` 帧——对应 Rust `spawn_blocking`）。
- **250 ms 心跳**：`tea.Tick` 循环自续，驱动倒计时文案重算（`format_reset` 输入 `reset_at - now`，每次重绘重算，无 1 Hz 定时器，SPEC 20）。Go 版无"定时器 unref 保活"问题（Go 进程不因定时器退出），22.7 一句话登记。
- **30 s 主题轮询**：`tea.Tick` + 进程内 registry 读（见 4.2），仅 `theme=system` 时生效。
- **mouse tracking**：bubbletea 默认**不**开鼠标（须显式 `tea.WithMouseCellMotion`）——不要开启，与"只读键盘 dashboard"契约一致；验收时确认启动字节流无 `?1000h/?1002h/?1003h/?1006h`。
- **整屏底色**：bubbletea/lipgloss 无 ratatui 整屏 `Block::bg` 填充——与 Bun 版同法处理：`window_bg` 作为 base bg 合成到每个无自有 bg 的 segment，每行右侧补 `window_bg` 空白铺到满宽、行间铺满高（对齐 SPEC 22.5 Bun 条目的观感）。
- **EAW 格宽**：`mattn/go-runewidth`；裁剪按码点迭代，2 格字形放不进剩余 1 格时整体丢弃（对齐 ratatui 缓冲区行为），不切断组合字符（SPEC 22.5 共有条目）。
- **sanitize 注入防线**：lipgloss 不过滤控制字符——一切外部字符串（skill 名称/描述、API 文案）进帧前过 `sanitize()`（先整段剥 ANSI 序列 CSI/OSC 等，再剥残余 C0/DEL/C1 控制符，规则与顺序同 `ts/src/tui/line.ts` / `ts-nodejs/src/tui/ansi.ts`）；关卡设在渲染入口，测试含注入用例。
- **终端恢复（最高优先级，SPEC 20）**：bubbletea 正常退出路径自带恢复；在此基础上再加与 Rust panic hook 等价的兜底：`main` 里 `defer` 恢复闭包（`recover` 后先恢复终端——离开 alternate screen、关 raw mode、显示光标——再打印退出），恢复闭包对 renderer 未就绪空值容忍；恢复处理注册**先于**终端初始化（对齐 Rust `app.rs:366-373` 与 22.5 两 TS 版纪律）。
- **Ctrl+C 双通路**：raw mode 下 `ENABLE_PROCESSED_INPUT` 被清，Ctrl+C 以 `0x03` 键事件到达（bubbletea `ctrl+c` KeyMsg）→ 路由为退出；同时保留 OS signal handler（`signal.Notify`）兜底。**真实终端实测两条通路**（对照 22.6 Bun 版漂移史——Go 不走 Bun 那条路，但实测纪律不变）；`q` 仍是首选退出键。
- **按键路由**：对齐 Rust 语义（SPEC 12.7）；注意 Rust 分发只看 KeyCode 不看 modifiers（Ctrl+R 仍命中 `r` 分支）——Go 版与 Rust 对齐，不引入 Bun 版的 Ctrl 组合忽略偏差。

### 4.4 polling 与数值饱和

- 调度语义（SPEC 16.5）：2 s 首刷；失败保留上次成功数据（只补 `five_hour`/`week`/`extra` 的空字段）；失败 30 s 快重试、成功回周期；手动刷新 2 s 防抖。
- **Duration 溢出**：Rust 用 `saturating_mul(60)`——Go 里 `time.Duration(minutes) * time.Minute` 在极端 `RefreshMinutes`（如 i64 最大值）下会 int64 溢出回绕成负数，必须自实现 saturating 换算（对齐 Rust"大数=长眠"方向；REVIEW-M1 Major A 的教训是这类溢出会变成带 token 的 HTTP 热循环）。补单测：`RefreshMinutes = math.MaxInt64` 不产生短延迟排程。Go 无 TS 的 24.8 天 setTimeout 上限——与 Rust 完全一致，22.7 登记。

---

## 5. 测试与 parity 策略

### 5.1 单元测试（M1 落地，`go test ./...`）

- **golden 复用**：把 `ts/test/golden/` 全套复制到 `go/testdata/golden/`（与 ts-nodejs 复制同一组文件的做法一致，保持各版自包含）。清单：`floats.txt`、`float_grid.txt`、`datetime.txt`、`reset_time.txt`、`parse_matrix.txt`、`as_i64.txt`、`settings-default.txt`、31 个 `quota-*.txt`。TS 测试对 golden 做全等断言——Go 版同样做**全等**断言（不做"近似"）。
- **时区固定 `Asia/Shanghai`**：golden 时间戳是 `DateTime<Local>`。Go 在 Windows 下认 `TZ` 环境变量；要求：`internal/core` 测试包的 `TestMain` 里 `os.Setenv("TZ","Asia/Shanghai")` + 重载 `time.Local`，并加一条 TZ 守卫测试（时区不对直接 fail，不假绿——对齐 TS 的 throw 守卫）。
- **用例来源**：`rust/src/` 内联单测（quota 解析：字符串/数字混排、`isEnabled=false`、单位四舍五入、除零；skills frontmatter）+ `ts/test/` 的核心套件（json 严格解析矩阵、format 阶梯、credentials 链、settings 语义、 polling 饱和）——逐条移植，含 REVIEW-M1 的全部回归用例（128/129 层深度、畸形时间、4 KiB 读取窗口、U+FFFD 断言用 `\uFFFD` 转义而非字面量）。
- **Rust 风格 lossy UTF-8**：Go 的 `range string` 对非法字节逐字节产 U+FFFD，Rust `from_utf8_lossy` 按 Unicode "maximal subpart" 归并——语义不同，需自实现 `lossyDecode()` 镜像 Rust 算法，用 GBK 字节用例钉死（skills 4 KiB 截断处切断多字节字符的场景）。
- **跳过可见**：依赖外部 exe / live token 的用例用显式 `t.Skip`（会计数），不允许裸 `return` 假绿（REVIEW-M1 Major E）。

### 5.2 跨版 parity（M2 落地）

- **Go 原生 parity 工具** `go run ./scripts/parity`：移植 `ts/test/parity/diff.ts` 逻辑——跑 `rust/target/debug/kimi-planbar-tui.exe` 与 Go exe 的 `--test-fetch` / `--test-update` 各两遍，两侧 `fetchedAt` 归一化为 `"<NOW>"` 后逐字节 diff；缺 Rust build 时 `exit(2)`；支持 `--go-exe dist/kpt-tui-go.exe` 比对 release 产物。选 Go 原生而非复用 node 版 diff.ts 的理由：Go 版自包含、不引入 Node 依赖。
- **通过标准**：成功路径 `--test-fetch` 19 行全等 + `--test-update` 1 行全等；`no-token` 分支 7 行同样全等（行数差异是凭证态，不是 parity 破裂——REVIEW-M1 回填段的经验）。
- **首刷数据真实性**：`--test-fetch` 为真实网络调用，跑 parity 前确保本机 Kimi CLI token 有效（`no-token` 时先跑一次 `kimi` 刷新）。

---

## 6. 里程碑计划（总预算参考：2–4 周业余时间，HANDOFF §11）

| 里程碑 | 内容 | DoD（验收标准） |
|---|---|---|
| **M0** 环境与脚手架 | §2 全部 | `go build ./...` / `go vet ./...` 通过；env-snapshot 重新盘点完成 |
| **M1** core 层 | §3 的 10 模块 + `json.go` + 单测（§4.1、§4.4、§5.1） | `go test ./...` 全绿（含 golden 全等、TZ 守卫）；`go vet` 0 问题 |
| **M2** 自检 + parity | `main.go` 自检分支 + 手写序列化 + parity 工具 | 与 Rust exe 背靠背逐字节一致（成功 19 行 / no-token 7 行两分支） |
| **M3** TUI 层 | §4.3 全部：三视图直译、心跳、主题轮询、sanitize、EAW | WT 双主题人工对照 SPEC 11/12/13/21；视图快照测试全绿；启动字节流无 mouse tracking 转义 |
| **M4** Win32 集成 | §4.2 全部：缩窗守卫、portable.dat、HKCU 自启、子进程、终端恢复兜底 | §7 触发矩阵四条路径全过；每条退出路径终端完整恢复 |
| **M5** 发布工程 | §6.4 构建 + §9 文档同步 | release exe 复跑 §5.2 parity + §7 人肉验收全过 |
| **M6** 交接验收 | 独立 code review（见 §8） | 审查发现清零或经用户拍板登记 |

**移植顺序纪律**（HANDOFF §11）：先 core 后 TUI；goldens 与 parity 基建在 M2 就接通，不拖到 M5——parity 是本仓库抗换栈的核心资产，越早接通返工越少。

> **落地进度（2026-09-25）**：M1 完成——`go/internal/core/` 10 模块 + `json.go` 防御层 + 102 个单测全绿（含 floats/float_grid/datetime/reset_time/parse_matrix/as_i64/settings-default + 31 个 quota golden **全等**断言、TZ 守卫、LossyDecode maximal-subpart 用例）；`go build` / `go vet` / `gofmt` 全净。M2 完成——`go/main.go` 自检分支 + `go run ./scripts/parity`（Go 原生 diff 工具，支持 `--go-exe`），对 `rust/target/debug` exe 实跑：`--test-fetch` 7 行（no-token 分支）与 `--test-update` 1 行逐字节一致；**成功路径 19 行待本机 token 刷新（跑一次 `kimi`）后复验**——31 个 quota golden 已在单测层钉死成功路径序列化，风险低。
>
> **M3 完成（2026-09-26）**：`go/internal/tui/` 五文件——`line.go`（sanitize 注入防线 + go-runewidth EAW 格宽、裁剪按码点且跨界宽字形整体丢弃、padLineToWidth 全宽铺底）、`app.go`（Model/Update/View 直译 rust/app.rs：按键路由只看 KeyCode 不看 modifiers、Ctrl+C 与 `q` 双退出、r 2 s 防抖、s/k/c/g、settings 表单 Esc 丢弃草稿、skills 跳组头滚动保选中、250 ms 心跳与 30 s 主题轮询 tea.Tick 自续、polling.Publish→prog.Send 接线、saveSettings 四步顺序）、`dashboard.go` / `settingsview.go` / `skillsview.go` 三视图逐行直译。终端恢复：bubbletea 自带 restoreTerminalState/panic 兜底，main 级再挂 `terminalRestore`（先取 stdin 状态、defer 恢复，注册先于 Run）。Win32 差异：registry 直读使主题轮询同步无阻塞（22.7 候选）、`HideWindow` 对齐 CREATE_NO_WINDOW。验证：`go test ./...` 134 测试全绿（core 102 + tui 32：三视图快照、注入用例、按键路由移植 Rust app.rs 测试、TZ 守卫）、`go vet`/`gofmt` 全净、parity 复跑双分支仍逐字节一致、隐藏 conhost 启动存活冒烟通过。**遗留**：§7-1/2/3 独占 console 缩窗属 M4；启动字节流无 mouse 转义已静态保证（View 显式 MouseModeNone，bubbletea 仅非 None 才发序列），真实终端字节级核验归 §7 人肉项；settings 表单在 13 行最小窗下 Save 行在折叠区下方（与 Rust Layout 行为一致，属共有形态非缺陷）。
>
> **M1 独立复审（2026-09-25，code-reviewer）**：0 Blocker / 2 Major / 4 Minor / 4 Suggestion，已闭环——Major 1（`kimi --version` 非零退出码吞输出，与 oracle `wait_with_output` 语义相反）与 Major 2（AppState 跨 goroutine 竞态：polling 的 timer goroutine 直写状态）已修；Minor 3（排队刷新 retime 被丢弃）按 oracle 优先改为「后完成者胜出」并补测试；Minor 4（共享 http.Client 复用）、Minor 5（lone surrogate 与非法 UTF-8 body → JsonException）、Minor 6（golden 计数钉死 19/85/6）、Suggestion 7/8 已修。**遗留登记（M5 写 SPEC 22.7）**：S9 DST 二义 naive 输入 Go 与 TS 底本一致、与 chrono `.single()` 不同；S10 版本号正则 `[0-9]` vs Rust `\d`（Unicode Nd）；另发现 TS 版 polling 在「后完成者 retime」角落与 Rust 偏离（Go 已按 Rust 实现同日修复），建议回登记 TS 侧。

### 6.4 构建与版本号

- **版本号唯一来源 `go/VERSION`**：运行时经 `go:embed` 读入；构建脚本读同一文件喂给 goversioninfo（对齐 Rust 版"Cargo.toml 唯一来源、build.rs 自动派生 VERSIONINFO"的纪律）。
- release 构建：`CGO_ENABLED=0 go build -ldflags "-s -w" -o dist/kpt-tui-go.exe .`（产物 ~8–15 MB；exe 名对齐既有命名 `kpt-tui.exe` / `kpt-tui-node.exe`）。goversioninfo 生成 `.syso` 嵌入 VERSIONINFO + `assets/icon.ico`；**嵌入失败只告警不 fail**（对齐 `rust/build.rs` 纪律）。exe 不签名，SmartScreen 提示属预期（README 已注明）。
- 发版：手动 GitHub Releases 上传 + `SHA256SUMS.txt`；不把二进制提交进仓库（`go/dist/` 已 gitignore）。是否进 Releases 由用户拍板（SPEC 7.3 现状：Node 版进、Bun 版不进）。

---

## 7. 人肉验收清单（DoD 的不可自动化部分——HANDOFF 事故的核心教训）

自动化测试够不到独占 console 分支（2026-09-25 Bun 版 270 测试全绿仍闪退）。以下必须**在真实机器上逐项打勾**：

| # | 场景 | 预期 |
|---|---|---|
| 1 | **双击 release exe**（独占 console） | 进程存活、窗口缩到 72×13、TUI 完整渲染、8 s 内出实时配额 |
| 2 | `start /wait` 启动 release exe | 同上；`q` 退出后 EXITCODE=0 |
| 3 | WT 标签页 / VS Code 终端内启动（共享 console） | 用户窗口尺寸**不被改动**；渲染/按键正常 |
| 4 | `cmd /k` 宿主内启动（同 console ≥2 进程） | 不缩窗；正常运行 |
| 5 | 管道 / `--test-fetch` / `--test-update`（非 TTY） | 不缩窗；打印后退出 |
| 6 | 退出路径 ×4：`q`、Ctrl+C、（能构造的）panic、kill 窗口 | 每条路径终端完整恢复（alternate screen / 光标 / cooked mode），无残留乱码 |
| 7 | 双主题（Moonlit/Moondark）+ `theme=system` 翻转系统深浅色 | 30 s 内跟随；色值对照 SPEC 11.1 |
| 8 | 中文 IME 下按键"无反应" | 文档已登记提示（SPEC 12.7 三版共有条目，Go 版 README 同样登记），非缺陷 |
| 9 | 鼠标选择/复制 dashboard 文本 | 可用（app 不劫持鼠标） |
| 10 | 极窄终端 | 进度条按 SPEC 12.2 省略规则降级，不崩不坏版 |

---

## 8. 交付验证纪律（用户全局规范）

- 每个里程碑完成后：`go build ./...` + `go test ./...` + `go vet ./...` 全绿，再跑 parity 与相关人肉验收项。
- **交付级代码委派 code-reviewer agent 独立复审**（只读、以证伪为导向、自行重跑验收命令）；委派前按用户全局规则用 AskUserQuestion 询问模型与思考强度，按答复选 Agent 工具或后台独立进程执行，完成后向用户转交完整报告。
- 不转述作者预期——给审查者的输入只有需求与代码/产物路径。

---

## 9. 文档同步清单（M5 必做，漏一项即返工）

- `docs/SPEC.md` / `docs/SPEC_EN.md`（同步改，章节编号一致）：
  - §1.2 / §3.1 / §3.3 表格 / §7 构建测试发布：加 Go 版条目
  - §9 维护边界：受支持实现加入 Go 版
  - **新增 §22.7 Go 版差异登记**，内容即本文件 §4 标注的登记点（registry 直读无 GBK / `os.Executable` 无歧义 / 系统根证书无 `--use-system-ca` / int64 无 clamp、无 24.8 天上限 / 主题轮询进程内同步 / 心跳无 unref 概念 / 非 2xx 排空 body / 其他实测新发现）
- `AGENTS.md`：仓库布局、构建运行命令、测试/自检命令、Go 版陷阱条目、发布流程
- `README.md` / `README_CN.md`：Go 版构建与运行说明、按键表（含 IME 提示）、产物体积说明
- 根 `.gitignore`：`go/dist/`、`go/*.syso`（M0 已做则复核）
- `HANDOFF.md` §11：回链本计划与落地状态
- `go/README.md`：目录说明（对齐 `ts/README.md` 的定位）

---

## 10. 风险登记

| 风险 | 缓解 |
|---|---|
| bubbletea v2 API 与 v1 差异大、import path 漂移 | M0 以官方 README 钉版本与 path；`go.mod` 锁死；升级需重新实测 §7 |
| Windows raw mode / Ctrl+C 送达行为未知 | §4.3 双通路 + §7-6 实测；`q` 永远是主退出键 |
| ConPTY 不透传缩窗转义（Node 版 2026-09-20 实测） | Win32 通道为主、转义通道 best-effort；独占启动按 §7-1/2 实测 |
| `from_utf8_lossy` 语义差（Go 逐字节 U+FFFD vs Rust maximal subpart） | 自实现 `lossyDecode()` + GBK/截断用例钉死（§5.1） |
| f64 / DateTime 文本与 serde 不逐字节 | golden 全等断言（§4.1）；不许"近似"断言 |
| `time.Duration` 溢出 → 带 token 热循环 | saturating 换算 + `math.MaxInt64` 用例（§4.4） |
| golden 时区依赖 | TestMain 固定 `Asia/Shanghai` + 守卫 fail（§5.1） |

## 11. 明确不做（非目标）

- 不做单实例互斥锁（SPEC 20）；不做鼠标交互；不做 macOS/Linux（`CGO_ENABLED=0` 只为静态产物，不代表跨平台支持承诺）
- 不引 YAML 库（frontmatter 手写行解析）；不引 TOML 库（config.toml 手写逐行解析）；不做遥测
- 不修改 Kimi Code CLI 任何文件；不读取 `~/.agents/.skill-lock.json`（SPEC 21.2）
- 不把 Go 版做成"更好"——行为契约以 Rust 为基准，改进提案先改 SPEC 再谈实现
