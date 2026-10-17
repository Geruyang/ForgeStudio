# 验收记录（ACCEPTANCE）

> 每个验收项及对应真实证据。QA Agent（D）维护；区分"已实现 / 已验证(fixture) / 未验证 / 阻塞"。
> 模拟与实机分开记录；fixture 记录必须标注"模拟"，不算实机验收。

## 验收总览（随进度更新）

| 编号 | 验收项 | 级别 | 状态 | 证据 |
|---|---|---|---|---|
| A-1 | 引擎隔离：CODEX_HOME 独立、不读用户现有配置 | T1 must (M1) | **已验证（dev 态）**：适配层固定注入 CODEX_HOME；真实 codex.exe 冒烟握手在该目录完成 | 见 A-16 |
| A-2 | 真实模型会话：初始化→回合→增量→审批→停止 | T1 must | **阻塞**（模型凭证缺失） | — |
| A-3 | model/list 返回与验收模型选择 | T1 must | **阻塞**（同上） | — |
| A-4 | 审批/拒绝/窗口重载不错误放行（M2） | T1 must | **已验证（fixture 协议进程）** | 见 A-4 记录 |
| A-5 | 引擎退出/协议不匹配/停止与进程树清理（M3） | T1 must | **已验证（fixture 协议进程，退出子集）** | 见 A-5 记录 |
| A-6 | 构建/测试失败保留日志、验收失败、不自动烧录（M4） | T1 must | 已验证（fixture 级，构建失败分支） | 见 A-13 附注 |
| A-7 | A 级输入指纹与证据过期（M5） | T1 must | **已验证（真实进程服务级）**：冒烟修改输入→hasStaleEvidence=true | 见 A-16 |
| A-8 | 重复 requestKey 幂等（M7） | T1 must | **已验证（真实进程服务级）**：同键两调返回同 operationId | 见 A-16 |
| A-9 | 任务/设备/证据不串；steer 绑定当前回合（M10） | T1 must | **已验证（fixture 组件级）**：B1 steer 三态 + A 组件测试 | 见 A-4/A-5 + renderer 测试 |
| A-10 | 安装包从安装后应用验收（H40 关） | T1 must | **已验证（安装后应用冒烟 + 13 步深检 + GUI 自动化走查）**：首装冒烟暴露闭包缺件 → 修复重建；走查再暴露并修复 listTasks/devices/TOML 三处接缝 → 最终包全绿 | 见 A-10 记录 |
| A-11 | 诊断/导出不含凭证（M1） | T1 must | **已验证（集成版，真实 runner 服务）**：起 createRunnerService → GET /api/diagnostics 响应体与存储目录无凭证命中；扫描器+交付物文件扫描通过 | 见 A-11 记录与 QA 第二波 |
| A-12 | 软件任务闭环（模型驱动的缺陷修复） | T1 | **阻塞**（依赖 A-2，K-1） | — |
| A-13 | 软件任务闭环（工程面板驱动：真实构建+固定验收+证据） | T1 | **已验证（安装态真实进程全链路）**：dev 13 步冒烟（A-16）+ 安装产物 13 步复验（A-10 深检，随包运行时执行安装目录 runner/bridge） | 见 A-16 / A-10 |
| A-14 | 实机构建→烧录→串口身份与行为验证（M6/M8/M9） | T2 | **阻塞**（无硬件，K-2） | — |
| A-15 | 设备适配 fixture 流程（bind/flash/verify 状态机、独占、去重） | T2 代理（模拟） | **已验证（fixture 模拟 49/49）**：C 交付虚拟探针+环回串口 | packages/engineering-runner/test/device |
| A-C | 契约级测试（实体/schema/判定函数/状态机） | 支撑 | **已验证（34/34 真实通过）** | 见 A-C 记录 |

运行环境：Windows 11（build 26200）x64，Node v24.21.0，vitest 5.0.4（2026-10-14，+08:00）。

---

## 记录模板

```text
### A-x 名称
- 版本：ForgeDesk v0.1.0 @ <commit/时间>
- 动作/命令：<实际执行内容>
- 预期：<通过标准>
- 实际：<真实结果>
- 证据位置：<原始日志/截图/导出包路径>
- 级别：must/should；fixture/实机
```

