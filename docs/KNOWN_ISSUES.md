# 已知问题与未验证能力（KNOWN_ISSUES）

> QA Agent（D）与集成负责人共同维护。已知问题、未验证能力、可用替代方式。

## 阻塞类（需用户提供）

| # | 问题 | 影响 | 替代方式 |
|---|---|---|---|
| K-1 | 无模型凭证（API key/账号登录） | 真实模型会话、T1 引擎驱动软件任务无法验收 | 引擎适配层提供 fixture 事件流供 UI/存储开发；产品交付后用户自行配置 |
| K-2 | 无嵌入式板卡/探针/工具链 | T2 实机闭环（M6/M8/M9）无法执行 | 设备适配用 fixture（虚拟探针+回环）开发并标注模拟 |
| K-3 | 系统未安装 git | A 级证据的 gitCommit/dirtyDiffDigest 字段为空 | 运行时探测：有 git 自动启用；无 git 走完整输入清单内容摘要（hasGit=false 标明） |

## 限制声明（首发范围，任务书 §4.3）

- 仅认证 Windows 11 x64；Windows 10 / ARM64 未验证。
- 无代码签名证书 → 安装包未签名（SmartScreen 可能告警）。
- MXC 沙箱未预置（未获得管理员授权执行 sandbox setup 探测）；设备操作走"引擎审批之外独立授权 + 执行器强制校验"，不宣称"受控自主设备操作"。
- 串口身份验证（nonce+buildId）是工程版本校验，不是抵抗恶意固件的密码学证明。
- A 级证据声明："证据绑定当前工作区状态"；模型可写范围内的输入变化可被检测，但不构成防篡改保证。

## 开发中已知问题（QA 第一波，2026-10-14）

### D-1 M 场景集成版测试——已解除 skip（2026-10-14 晚，QA 第二波）
- 状态更新：B2 `createRunnerService` 已交付。m1/m5/m7 三个集成版用例对真实 runner 服务
  **31/31 真实通过**（GET /api/diagnostics 无凭证命中、同 requestKey 幂等、hasStaleEvidence 闭环），
  详见 ACCEPTANCE「QA 第二波」。`describe.skipIf` 现为自动放行，非跳过。
- 仍待前置的两项（非 skip 语义，记录在案）：
  - M1 的 app:exportDiagnostics 桌面导出文件扫描（待桌面导出联调用例）；
  - M7 实机烧录去重（T2，无硬件）。

### D-2 sample-tool 修复演示待模型凭证（关联 K-1）
- `engineering/fixtures/sample-tool/`（wordcount 版）的"由模型修复空输入崩溃"演示需模型凭证；
  无凭证时可手工修复后走工程面板重复 build/test 完成等效闭环（见其 README"修复后如何验证"）。
- 注意与既有 `engineering/fixtures/software/sample-tool/`（行数统计版）并存：同一 T1 故事的两个
  fixture 实现，profile id 互不冲突（`sample-tool-wordcount` vs `sample-tool`）。

### D-3 设备 fixtures 待 Agent C 交付
- `engineering/fixtures/` 的 device 子目录归 Agent C 所有；本波验收模板（嵌入式 4 项）与文档已按
  contracts `DeviceProfileSchema` 语义先行编写，C 交付 fixtures 后补 A-15 验证记录。

