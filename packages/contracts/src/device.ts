/**
 * ForgeDesk 设备类型：身份、绑定、烧录/串口验证请求。
 * 冻结契约 v1 —— 集成负责人维护；设备 Agent 在 runner/device 内实现。
 */
import { z } from 'zod';
import type { SchemaVersion, DeviceBindingId, Timestamp, Sha256 } from './common.ts';

/**
 * 设备身份：USB VID/PID + 探针序列号为稳定身份；COM 口只是当前连接位置。
 * 无可靠序列号时必须要求人工重新确认（任务书 §10.2）。
 */
export const DeviceIdentitySchema = z.object({
  usbVid: z.number().int().nonnegative(),
  usbPid: z.number().int().nonnegative(),
  probeSerial: z.string().optional(),
  chipTarget: z.string().optional(), // 如 stm32f103cb
  serialPort: z.string().optional(), // 当前 COM 口（仅位置信息）
  displayName: z.string().optional(),
  /** 采集方式：usb_hub | manual */
  source: z.enum(['usb_hub', 'manual']),
});
export type DeviceIdentity = z.infer<typeof DeviceIdentitySchema>;

/** 设备绑定：profile + 稳定身份 + 身份证据 */
export interface DeviceBinding {
  schemaVersion: SchemaVersion;
  id: DeviceBindingId;
  profileId: string;
  identity: DeviceIdentity;
  chipTarget: string;
  serialPort?: string;
  /** 身份证据描述：如何确认这块板就是目标板 */
  identityEvidence: string;
  /** 用户首次确认时间（授权前提） */
  confirmedByUser: boolean;
  createdAt: Timestamp;
}

/** 探针/板卡枚举结果 */
export interface EnumeratedDevice {
  identity: DeviceIdentity;
  availableSerialPorts: string[];
  /** probe-rs 等工具对该目标的探测输出摘要 */
  probeSummary?: string;
  busy: boolean;
}

/** 设备授权范围（任务书 §10.3）：引擎审批不能替代设备授权 */
export interface DeviceAuthorizationScope {
  deviceBindingId: DeviceBindingId;
  artifactSha256: Sha256;
  taskId: string;
  /** 验收规则摘要 */
  acceptanceDigest: Sha256;
  /** 策略版本 */
  policyVersion: number;
  /** 有效期（ISO 时间），到期或参数变化需重新授权 */
  validUntil: Timestamp;
}

export const DEVICE_AUTH_DECISIONS = ['approved', 'declined'] as const;
export type DeviceAuthDecision = (typeof DEVICE_AUTH_DECISIONS)[number];
/** 烧录前置检查结果 */
export interface FlashPreflight {
  artifactExists: boolean;
  artifactDigestMatch: boolean;
  deviceAttached: boolean;
  deviceIdentityMatch: boolean;
  exclusiveAcquired: boolean;
  authorizationValid: boolean;
  ready: boolean;
  blockers: string[];
}

/** 串口验证协议（任务书 §8.3）：随机 nonce + buildId，防旧日志/旧固件假通过 */
export interface SerialVerifyExchange {
  nonce: string; // 本轮随机数（十六进制）
  sentAt: Timestamp;
  responseRaw: string;
  responseNonceMatch: boolean;
  responseBuildId?: string;
  buildIdMatch: boolean;
  capturedAt: Timestamp;
}