---

### A-4 审批代次配对（M2）——已验证（fixture 协议进程，非实机/非模型）
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令：`npx vitest run --root packages/engine-adapter test/m-scenarios/m2-approval-pairing.test.ts`
- 预期：fixture 服务器发起审批 → 跨 generation 重启引擎 → 旧 requestId 应答必须不生效（新代次拒绝，无副作用）；未知 requestId 拒绝；新代次审批正常工作
- 实际：**4/4 通过**（真实 spawn fixture 协议进程走完整 JSONL 握手）：
  代次 1 审批到达（requestId/代次一致）→ dispose 后同实例重启（代次 2）→ 旧 requestId 两次应答均被拒
  （"旧批准不得重放"）→ 未知 id 拒绝 → 新代次审批应答成功且回合 success。连续 5 次重跑全部通过
- 证据位置：`packages/engine-adapter/test/m-scenarios/m2-approval-pairing.test.ts`；fixture 对端
  `packages/engine-adapter/test/fixtures/fake-app-server.mjs`（scenario 'approval'）
- 级别：T1 must（M2）；**fixture 协议进程（模拟对端，非模型调用）**

### A-5 引擎退出（M3 退出子集）——已验证（fixture 协议进程）
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令：`npx vitest run --root packages/engine-adapter test/m-scenarios/m3-engine-exit.test.ts`
- 预期：fixture 服务器进程回合中途退出 → adapter 状态 stopped、pending 拒绝、SessionStore 标记 incomplete
- 实际：**5/5 通过**：die-midturn（exit code 3）→ `adapter.status==='stopped'`；事件流 engine/status(stopped)
  且该回合无 turn/completed（不伪造成功）；死进程上 send()/approve() 均被拒；
  `EngineSessionStore.loadThread().complete===false`（缺口可见，listThreads 同样 complete=false）
- 证据位置：`packages/engine-adapter/test/m-scenarios/m3-engine-exit.test.ts`
- 级别：T1 must（M3 的引擎退出子集）；fixture。协议不匹配与进程树清理子项仍待验证（M3 其余部分）

### A-7 A 级输入指纹与证据过期（M5）
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令：
  `npx vitest run --root packages/engineering-runner`（含 m5-evidence-stale A 层 + m5-fingerprint-stale）
- 预期：临时工程 build 过 → 修改输入 → 再采集/inspect → 指纹变化、证据 stale、必需项全过也不点亮
- 实际：**A 层（B2 真实 snapshot 模块）5/5 + fixture 级 9/9 通过**：真实 build（退出码 0+产物）；
  未变化两次采集一致；改输入后 inputDigest 与文件摘要都变；证据摘要失配→stale→
  `computeTaskAcceptance` 不点亮；重验后恢复。**待集成**：经 runner HTTP 服务断言
  `GET /api/tasks/:id hasStaleEvidence=true`（B2 createRunnerService 未交付，用例自动 skip 并记录
  import 错误：`Cannot find module '.../src/index.ts'`）
- 证据位置：`packages/engineering-runner/test/m-scenarios/m5-evidence-stale.test.ts`（A 层 import
  B2 `src/snapshot/source-snapshot.ts` 真实现）、`m5-fingerprint-stale.test.ts`
- 级别：T1 must（M5）；fixture（临时工程，无 git 机器上 hasGit=false 路径）

### A-8 重复 requestKey 幂等（M7）
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令：`npx vitest run --root packages/engineering-runner`（m7-requestkey-idempotent）
- 预期：同 requestKey 连发两次 → 返回原操作、副作用只发起一次；同键不同参冲突；代次变化不复用
- 实际：**fixture 级 8/8 通过**（文件共 10 用例：8 fixture + 1 集成版 skip + 1 依赖状态记录；
  内存注册表 fixture 固化幂等语义）。**待集成**：经 runner 控制协议
  真实 POST 两次 build 断言同 operationId + 操作数=1（B2 服务层未交付，集成用例 skip 并记录错误）
- 证据位置：`packages/engineering-runner/test/m-scenarios/m7-requestkey-idempotent.test.ts`
- 级别：T1 must（M7）；fixture（语义验证，非真实 HTTP 端点）

