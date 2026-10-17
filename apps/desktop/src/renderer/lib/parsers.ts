﻿﻿﻿/**
 * runner 事件 payload 与 invoke 返回值的防御性解析（运行时守卫）：
 * 桥只承诺 unknown，这里只做最小形状校验，不伪造缺失字段。
 */
import {
  EVIDENCE_RESULTS,
  OPERATION_STATUSES,
  OPERATION_TYPES,
  TASK_STATUSES,
  type EvidenceResult,
  type Operation,
  type TaskOverview,
} from '../contracts/engineering';
import type { PendingAuthorization } from '../contracts/runner';

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

export function asTaskOverview(v: unknown): TaskOverview | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.id !== 'string' || typeof r.title !== 'string') return null;
  if (!isOneOf(r.status, TASK_STATUSES)) return null;
  if (!Array.isArray(r.acceptance) || !Array.isArray(r.operations) || !Array.isArray(r.artifacts)) return null;
  if (typeof r.hasStaleEvidence !== 'boolean') return null;
  return v as TaskOverview;
}

export function asOperation(v: unknown): Operation | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.id !== 'string' || typeof r.taskId !== 'string') return null;
  if (!isOneOf(r.type, OPERATION_TYPES)) return null;
  if (!isOneOf(r.status, OPERATION_STATUSES)) return null;
  return v as Operation;
}

const DEVICE_OP_TYPES = ['device_bind', 'device_flash', 'device_verify'] as const;

export function asPendingAuthorization(v: unknown): PendingAuthorization | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.operationId !== 'string' || typeof r.taskId !== 'string') return null;
  if (!isOneOf(r.type, DEVICE_OP_TYPES)) return null;
  if (typeof r.scopeSummary !== 'string') return null;
  return v as PendingAuthorization;
}

export interface TestOutputView {
  result: EvidenceResult;
  evidenceId?: string;
  acceptanceItemId?: string;
  detail?: unknown;
  logRef?: string;
}

export function asTestOutput(v: unknown): TestOutputView | null {
  const r = asRecord(v);
  if (!r) return null;
  if (!isOneOf(r.result, EVIDENCE_RESULTS)) return null;
  return {
    result: r.result,
    evidenceId: str(r.evidenceId),
    acceptanceItemId: str(r.acceptanceItemId),
    detail: r.detail,
    logRef: str(r.logRef),
  };
}

export interface BuildOutputView {
  artifactId?: string;
  buildId?: string;
  artifactPath?: string;
  artifactSha256?: string;
  logRef?: string;
  durationMs?: number;
}

export function asBuildOutput(v: unknown): BuildOutputView | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    artifactId: str(r.artifactId),
    buildId: str(r.buildId),
    artifactPath: str(r.artifactPath),
    artifactSha256: str(r.artifactSha256),
    logRef: str(r.logRef),
    durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
  };
}

export interface VerifyOutputView {
  result?: EvidenceResult;
  nonceMatch?: boolean;
  buildIdMatch?: boolean;
  buildId?: string;
  responsePreview?: string;
  logRef?: string;
  evidenceId?: string;
}

export function asVerifyOutput(v: unknown): VerifyOutputView | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    result: isOneOf(r.result, EVIDENCE_RESULTS) ? r.result : undefined,
    nonceMatch: typeof r.nonceMatch === 'boolean' ? r.nonceMatch : undefined,
    buildIdMatch: typeof r.buildIdMatch === 'boolean' ? r.buildIdMatch : undefined,
    buildId: str(r.buildId),
    responsePreview: str(r.responsePreview),
    logRef: str(r.logRef),
    evidenceId: str(r.evidenceId),
  };
}

export interface InspectOutputView {
  missing: string[];
  toolchain: Array<{ tool: string; available: boolean; version?: string; missingHint?: string }>;
  inputDigest?: string;
}

export function asInspectOutput(v: unknown): InspectOutputView | null {
  const r = asRecord(v);
  if (!r || !Array.isArray(r.missing)) return null;
  const toolchain = Array.isArray(r.toolchain)
    ? r.toolchain
        .map((t): InspectOutputView['toolchain'][number] | null => {
          const rec = asRecord(t);
          if (!rec) return null;
          return {
            tool: String(rec.tool ?? ''),
            available: rec.available === true,
            version: str(rec.version),
            missingHint: str(rec.missingHint),
          };
        })
        .filter((t): t is InspectOutputView['toolchain'][number] => t !== null)
    : [];
  return { missing: r.missing.map(String), toolchain, inputDigest: str(r.inputDigest) };
}

export interface ExportOutputView {
  bundlePath?: string;
  operationId?: string;
}

export function asExportOutput(v: unknown): ExportOutputView | null {
  const r = asRecord(v);
  if (!r) return null;
  return { bundlePath: str(r.bundlePath), operationId: str(r.operationId) };
}

/**
 * runner:invoke 返回拆包：OpResult.ok 之内的 payload 还可能是 ToolFailure
 * {ok:false, kind, message}——两级都要判，不把失败当成功展示。
 */
export type InvokePayload =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; kind: string; message: string; detail?: string };

export function parseInvokePayload(v: unknown): InvokePayload {
  const r = asRecord(v);
  if (r && r.ok === true) return { ok: true, data: r };
  if (r && r.ok === false && typeof r.kind === 'string' && typeof r.message === 'string') {
    return { ok: false, kind: r.kind, message: r.message, detail: str(r.detail) };
  }
  return {
    ok: false,
    kind: 'unknown_result',
    message: '工具返回结构无法识别',
    detail: truncateJson(v),
  };
}

function truncateJson(v: unknown): string | undefined {
  try {
    const s = JSON.stringify(v);
    return s ? (s.length > 300 ? `${s.slice(0, 300)}…` : s) : undefined;
  } catch {
    return undefined;
  }
}
