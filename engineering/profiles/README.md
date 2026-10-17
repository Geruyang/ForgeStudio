# engineering/profiles

工程 Profile：用户认可的构建/测试/设备配置。schema 冻结于 `packages/contracts/src/profile.ts`（EngineeringProfileSchema，zod）。

- `forgedesk-self.profile.json`：ForgeDesk 自身软件 profile（构建+类型检查验收），示范 T1 软件闭环。
- `example-embedded-stm32.profile.json`：嵌入式模板（设备 Agent C 提供并配 fixtures；**未经实机验证，标注示例**）。

Runner 加载顺序：用户数据目录 profiles → 安装包 resources/engineering/profiles（后者只读模板）。
修改 profile = 修改构建/验收规则 → revision +1，旧证据自动过期（输入指纹含 profile 摘要）。

## 嵌入式 profile（example-embedded-stm32）使用说明

> **示例未经实机验证**：`example-embedded-stm32.profile.json` 为 STM32F103 + probe-rs +
> 串口验证的模板（任务书 §10 首发组合参考），在本仓库开发机（无板卡）上仅通过虚拟探针
> fixture 测试，不构成任何实机验收声明。首次实机使用前请完成 §10.2 的人工演练。

字段速查（schema 见 `packages/contracts/src/profile.ts` DeviceProfileSchema）：

| 字段 | 说明 | 替换为你的工程 |
|---|---|---|
| `device.chipTarget` | 目标芯片（传给烧录工具） | 你的芯片型号，如 `nRF52840_xxAA` |
| `device.identity.usbVid/usbPid` | 探针/板卡 USB 身份（枚举匹配用，十进制） | 设备管理器 `USB\VID_xxxx&PID_xxxx` 的十六进制转十进制，如 `0483`→`1155` |
| `device.flashCommand` | 烧录命令（`exe`+`args` 数组，禁 shell 拼接） | 你已安装的工具：probe-rs / `JLink.exe` / `STM32_Programmer_CLI.exe` / openocd 等；`${artifact}` 占位符在执行时替换为产物绝对路径 |
| `device.flashBudgetMs` / `verifyBudgetMs` | 烧录/验证预算（默认 300s/120s） | 按芯片 Flash 大小与工具速度调整；超时→结果 unknown，不自动重试 |
| `device.readbackCommand` | 可选读回校验命令（exit 0 = 校验通过） | 工具支持时配置，如 probe-rs `verify` |
| `device.serial.baudRate` | 串口波特率 | 与固件一致 |
| `device.serial.verifyProtocol.requestLine` | 身份请求行模板，`${nonce}` 由 runner 每轮随机替换 | 固件侧需实现：收到该行后回显 `${buildIdEchoPrefix}<buildId> NONCE:<收到的nonce>` |
| `device.serial.verifyProtocol.buildIdEchoPrefix` | 响应中 buildId 的前缀 | 固件回报格式，如 `BUILD_ID:` |

已有工程替换示例（Keil/J-Link 用户无需换工具链，任务书 §10.1）：

```json
"flashCommand": {
  "exe": "C:/Keil_v5/ARM/JLink/JLink.exe",
  "args": ["-device", "STM32F103C8", "-if", "SWD", "-speed", "4000",
           "-autoconnect", "1", "-CommanderScript", "flash.jlink"],
  "timeoutMs": 300000
}
```

行为要点（任务书 §8.3/§10.2）：COM 口号只作当前位置，稳定绑定用 VID/PID+探针序列号；
串口验证每轮生成随机 nonce，固件回显 nonce+buildId 才算本轮证据（旧日志/旧固件不产生
假通过）；固件暂不支持身份回报时显示"已烧录，运行版本未独立确认"，不宣称完整实机验收。
烧录/验证日志落盘在任务 evidence 工作区（`flash-receipt-*.log`、`serial-raw-*.log`）。