### A-11 诊断/导出不含凭证（M1）——部分已验证
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令：`npx vitest run --root packages/engineering-runner`（m1-diagnostics-no-credentials）
- 预期：诊断响应/存储/导出包不含 token/密钥模式（sk-[A-Za-z0-9]、OPENAI_API_KEY 等）
- 实际：**16 通过 + 1 集成版 skip**：凭证扫描器正控制（7 类凭证样式全命中、正常文本
  不误报——期间发现并修复扫描器对 JSON 形式 `{"apiKey":"..."}` 赋值的漏检盲点）；RunnerDiagnostics
  序列化样本、SSE 事件包装、导出包样例无命中；8 个真实交付物文件（profiles/templates/transcripts/
  vendored VERSION.json）扫描无命中。**待集成**：真实 runner `GET /api/diagnostics` 响应体扫描
  （B2 服务层未交付，skip 并记录 import 错误）
- 证据位置：`packages/engineering-runner/test/m-scenarios/m1-diagnostics-no-credentials.test.ts`
- 级别：T1 must（M1）；fixture（样本+文件扫描，非真实端点响应）

### A-13 软件任务闭环（工程面板驱动）——fixture 级已验证（缺陷复现部分）
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令（sample-tool fixture，工程根 `engineering/fixtures/sample-tool`，均真实执行）：
  ```text
  node scripts/build.mjs                            → BUILD_OK（exit=0），生成 build/build-manifest.json
  node tools/wordcount.mjs fixtures/normal.txt      → words=12（exit=0）
  node tools/wordcount.mjs fixtures/empty.txt       → TypeError: Cannot read properties of null
                                                      (reading 'length')（exit=1，缺陷复现）
  node test/wordcount.test.mjs                      → T1 ✔ / T2 ✔（2 pass, 0 fail；T2=复现器）
  ```
- 预期：正常文本统计正确；空输入崩溃可复现（退出码非 0）；构建通过；复现器与无回归 verifier 语义
  按 profile 判定规则可机判
- 实际：全部符合。profile `forgedesk.profile.json`（id `sample-tool-wordcount`）通过
  `EngineeringProfileSchema` 校验；verifier `wordcount-normal`（passExitCode=0+MustContain words=12）
  与 `wordcount-empty-crash-repro`（passExitCode=1+MustNotContain words=0）判定规则经契约测试验证。
  产品面板内端到端（inspect/build/test/证据/导出）待 runner 服务层（B2）与桌面（A）集成后执行
- 证据位置：`engineering/fixtures/sample-tool/**`（含 README"修复后如何验证"）；操作手册
  `docs/engineering/sample-task-walkthrough.md`
- 级别：T1（A-13）；**fixture 工程（模拟目标工程），修复演示待模型凭证（K-1）**
- 附注（M4）：`scripts/build.mjs` 语法检查失败分支输出 BUILD_FAILED 且非 0 退出（构建失败→验收失败
  →不进入后续步骤的输入端行为已在 fixture 验证；面板不自动烧录的联动待集成验证）

### A-C 契约级测试——已验证
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令：`npx vitest run --root packages/contracts`（配置：`packages/contracts/vitest.config.ts`）
- 预期：computeTaskAcceptance 三态（全过/缺一/stale）；MCP 七工具 schema 合法样例通过+非法拒绝；
  profile schema 校验 3 个真实 profile 文件；状态机常量与标签表键严格一致；newId/OpResult 基础行为
- 实际：**34/34 通过**（含：软件/嵌入式验收模板 4+4 项与 contracts 字段兼容性断言；
  `wordcount-empty-crash-repro` 复现器语义断言）
- 证据位置：`packages/contracts/test/contracts.test.ts`
- 级别：支撑项（契约层，真实运行）

---

## 待集成后执行的测试（本波落地、依赖标注）

