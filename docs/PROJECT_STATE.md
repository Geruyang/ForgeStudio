# ForgeDesk 项目状态（PROJECT_STATE）

> 每次阶段交付更新本文件；上下文切换时先更新这里。下一个 Agent 从这里继续，不重新讨论已定方向。

## 基本信息

- 项目：ForgeDesk（Windows 工程 Agent 工作台）
- 实施任务书：《Windows-Agent平台-笔记本实施任务书》（方案正文 v2.1）
- 输出目录：`e:\AiProject\agent-design\ForgeDesk-zcode\`
- **H0（开工时点）：2026-10-14 13:11 (+08:00)**，48 小时连续计时
- **H48 截止：2026-10-16 13:11 (+08:00)**；当前进度约 H+7
- 验收分级：T1 必达 / T2 条件目标（依赖硬件）/ T3 可顺延

## 工作规则（用户指令）

1. **模型用量低于 5% 时暂停子 Agent 调用，等待限额恢复后继续执行**（遇配额类报错等待重试，不放弃任务）。
2. 主会话统一指挥并接受人类用户指令；子 Agent 按任务复杂度分配，并行完成独立工作包。
3. 所有输出成果放入 ForgeDesk-zcode 文件夹内。
4. 多 Agent 共享仓库：**你不是唯一修改者，不得回退其他人的更改**；共享文件（契约、锁文件、公共注册点）由集成负责人（主 Agent）维护。
5. 真实设备操作串行；fixture 记录必须标注"模拟"，不算实机验收。
6. 不用 mock、便携目录或原版客户端成功替代对应验收；无法验证的部分保持未完成，不虚报。

## 多 Agent 分工（任务书 §14）——全部交付

| Agent | 所有权目录 | 状态 | 交付摘要 |
|---|---|---|---|
| 主 Agent（集成负责人） | contracts、desktop main/preload/bridge、electron-builder、脚本、合并 | **完成（集成中收尾）** | 契约 v1、主进程全套、NSIS 打包 |
| A：桌面体验 | renderer/** | **完成** | 85 模块构建通过、38 组件测试全绿 |
| B1：引擎适配 | engine-adapter/** | **完成** | 50 测试；真实 codex.exe 握手冒烟 |
| B2：执行器+MCP | runner 核心 + engineering-mcp | **完成** | 138+35 测试全绿 |
| C：设备适配 | runner/src/device/**、profiles | **完成** | 49 fixture 测试（模拟） |
| D：独立验证（第一波） | fixtures/acceptance/docs | **完成** | 契约 34 测试 + M 场景 + 文档四份 |

冲突修复记录（集成负责人）：contracts 补 `DeviceProfile` 导出与 IPC 通道；`--reporter=basic` → 移除（vitest 5）；device-port 改包导入；C 的测试 fixture 补必填字段；A 的 mock-bridge 补新方法；runner 包加 `./device` 子路径导出。

## 当前进度（2026-10-14 晚，H+9 左右）

### 已完成

- [x] Day-0：环境检查、codex 0.162.1 锁定+vendor、协议类型生成（743 文件）
- [x] 契约冻结 v1（实体/引擎事件/MCP 七工具/Runner 协议/IPC 白名单/Profile/DeviceAdapter 接缝）
- [x] 五 Agent 并行交付 → 集成修复 → 全工作区 typecheck 0 错误（逐工作区执行）
- [x] 全量测试通过（contracts 34 / runner 141+（含 m1/m5/m7 集成版解除 skip）/ mcp 35 / adapter 50 / desktop 38）
- [x] esbuild 四产物构建（main ESM / preload CJS / bridge CJS / runner service CJS 1.1MB）
- [x] **集成冒烟 13 步全通过**（A-16）：真实进程软件闭环——任务→真实构建→固定验收→证据→幂等→证据过期→导出→MCP 桥 7 工具握手
- [x] Electron dev 态冒烟（A-17）：12s 存活、runner utilityProcess 拉起、无错误
- [x] 引擎隔离冒烟（A-18）：真实 codex.exe 在产品 CODEX_HOME 握手
- [x] **NSIS 安装包完成并通过 A-10 安装后验收**：首次包冒烟暴露 runner 闭包缺件（debug/ms）→
      打包修复（dist/runner 自包含闭包 + node_modules 拷贝根）+ 数据目录规范化（%APPDATA%\ForgeDesk）
      → 重建 → 静默安装 → 启动/runner 服务（health/profiles/diagnostics 实测）/注册项/优雅退出全通。
      正式包见上方最终哈希（历次迭代包均已废弃），未签名
- [x] QA 第二波：m1/m5/m7 集成版 31/31（真实 runner 服务）；全量回归+typecheck 全绿
- [x] 根 typecheck 脚本修复（原 `tsc -b tsconfig.base.json` 会全仓误编译并 emit 1795 个旁产物，已清理）
- [x] **安装态深检**：`smoke-runner.mjs` 支持 FD_SMOKE_* 覆盖；随包 ForgeDesk.exe 运行安装目录
      runner/bridge，13 步工程闭环在安装产物上全部通过（A-13 升级为安装态已验证）
- [x] **GUI 自动化走查（CDP，最终包全绿）**：`scripts/gui-walkthrough.mjs` 驱动安装后应用完成
      外壳→设置→建任务→检查/构建/验证/导出（真实按钮）→验收 2/3 判定→引擎链（auth_required
      如实呈现）→优雅退出。过程中发现并修复三处 mock 掩盖的集成接缝（listTasks 瘦条目致任务
      列表恒空、devices 信封致整树崩溃、TOML 转义致路径双反斜杠），全部补回归。
- [x] **官方登录入口 + 界面信息架构优化（D9）**：设置页「官方登录」（中文引导终端进入随包 CLI
      官方 login，CODEX_HOME 隔离）+「刷新认证状态」；authStatus 引擎未启动时降级为 CLI 只读探测
      （认证状态/横幅/顶栏徽标开箱即见）；工程面板低频区块折叠收纳、顶栏新会话主按钮、未登录
      徽标常亮、导出诊断收纳进设置。
- [x] **登录终端报错修复 + 多模型提供方（D10）**：start 中文标题引号坑修复（终端实测弹出
      "ForgeDesk 模型登录"）；火山方舟/智谱/Kimi/千问/DeepSeek + OpenAI 六家接入（responses 协议
      实测可行）——设置页选择提供方、粘贴 API key（provider.env 隔离存储、界面不回显）、控制台
      外链直达；config.toml 自动生成 provider 段、key 经环境注入；OpenAI 另有订阅式官方登录。
- [x] **登录链路修复 + Coding Plan + 模型列表（D11）**：登录终端 CODEX_HOME 显式设置（修复
      WindowsTerminal 环境断链导致的"登录无效"）；引擎就绪/会话启动后模型列表自动刷新；
      六家 planNote 订阅套餐如实说明；「拉取模型列表」从厂商 GET /models 拉真实列表（假 key
      实测得到厂商 401 原文，失败保持手填）。UI 按 intentional-ui-design skill 复查（溢出检测 0px）。
- [x] **全面测试轮：人工验收闭环 + 五项缺陷修复 + 操纵电脑实操（D12，2026-10-15）**：
      ①manual 验收项死锁修复（manual_review 操作 + B 级人证证据 + 专用 API + UI 按钮，
      executable 项红线不变）；②manualReview/updateAcceptance IPC 契约返回类型谎报修正
      （AcceptanceItem[]，store 按 taskId merge）；③**验收单全量替换语义毁单缺陷**（store
      追加/采纳/移除改全量组装提交，remove 字段废弃）；④recordManualReview 改判回退
      requestKey 撞 UNIQUE 修复；⑤clearProvider 假清除修复（patch 浅合并 + 空 provider.env
      残留），走查 9b 补落盘断言。测试增量：runner http +1（8 测）、desktop 39、walkthrough
      7b 人工验收断言 + 9b 落盘断言 + 7 步重试；UIA 实操脚本（向导 acceptance 全流程 + 4 截图
      release-final/ui-audit/）；多实例互斥实测。观察中：背靠背运行验证偶发 UI 不刷新
      （D-12a，数据层无损重跑即亮）。
- [x] **认证即可选模型 + 设置页信息架构（D13，2026-10-15）**：refreshModels 三级回退链
      （引擎 model/list → 激活提供方直拉 /models → 空列表不报错）——**配置 API key 后即可
      选择模型，无需先选目录或开会话**；认证就绪口径三处统一（顶栏徽标/横幅/设置页：
      官方登录 ok 或激活提供方 keyConfigured 即就绪）；设置页重组三分组（模型与账号→界面→
      诊断与关于）；欢迎引导/横幅/空态文案对齐。新增 models-fallback 测试 4 例（desktop 46）。
- [x] **产品改名 ForgeStudio + 数据迁移（D14，2026-10-15，用户指令）**：productName/exe/安装目录/
      appId/窗口标题/品牌字标/全部文案更名 ForgeStudio（内部 npm scope 不动）；userData 一次性
      rename 迁移（任务库/验收证据/引擎登录态全保留，实测成功）；旧 ForgeDesk 静默卸载、
      残留快捷方式清理。
- [x] **认证即可用：引擎预热 + preload 解包修复（D15，2026-10-15，用户实测倒逼）**：认证就绪
      即自动 `engine.start`（cwd 兜底 recentProjects→homeDir），打开客户端免选目录/免开会话即可
      选模型、发消息；**深挖出两个存量缺陷并修复**——①preload 对 app.info/settingsGet/
      settingsSet 三通道未解包 OpResult（主进程全量包装），真实安装态 appInfo/settings 全域
      undefined（设置字段/默认模型恢复一直是空，单测因 mock 按契约裸值实现而全绿）；②bootstrap
      事件订阅晚于慢速刷新（设备枚举 22s），错过预热的 ready 事件致模型列表不刷新——订阅提前 +
      尾部按 sendSync 实时状态兜底。测试 desktop 52（+prewarm 6 例）；走查新增 1b"未开会话
      模型下拉可选"，冷启动实测 t=4s ready、下拉 7 项。**当前正式包 `ForgeStudio Setup
      0.1.0.exe`，SHA-256 `9678BB032B9EEED7C240C583886AD3654E92955B288A80F242CD226D91E2E0C8`**
      （v8；安装位置：默认 %LOCALAPPDATA%\Programs\ForgeStudio，注册表可查；数据
      %APPDATA%\ForgeStudio，已从旧目录自动迁移）

### 已实现 / 已验证 / 未验证 / 阻塞（当前快照 v12）

| 范围 | 状态 |
|---|---|
| 契约与协议类型 | 已实现（生成自真实 CLI） |
| 引擎适配（协议层） | 已实现+fixture 验证（50 测试）；provider 切换重建/auth 语义修正（D17） |
| 工程执行器（存储/状态机/快照/证据/HTTP/MCP） | 已实现+已验证（真实进程 13 步冒烟 + 集成版测试 + 173+ 测试） |
| 设备适配 | 已实现+fixture 验证（49 测试，模拟）；**实机未验证（无硬件）** |
| 桌面 UI | 已实现+组件级验证（55 测试）；认证即可用（预热）+ 模型切换即时生效；安装态全链走查通过 |
| 安装包 | **已验证（A-10）**：v12 静默安装/数据目录/runner/注册项/进程清理全通；未签名 |
| 模型认证与真实推理 | **已解锁（K-1 大半）**：ChatGPT 官方登录 + 智谱/DeepSeek/千问/方舟四家 API key 产品内真实对话闭环（D16/D17）；剩余：模型驱动工程任务 A-12 端到端 |
| 嵌入式硬件链 | **阻塞**：无板卡/探针（K-2）→ T2 未完成，保留 |
| git 可用性 | **阻塞**：未安装（K-3）→ A 级证据走内容清单回退（hasGit=false），运行时自动探测 |

## D18 补充（v14，2026-10-16）

- [x] **A-12 模型驱动工程任务闭环 + 方舟 Agent Plan 双端点**：ChatGPT 订阅下模型在产品内完成
      "建任务→真实修复 wordcount 空输入崩溃→经 MCP 工具构建/验证留证→人工验收→导出"全链
      （scripts/model-task-e2e.mjs）；MCP 工具调用确认（elicitation）转产品审批卡（mcp_tool）；
      build 的 profileRevision 可选；目录新增 volces-ark-plan（/api/plan/v3）。**当前正式包 v14，
      SHA-256 `34DE3E015B317F5AF192E718A3F5D38633C1F9B21BAAD92BEDE0A768C674F53A`**

## Z0 阶段交接：Trae → ZCode（2026-10-17）

- 开发环境由 Trae 切换为 **ZCode**；目录由 `ForgeDesk-trae` 迁移为 **`ForgeDesk-zcode`**，
  后续所有开发输出只放入本目录（用户指令）。
- 迁移方式：因 D-6 系统级句柄锁定目录树无法 rename，采用完整复制。**复制暴露并修复了一个
  迁移缺陷**：npm workspaces 在 `node_modules/@forgedesk/*` 的 5 个 junction 被 robocopy 展开为
  实体副本（其中 desktop 链接把 2.1GB 构建产物一并带入），导致 TS 解析出两份契约类型
  （TS2717 全局声明冲突 + recentProjects TS2339）；已删除实体副本并按原布局重建 5 个 junction，
  **全工作区 typecheck 复验 0 错误**。
- 迁移内容：源码/文档/依赖/运行时数据全量；release、release-final、.electron-cache 产物目录
  未复制，正式安装包 exe、SHA256SUMS、blockmap、ui-audit 验收截图已单独补回；源码与文档 5 处
  路径引用已改为 `ForgeDesk-zcode`。
- 清理：新目录删除 dist/、.vite 缓存、builder-debug.yml（均可再生）；旧目录 `ForgeDesk-trae`
  已尽量删除（锁定残留待重启后清），原写有弃用标记。
- 迁移后基线：ZCode 环境 Node v24.21.0 与原环境一致；typecheck 全绿。
- 后续开发排期移至 **`docs/ROADMAP.md`**（Z0–Z3 阶段），本文件继续承担阶段状态记录。

## Z1 阶段交付（2026-10-17，ZCode）

- [x] **Z0-4 版本控制启用**：git init + 基线入库（7 commits）；`hasGit=true` 真实路径回归
  （probeGit + captureSourceSnapshot 于仓库内 fixture，非检出环境自动跳过）。K-3 正式解除。
- [x] **Z1-1 模型列表直拉实测**：发现 D19（2026-10-16 晚）已实现四家拉取 + providerModelMemory
  但未记录未验证——本轮补 main 进程 node 测试环境（vitest projects 双环境）+ live 回归：
  **方舟 35 / 智谱 3 / 千问 176 真实过**（含方舟下线剔除、Agent Plan 404 回落）；DeepSeek/Kimi
  无 key 自动跳过（不算通过）。
- [x] **Z1-3 token 用量呈现收尾**：发现 D19 已有 usage/updated 投影与 TokenUsageBar——补齐
  测试并**修复会话切换残留缺陷**（session/started 未清 tokenUsage，旧线程用量串到新会话）。
- [x] **Z1-4 should 场景补齐（部分）**：中文+空格路径端到端（真实构建/验收/快照指纹）+
  输入组合（二进制单字节可检出、200 文件深嵌套确定性）。未做：B级快照（Z2）、热插拔/长串口
  （设备 fixture 扩展）、第二 Windows 用户（需环境）。
- [x] **Z1-5 多会话管理纵切片**：重命名（title meta 持久化 + thread/name/set 同步）、删除
  （幂等清文件 + thread/delete）、搜索（标题/项目根过滤）、上下文压缩（thread/compact/start +
  session/compacted 事件投影 + ChatView 入口）。**契约 v1 增量**（集成负责人变更）：
  CLIENT_METHODS +3、EngineAdapter +3 方法、EngineEvent +session/compacted、IPC +3 通道。
- [x] **Z1-2 D-12a 根修**：根因定位为 refreshTask 并发响应乱序回达时旧快照覆盖新状态
  （SSE 事件风暴 → 多并发 getTask → upsertTask 无条件替换）。修复：per-task 单飞合并 +
  updatedAt 单调防御，3 例回归。**走查重试兜底可撤**（待安装态走查复验后移除）。

### Z1 测试基线

typecheck 0 错误；全量回归：contracts 34 / runner 146（+git 2、+组合 5）/ mcp 36 /
adapter 60（+usage 2、+会话管理 5）/ desktop 72+6 skip（+token 6、+会话管理 8、+竞态 3；
skip 为无 FD_LIVE_ENGINE_HOME 的 live 用例）。

## 下一步

见 `docs/ROADMAP.md`（ZCode 阶段开发安排：Z0 迁移基线 → Z1 产品补全 → Z2 发布工程 →
Z3 硬件实机条件项）。

## 阻塞与升级项（需要用户提供）

| 阻塞 | 需要 | 影响范围 |
|---|---|---|
| 模型认证（K-1） | Codex API key 或账号登录授权（在产品专属 CODEX_HOME 内，产品设置界面或 `codex login --api-key` 辅助） | 真实模型会话 A-2/A-3、模型驱动软件任务 A-12（T1 的该子项） |
| 实机硬件（K-2） | 至少一套用户可手工构建/烧录的板卡+探针+串口 | T2 实机闭环 A-14 |
| git（K-3，Z0 起**已具备**） | ~~允许安装 Git for Windows~~ ZCode 环境 Git Bash 自带 git CLI；待 Z0 执行 `git init` 后验证 hasGit=true 证据链 | A 级证据 commit/diff 摘要增强（当前走内容清单回退） |
| 代码签名（可选） | 签名证书/服务 | 安装包免 SmartScreen 告警 |

不阻塞项：UI、协议、存储、设备适配代码、打包、fixture、文档已全部就绪。

## Z2/Z3 阶段交付（2026-10-17 晚，ZCode；正式包 v15）

- [x] **Z3-FZ3B 硬件接入（T2 首段实机）**：FZ3B/ZU3EG 经以太网点对点发现（169.254.220.254，
  MAC 00:0a:35:…），SSH 手工演练通过（ubuntu/ubuntu，板上 gcc/make/python3）。集成方式：
  **SSH 远程执行作为 profile 命令可选传输**（契约 v1 增量：ProfileCommand.ssh/SshTarget，
  密码经环境变量注入）；runner 上传输入清单到板上内容寻址目录 → 板上构建/验收 →
  产物取回本地证据管线。fixture 3 例 + **实机验收 1 例**（main.c→板上 gcc→板上运行→
  TESTS_PASSED+BOARD_HOST 回报→证据落库→验收点亮，4.0s 全链）。STM32/probe-rs 路线按用户指示暂缓。
- [x] **Z2B-1 B 级快照证据**：profile.buildFromSnapshot 启用后输入复制到任务专属内容寻址快照目录，
  构建/验收从快照执行、产物独立归档、快照记录 B 级+snapshotPath；复核针对快照（源漂移不误报本次，
  M5 时效语义保持——构建期间源被改的用例证明隔离生效且后续验收不点亮）。UI 文案合规
  （A 级注明"不构成防篡改保证"；B 级注明快照绑定）。
- [x] **Z2B-2 review/start**：评估完成——完整审阅面板留待后续，引擎侧接口先行
  （EngineAdapter.startReview，当前线程 inline/uncommittedChanges，2 例回归）。
- [x] **Z2B-3 设备 fixture 扩展**：热插拔身份变化（序列号变化→新绑定不复用；换型号→拒绝）、
  长串口流（1000 行旧日志+50 噪声→flush 丢弃、nonce 判定不受干扰）。
- [x] **Z2C 更新检查 scaffold + 发布物规范**：AppSettings.updateFeedUrl + app:check-update
  （仅比对告知，不下载安装；6 例测试）；BUILD.md 发布三元组与 update-feed.json 规范。
- [x] **Z2A 打包验证关口（v15）**：
  - 构建+NSIS 打包：**SHA-256 `F8661AD1C6B488E6ACD536F687242F249CB5A52BC298D19AEB31EDBB5B871C94`**
    （未签名；对应 commit 见 ROADMAP 发布记录；release-final 已留存）
  - 静默安装 + v15 标记核验（asar 含 checkUpdate/renameThread、runner 含 ssh-transport）
  - **安装态冒烟 13/13 全绿**（A-13 深检口径：真实构建/验收/幂等/证据过期/导出/MCP 桥 7 工具）
  - **GUI 走查 exit=0，31 项断言全绿**：新增 D-12a 真·背靠背复验（双验证连点直接点亮，重试兜底已撤）、
    会话管理 9c（搜索过滤/空态/清空/行内重命名/两步删除/压缩入口渲染条件）；React 19 受控输入
    需 CDP 键盘级事件驱动（原生 setter+input 事件无效）已记入脚本
  - model-task-e2e（A-12 v15 复验）：**阻塞于 ChatGPT 订阅额度用尽（10-23 重置）**——引擎如实
    呈现 systemError 与配额原文（不虚报）；v15 引擎链健康已由走查 step 9（握手/authStatus/预热）证明

### Z2/Z3 测试基线

contracts 34 / runner 151（+B级快照 2、+热插拔长流 2）/ mcp 36 / adapter 62（+review 2）/
desktop 79+6skip（+更新检查 7）；typecheck 0 错误；安装态 13 步冒烟 + 31 断言走查全绿。

## 下一步（v15 后）

1. **A-12 v15 复验**：ChatGPT 额度恢复（10-23）或切换方舟/智谱 key 激活后重跑 model-task-e2e
2. **FZ3B 工程深化**：真实工程样例（板上 make 工程 profile）、B 级快照+SSH 组合、设备授权卡与
   SSH 目标的 UI 呈现（当前经 profile 直达）
3. Z2C 完整更新通道（electron-updater，待签名证书）；审阅面板（review/start UI）
4. 第二用户回归、DeepSeek/Kimi 列表 live（待外部输入）

## v15 后续交付（2026-10-18，ZCode）

- [x] **A-12 v15 复验**：切换智谱 glm-5.3（ChatGPT 额度 10-23 恢复）——模型修复缺陷 → Node 侧
  独立核验 → MCP 留证（3 操作 2 证据）→ 人工验收 → 导出全链通过（ACCEPTANCE 已记录）。
- [x] **FZ3B 工程深化**：真实 make 工程（Makefile + C 自检工具，板上原生构建）+ fz3b-make profile；
  实机验收 3.6s（make→自检→B 级证据落库），**B 级快照 × SSH 组合**同用例覆盖。
- [x] **审阅入口（Z2B-2 UI）**：IPC engine.review → adapter.startReview；ChatView「代码审阅」按钮
  （live 会话 + 非回合中显示）；store 双守卫（无会话/回合中不调桥）。审阅过程以普通会话事件回流
  现有消息流渲染（协议评估结论：inline 审阅无独立 item 视图需求）。
- 测试基线：contracts 34 / runner 153+2skip(live) / mcp 36 / adapter 62 / desktop 80+6skip；typecheck 0。

## 下一步

1. v16 打包（含审阅入口与 FZ3B profile）+ 走查补「代码审阅」按钮断言（需模型回合，走查暂无）
2. FZ3B：SSH 目标在设备/授权 UI 的呈现（当前经 profile 直达，无授权卡语义——按需细化）
3. electron-updater 完整通道（待签名证书）；DeepSeek/Kimi 列表 live（待 key）；第二用户（暂缓）

## v16 阶段交付（2026-10-18，ZCode）

- [x] **Z3 呈现层**：inspect 集成 SSH 目标探测（TCP 可达 + 密码环境变量状态，inspect resultSummary
  含 SSH 异常统计）；工程面板「远程目标（SSH 板卡）」行（host:port/用户/密码变量名，无目标不渲染）；
  ProfileSummary.sshTargets 摘要 + store.profileSummaries。测试 runner 4 + renderer 2。
- [x] **v16 验证关口**：构建打包 **SHA-256 `99DD0573F3415BC68E3C665F22A0B50DF1F118D236E5AC11AC791957647B4EA7`**
  （未签名，release-final 留存）→ 静默升级安装（v15→v16，标记核验）→ **安装态冒烟 13/13** →
  **GUI 走查 exit=0 / 34 断言全绿**（新增审阅按钮/远程目标行渲染条件断言；走查搜索改用
  最小唯一前缀——A-12 批量会话标题前缀高度相似）。
- 测试基线：contracts 34 / runner 157+2skip(live) / mcp 36 / adapter 62 / desktop 82+6skip；typecheck 0。

## 下一步

1. FZ3B GUI 级使用链：应用向 runner 传递 SSH 凭据环境（当前需带 FZ3B_PASSWORD 启动应用），
   与设备授权卡语义整合（按需）
2. electron-updater 完整通道（待签名证书）；DeepSeek/Kimi 列表 live（待 key）；第二用户（暂缓）

## v17 阶段交付（2026-10-18，ZCode）——FZ3B 硬件 GUI 闭环打通

- [x] **SSH 凭据产品内管理**：dataDir/ssh-credentials.env（与 provider.env 同保护级）；
  IPC set/clear/names（仅回变量名）；RunnerHost 启动注入子进程 env；远程目标行升级为
  「密码已配置/未配置徽标 + 配置/更换（type=password 不回显）/清除 + 变量名呈现」；
  重启注入语义如实提示。测试 +1（配置交互→状态翻转→不回显）。
- [x] **v17 验证关口**：**SHA-256 `5EA743A20CC47EF505B3704942DA09E8A9B96D9D3820C37F14B15B6B7057F879`**
  （未签名，release-final 留存）→ 静默安装（标记核验）→ **安装态冒烟 13/13** →
  **GUI 走查 exit=0 / 36 断言全绿**。
- [x] **走查 9d：FZ3B 真实硬件 GUI 闭环**（产品口号的完整实证）：真实按钮路径
  建任务 → 远程目标行呈现 → 环境检查（SSH 目标 TCP 探测）→ **板上 make 构建 + 产物取回** →
  **板上自检验收点亮**——全程经 UI/IPC/runner/SSH 链路在 ZU3EG 实机执行。
- 用户已补充有额度的 API key（智谱路径 A-12 已于 v15 复验通过；ChatGPT 额度 10-23 恢复）。
- 测试基线：contracts 34 / runner 157+2skip / mcp 36 / adapter 62 / desktop 83+6skip；typecheck 0。

## 下一步

1. electron-updater 完整通道（待签名证书）；DeepSeek/Kimi 列表 live（待 key）；第二用户（暂缓）
2. （可选）FZ3B 更大工程样例（多文件 C 工程/板上单元测试框架）；设备授权卡与 SSH 目标整合

## v18 阶段交付（2026-10-18，ZCode）——用户项目实机验证 + 完整更新通道

- [x] **fz3b-semantic-video-search 用户项目实机验证**（A-14-SSH 第二个真实项目）：
  vendored PS 用户态组件；板上编译（read_clock/mjpeg_source/NEON native -Wall -Wextra 零告警）+
  自检（构建完整性 + 非根 /dev/mem 拒绝语义）+ B 级证据，7.1s 全链。
  ort_runner 需 /root 下 onnxruntime SDK（root-only），如实排除并注明。
- [x] **Z2C 完整更新通道**：electron-updater（generic provider）；autoDownload=false——下载/安装
  均用户触发（进度% + confirm 确认重启）；package.mjs 现算 latest.yml（sha512/size 与安装包一致，
  打包机断言测试）；设置页完整链 UI；未签名包如实说明。
- [x] **v18 验证关口**：**SHA-256 `C903EF4A348E89FB7122533FE8AC846B99FB99A4ED1B5C2EDF01B15F9F45720E`**
  → 静默安装 → 冒烟 13/13 → 走查 exit=0/36 断言（含 FZ3B 硬件 GUI 闭环 9d）。
- DeepSeek/Kimi live：provider.env 无对应 key（用户新增的是智谱额度），如实跳过。

## 3 轮 Bug 筛查（2026-10-18，ZCode）——5 项实际缺陷修复，全门复验绿

**R1 静态扫描**（typecheck 严格/危险模式 grep/泄漏模式）：
1. B级快照复核产物自污染（本地 B 级构建产物写入快照目录，未排除的 profile 复核时把产物计入
   输入清单 → 误报 evidence_stale）——复核快照目录时产物 glob 防御性并入 inputExcludes
2. quitAndInstall 被 will-quit 优雅收尾拦截（app.exit 抢先，安装器不启动）

**R2 代码审查**（R1 后新增模块逐文件）：
3. quitAndInstall 标记循环依赖（打包后 require('./index.ts') 不可用 → 修复 2 实际未生效）——
   独立共享状态模块 update-install-flag
4. SSH connect 失败 socket 泄漏（句柄悬挂）
5. SSH exec 超时悬挂（OpenSSH 7.6 close 延迟缺陷影响超时路径）——timeoutMs+5s 硬兜底

**R3 运行时审计**（v19 含全部修复：冒烟 13/13 + 走查 36 断言 + FZ3B 硬件闭环 +
fz3b-make/fz3b-svs 双 live 实机 + B级快照回归——全绿）
正式包 **v19 SHA-256 `8AF8511A9E373887F788301D99D70A3DD4B33ACB0E6678CE3A22AB5A62F5BAC8`**（未签名）

## 客户端优化（2026-10-18，ZCode）——v20

- main bundle **2.80MB → 0.25MB（-91%）**：electron-updater 构建期 external + 运行时按需
  require（更新检查路径才加载 js-yaml/semver 全家桶，冷启动不再解析）；sourcemap 外置
  （内联 sourceMap 使产物体积翻倍，外置可调试且不随包分发）
- 安装包 211.6→211.1MB（主 bundle 占比小；updater 依赖仍随包 node_modules 供按需加载）
- 全门复验：冒烟 13/13 + 走查 36 断言 + FZ3B 硬件 GUI 闭环 ✅
- 正式包 **v20 SHA-256 `9C9D43F9301098E54BB11531801656B2B4FA9C5824FE58340EDA55BBC1850822`**（未签名，release-final 留存含 latest.yml/blockmap）

## 深度审查（全面检查，2026-10-18，ZCode）——4 项缺陷修复 + 全门复验

A-D 四层（契约/适配层→runner→主进程→渲染层）+ 安全面专项逐文件审查：

**修复**：
1. session/compacted 后 threads 列表未刷新（压缩改变 thread 服务端状态——消息数/活动时间）
2. SettingsStore.patch 读改写竞态（并发调用丢更新）——Promise 链串行化
3. openExternalTerminal projectRoot 内嵌引号注入面——清除引号后拼 cmd
4. MessageItem 巨型助手文本（>4000 字符）撑爆 DOM——折叠预览+展开按钮
   （流式中/用户消息不折叠）；3 例测试

**审计通过（无缺陷，重点面）**：IPC 契约 50 键全注册（engine.status 走 sendSync 白名单）；
loadPatch patchRef 正则防穿越；SSH host 无 renderer 注入面（profile 文件来源）；凭据变量名
白名单；HTTP body 上限 413；token timingSafeEqual；诊断 redact；导出无凭据；profile 用户
目录优先次序正确；bootstrap 双订阅防护；DiffPanel 分块加载；WAL+事务存储；settings 原子写。

**v21 全门复验**：冒烟 13/13 + 走查 exit=0/36 断言 + FZ3B 硬件 GUI 闭环 ✅
正式包 **v21 SHA-256 `0EE357B7C5A6367C6CC2AC1AEFCA047BE8C5B8CFBAAEA278279A88F36D614484`**（未签名，release-final 留存含 latest.yml/blockmap）

## Z4 清单推进（2026-10-18 晚，ZCode；用户提供 DeepSeek key，Kimi 指示暂缓）

- [x] **Z4-B1 DeepSeek 模型列表 live**：key 落 provider.env（产品等效路径）→ live 测试
  **deepseek 2 模型（deepseek-flash、deepseek-v4-pro）非空/去重/排序全绿**；同轮方舟 36 /
  智谱 3 / 千问 176 复验过；moonshot 无 key 自动跳过（暂缓，skip≠通过）。附加推理 sanity
  （chat/completions 51 token 正常）。附带修正 deepseek/zhipu modelHint 为实测口径。
- [x] **D-4b 根因修复（非单纯复查）**：`#emitPatchApplied` 异步落盘 fire-and-forget，
  `patch/applied` 可能晚于同回合 `turn/completed` 投影（适配层事件顺序真实缺陷）。
  改同步落盘保序 + 测试顺序断言；**patches 用例 20 连跑全绿**，adapter 62/62。
- [x] **测试链修复（静默虚报风险）**：contracts `npm test` 脚本走 `node --test` 路径跑出
  0 用例仍报成功（根链路 contracts 从未实际执行）——改为与其他工作区一致的 vitest；
  顺带确认 D-4a（reporter=basic）已在早前版本修复，全链复验。
- [x] **环境残留清理**：`apps/desktop/release/win-unpacked/` 删除成功（句柄已释放）；
  `release/`+`release-final/` 哈希复核均 v21（0EE357B7…D4484）。
- 测试基线（全量复验）：contracts 34 / runner 157+3skip / mcp 36 / adapter 62 /
  desktop 88+6skip；typecheck 0 错误。
- 剩余外部依赖：Z4-B2 签名证书、Z4-B3 管理员沙箱授权、Kimi key（暂缓）；Z4-A1/A2 用户暂缓。

## 下一步

1. Kimi key 恢复后同法补 live（框架就绪）；Z4-B2/B3 待用户提供证书/授权。
2. Z4 可选增强（完整审阅面板 UI、设备授权卡整合、FZ3B 更大工程）按需排期；
   任一项交付照例走打包验证关口（v22）。
