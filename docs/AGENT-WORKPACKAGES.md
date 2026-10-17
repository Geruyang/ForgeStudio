# AI 员工工作包（AGENT-WORKPACKAGES）

> 冻结契约后的并行分工。每个工作包包含：目标、允许修改目录、接口版本、验收条件、禁止范围。
> 契约版本：v1（packages/contracts，集成负责人维护，**只读引用**）。
> 通用规则：你不是唯一修改者，不得回退他人更改；共享文件（contracts、锁文件、公共注册点）由主 Agent 维护，需要变更时提交给主 Agent。

## 主 Agent（集成负责人，本会话）

- 所有权：`packages/contracts/**`（契约冻结后仅修 bug 级问题并通知全员）、`apps/desktop/src/main/**`、`apps/desktop/src/preload/**`、`apps/desktop/src/bridge/**`、`apps/desktop/electron-builder.yml`、`apps/desktop/scripts/**`、根 `package.json`/`package-lock.json`、`tools/vendored/**`、docs 合并
- 交付：可安装主线、版本清单、阶段报告

## Agent A：桌面体验（renderer）

- 目标：Electron renderer 内实现自有品牌 UI——项目/会话侧栏、消息流（增量/节流渲染）、计划卡、操作卡、审批卡、代码差异面板、工程交付面板、设置、诊断导出入口
- 允许修改：`apps/desktop/src/renderer/**`、`apps/desktop/src/renderer/test/**`
- 接口：仅经 `window.forgedesk.*`（packages/contracts/src/ipc.ts 冻结）调用主进程；不直接 require Node 模块；不硬编码引擎协议
- 验收：Vite 构建通过、typecheck 通过；组件级测试（关键交互：审批决定、steer 送达态、验收单渲染）；连接真实事件桥接点（MainBridge mock 实现 + vitest fixture 事件流）
- 禁止：改 main/preload/bridge/契约；实现引擎循环或证据判定（面板显示由 contracts computeTaskAcceptance 驱动）；模拟数据冒充真实状态

## Agent B：引擎与工程状态

- 目标：① engine-adapter：Codex app-server stdio JSONL 接入（0.162.1 生成类型）；② engineering-runner 的状态/存储/操作/快照/HTTP 控制面；③ engineering-mcp：MCP stdio 服务桥接七工具
- 允许修改：`packages/engine-adapter/**`、`packages/engineering-mcp/**`、`packages/engineering-runner/src/{storage,ops,snapshot,http,profiles,index*}/**`
- 接口：EngineAdapter（contracts/src/engine.ts）；runner 控制协议（contracts/src/runner-api.ts）；MCP 工具（contracts/src/mcp-tools.ts）；实体与状态机（contracts/src/engineering.ts）；协议类型在 contracts/src/protocol/codex（生成，只读）
- 验收：各包 vitest 测试通过（含 fixture 协议流、状态机、requestKey 幂等、A 级指纹、SQLite 迁移）；typecheck 通过
- 禁止：改 `src/device/**`（C 所有）；改 contracts；降低验收阈值；改硬件底层驱动
- 注：**不要实现双引擎**（Claude 保留适配边界，不落地）

## Agent C：设备适配

- 目标：runner 的设备目录——设备枚举/绑定、独占锁、烧录（probe-rs CLI 包装）、串口验证（nonce+buildId）、unknown 恢复语义；一个板型 profile + 设备 fixtures
- 允许修改：`packages/engineering-runner/src/device/**`、`engineering/profiles/**`、`packages/engineering-runner/test/device/**`
- 接口：设备类型（contracts/src/device.ts）、DeviceProfile（contracts/src/profile.ts）、操作状态机（contracts/src/engineering.ts）；经 B 提供的 OperationStore/Storage 接口协作（B 先冻结这些内部接口文件）
- 验收：设备状态机 fixture 测试（虚拟探针/回环串口）通过；独占与去重用例通过；无实机——所有 fixture 测试标注"模拟"
- 禁止：改 B 的核心目录；并行抢占设备（单设备独占语义必须成立）；改共享调度

## Agent D：独立验证（QA）

- 目标：跨包测试与 fixtures、验收记录、使用说明、支持矩阵、第三方许可清单
- 允许修改：各包 `test/**`（不碰 src/）、`engineering/fixtures/**`（设备 fixtures 与 C 协作）、`engineering/acceptance/**`、`docs/ACCEPTANCE.md`、`docs/KNOWN_ISSUES.md`、`docs/engineering/**`
- 接口：同上；验收执行结果只信真实命令输出与日志
- 验收：M1/M2/M3/M5/M7 的 fixture 级测试落地并记录；验收单模板可用；文档区分已实现/已验证/未验证/阻塞
- 禁止：修改实现使测试通过；以实现 Agent 口头报告代替验收；把 fixture 结果标成实机结果

## 协作要点

- B 与 C 同包不同目录：B 先创建 `src/device/README.md`（接口占位说明）并冻结 OperationStore 内部接口后，C 才开始；两人不互相改目录。
- 真实设备操作串行；本机无硬件，一切设备验证走 fixture（虚拟探针），证据标注"模拟"。
- 主 Agent 按 T1 路径集成：契约 → B（引擎+runner 核心）→ C（设备）→ A（UI）→ D（验收）滚动合并，每批合并后跑测试。