| 文件 | 依赖 | 当前状态 |
|---|---|---|
| `packages/engineering-runner/test/m-scenarios/` m1/m5/m7 的"集成版"块 | B2 createRunnerService（src/index.ts） | 自动 skip；import 错误已记录（Cannot find module） |
| `packages/engineering-runner/test/m-scenarios/m5-evidence-stale.test.ts` B 层 | B2 同上 | 同上 |
| `packages/engine-adapter/test/m-scenarios/m2-approval-pairing.test.ts` | B1（已交付） | **已真实运行通过** |
| `packages/engineering-runner/test/m-scenarios/m1-diagnostics-no-credentials.test.ts` 鉴权失败路径 | B1+A 集成 | TODO-INT |

### A-16 集成冒烟：真实进程软件闭环全链路——已验证（真实进程，开发机）
- 版本：ForgeDesk v0.1.0 @ 2026-10-14（H0+~6h）
- 动作/命令：`node scripts/smoke-runner.mjs`（真实 spawn dist/runner/service.cjs 与 dist/bridge/mcp-bridge.cjs 两个产品 bundle 进程）
- 预期：任务创建→真实构建→固定验收→证据落盘→requestKey 幂等→输入变化证据过期→交付包导出→MCP 桥握手与工具调用全部通过
- 实际：**13 步全部通过**：
  1. runner 服务进程启动、发现文件写出、`/health` OK
  2. sample-tool profile 加载（rev1）
  3. 任务创建（验收单 3 项：2 可执行+1 人工）
  4. 真实构建：`node` 实际执行 build 脚本，buildId=f4ca829c…、产物 sha256=b0af8d9a7ad3…
  5. wordcount-normal 验收 passed；wordcount-empty-crash-repro passed（缺陷存在时复现器按预期工作——缺陷尚未修复，语义正确）
  6. 验收单 2/3（人工项保持待办，不被工具点亮）；证据 2 条落盘
  7. 同 requestKey 两次 build → 同一 operationId（副作用仅一次）
  8. 修改 fixtures/normal.txt → hasStaleEvidence=true（A 级失效规则，恢复后如初）
  9. 导出交付包生成（含 manifest/产物/证据）
  10. MCP 桥 bundle：initialize OK、tools/list=7、engineering.inspect tools/call OK（经同一 runner 实例）
- 证据位置：scripts/smoke-runner.mjs 输出（已存本记录）；交付包 `.runtime/smoke/exports/`；数据库 `.runtime/smoke/forgedesk.db`
- 级别：T1 must（A-7/A-8/A-13）；真实进程执行（fixture 样例工程，非模型驱动、非实机）

### A-17 Electron 桌面冒烟——已验证（真实启动，开发机 dev 态）
- 版本：ForgeDesk v0.1.0 @ 2026-10-14
- 动作/命令：`electron.exe .`（apps/desktop，dev 产物）；观察 12s 后进程存活与数据目录产物
- 预期：窗口加载 renderer、runner 以 utilityProcess 启动、无崩溃错误
- 实际：`alive_after_12s=true`；stderr 无错误；`.runtime/app-data/runner-discovery.json` 与 `forgedesk.db` 生成（runner 真实拉起）；修复一处 ESM `__dirname` 残留后通过
- 证据位置：本记录；`.runtime/app-data/`
- 级别：支撑（H4 前置：dev 态基线；安装后验收见 A-10）

### A-18 引擎隔离（M1 子项，dev 态）——已验证
- 动作：B1 真实 vendored codex.exe（0.162.1）冒烟（仅 initialize→initialized→thread/start→getAuthStatus，无模型推理）
- 实际：握手成功、clientInfo="forgedesktop" 被接受；CODEX_HOME 由适配层固定注入产品目录（.runtime/app-data/engine），不读 %USERPROFILE%\.codex；无凭证返回 authMethod:null → auth_required 映射正确
- 证据位置：packages/engine-adapter 冒烟（B1 交付汇报）；.runtime/app-data/engine/
- 级别：T1 must（M1）子项；真实引擎进程（只读冒烟，无模型调用）

### A-10 安装包从安装后应用验收（H40 关）——已验证（2026-10-14 晚）
- 版本：ForgeDesk v0.1.0，正式安装包 `ForgeDesk Setup 0.1.0.exe`
- 正式包：SHA-256 `6FFD8365835CD8E8DB346B8B9155F732FAE82EE7CD195BE0B56F5C972F6AE6AB`（220,629,254 B，
  `apps/desktop/release/` 与 `apps/desktop/release-final/` 一致，`release*/SHA256SUMS.txt`）；Authenticode 状态
  **NotSigned**（安装包与 ForgeDesk.exe 实测，与 BUILD.md 口径一致）
