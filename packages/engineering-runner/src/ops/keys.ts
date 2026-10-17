/**
 * requestKey / argsDigest 规范化（M7 幂等约定）。
 * - argsDigest = sha256(canonicalJson(args 去除 requestKey 字段))：同键必须同参
 * - requestKey 由调用方（GUI/MCP）传入；未传时操作不做幂等去重（每次调用都是新操作，
 *   允许修复源码后重新 build/test）
 */
import { sha256Of, canonicalJson } from '../snapshot/digests.ts';

/** 计算参数摘要：忽略 requestKey 本身（键不是参数） */
export function buildArgsDigest(args: Record<string, unknown>): string {
  const { requestKey: _ignored, ...rest } = args;
  return sha256Of(canonicalJson(rest));
}
