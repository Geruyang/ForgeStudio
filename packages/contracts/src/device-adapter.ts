/**
 * 设备适配器接缝（Agent B 与 Agent C 的分界）。
 * C 在 runner/src/device/ 实现 DeviceAdapter；B 的操作层组合调用并持久化状态。
 * C 不写存储；B 不碰硬件底层。冻结契约 v1 —— 集成负责人维护。
 */
import type { DeviceBinding, EnumeratedDevice, SerialVerifyExchange } from './device.ts';
import type { DeviceProfile } from './profile.ts';
import type { TaskId } from './common.ts';

export interface FlashOutcome {
  /** 烧录工具回执日志落盘路径（evidence 存储内） */
  toolReceiptPath: string;
  toolSummary: string;
  durationMs: number;
  /** 烧录后读回校验（工具支持时） */
  readbackVerified?: boolean;
}

export interface DeviceFlashArgs {
  taskId: TaskId;
  artifactPath: string;
  artifactSha256: string;
  buildId?: string;
  binding: DeviceBinding;
  profile: DeviceProfile;
  /** 回执/日志落盘目录（evidence 工作区） */
  workDir: string;
  budgetMs: number;
  /** 取消信号：副作用前取消 → 副作用后不可强杀（由工具能力决定） */
  signal?: AbortSignal;
}

export interface SerialVerifyOutcome {
  exchange: SerialVerifyExchange;
  responsePreview: string;
  logRef?: string;
}

export interface SerialVerifyArgs {
  taskId: TaskId;
  binding: DeviceBinding;
  profile: DeviceProfile;
  buildId?: string;
  /** 工作目录：原始串口流落盘 */
  workDir: string;
  budgetMs: number;
  signal?: AbortSignal;
}

export interface ExclusiveLease {
  acquired: boolean;
  /** 已被占用时的持有者描述 */
  heldBy?: string;
  acquiredAt?: string;
}

/**
 * 纯设备操作接口：不读写数据库、不产生事件（状态由 B 的操作层记录）。
 * 串口传输经 SerialTransport 抽象：真实实现用 serialport；fixture 用内存环回（标注模拟）。
 */
export interface DeviceAdapter {
  /** 枚举当前连接的探针/板卡 */
  enumerate(): Promise<EnumeratedDevice[]>;
  /** 设备独占（应用级锁 + 端口持有由实现负责） */
  acquireExclusive(bindingId: string, holderDescription: string): Promise<ExclusiveLease>;
  releaseExclusive(bindingId: string): Promise<void>;
  /** 构造绑定对象（持久化由调用方负责） */
  buildBinding(profile: DeviceProfile, identity: DeviceBinding['identity'], identityEvidence: string): DeviceBinding;
  /** 烧录：非 zero 退出/超时/崩溃→按 unknown 语义返回，不自动重试 */
  flash(args: DeviceFlashArgs): Promise<FlashOutcome>;
  /** 串口验证：清空旧缓冲→发 nonce→校验 nonce+buildId→返回本轮交换 */
  verifySerial(args: SerialVerifyArgs): Promise<SerialVerifyOutcome>;
  /** 能力诊断（不含凭证） */
  capabilities(): {
    probeRsAvailable: boolean;
    probeRsPath?: string;
    serialPortsAvailable: boolean;
    serialPortCount: number;
  };
}

/** 串口传输抽象：真实 = serialport；fixture = 内存环回 */
export interface SerialTransport {
  open(portPath: string, baudRate: number): Promise<void>;
  /** 清空/标记旧缓冲（防旧日志污染本轮证据） */
  flush(): Promise<void>;
  writeLine(line: string): Promise<void>;
  /** 等待一行响应（带超时） */
  readLine(timeoutMs: number): Promise<string>;
  close(): Promise<void>;
  readonly kind: 'real' | 'fixture';
}
