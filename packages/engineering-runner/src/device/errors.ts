/**
 * 设备层错误类型（Agent C）。
 * 设备目录不写存储：错误即结果通道；B2 操作层据此映射 operation 状态与 FailureKind。
 * - DeviceOperationError.status → device.flash 输出的 status（failed/unknown）
 * - DeviceCancelledError.stage → cancelled（before_start 无副作用；after_start 结果仍按真实进程结果报告）
 * - DeviceVerifyError → 携带本轮 SerialVerifyExchange，B2 落证据
 */
import type { FailureKind, SerialVerifyExchange } from '@forgedesk/contracts';

/** 设备失败机器原因（B2 可据此精化映射，不依赖中文文案） */
export type DeviceFailureReason =
  | 'artifact_missing'
  | 'tool_missing'
  | 'tool_nonzero_exit'
  | 'budget_timeout'
  | 'abnormal_termination'
  | 'port_missing'
  | 'protocol_missing'
  | 'no_response'
  | 'nonce_mismatch'
  | 'build_id_mismatch'
  | 'connection_failure'
  | 'budget_exceeded'
  | 'internal_error';

/** flash 结果载荷：即使失败也必须让 B2 拿到回执路径与时长（evidence 需要） */
export interface FlashOutcomePayload {
  toolReceiptPath?: string;
  toolSummary?: string;
  durationMs?: number;
  readbackVerified?: boolean;
}

export class DeviceOperationError extends Error {
  /** B2 映射 device.flash 输出 status：failed | unknown */
  readonly status: 'failed' | 'unknown';
  /** 建议的 FailureKind（契约枚举内；B2 可按 reason 重映射） */
  readonly kind: FailureKind;
  readonly reason: DeviceFailureReason;
  readonly detail?: string;
  readonly logRef?: string;
  readonly outcome?: FlashOutcomePayload;

  constructor(opts: {
    status: 'failed' | 'unknown';
    kind: FailureKind;
    reason: DeviceFailureReason;
    message: string;
    detail?: string;
    logRef?: string;
    outcome?: FlashOutcomePayload;
  }) {
    super(opts.message);
    this.name = 'DeviceOperationError';
    this.status = opts.status;
    this.kind = opts.kind;
    this.reason = opts.reason;
    this.detail = opts.detail;
    this.logRef = opts.logRef;
    this.outcome = opts.outcome;
  }
}

export class DeviceCancelledError extends Error {
  /** before_start：取消发生在副作用前（不算副作用）；after_start：副作用已发生 */
  readonly stage: 'before_start' | 'after_start';

  constructor(stage: 'before_start' | 'after_start', message: string) {
    super(message);
    this.name = 'DeviceCancelledError';
    this.stage = stage;
  }
}

/** 串口验证失败：nonce/buildId 不匹配、无响应、拔线、配置缺失等 */
export class DeviceVerifyError extends Error {
  readonly reason: DeviceFailureReason;
  readonly kind: FailureKind;
  /** 本轮交换（含失败原因的原始行）——B2 落证据用 */
  readonly exchange: SerialVerifyExchange;
  readonly responsePreview: string;
  readonly logRef?: string;

  constructor(opts: {
    reason: DeviceFailureReason;
    kind: FailureKind;
    message: string;
    exchange: SerialVerifyExchange;
    responsePreview: string;
    logRef?: string;
  }) {
    super(opts.message);
    this.name = 'DeviceVerifyError';
    this.reason = opts.reason;
    this.kind = opts.kind;
    this.exchange = opts.exchange;
    this.responsePreview = opts.responsePreview;
    this.logRef = opts.logRef;
  }
}

/** 串口传输层错误：open 失败/读超时/拔线/写入失败/未打开 */
export class SerialTransportError extends Error {
  readonly code: 'open_failed' | 'timeout' | 'disconnected' | 'write_failed' | 'closed';
  override readonly cause?: unknown;

  constructor(code: SerialTransportError['code'], message: string, cause?: unknown) {
    super(message);
    this.name = 'SerialTransportError';
    this.code = code;
    this.cause = cause;
  }
}
