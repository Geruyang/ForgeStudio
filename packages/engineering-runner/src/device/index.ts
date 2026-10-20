/**
 * 设备适配汇总（Agent C 对 B2 操作层的唯一出口，冻结接缝 contracts/device-adapter.ts）。
 * createDeviceAdapter(opts) 返回契约 DeviceAdapter：
 * - enumerate：powershell Get-PnpDevice USB 枚举 + serialport 列表合并（enumerate.ts）
 * - acquireExclusive/releaseExclusive：应用级锁 <dataDir>/device-locks/<bindingId>.lock
 *   （exclusive.ts）+ 串口物理独占（open 失败不得宣称独占成功）
 * - buildBinding：身份规范化（VID/PID 十六进制字符串→大写数值、序列号 trim、COM 口
 *   只作位置信息）；confirmedByUser 构造期恒 false（授权由 B2 ops 层负责，C 不写授权状态）
 * - flash/verifySerial：flash.ts / serial.ts
 * - capabilities：probe-rs 探测（PATH + 显式路径）；契约为同步签名 → 构造时后台预热
 *   一次，调用方可显式 await refreshCapabilities() 刷新
 * 契约已知缺陷：profile.ts 未导出 DeviceProfile 类型，此处以 DeviceProfileSchema 推导
 * 等价类型（与 contracts/src/device-adapter.ts 引用名一致），待契约补导出后直接引用。
 */
import * as path from 'node:path';
import { z } from 'zod';
import { SerialPort } from 'serialport';
import {
  SCHEMA_VERSION,
  DeviceIdentitySchema,
  DeviceProfileSchema,
  newId,
  type DeviceAdapter,
  type DeviceBinding,
  type DeviceFlashArgs,
  type EnumeratedDevice,
  type ExclusiveLease,
  type FlashOutcome,
  type SerialTransport,
  type SerialVerifyArgs,
  type SerialVerifyOutcome,
} from '@forgedesk/contracts';
import { DeviceExclusiveFileLock } from './exclusive';
import {
  enumerateUsbEntitiesViaPowerShell,
  mergeEnumeratedDevices,
  type SerialPortInfoLike,
  type UsbPnpEntity,
} from './enumerate';
import { runFlash } from './flash';
import { runSerialVerify } from './serial';
import { SerialPortTransport } from './serial/serial-transport-serialport';
import { detectProbeRs } from './probe-rs';

/** DeviceProfile 类型：契约 profile.ts 暂未导出（已知缺陷），由同一 schema 推导等价类型 */
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

/** buildBinding 兼容接收带 profileId 的扩展形态（契约 DeviceProfile 无 id 字段，见接缝说明） */
export type BindableProfile = DeviceProfile & { id?: string; profileId?: string };

export interface CreateDeviceAdapterOptions {
  /** runner 数据目录：锁文件位于 <dataDir>/device-locks/（与 lockDir 二选一） */
  dataDir?: string;
  /** 显式锁目录（优先于 dataDir/device-locks 拼接；兼容 B2 注入点接线形态） */
  lockDir?: string;
  /** probe-rs 显式路径（优先于 PATH 探测） */
  probeRsPath?: string;
  /** 串口传输工厂：默认真实 serialport（RealSerialTransport）；测试注入内存环回 fixture */
  serialTransportFactory?: (portPath: string, baudRate: number) => SerialTransport;
  /** bindingId → 串口位置（B2 从存储读取注入；提供时独占含物理串口层） */
  resolveBindingPort?: (
    bindingId: string,
  ) =>
    | Promise<{ serialPort?: string; baudRate?: number } | undefined>
    | { serialPort?: string; baudRate?: number }
    | undefined;
  /** powershell USB 枚举超时（缺省 15s；超时回退 serialport 列表） */
  usbEnumerateTimeoutMs?: number;
}

type Caps = {
  probeRsAvailable: boolean;
  probeRsPath?: string;
  serialPortsAvailable: boolean;
  serialPortCount: number;
};

/** 契约 DeviceAdapter + 能力显式刷新（B2 按契约接口消费不受影响；契约 capabilities() 为同步签名） */
export type DeviceAdapterWithRefresh = DeviceAdapter & {
  refreshCapabilities(): Promise<void>;
};

/** 身份规范化（§10.2）：VID/PID 接受 number 或十六进制字符串（"0483"/"0x0483"，大小写不敏感
 *  均按大写十六进制解析）、序列号 trim、COM 口统一大写；source 保留原值或默认 usb_hub */
