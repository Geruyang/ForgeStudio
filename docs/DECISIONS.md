# 关键决策记录（DECISIONS）

> 锁定版本、关键取舍、变更原因。由集成负责人维护；变更必须先记录后实施。

## D1 引擎与版本锁定（H0，2026-10-14）

| 项 | 值 |
|---|---|
| Codex CLI | **0.162.1**（npm `@openai/codex@0.162.1`，win32-x64 平台包 `@openai/codex-win32-x64@npm:@openai/codex@0.162.1-win32-x64`） |
| codex.exe SHA-256 | `DD13BDB162A184FA04039488B234A8258EF9B76F84E926C505D5742B19249A6A` |
| 来源 | npm registry（官方 OpenAI 发布物），非浮动版本 |
| 协议类型 | 同版本 CLI `codex app-server generate-ts` 生成 743 个 TS 文件，纳入版本控制（packages/contracts/src/protocol/codex/，PROVENANCE.md 记录来源） |
| 许可证 | Apache-2.0（不包含模型服务权益或官方品牌使用权） |

理由：任务书 §2.2 要求锁定版本并生成对应类型；0.162.1 为当日 npm latest，较旧快照（0.162.0-alpha.17.2，原 ForgeDesk-codex 尝试使用）更新且为正式版而非 alpha。**不使用原 ForgeDesk-codex 目录的旧 schemas**（生成不完整且来源为 alpha 版本）。

## D2 协议要点（由 0.162.1 生成类型核实，替换任务书旧快照中的推测）

