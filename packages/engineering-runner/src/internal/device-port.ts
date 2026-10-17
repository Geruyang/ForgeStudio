/**
 * 供 device 适配层使用的内部接口（Agent B 冻结；设备 Agent C 通过本注入点接入）。
 *
 * 接线方式（集成负责人 / 主进程）：
 *   import { DeviceAdapterImpl } from '../device/device-adapter.ts';   // 设备 Agent C 提供
 *   const service = await createRunnerService({
 *     dataDir, token, port,
 *     deviceAdapter: new DeviceAdapterImpl({ lockDir: path.join(dataDir, 'device-locks') }),
 *   });
 *
 * 约束：
 * - C 的适配器实现纯设备操作（枚举/独占/绑定构造/烧录/串口验证），不读写数据库、不发事件；
 *   状态持久化、授权语义、Evidence 落盘全部由本层（ops）负责。
 * - 未注入适配器时：device.bind/flash/verify 返回 environment_missing（不崩溃），
 *   GET /api/devices 返回空数组 + 诊断说明。
 * - DeviceAdapter 契约见 packages/contracts/src/device-adapter.ts（冻结 v1）。
 */
import type { DeviceAdapter } from '@forgedesk/contracts';

export type { DeviceAdapter };
/** 设备操作相关类型一并透出（供 device 适配层与测试使用） */
export type {
  DeviceFlashArgs,
  FlashOutcome,
  SerialVerifyArgs,
  SerialVerifyOutcome,
  ExclusiveLease,
  SerialTransport,
} from '@forgedesk/contracts';

/** 服务初始化时可选注入的设备适配器挂点（null/缺省 = 无设备能力） */
export interface DeviceAdapterInjection {
  deviceAdapter?: DeviceAdapter | null;
}