function normalizeIdentity(identity: DeviceBinding['identity']): DeviceBinding['identity'] {
  const parseVidPid = (v: number | string | undefined): number => {
    if (typeof v === 'number') return Math.trunc(v);
    if (typeof v === 'string') {
      const parsed = parseInt(v.replace(/^0x/i, ''), 16);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return 0;
  };
  const parsed = DeviceIdentitySchema.parse({
    ...identity,
    usbVid: parseVidPid(identity.usbVid),
    usbPid: parseVidPid(identity.usbPid),
    probeSerial: identity.probeSerial?.trim() || undefined,
    serialPort: identity.serialPort?.toUpperCase() || undefined,
    displayName: identity.displayName?.trim() || undefined,
  });
  return parsed;
}

export class ForgeDeviceAdapter implements DeviceAdapter {
  private readonly options: CreateDeviceAdapterOptions;
  private readonly lock: DeviceExclusiveFileLock;

  /** 当前独占持有的设备 bindingId（diagnostics 用；无则 null） */
  get activeExclusive(): string | undefined { return this.lock.activeKeys[0]; }
  /** bindingId → 持有（物理串口传输 + 端口名） */
  private readonly held = new Map<string, { transport?: SerialTransport; port?: string }>();
  private caps: Caps = { probeRsAvailable: false, serialPortsAvailable: false, serialPortCount: 0 };

  constructor(options: CreateDeviceAdapterOptions) {
    if (!options.dataDir && !options.lockDir) {
      throw new Error('CreateDeviceAdapterOptions 需要 dataDir 或 lockDir 至少一项');
    }
    this.options = options;
    // 锁目录：显式 lockDir 优先（B2 接线形态 new DeviceAdapterImpl({ lockDir })），否则 <dataDir>/device-locks
    this.lock = new DeviceExclusiveFileLock(
      options.lockDir ?? path.join(options.dataDir as string, 'device-locks'),
    );
    // 契约 capabilities() 为同步签名：构造时后台预热一次快照，调用方可显式刷新
    void this.refreshCapabilities().catch(() => undefined);
  }

  private createTransportFor(portPath: string, baudRate: number): SerialTransport {
    return this.options.serialTransportFactory
      ? this.options.serialTransportFactory(portPath, baudRate)
      : new SerialPortTransport();
  }

  // -----------------------------------------------------------------------
  // 枚举
  // -----------------------------------------------------------------------

  async enumerate(): Promise<EnumeratedDevice[]> {
    const heldPorts: string[] = [];
    for (const h of this.held.values()) {
      if (h.port) heldPorts.push(h.port);
    }
    const [entities, ports] = await Promise.all([this.tryUsbEntities(), this.tryListSerialPorts()]);
    return mergeEnumeratedDevices(entities ?? [], ports, heldPorts);
  }

  private async tryUsbEntities(): Promise<UsbPnpEntity[] | null> {
    try {
      return await enumerateUsbEntitiesViaPowerShell(this.options.usbEnumerateTimeoutMs ?? 15_000);
    } catch {
      return null; // powershell 不可用 → serialport 回退
    }
  }

  private async tryListSerialPorts(): Promise<SerialPortInfoLike[]> {
    try {
      return (await SerialPort.list()) as unknown as SerialPortInfoLike[];
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // 独占（M8 基础）：应用级文件锁 + 串口物理独占
  // -----------------------------------------------------------------------

  async acquireExclusive(bindingId: string, holderDescription: string): Promise<ExclusiveLease> {
    const res = await this.lock.acquire(bindingId, holderDescription);
    if (!res.acquired) {
      return { acquired: false, heldBy: res.heldBy, acquiredAt: res.acquiredAt };
    }
    // 物理层：解析串口并打开（serialport lock=true / fixture 注册表 → 第二道锁）
    let portInfo: { serialPort?: string; baudRate?: number } | undefined;
    try {
      portInfo = await this.options.resolveBindingPort?.(bindingId);
    } catch {
      portInfo = undefined; // 解析器异常降级为仅文件锁（单一权威实例下可接受）
    }
    if (portInfo?.serialPort) {
      const baudRate = portInfo.baudRate ?? 115_200;
      try {
        const transport = this.createTransportFor(portInfo.serialPort, baudRate);
        await transport.open(portInfo.serialPort, baudRate);
        this.held.set(bindingId, { transport, port: portInfo.serialPort });
      } catch (err) {
        // 物理锁失败（端口被占用）：回滚文件锁，整体判为未获取——不得宣称独占成功
        await this.lock.release(bindingId);
        const detail = err instanceof Error ? err.message : String(err);
        return {
          acquired: false,
          heldBy: `串口 ${portInfo.serialPort} 被占用或不可用（物理独占失败）：${detail}`,
        };
      }
    } else {
      // 无串口信息（纯 SWD 烧录等）：仅文件锁
      this.held.set(bindingId, { port: portInfo?.serialPort });
    }
    return { acquired: true, acquiredAt: res.acquiredAt };
  }

  async releaseExclusive(bindingId: string): Promise<void> {
    const held = this.held.get(bindingId);
    this.held.delete(bindingId);
    if (held?.transport) {
      try {
        await held.transport.close();
      } catch {
        // 关闭尽力而为：不影响锁释放
      }
    }
    await this.lock.release(bindingId);
  }

  // -----------------------------------------------------------------------
  // 绑定构造（持久化由 B2 负责）
  // -----------------------------------------------------------------------

  buildBinding(
    profile: BindableProfile,
    identity: DeviceBinding['identity'],
    identityEvidence: string,
  ): DeviceBinding {
    if (typeof identityEvidence !== 'string' || identityEvidence.trim().length === 0) {
      throw new Error('identityEvidence 必填：必须描述如何确认这块板就是目标板');
    }
    const normalized = normalizeIdentity(identity);
    const profileId = profile.id ?? profile.profileId ?? 'unresolved-profile';
    return {
      schemaVersion: SCHEMA_VERSION,
      id: newId('dev'),
      profileId,
      identity: normalized,
      chipTarget: profile.chipTarget,
      serialPort: normalized.serialPort,
      identityEvidence,
      // 构造期恒 false：授权确认是 GUI 流程动作，由 B2 确认后落库（C 不写授权状态）
      confirmedByUser: false,
      createdAt: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // 烧录 / 串口验证（flash.ts / serial.ts）
  // -----------------------------------------------------------------------

  async flash(args: DeviceFlashArgs): Promise<FlashOutcome> {
    return runFlash(args);
  }

  async verifySerial(args: SerialVerifyArgs): Promise<SerialVerifyOutcome> {
    return runSerialVerify(args, {
      createTransport: (portPath, baudRate) => this.createTransportFor(portPath, baudRate),
      resolvePort: async (bindingId) => {
        const viaArgs = args.binding.serialPort;
        if (viaArgs) return viaArgs;
        const info = await this.options.resolveBindingPort?.(bindingId);
        return info?.serialPort;
      },
    });
  }

  // -----------------------------------------------------------------------
  // 能力诊断（契约为同步签名 → 快照 + 显式刷新；不含凭证）
  // -----------------------------------------------------------------------

  capabilities(): Caps {
    return { ...this.caps };
  }

  /** 重新探测 probe-rs 与串口可用性；构造时已自动预热一次（本机无硬件 → 如实 false，不崩溃） */
  async refreshCapabilities(): Promise<void> {
    const probe = await detectProbeRs({ explicitPath: this.options.probeRsPath });
    let serialPortsAvailable = false;
    let serialPortCount = 0;
    try {
      const ports = await SerialPort.list();
      serialPortsAvailable = true;
      serialPortCount = ports.length;
    } catch {
      // bindings 不可用（本机驱动缺失等）：capabilities 如实反映
    }
    this.caps = {
      probeRsAvailable: probe.available,
      ...(probe.path ? { probeRsPath: probe.path } : {}),
      serialPortsAvailable,
      serialPortCount,
    };
  }
}

/**
 * 构造设备适配器（设备目录唯一出口）。
 * 返回契约 DeviceAdapter（附加 refreshCapabilities 显式刷新——契约 capabilities()
 * 为同步签名，只返回构造时预热的能力快照）。
 * @example
 *   const adapter = createDeviceAdapter({ dataDir: '<runner 数据目录>' });
 *   await adapter.refreshCapabilities();
 *   const devices = await adapter.enumerate();
 */
export function createDeviceAdapter(options: CreateDeviceAdapterOptions): DeviceAdapterWithRefresh {
  return new ForgeDeviceAdapter(options);
}

/** 兼容 B2 注入点接线形态（src/internal/device-port.ts 示例）：new DeviceAdapterImpl({ lockDir }) */
export { ForgeDeviceAdapter as DeviceAdapterImpl };
export { DeviceExclusiveFileLock } from './exclusive';
export { isPidAlive } from './exclusive';
export {
  extractComPort,
  extractUsbIdentity,
  identityFromSerialPortInfo,
  mergeEnumeratedDevices,
  parsePnpJsonOutput,
  enumerateUsbEntitiesViaPowerShell,
  type UsbPnpEntity,
  type SerialPortInfoLike,
} from './enumerate';
export { runFlash, type FlashProfile } from './flash';
export { runSerialVerify, RealSerialTransport, type SerialProfile, type SerialVerifyDeps } from './serial';
export {
  DeviceCancelledError,
  DeviceOperationError,
  DeviceVerifyError,
  SerialTransportError,
  type DeviceFailureReason,
  type FlashOutcomePayload,
} from './errors';
export { detectProbeRs, buildProbeRsDownloadCommand, buildProbeRsVerifyCommand, type ProbeRsInfo } from './probe-rs';
export { FixtureSerialTransport, type FixtureReply, type FixtureSerialTransportOptions } from './serial/serial-transport-fixture';
export { LineQueue } from './serial/line-queue';