- 客户端方法：`initialize`、`thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`、`model/list`、`getAuthStatus` 均存在（与任务书一致）。
- 服务端审批请求（带 requestId，必须应答）：**新旧两组并存**——新版 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`；旧版 `execCommandApproval`、`applyPatchApproval`。适配层两组都必须处理（映射到自有 ApprovalRequestView）。
- `mcpServer/elicitation/request` 存在：按任务书 §6.2，首发 engineering-mcp 不使用 elicitation；意外收到时按协议拒绝。
- 通知：`TurnStartedNotification`/`TurnCompletedNotification`/`AgentMessageDeltaNotification`/`ReasoningSummaryTextDeltaNotification`/`ItemStarted`/`ItemCompleted`/`TurnDiffUpdated`/`ErrorNotification`/`ThreadStatusChanged` 等构成事件投影来源。
- `turn/completed` 之后仍检查实际 status（success/failure/interrupted），与任务书要求一致。
- 新版本协议含大量未消费方法（apps/plugin/fs/command/exec 等）：**一律不向 renderer/模型透传**，未知通知限量记录。

## D3 架构与进程模型

- 单一权威执行器实例：Electron 主进程启动 `engineering-runner` 服务进程（utilityProcess），持有设备锁与操作状态；MCP 桥接进程（由 Codex 按产品 CODEX_HOME/config.toml 拉起）经 loopback HTTP 控制协议代理七工具调用到同一实例。桥接重启不产生第二个设备所有者（任务书 §6.2）。
- 控制协议：127.0.0.1 随机端口 + 启动随机 Bearer Token + 受限路由；发现文件 `runner-discovery.json` 写入产品数据目录。
- 存储：**node:sqlite**（Node ≥22.5 内建）为首选后端，WAL 模式，schemaVersion=1 + 迁移记录表；无原生 ABI 重编译负担。若 Electron 44 的 Node 内建不可用则回退 sql.js（WASM）——以 Storage 接口隔离。日志与固件放文件目录，数据库只存引用与哈希（任务书 §6.2）。
- MCP 桥接进程宿主：安装包内 Codex 拉起桥接时使用 `ForgeDesk.exe` + `ELECTRON_RUN_AS_NODE=1` 复用随包 Electron 作为 Node 运行时（零额外体积），入口 `--fd-mcp-bridge`。
- 引擎隔离：子进程显式 `CODEX_HOME=<产品数据目录>\engine`；不读不写用户现有 Codex/Claude 配置。

## D4 前端与依赖（2026-10-14）

| 依赖 | 锁定 | 理由 |
|---|---|---|
| Electron | 44.7.2 | 当前 latest stable；Windows 11 x64 验收平台 |
| React | 19.3.0 | 稳定 latest |
| Vite | 8.3.4 + @vitejs/plugin-react 6.1.2 | renderer 构建 |
| esbuild | 0.28.2 | main/preload/bridge/runner 打包（native 依赖 external） |
| electron-builder | 26.15.3 | NSIS per-user 安装包 |
| zustand | 5.0.15 | renderer 状态 |
| diff | 9.0.0 | 会话内补丁渲染 |
| serialport | 13.0.0（bindings-cpp 13.0.1，N-API） | 串口；N-API 跨 Electron ABI 免重编 |
| zod | 3.25.76 | 契约 schema 与运行时校验 |
| vitest | 5.0.4 | 各包测试 |

锁定方式：根 package-lock.json 由集成负责人管理；工作区包内版本写死。

## D5 范围与验收取舍

- T2 实机：本机无硬件 → T2 明确保留未完成；设备适配按 fixture（虚拟探针/回环串口）开发并标注模拟。
- A 级证据：git 缺失时按任务书 §8.2 采用"完整输入清单内容摘要"替代 commit/diff 字段并标明（hasGit=false）；运行时检测 git 存在则自动增强。
- 不安装 git：是否给本机安装 Git for Windows 由用户决定（涉及系统级安装权限）；产品运行时自动探测，两端（有/无 git）均支持。
- UI 中文优先；引擎原始英文错误保留并配中文说明（任务书 §7）。
- 首发不启用 `experimentalApi`；不透传 `command/exec`、`thread/shellCommand`、`fs/*`、`process/*` 给 renderer。

## D6 计时口径

- H0 = 2026-10-14 13:11 (+08:00)（首次环境检查时点），默认连续计时（排障等待不暂停）；H48 = 2026-10-16 13:11。
- 用户已设定工作规则：模型用量低于 5% 时暂停子 Agent 调用等待限额恢复——此等待属资源限额等待，恢复后继续，不重置时钟。

## D7 集成决策（H+7，2026-10-14 晚）

1. **进程模型落地**：Electron 主进程经 `utilityProcess.fork` 拉起 `resources/fd-runner/service.cjs`（唯一权威执行器；发现文件交接端口+令牌）；MCP 桥 = `ForgeDesk.exe <fd-bridge/mcp-bridge.cjs>` + `ELECTRON_RUN_AS_NODE=1`（复用随包运行时，零额外体积），config.toml 由主进程每次引擎启动前幂等生成（MCP 注册含 FD_RUNNER_DATA_DIR env）。
2. **存储确认**：node:sqlite 在 Electron 44（Node 24.21）utilityProcess 实测可用（A-17 证据：forgedesk.db 生成）；不引入 better-sqlite3（免 ABI 重编）。
3. **契约增量补丁**（向后兼容）：TaskOverview.evidence（倒序 50 条）、session.loadPatch（补丁全文，主进程限 patches/ 目录防穿越）、runner.listProfiles（GET /api/profiles）、IPC engine:status sendSync 唯一同步通道。
4. **esbuild 打包**：四产物（main ESM / preload·bridge·runner CJS）；serialport 与 node:* 外置；runner 的 serialport 运行时依赖随 extraResources（fd-runner/node_modules）分发（N-API 跨 ABI）。
5. **electron-builder 26 适配**：win 配置最小化（x64ArchName/signAndEditExecutable 已不在 schema）；package.json 补 author。
6. **fixture 并存裁定**：`engineering/fixtures/sample-tool/`（wordcount 版）为 T1 故事主 fixture；`fixtures/software/sample-tool/`（行数版）保留为补充样例（无代码引用冲突）。
7. **npm 11.19 install-scripts 白名单**：electron/esbuild/bindings-cpp 的 postinstall 被拦导致二进制缺失（第二次 npm install 复现）；已 `npm install-scripts approve` 三包并手动补跑 electron install.js；BUILD.md 记录该坑。

## D8 打包修复与验收补丁（H+8~9，2026-10-14 晚，A-10 首装冒烟驱动）

1. **runner 依赖闭包自包含**（修复 A-10 首装必现缺件）：extraResources 只拷 workspace 提升目录
   （serialport/@serialport）会漏 `debug`/`ms`（@serialport/stream 传递依赖），安装态 runner
   `require('debug')` 即崩且被主进程 catch 静默降级。修复：`scripts/package.mjs` 在 `dist/runner`
   内独立 `npm install`（`serialport@13.0.0`、`--ignore-scripts`——bindings-cpp 预编译内嵌于包内
   prebuilds/win32-x64，运行时由 node-gyp-build 直接加载）并强校验 6 个关键模块；
   `electron-builder.yml` 以 `dist/runner/node_modules` 为拷贝根单独成项（extraResources 对目录内
   node_modules 有默认过滤，这是旧配置两条手工拷贝项能工作的同一机制）。闭包 staging 由 registry
   解析（bindings-cpp 为其依 serialport 的精确依赖），版本记录：serialport 13.0.0。
2. **安装态数据目录规范化**：Electron 默认 userData 按包名派生为 `%APPDATA%\@forgedesk\desktop`，
   与 BUILD/ENVIRONMENT 文档口径不符。主进程 ready 前显式
   `app.setPath('userData', appData\ForgeDesk)`（仅 packaged 态），实测落位
   `%APPDATA%\ForgeDesk`（runner-discovery.json/forgedesk.db/engine/evidence/profiles）。
   首装测试产生的 `@forgedesk` 旧目录已删除。
3. **根 typecheck 脚本修复**：原 `tsc -b tsconfig.base.json` 把共享 base 当项目编译——无 include
   即全仓扫描且 `declaration:true`/无 noEmit → 向源码旁 emit 了 1795 个 .js/.d.ts（JSX 以 preserve
   原样落盘，污染 Vite 扩展名解析使 7 个测试套件加载坏副本）。已删除全部误产物（时间窗
   20:54–20:56 全量核对）；脚本改为逐工作区 `npm run typecheck -w …`（与 build 脚本同型）。
   此前"全工作区 typecheck 0 错误"的口径按此脚本含义修正为逐工作区执行。
4. **正式安装包**：`ForgeDesk Setup 0.1.0.exe`，SHA-256
   `6FFD8365835CD8E8DB346B8B9155F732FAE82EE7CD195BE0B56F5C972F6AE6AB`（220,629,254 B），
   Authenticode **NotSigned**（实测安装包与 ForgeDesk.exe），正式证据目录 `apps/desktop/release-final/`，
   `release/` 同步留存。首个缺件安装包（SHA-256 `25870788EB3A9E9B37D8FEBE848153C4D175E0952EB1DEE9AEC309600CDB3E27`）已废弃删除。
5. **electron-builder 发布开关**：CI 检测会触发 implicit publishing 告警，打包命令一律显式
   `--publish never`。
6. **GUI 自动化走查暴露的三处集成接缝修复**（2026-10-14 深夜，脚本 scripts/gui-walkthrough.mjs）：
   ① runner `GET /api/tasks` 改回完整 TaskOverview（契约 ipc.ts 即 TaskOverview[]；旧瘦条目致
   renderer asTaskOverview 全滤、任务列表恒空）＋http.test 字段回归；② `/api/devices` 信封在主进程
   IPC 边界解包为数组＋store 数组矫正（信封直传令 DeviceSection map 崩溃卸载整棵树）；
   ③ engine-host TOML 生成改 tomlStr（literal string 反斜杠原样、含引号退回 basic string），
   安装态 config.toml 实测路径正确。三处均为"mock 测试绿、真实组装红"的跨 Agent 契约缝。
7. **最终正式包**：`ForgeDesk Setup 0.1.0.exe`，SHA-256
   `75DD4AF1BEADBB16CEEE53B5E917269E5356449BD739AFB45BFF527ED51044FF`（含全部六项修复：
   闭包/数据目录/typecheck 脚本/listTasks/devices/TOML）。本包三重验证全绿：安装态 13 步冒烟
   （%TEMP%\fd-installed-smoke3）＋GUI 自动化走查（外壳/任务/构建/验证/导出/引擎链/优雅退出）＋
   全量回归（runner 138+、desktop 38、typecheck 0）。
8. **K-1 认证前置核查结论**：环境无 OPENAI_API_KEY/CODEX_API_KEY，产品引擎目录无 auth.json；
   用户 ~/.codex 存在登录态但按冻结决策不复制既有客户端凭证——凭证必须由用户经产品内官方流程
   （设置界面指引的引擎目录 codex login，或 API key 写入产品 CODEX_HOME）提供。

## D9 官方登录入口与界面信息架构优化（2026-10-15 凌晨，用户反馈驱动）

1. **设置页官方登录入口**（补 BUILD.md 既有验收路径"设置中配置 API key（或账号登录）"的实现缺口）：
   新增 IPC `app:open-engine-login`（无参数、命令与目录全部来自主进程 ctx.paths，无注入面）——
   主进程生成中文引导脚本（UTF-8 无 BOM + chcp 65001，写系统临时目录）在外部终端打开，进入
   随包 CLI 的官方 `login` 流程（CODEX_HOME 固定产品引擎目录，不复制既有客户端凭证，P0-1 冻结）；
   脚本内置 API key 替代路径说明。设置页配套「官方登录」「刷新认证状态」按钮与说明文案。
2. **authStatus 引擎未启动降级探测**：无 adapter 时不再抛"引擎未启动"，改为 execFile
   `codex login status`（15s 超时）解析登录态——设置页/顶栏/横幅在应用一打开即可见真实认证态
   （此前认证状态在未发起会话时永远"不可用"，auth 缺失横幅从不呈现）。
3. **界面信息架构（用户指令：功能分类叠放、核心/高频突出）**：
   - 工程面板：任务头（状态/检查/构建/导出）与验收单/证据/产物保持平铺突出；低频区块
     设备/操作历史改为 Collapse 默认收起（标题携带绑定数/操作数；有运行中操作时历史自动展开）。
   - 顶栏：高频「新会话」提升为 primary 主按钮；未登录时「模型未登录」warn 徽标常亮（一键开设置）；
     任务下拉旁常驻「新建」；低频「导出诊断」移出顶栏（设置页已有）。
   - 认证缺失横幅文案改为行动导向（「去官方登录」primary 按钮）并保留 CODEX_HOME 展示。
4. **正式包更新**：`ForgeDesk Setup 0.1.0.exe`，SHA-256
   `4ECDD93E53DFFBE1D96E5A2F5C4477FB415A5EE6D6D486B9B712D8CCEE1EBDDB`（未签名）。
   本包 GUI 走查全绿：横幅呈现、顶栏新会话按钮、顶栏未登录徽标、设置页两按钮、真实点击
   「刷新认证状态」触发安装态只读探测（返回"未配置"指引文案）、工程闭环与优雅退出复验通过；
   全量回归（contracts/runner/mcp/adapter + desktop 38）与 typecheck 全绿。

## D10 多模型提供方与登录终端修复（2026-10-15，用户反馈驱动）

1. **官方登录终端报错根因与修复**：start 的窗口标题参数含中文/空格会被 Node 引号包裹成
   ""标题""，cmd 将其解析为待打开文件而报"找不到文件"。修复：start 标题固定空 ''，窗口标题由
   脚本内 title 行设置。安装态实测：IPC 返回 ok、WindowsTerminal 弹出标题"ForgeDesk 模型登录"。
2. **多模型提供方支持**（火山方舟/智谱 GLM/Kimi/通义千问/DeepSeek，OpenAI 官方并存）：
   - 前置实测：vendored Codex 0.162.1 已移除 wire_api="chat"（自定义 provider 仅支持 responses 协议）；
     六家 /responses 端点逐一探测均存在（401=端点在仅鉴权失败），方案可行、不虚构。
   - 机制：设置页选择提供方→粘贴 API key（+可选默认模型）→主进程写 <engineHome>/provider.env
     （key 本体，与 auth.json 同级保护）+ settings.modelProvider（id/默认模型）；每次引擎启动前
     resolveRuntimeProvider → config.toml 生成 model_provider/model_providers.<id>
     （base_url/env_key/wire_api="responses"），key 经 adapter extraEnv 注入子进程环境——
     key 永不落 config.toml、永不回显 renderer。
   - "套餐订阅"诚实口径：仅 OpenAI 支持账号订阅式官方登录（终端 codex login）；其余五家为
     API key 按量计费（无订阅 OAuth），设置页提供"获取 API key"白名单外链直达各厂商控制台。
   - 安装位置说明：NSIS allowToChangeInstallationDirectory 记忆用户自选目录（当前注册表指向
     E:\AiProject\agent-design\ForgeDesk-zcode\ForgeDesk\——用户手动安装所选），验收按注册表
     InstallLocation 定位。
3. **正式包**：`ForgeDesk Setup 0.1.0.exe` SHA-256
   `883170C001B7E8C72150B6E10429B4196BB8A0202D10F61741E99E22416572D6`（未签名）。
   本包 GUI 走查全绿（含新增多提供方全链断言）：DeepSeek 配置→"已配置 key"徽标→引擎启动后
   config.toml 生成 model_provider/model_providers.deepseek/wire_api=responses/base_url 正确、
   key 本体未入 config、清除生效；工程闭环与优雅退出复验通过；全量 typecheck 0、
   desktop 38/38、contracts 通过。

## D11 登录链路修复、Coding Plan 说明与模型列表（2026-10-15，用户反馈驱动，skill: intentional-ui-design）

1. **OpenAI 登录"又需要登录"根因**：登录终端经 start 由 WindowsTerminal 承载，环境继承链断裂，
   CODEX_HOME 未传到登录会话——codex login 写入错误目录（产品引擎目录始终无 auth.json，表现为
   网页登录后依旧未登录）。修复：引导脚本内显式 `set "CODEX_HOME=<engineHome>"`（脚本级设置，
   不依赖任何继承）。走查回归断言：点击官方登录→脚本生成且含显式设置。
2. **登录后模型下拉不可用**：model/list 需活动引擎，而启动会话/引擎就绪后未刷新。修复：
   engine/status → ready|auth_required 时自动 refreshModels+refreshAuth；startNewConversation/
   resumeThread 成功后同样刷新；设置页「刷新认证状态」联动刷新模型列表。
3. **Coding Plan 订阅套餐（如实口径）**：契约 descriptor 新增 planNote——火山方舟 Coding Plan、
   智谱 GLM Coding Plan、Kimi for Coding 标注"订阅套餐开通后使用套餐 API key"；千问标注
   百炼资源包/套餐（控制台查看）；DeepSeek 如实标注按量计费无订阅；OpenAI 标注官方订阅登录。
   套餐形态本就是"订阅计费的 API key"，经既有 provider.env 机制接入，不虚构 OAuth 登录。
4. **提供方模型列表拉取（Trae 式）**：新增 IPC app:list-provider-models——GET {base}/models
   （六家端点已实测存在）用已配置 key 拉真实模型列表；设置页「拉取模型列表」按钮→下拉选择
   默认模型（保留手填回退）。走查实测：假 key 得到厂商原始 401 错误 toast（请求真实到达
   DeepSeek 服务器），失败时保持手填输入不出现假列表。
5. **UI skill 复查（intentional-ui-design）**：按"任务阻塞优先"流程处理（登录/模型为最高阻塞）；
   渲染验证采用 DOM 代理检查（modal/body 溢出 0px 通过）；截图级视觉自检受当前模型无多模态
   能力所限未做，如实声明，待用户人工过目。
6. **正式包**：SHA-256 `AB17D4044AC74C68F37D587C8374602AAB7659338CA560C0CBE0BCB19EF6F5CD`
   （未签名）。本包三重验证：GUI 全链走查全绿（含上述全部新断言）＋13 步安装态冒烟全通
   （%TEMP%\fd-installed-smoke4）＋全量回归/typecheck 0。安装位置：本轮卸载清空了用户自选
   目录记忆，静默安装回到默认 %LOCALAPPDATA%\Programs\ForgeDesk（注册表可查）。

## D12 全面测试轮：人工验收闭环与验收单语义缺陷群（2026-10-15，用户指令"全面测试+操纵电脑实操"驱动）

用户指令："继续对客户端进行全面测试。不要放过任何一个细节。然后，操纵电脑对客户端进行实际验证。"

1. **manual 验收项死锁（全面测试首发现）**：manual 项无任何合法通过路径（UI 无按钮 / schema 拒绝
   直接写 passed / 执行器不消费 manualRequired）——防作弊红线"passed 只能由执行器点亮"误伤了
   manual 项。修复（端到端 12 处）：新增 `manual_review` 操作类型 + B 级人证证据（Evidence.
   evidenceLevel='B'，detail 记 reviewer/note/itemTitle）+ 专用 API `POST /api/tasks/:id/
   acceptance/:itemId/manual-review`（engine.recordManualReview）+ IPC `runner:manual-review` +
   UI 确认通过/标记不通过按钮（通过走 confirm 二次确认）。executable 项人工判定 400 拒绝
   （红线不变：可执行项仍只能由执行器点亮）。幂等：同判定重复 no-op；改判（含回退）每次新
   判定事件，requestKey 追加序号避开 UNIQUE 约束（固定 requestKey 在 passed→failed→passed
   回退时会撞库崩 500——测试实证后修复）。
2. **返回类型谎报缺陷群（同一根因三连击）**：runner HTTP 实际返回 `AcceptanceItem[]`，而 IPC
   契约谎报 `TaskOverview`，store 拿数组当任务 upsert——manualReview / updateAcceptance 两条
   链路先后爆雷（数组无 .id，upsertTask 产生坏 entry，Sidebar computeTaskAcceptance 对
   undefined acceptance 抛错崩掉整棵 React 树）。此前被 SSE 事件兜底掩盖（正常使用时 SSE
   acceptance/updated 刷新 UI，坏 entry 不被渲染）。修复：契约对齐 `OpResult<AcceptanceItem[]>`
   + store 按 taskId merge acceptance（三处）。typecheck 全绿证明契约修正是唯一真源。
3. **验收单全量替换语义错配（毁单缺陷，最严重）**：engine.updateAcceptance 是**全量替换语义**
   （未提交的条目删除——快照式设计，本身正确），但 store 的 addAcceptanceItems（追加）/
   adoptAcceptanceItem（采纳）/ removeAcceptanceItem（移除）全都只传增量/单项 → 每次操作
   **把验收单毁成只剩本次提交的项**（含已 passed 项全灭）；remove 字段 runner 根本不消费
   （zod 剥离未知键）。SSE 掩盖 + 无 e2e 验收单操作测试导致长期潜伏。修复：store 三 action
   改为全量组装提交（现有项带 id 不传 status——runner 端保留真实状态，防"passed 直接写入"
   红线被绕过；采纳项 status:'pending' 显式计入验收；移除=提交排除项）。IPC 类型补
   `status?: 'pending'|'proposed'|'not_runnable'`、废弃 remove 字段。三个毁单场景全部补了
   store 级回归测试（追加/移除/采纳的 payload 全量断言）。
4. **模板 verifier 防错（实测确认正常）**：向导 software 模板项（verifier software.build-pass 等）
   提交到 sample-tool 任务 → runner 400「引用了未知 verifier」——profile 校验防错符合设计，
   UIA 走查脚本改为清空模板勾选只提交手动项。
5. **clearProvider 假清除（落盘复核抓出）**：走查 9b 断言 IPC 返回 ok，但落盘复核发现
   provider.env 的 key、settings.modelProvider 均未清——两个根因：①SettingsStore.patch 是
   浅合并（`{...cur, ...p}`），传"不含该字段的对象"删不掉字段，必须显式置 undefined；
   ②清空后 provider.env 残留空文件。修复：`patch({ modelProvider: undefined })` + 空映射
   删文件；走查 9b 补**落盘断言**（IPC ok ≠ 真清了）。
6. **背靠背运行验证 UI 刷新偶发丢失（观察中，见 KNOWN_ISSUES D-12a）**：数据层无损、重跑即亮；
   走查加"首轮 60s 未亮重点一次"重试并如实记录。
7. **环境类发现（记录不修复）**：
   - **幽灵 CDP 端口**：Force-kill（甚至偶发优雅退出）后，CDP 端口偶被"已死 PID"的 socket
     条目占用（疑似子进程继承 socket 的释放窗口），新实例绑定失败。规避：换端口。
   - **登录终端窗口不自闭**：官方登录打开的"ForgeDesk 模型登录"终端窗口依赖用户手动关闭，
     自动化走查后残留（本轮手动清理一枚）。
   - **原生目录对话框自动化不安全**：Windows 前台锁定下 SetForegroundWindow 可能失败，
     SendKeys 会误投到其他前台窗口（本轮误开过一个资源管理器窗口，已向用户说明并收敛）。
     走查/UIA 脚本维持"目录选择留给人工"口径；应用内交互全部走 CDP DOM 驱动（零系统键盘）。
   - **PowerShell 5 读无 BOM 的 UTF-8 .ps1 会乱码**：中文匹配串失效——脚本落盘必须带 BOM
     （本轮 filedialog-uia.ps1 实证）。
8. **测试增量**：runner http.test +1（manual-review 路由：executable 拒绝/幂等/改判回退/B级证据，
   8 测）；desktop acceptance-panel +4（manual 按钮交互、追加/移除/采纳全量 payload），合计 39；
   walkthrough 增 7b 人工验收断言（3/3 点亮+操作入史+B 级证据）与 9b 落盘断言、7 步重试；
   scripts/uia-task-wizard.mjs（向导 acceptance 模式全流程实操 + 截图存档
   release-final/ui-audit/，另含 scripts/filedialog-uia.ps1 对话框操控尝试，UTF-8 BOM）。
9. **正式包（v5，含 D12 全部五项修复）**：SHA-256
   `7A347FD244A74ED72E238BC08D56EFD9A6160B58CA11FBAD1F89972825B5DA9C`（未签名；前序 v4
   `BB35D055F3CD23C0E8E78D0A0D405B098579F2B8878B677AC7776D72333F0497` 不含 clearProvider 修复，
   勿用）。最终验证（v5 安装态）：typecheck 0、runner http.test 8 测全绿（138+ 新增）、
   desktop 39/39、全链走查 exit 0（含 7b 人工验收闭环与 9b 落盘断言——provider.env key 移除、
   settings.modelProvider 移除）、13 步安装态冒烟（v4 包 %TEMP%\fd-smoke-v4 全通，runner 无改
   动复验）、UIA 向导实操全绿（截图 4 张 release-final/ui-audit/）、多实例互斥实测、
   落盘核对（config.toml 无 key 本体）。

## D13 认证即可选模型与设置页信息架构（2026-10-15，用户反馈驱动）

用户指令："不需要先选择目录和开启新会话，账号、api-key 或订阅认证通过就应该可以选择模型；
设置界面需要优化，整个客户端界面也需要优化。"

1. **认证即可选模型（refreshModels 三级回退链）**：
   - 优先：活动引擎 model/list（会话内真实可用模型）；
   - 回退：已配置 key 的激活提供方直拉 `GET {base}/models`（六家端点此前已实测存在）——
     **认证通过即可在顶栏/设置选择模型，不依赖选择项目目录或开启会话**；
     selectedModel 取 settings.defaultModel → 既有选择 → 列表首项；
   - 兜底：空列表（未认证且引擎不可用是预期状态，不再弹错误 toast）。
   - 联动：configureModelProvider 成功即刷新模型列表（defaultModel 同步为全局默认）；
     clearModelProvider 后刷新（列表回退/清空）；bootstrap 中 provider 目录先于 refreshModels
     串行完成（回退链启动时即就绪）。新增 models-fallback 测试 4 例（空列表不报错/直拉填充/
     preferred 优先/引擎优先不经 provider）。
2. **认证就绪口径统一（三处）**：`authStatus.ok || 激活提供方 keyConfigured`——顶栏
   「模型未登录」徽标、全局认证缺失横幅、设置页认证状态徽标同一口径：粘贴任一厂商 API key
   即视为认证就绪，不再提示"未登录"。走查新断言：假 key 保存后徽标立即消失。
3. **设置页信息架构重组（三分组）**：① 模型与账号（核心组置顶：提供方/key/默认模型/认证状态/
   官方登录——从分散三行合并为一组）→ ② 界面（语言/退出确认）→ ③ 诊断与关于（引擎与执行器/
   导出/版本）。新增 .fd-form__section 分组样式（分隔线+小节标题）；全部 data-testid 保持
   （走查兼容）；空态文案改「（配置认证后可选）」+ title 引导。
4. **整体界面文案对齐**：欢迎引导改三步说明（配置认证→选目录→开会话）；认证缺失横幅文案
   改为多厂商路径（"粘贴任一提供方 API key 或官方登录"）、按钮改「去配置认证」；顶栏模型
   下拉空态与 title 引导一致。
5. **正式包（v6）**：SHA-256 `84666DCED10C60E57EE77AA63AEBEFABCFF60BA8B5598FB1F0F9D4453C2EA9E0`
   （未签名）。验证：typecheck 0、desktop 46/46（42+新增 4）、安装态全链走查 exit 0（含新断言
   "key 配置后未登录徽标消失"与既有 7b/9b 全部断言、新分组布局溢出 0px、优雅退出）。

## D14 产品改名 ForgeStudio（2026-10-15，用户指令"客户端文件名冲突，改为 ForgeStudio"）

1. **改名范围（用户可见层全量，内部 npm scope @forgedesk 不动）**：electron-builder
   productName/shortcutName/copyright/appId（com.forgestudio.app）→ exe `ForgeStudio.exe`、
   安装器 `ForgeStudio Setup 0.1.0.exe`、安装目录 `%LOCALAPPDATA%\Programs\ForgeStudio`；
   窗口标题/页面 title/品牌字标（Forge<em>Studio</em>）/欢迎语/引擎署名（"ForgeStudio 引擎"）/
   app.info.name（契约 AppInfo 字面量类型同步）/登录终端标题与文案/config.toml 注释/错误框
   文案全量更名；登录引导脚本文件名 forgestudio-login-guide.cmd。
2. **userData 一次性迁移（数据无损）**：main 在 ready 前 setPath('userData', %APPDATA%\
   ForgeStudio)，且检测旧 `%APPDATA%\ForgeDesk` 存在而新目录不存在时 rename 迁移——任务库
   （forgedesk.db）/验收证据/引擎配置与登录态（auth.json）/profiles/settings 全部保留；
   迁移失败不阻塞启动（以新目录全新开始）。实测：迁移后 db 与 auth.json 均在新目录就位。
3. **验证**：typecheck 0、desktop 46/46（欢迎语/引擎名/横幅断言随更名更新）；旧 ForgeDesk
   静默卸载（用户数据按 NSIS 配置保留）→ 静默安装 ForgeStudio → **数据迁移实测成功**
   （ForgeDesk 目录消失、ForgeStudio 就位、db/auth.json 完好）→ 安装态全链走查 exit 0
   （9b 落盘断言在 ForgeStudio 新路径通过）→ 注册表 DisplayName "ForgeStudio 0.1.0"、
   桌面/开始菜单快捷方式 ForgeStudio.lnk（旧残留快捷方式已清理）。
4. **正式包（v7）**：`ForgeStudio Setup 0.1.0.exe`，SHA-256
   `59A0A0C29C48862625D456C356C6A8FB2B17649C88200EC9938D9B4096AA5B2D`（未签名）。
   旧命名的 ForgeDesk Setup 已从 release/ 移除防误装。

## D15 认证即可用：引擎预热 + preload 解包修复（2026-10-15，用户实测"不选目录/不开会话仍无法选模型、引擎未启动"）

1. **引擎预热（用户指令的正面实现）**：认证就绪（官方登录 ok 或激活 provider keyConfigured）
   即调 `engine.start` 完整启动引擎（initialize+thread），免选目录/免开会话。cwd 兜底链
   `recentProjects[0] → appInfo.homeDir → appInfo.dataDir`；成功后同步 project 状态（顶栏显
   项目名）并直接补拉模型列表。三处触发点：bootstrap 尾部、refreshAuth 认证转 ok、
   configureModelProvider 成功；`prewarmInFlight` 布尔守卫 + `status()!=='stopped'` 检查幂等
   （status 为 sendSync 直查主进程，非缓存）。
2. **根因修复（走查 1b 断言失败倒逼的深挖）——preload OpResult 解包缺失**：主进程
   `register()` 对全部 IPC 通道统一包 OpResult，而契约将 `app.info/settingsGet/settingsSet`
   三处声明为裸值（人体工学桥面），preload 原样透传 → renderer 存的是 `{ok,value}` 包装 →
   `appInfo.homeDir`/`settings.recentProjects`/`settings.defaultModel` 全域 undefined（不止
   预热：设置界面字段、默认模型恢复在真实安装态一直是空的，单测因 mock 按契约裸值实现而
   全绿——类型谎报的教训与 D12 契约谎报同型）。修复：preload 增 `invokeUnwrapped`（解包，
   失败转 throw 由 store 既有 catch 承接），三方法切换之；契约与 mock 不动。
3. **事件订阅时序修复**：原 bootstrap 在 Promise.all 之后才订阅 engine/runner 事件，而设备
   枚举（Get-PnpDevice）实测可达 22s、预热 4-10s 就把引擎拉到 ready——晚订阅错过
   engine/status(ready)，模型列表永不刷新。修复：订阅提前到 Promise.all 之前；尾部再按
   sendSync 实时状态兜底补拉 models/auth（覆盖订阅前窗口缝隙）。
4. **验证（安装态，冷启动）**：typecheck 0；desktop 52/52（新增 prewarm-engine 6 用例：
   官方登录预热/homeDir 兜底/project 同步/双触发幂等/recentProjects 优先/未认证不预热/
   引擎运行不重复 start/配 key 即预热）；contracts 34/34（修正过时断言 OPERATION_TYPES
   7→8，manual_review 为第 8 项）；runner 139/139；走查新增步骤 1b"未开会话模型下拉可选"
   ——冷启动实测 t=4s 引擎 ready、下拉 7 项可选；安装态全链走查 exit 0；随包 exe 作 Node
   的 13 步冒烟全过。
5. **正式包（v8）**：`ForgeStudio Setup 0.1.0.exe`，SHA-256
   `9678BB032B9EEED7C240C583886AD3654E92955B288A80F242CD226D91E2E0C8`（未签名）。

## D16 会话错误修复：预热线程绑定陈旧模型（2026-10-16，用户实测"会话出现错误"）

1. **根因（安装态复现取原文）**：D15 预热把 `settings.defaultModel`（陈旧残留 "deepseek-chat"）
   作为 options.model 传入 `engine.start` → 线程在 thread/start 时绑定该模型 → ChatGPT 认证下
   发送即 400：`The 'deepseek-chat' model is not supported when using Codex with a ChatGPT
   account` → 线程 systemError"会话不可继续"。下拉虽经 refreshModels 重置为合法模型，但线程
   模型已固定，换下拉不作用于已建线程（send 无模型参数）。
2. **修复三件**：①预热不传 model（线程用引擎默认模型，杜绝陈旧默认值入线程）；
   ②selectModel 即时生效——引擎 ready 且无进行中回合时，同项目根以新模型重建线程（等价静默
   "新会话"：重置会话态/刷新线程列表；回合中不重启防打断）——下拉成为模型选择的唯一权威
   入口；③`prewarmDone` 一次性标记：mock 场景暴露 refreshAuth 触发的预热完成后 in-flight
   复位、bootstrap 尾部再触发一次的异步双启动（真机靠主进程状态拦截，渲染层补自守）。
3. **验证（安装态端到端，含首次真实推理闭环）**：typecheck 0；desktop 55/55（新增 3 用例：
   预热不绑定模型/selectModel 重建线程并重置会话/回合中不重启）；E2E 冷启动→UI 发"请只回复
   两个字：收到"→**收到模型真实回复**→下拉切 gpt-5.6-sol→线程重建 ready→再发再收——K-1
   真实模型会话在用户 ChatGPT 登录下首次闭环（A-2/A-3 可复核）；安装态全链走查 exit 0；
   随包 exe 13 步冒烟全过。
4. **正式包（v9）**：`ForgeStudio Setup 0.1.0.exe`，SHA-256
   `8A2CAB64554AE45FB99A78B4C95EC8C2EBCD5F2C22B4789AA16C004B87D0F566`（未签名）。

## D17 四厂商 API key 产品内接入实测（2026-10-16，用户提供智谱/DeepSeek/千问/方舟 key）

1. **端点层实测（零/极低 token 分层探测）**：DeepSeek `/v1/responses` 与千问
   `compatible-mode/v1/responses` 均已支持 Responses 协议（HTTP 200 真实回复）；
   **智谱目录 baseUrl 修正**：`/api/paas/v4` 无 responses（实测 404），官方 Codex 专用端点为
   `https://open.bigmodel.cn/api/v1`（依据 docs.bigmodel.cn/cn/coding-plan/tool/codex，实测 200）；
   方舟 `/api/v3/responses` 存在，Agent Plan 亦有 `/api/plan/v3` 专属端点（key 未被其授权）。
2. **两个产品缺陷修复（E2E 倒逼）**：①**provider 切换不重建 adapter**——extraEnv 只随 adapter
   构造注入，同 root 重启复用旧 adapter 导致换厂商后旧 key 仍被注入子进程；engine-host 改为
   ensureEngineHome 先行 + `#adapterProviderId` 比对，provider 变更即销毁重建；configureModelProvider
   无 defaultModel 时也主动重建（selectModel 守卫从 `=== 'ready'` 放宽为 `!== 'stopped'`，防
   starting 期静默丢切换）。②**auth 误判**——app-server `getAuthStatus` 对自定义 provider 返回
   `authMethod:null + requiresOpenaiAuth:false`，adapter 误判"未配置凭证"把引擎卡在 auth_required
   （输入框被禁用）；新增 requiresOpenaiAuth===false → api_key（提供方自持凭证）映射。另将
   remoteControl/rateLimits 两类 0.162.1 噪音通知加入忽略表（不再计"未识别事件"）。
3. **方舟 modelHint 更新**（doubao-seed-1-6 等已下线；GET /models 实测返回 glm-5-3-flash/
   deepseek-v4 系等；早前 ModelNotOpen 为账号开通传播延迟，稍后自动可用）。
4. **验证（安装态 v12，四家逐一切换+UI 真实对话）**：DeepSeek(deepseek-chat)/千问(qwen-plus)/
   方舟(glm-5-3-flash-260828)/智谱(glm-4.6) 全部"配置→adapter 重建→输入框可用→UI 发送→收到
   模型回复 OK"；每轮含 provider.env/config.toml/adapter 重建核验。typecheck 0；adapter 50/50；
   desktop 55/55；安装态全链走查 exit 0；13 步冒烟全过。方舟另注：`/api/plan/v3`（Agent Plan 专属
   端点）对该 key 401，若用户开通 Agent Plan 企业版需切此端点。
5. **正式包（v12）**：`ForgeStudio Setup 0.1.0.exe`，SHA-256
   `40FE3CE543CD6CB5C83C5EDF775E5EDE1929CFDC0B01527FDA2B627CD1309C8A`（未签名）。
   工具链教训：探针正则里手打的"api-key"含 U+2011 连字符导致前三次 key 解析静默失败——
   自动化断言失败先查测量工具本身。

## D18 A-12 模型驱动工程任务闭环 + MCP 工具审批（2026-10-16，模型用 ChatGPT 订阅）

1. **A-12 全链闭环（产品核心价值首次完整点亮）**：新增 `scripts/model-task-e2e.mjs`（按需运行，
   消耗真实模型 token）——fixture 拷贝临时目录 → recentProjects 指向（预热 cwd=工程目录）→
   桥建任务 → UI 下发修复指令 → ChatGPT 模型真实回合：读码 → 最小修复（`match(/\S+/g) ?? []`）→
   经 MCP 工具 engineering.build + test×2 留证（runner 3 操作 2 证据）→ Node 侧独立核验
   （words=0 退出码 0）→ 人工验收点亮 → 验收通过 → 导出。全程 4-5 次审批（命令+工程工具）自动放行。
2. **两个产品能力补齐（首跑倒逼）**：①codex 0.162.1 把 MCP 工具调用确认包装为
   `mcpServer/elicitation/request`（实测 `_meta.codex_approval_kind=mcp_tool_call`、空 schema、
   `_meta.persist:["session","always"]`）——adapter 此前一律 decline 导致模型无法调用任何 MCP
   工具。现转成产品既有审批卡（新 kind `mcp_tool`·工程工具调用）：允许一次→accept；
   本会话内允许→accept+persist:session；拒绝→decline。②`engineering.build` 的
   profileRevision 改为可选（省略按当前修订执行，显式仍校验）——模型无需预查修订号。
3. **验收单语义澄清**：缺陷复现器（wordcount-empty-crash-repro）语义=检测缺陷存在，修复后
   failed 恰是"缺陷已除"的证据——修复类任务的验收单应将其设为非必需观察项（walkthrough 的
   带缺陷基线场景仍为必需）。
4. **走查加固**：任务变多后 latest 不再必然是走查任务——第 4 步经顶栏任务下拉显式选中
   （React 受控 select 须用原型 value setter + change 事件；下拉在 project 预热就绪后才渲染）。
5. **验证**：typecheck 0；adapter 50/50（patches 用例偶发抖动单跑即过）；desktop 55/55；
   contracts 34/34；runner 139/139；A-12 E2E 三轮迭代全绿；安装态走查 exit 0（第 9 步顺带
   验证 D17 auth 修复：provider 态显示"api_key·模型提供方 API Key 已配置"）；13 步冒烟全过。
   用户四家 provider key 在走查后被 9b 清除——已从 key 文件恢复 provider.env。
6. **正式包（v14）**：`ForgeStudio Setup 0.1.0.exe`，SHA-256
   `34DE3E015B317F5AF192E718A3F5D38633C1F9B21BAAD92BEDE0A768C674F53A`（未签名）。
   运维教训：强杀持有 CDP 调试端口的应用会把该端口打入幽灵态（bind 静默失败）——
   自动化循环中调试端口应逐次递增；PowerShell 后台管道会吞 node stdout，长跑脚本换新终端直跑。