- **首次安装包冒烟暴露缺件事故（如实记录）**：首个安装包静默安装（exit=0）后启动，应用存活但
  **runner 未拉起**（数据目录无 runner-discovery.json / forgedesk.db；进程树只有 main/gpu/network/renderer）。
  手动复现（`ELECTRON_RUN_AS_NODE` 直接执行安装态 `fd-runner/service.cjs`）：`Cannot find module 'debug'`
  ——extraResources 只拷了 workspace 提升目录 serialport/@serialport，漏掉 `@serialport/stream` 的传递依赖
  `debug`/`ms`。dev 态因 Node 解析上溯 workspace 根 node_modules 而不可见，安装态必现。
- **修复与重建**：① `scripts/package.mjs` 新增步骤 2/4——在 `dist/runner` 内独立安装自包含闭包
  （`serialport@13.0.0`，`--ignore-scripts` 用 bindings-cpp 内嵌 prebuilds/win32-x64）并校验 6 个关键
  模块存在，缺件即打包失败；② `electron-builder.yml` 闭包以 `dist/runner/node_modules` 为拷贝根单独
  成项（extraResources 对目录内 node_modules 有默认过滤）；③ 顺带修复安装态数据目录偏差
  （见 DECISIONS D8）。重建后未打包产物先验证：runner 以随包闭包真实启动、发现文件+数据库落盘。
- 动作/命令（正式包，全部真实执行）：
  ```text
  卸载旧安装（Uninstall ForgeDesk.exe /S → exit=0）→ 新包静默安装（/S → exit=0）
  安装态校验：fd-runner/node_modules 含 debug/ms/serialport/bindings-cpp prebuilds/node-gyp-build；
              vendored codex.exe SHA-256 = DD13BDB1…（与 VERSION.json 一致）
  启动 ForgeDesk.exe → 18s 存活；进程树 main+gpu+2×utility（含 runner）+renderer 共 5 进程
  数据目录 %APPDATA%\ForgeDesk：runner-discovery.json + forgedesk.db（WAL）+ engine/ + evidence/ + profiles/
  runner HTTP 实测（Bearer 发现令牌）：GET /health → {ok:true}；GET /api/profiles → 2 个随包 profile；
              GET /api/diagnostics → schemaVersion/runnerVersion/storageOk/… 结构正确
  注册与快捷方式：HKCU 卸载项（ForgeDesk 0.1.0，/currentuser）、桌面与开始菜单快捷方式齐备
  优雅关闭（CloseMainWindow）→ 12s 后 ForgeDesk 进程残留 0（runner/engine 依 will-quit 收尾，无孤儿）
  ```
- 实际：全部符合预期；A-1（数据目录规范路径+引擎目录就位）、A-17 的安装态对应项一并覆盖。
- 附注（引擎隔离归属核验）：冒烟期间 `%USERPROFILE%\.codex` 出现的写入经查全部来自并行运行的
  OpenAI Codex 代理进程（命令行均为 `AppData\Local\OpenAI\Codex\bin\...`，无一引用 ForgeDesk vendored
  路径）；本次冒烟未创建模型会话、未启动引擎（无凭证，K-1）。