### D-4 发现的实现/脚本问题（非 D 所有权，待负责人处理）
| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| D-4a | ~~`--reporter=basic` 在 vitest 5 已移除：`npm test -w packages/engineering-runner`（及 apps/desktop）直接崩溃~~ | 各包 package.json test 脚本 | **已修复**（后续版本脚本已去 basic reporter；2026-10-18 全链 `npm test` 复验通过） |
| D-4b | ~~B1 既有测试 "patches" 用例偶发失败（约 10 次运行 1~2 次）~~ | engine-adapter | **已修复（2026-10-18，集成负责人）**：根因是 `#emitPatchApplied` fire-and-forget 异步写盘后才发 `patch/applied`，与同步投影的 `turn/completed` 存在乱序竞态（事件顺序无保证，属适配层真实缺陷而非测试时序）。修复：patch 落盘改 `mkdirSync/writeFileSync` 同步路径，保证 patch/applied 先于同回合后续通知投影；测试补顺序断言。**连续 20 轮单跑全绿 + 全量 62/62** |
| D-4c | M1 凭证扫描器曾漏检 JSON 形式赋值 `{"apiKey": "..."}`（键名带尾引号时不命中）——诊断/导出恰以 JSON 为载体；已在 m1 测试修复正则（`["']?`）并加注释 | m1 测试（已修） | B2 实现真实导出时复用同一扫描器语义 |

### D-6 环境残留（2026-10-14 晚，非产品缺陷）

- ~~`apps/desktop/release/win-unpacked/`：首次打包的旧产物，句柄占用删除被拒~~
  **已清理（2026-10-18）**：系统句柄释放后删除成功；`release/` 与 `release-final/` 中
  ForgeStudio Setup 0.1.0.exe 哈希复核均为 v21（0EE357B7…D4484），正式证据不受影响。

### D-5 已修复的 D 侧问题（记录供追溯）
- m1/m5 前波遗留用例两处失败（本波首跑暴露、随即修复）：①扫描器 JSON 盲点（见 D-4c）；
  ②m5-fingerprint-stale"等长不同内容"用例的等长假设错误（'临时说明!' 多 1 字节 → 改'临时注解'，
  13 字节等长）。

## 全面测试轮新记录（2026-10-15，D12）

### D-12a 背靠背运行验证偶发 UI 不刷新（数据层无损）【已根修 2026-10-17，Z1-2】
- 根因：SSE 事件风暴（acceptance/evidence/operation 连发）触发多个并发 `refreshTask` GET；
  HTTP 响应乱序回达时**旧快照覆盖新状态**（store `upsertTask` 无条件全量替换）——
  数据层正确、UI 停留旧值、重跑即恢复，与症状完全一致。
- 修复：同任务单飞（在途请求合并为一次收尾拉取，收尾必然取到最后事件之后的状态）+
  `updatedAt` 单调防御（跨链乱序亦拒绝回退）。回归 3 例（refresh-task-race.test.ts）。
- 收尾：走查脚本 7 步重试兜底待安装态复验后移除；main 侧事件遥测暂不需要（根因不在投递链）。

### D-12b 幽灵 CDP 端口（测试环境，非产品缺陷）
- Force-kill 或（偶发）优雅退出后，CDP 端口偶被"已死 PID"的 socket 条目占用，新实例绑定失败。
  疑似 Electron 子进程继承 socket 后的释放窗口。自动化测试规避：每次启动用新端口。

### D-12c 官方登录终端窗口不自闭
- "ForgeDesk 模型登录"外部终端窗口由用户手动关闭；自动化走查后可能残留，属预期（登录是
  用户交互过程），已知即可。

### D-12d 原生目录对话框不可安全自动化（测试口径）
- Windows 前台锁定下 SetForegroundWindow 可能失败，系统级 SendKeys 会误投其他前台窗口
  （有误开资源管理器窗口的实测教训）。口径：目录选择留给人工；应用内交互全走 CDP DOM 驱动。

### D-12e 已修复缺陷（本轮五连，详见 DECISIONS D12）
- manual 验收项死锁（新增 manual_review 闭环）、manualReview/updateAcceptance 返回类型谎报
  （契约对齐 + store merge）、验收单全量替换语义错配导致的毁单缺陷（store 改全量组装提交）、
  recordManualReview 固定 requestKey 改判回退撞 UNIQUE、clearProvider 假清除（patch 浅合并
  删不掉字段 + 空 provider.env 残留）。全部已修复并有回归测试/落盘断言。
