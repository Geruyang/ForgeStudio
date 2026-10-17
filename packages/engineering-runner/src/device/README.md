# 设备适配层（设备 Agent C 所有）

本目录由**设备 Agent C** 实现与维护，工程执行器 Agent（B）不修改本目录内容。

- 契约接缝：`packages/contracts/src/device-adapter.ts`（`DeviceAdapter`，冻结 v1）
- 注入点：`src/internal/device-port.ts`（B 冻结）——主进程构造 `DeviceAdapterImpl` 后经
  `createRunnerService({ deviceAdapter })` 注入；B 的 ops 层负责授权语义、状态持久化与
  Evidence 落盘，C 只做纯设备操作（枚举/独占锁/绑定构造/烧录/串口验证）。
- 未注入适配器时，`device.bind/flash/verify` 返回 `environment_missing`，不崩溃。
- 本机无实机：一切设备验证走 fixture（虚拟探针/内存环回串口），证据标注"模拟"。