- 证据位置：本记录；`release-final/`（安装包+blockmap+SHA256SUMS+builder-debug.yml）；`%APPDATA%\ForgeDesk\`
- 级别：T1 must（A-10/H40 关）；**安装后应用冒烟（进程/服务/数据目录级）**；GUI 内容人工走查与
  安装态真实模型会话仍待用户解锁（K-1）
- **安装态深检（13 步全链路，同日晚些追加）**：`scripts/smoke-runner.mjs` 已支持 FD_SMOKE_* 路径
  覆盖；以随包 `ForgeDesk.exe`（ELECTRON_RUN_AS_NODE）直接运行**安装目录**的 `fd-runner/service.cjs`
  与 `fd-bridge/mcp-bridge.cjs`，独立临时数据目录（不触碰应用数据目录）——13 步全部通过（exit=0）：
  真实构建（buildId be8de75c…）、wordcount-normal passed、复现器 passed（2/3，人工项保持待办）、
  证据 2 条落盘、requestKey 幂等（同 operationId）、修改输入→hasStaleEvidence=true、导出包生成、
  MCP 桥 initialize/tools=7/inspect 全 OK。即 **A-13/A-16 的工程闭环在安装产物上完整复现**
  （A-13 升级为"已验证（安装态真实进程全链路）"）。证据：`%TEMP%\fd-installed-smoke\`
  （forgedesk.db + exports/task-f0bc034b…）

### A-10 附：GUI 自动化走查（CDP 驱动安装后应用，2026-10-14 深夜）——最终包全绿
- 工具：`scripts/gui-walkthrough.mjs`（零依赖 CDP 驱动；`--remote-debugging-port` 启动安装应用，
  原生目录对话框不可自动化的项目选择环节用桥接口等价替代，表单逻辑由组件测试覆盖）
- **走查过程再暴露并修复三处集成接缝**（mock 测试掩盖、只有真实组装才可见；修复后均补回归）：
  1. `GET /api/tasks` 返回瘦条目（缺 acceptance/operations/artifacts/hasStaleEvidence），
     renderer `asTaskOverview` 全滤 → **真实应用任务列表恒空**。修复：runner 列表路由返回完整
     TaskOverview（对齐契约 ipc.ts），http.test 补字段断言。
  2. `GET /api/devices` 返回信封 `{devices,…}` 而契约要求数组，直传致 DeviceSection
     `devices.map` 崩溃并**卸载整棵 React 树**（白屏根因）。修复：主进程 IPC 边界解包 + store
     数组矫正。此前因缺陷 1 组件从未渲染而长期潜伏。
  3. engine-host `escapeToml` 对单引号 literal string 做反斜杠转义 → 生成的 config.toml
     `command` 路径成字面 `\\`（Win32 恰好容忍）。修复：tomlStr（literal string 原样/含引号退回
     basic string），安装态实测生成路径正确。
- **最终包走查记录（全部断言通过，exit=0）**：外壳/侧栏渲染 → 设置弹窗（语言/模型控件）开合 →
  桥建任务（与向导同一 IPC）→ 重载后面板呈现（验收单 2 可执行项）→ 真实按钮 环境检查/构建
  （产物卡+输入指纹呈现）→ 逐项"运行验证"→ **UI 判定"必需项 2/3 通过"（人工项保持待办，不被
  工具点亮）**→ 导出交付包（runner 侧 export:succeeded 核验）→ **引擎链安装态实测**：engine.start
  ok（threadId 01a13af9…）、状态 auth_required、authStatus {mode:none, ok:false}、UI 显示"引擎需要
  认证"（A-18 dev 结论在安装态复现）→ Browser.close 优雅退出（进程 ~10s 内清零）。
  config.toml 重新生成且路径正确（`command = 'C:\…\ForgeDesk.exe'`）。
- 最终正式包：`ForgeDesk Setup 0.1.0.exe`，SHA-256
  `75DD4AF1BEADBB16CEEE53B5E917269E5356449BD739AFB45BFF527ED51044FF`（未签名）；本包 13 步安装态
  冒烟再次全通（`%TEMP%\fd-installed-smoke3\`）。迭代过程包（缺件包 2587…/2DD2…/B43F…）均废弃，
  `release-final/` 恒为当前正式证据。
- 级别：T1 must（A-10）增强证据；**GUI 自动化走查（非人工走查——原生目录选择对话框与真实视觉
  检查仍留人工）**

### QA 第二波（2026-10-14 晚）——m1/m5/m7 集成版解除 skip
- 动作/命令：`npx vitest run --root packages/engineering-runner test/m-scenarios/m1-diagnostics-no-credentials.test.ts test/m-scenarios/m5-evidence-stale.test.ts test/m-scenarios/m7-requestkey-idempotent.test.ts`
- 实际：**31/31 通过**（此前 D-1 记录的 3 个集成 skip 全部解除并真实运行）：
  M1 集成版——真实 createRunnerService → GET /api/diagnostics 响应体与存储目录扫描无凭证命中；
  M7 集成版——同 requestKey 连发两次 build → 同一 operationId、副作用计数=1；
  M5 B 层——build 过 → 修改输入 → inspect → `GET /api/tasks/:id` hasStaleEvidence=true 不点亮。
- 全量回归（干净树）：`npm test`（contracts/runner/mcp/adapter，exit 0）+ `npm test -w apps/desktop`
  （10 文件 38 用例全过）+ `npm run typecheck`（逐工作区 0 错误）。
- 遗留：M1 的 app:exportDiagnostics 桌面导出文件扫描与 M7 实机烧录去重（T2）仍待对应前置；
  M1 鉴权失败路径已由 A-18（authMethod:null→auth_required）覆盖证据。
- 级别：T1 must 收口支撑；真实进程执行

### A-10 附二：官方登录入口与信息架构优化走查（2026-10-15 凌晨，包 4ECDD93E…）
- 用户反馈：①设置界面没有官方登录方式；②界面需功能分类叠放、核心/高频突出。实现见 DECISIONS D9。
- 本包 GUI 走查新增断言全部通过（exit=0，进程清零）：
  - 认证缺失横幅**呈现**（authStatus 降级探测生效——此前引擎未启动时永不显示）；
  - 顶栏「新会话」主按钮、「模型未登录」warn 徽标存在；
  - 设置页「官方登录」「刷新认证状态」按钮存在；真实点击刷新触发安装态只读探测
    （codex login status），区块显示"未配置——点击「官方登录」在终端完成…"；
  - 工程闭环（任务/构建/两项验证 2/3/导出/引擎链 auth_required/优雅退出）在新包复验通过；
  - 工程面板设备/操作历史折叠收纳（标题带计数），核心区块平铺保持。
- K-1 状态更新：产品内官方登录入口已就绪（设置页「官方登录」），用户完成登录后即可执行
  A-2/A-3/A-12；凭证不经桌面端展示/存储（写入产品 CODEX_HOME，官方流程）。
- 级别：T1 must（A-10/K-1 前置）增强证据；GUI 自动化走查

### A-10 附三：登录终端修复与多提供方全链走查（2026-10-15，包 883170C0…）
- **登录按钮报错（用户反馈）**：根因为 start 窗口标题中文参数引号坑（详见 DECISIONS D10-1）；
  修复后安装态实测 IPC {"ok":true} + WindowsTerminal 弹出标题"ForgeDesk 模型登录"的引导窗口。
- **多提供方全链（走查新增断言全部通过，exit=0）**：
  - 设置页「模型提供方」下拉六家（OpenAI/火山方舟/智谱/Kimi/千问/DeepSeek）；
  - DeepSeek 样例：选择→粘贴 key/默认模型→保存→「已配置 key」徽标呈现；
  - 引擎启动后 config.toml 实测生成 model_provider='deepseek' + [model_providers.deepseek]
    （base_url=api.deepseek.com/v1、wire_api="responses"）；
  - **API key 本体未落入 config.toml**（断言通过，key 仅经环境注入）；
  - 清除配置生效；工程闭环（构建/验证 2/3/导出/引擎链/优雅退出）在本包复验通过。
- **协议可行性实测（前置，未虚构）**：vendored Codex 0.162.1 明确拒绝 wire_api="chat"
  （CLI 报错原文引证）；六家 /responses 端点无效 key 探测全部返回 401（端点存在）。
- **订阅口径（诚实声明）**：仅 OpenAI 有账号订阅式官方登录（终端 login）；火山方舟/智谱/Kimi/
  千问/DeepSeek 为 API key 按量计费，产品提供控制台直达外链，不虚构"订阅登录"。
- 级别：T1 must（K-1 前置）增强证据；GUI 自动化走查 + 安装态实测

### A-10 附四：登录链路修复与模型列表走查（2026-10-15，包 AB17D404…）
- 用户反馈三个问题全部修复并在安装态实测：
  1. **OpenAI 登录后仍要求登录**：根因是 WindowsTerminal 承载登录终端时环境继承断裂，
     CODEX_HOME 未传到登录会话（写入错误目录）。修复后走查断言：点击官方登录→引导脚本
     生成且含 `set "CODEX_HOME=…"` 显式设置（脚本级，不依赖继承）。
  2. **登录后无法选择模型**：引擎就绪/会话启动/恢复会话后自动 refreshModels+refreshAuth；
     设置页「刷新认证状态」联动刷新模型列表。
  3. **其他厂商 Coding Plan（订阅套餐）**：六家 planNote 如实标注（方舟 Coding Plan/智谱
     GLM Coding Plan/Kimi for Coding=订阅套餐 key；千问=百炼套餐控制台查看；DeepSeek=按量
     无订阅；OpenAI=官方订阅登录）。走查断言火山方舟显示"支持 Coding Plan 订阅套餐"文案。
- **模型列表拉取实测**：假 key 点「拉取模型列表」→ toast 显示 DeepSeek 服务器原始 401
  （"Authentication Fails, Your api key: ****345"——请求真实到达厂商并被拒，链路端到端正确）；
  失败时保持手填输入、不出现假列表；overflow 检查 modal=0px body=0px。
- 13 步安装态冒烟在本包复跑全通（%TEMP%\fd-installed-smoke4）；全量回归/typecheck 0。
- 未验证声明（如实）：带真实有效 key 的模型列表成功路径与真实模型会话仍待用户提供 key 后
  验证（K-1）；截图级视觉检查受工具能力所限未做（DOM 溢出代理检查已过）。

### A-10 附五：全面测试轮——人工验收闭环 + 五缺陷修复 + 操纵电脑实操（2026-10-15，包 7A347FD2…）
- **缺陷修复与回归**（详见 DECISIONS D12 / KNOWN_ISSUES D-12e）：
  1. manual 验收项死锁 → manual_review 操作 + B 级人证证据端到端闭环（runner http.test 8 测：
     executable 拒绝/幂等 no-op/改判回退不撞 UNIQUE/B 级证据落链；desktop 组件测试：确认通过
     走 confirm、标记不通过直调）；
  2. manualReview / updateAcceptance IPC 契约返回类型谎报（AcceptanceItem[] 被当 TaskOverview
     upsert → 坏 entry 崩整棵 React 树）→ 契约对齐 + store 按 taskId merge；
  3. **验收单全量替换语义毁单**（追加/采纳/移除三项操作均会把验收单毁成只剩本次提交项）→
     store 全量组装提交（现有项带 id 不传 status 保留真实状态）+ 三个毁单场景 store 级回归；
  4. recordManualReview 固定 requestKey 改判回退撞 UNIQUE（HTTP 测试实证后修复）；
  5. clearProvider 假清除（patch 浅合并删不掉 modelProvider + 空 provider.env 残留）→ 显式
     undefined + 空映射删文件；walkthrough 9b 新增**落盘断言**（IPC ok ≠ 真清了）。
- **安装态验证（v5 包 7A347FD2…33F0497）**：全链 GUI 走查 exit 0（含新增 7b 人工验收闭环
  断言：manual 项 UI 点亮→3/3→manual_review 操作入史→B 级证据≥1；9b 落盘断言：provider.env
  key 移除 + settings.modelProvider 移除）；13 步安装态冒烟（fd-smoke-v4 于 v4 包全通）；
  desktop 39/39；typecheck 五包全绿。
- **操纵电脑实操（CDP + PowerShell UIA 混合）**：多实例互斥实测（第二实例自动退出、进程集合
  不变）；原生"选择文件夹"对话框实测弹出（Win32 枚举 #32770 定位）；向导「调整验收单」全流程
  UIA 实操全绿（清模板→加手动项→提交→验收单新增且**原有项保留**→人工确认通过→runner 侧
  manual_review×2 + B 级证据×2 + lastEvidenceId 绑定），截图 4 张存 release-final/ui-audit/。
- **如实声明**：①背靠背连续运行验证偶发 UI 不刷新（数据层无损、重跑即亮，D-12a 观察中，
  走查已加重试缓解）；②原生目录对话框自动化在 Windows 前台锁定下不安全（SendKeys 误投
  风险，实测教训），目录选择留人工——向导 create 模式的目录环节未走自动化实操；③带真实
  key 的模型链仍待 K-1。
