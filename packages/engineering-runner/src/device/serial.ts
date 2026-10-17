/**
 * 串口验证（Agent C，任务书 §8.3 / M6 语义）：
 * 打开 → flush 清空/标记旧缓冲（旧日志不作本轮证据）→ 生成本轮随机 nonce（16 字节 hex）
 * → 按 profile.serial.verifyProtocol.requestLine 发送（占位 ${nonce}/${buildId}）
 * → readLine 等响应 → 解析 nonce 匹配 + buildIdEchoPrefix 匹配 → SerialVerifyExchange。
 * - 响应候选 = 含 NONCE 协议标记的行；nonce 与本轮不一致 → failed（旧固件/旧响应
 *   不作为本轮证据）；无 NONCE 标记的行按噪声记录原始流并继续等待
 * - 固件回报 buildId 但与期望不一致 → failed（板上可能仍是旧固件）
 * - 固件无 buildId 回报 → buildIdMatch:false 但不算失败（"已烧录，运行版本未独立确认"）
 * - 响应超时 → inconclusive/failed 语义（no_response）；拔线 → 连接失败
 * - 长串口流分页读取，不塞聊天上下文：原始流（含噪声行）追加落盘 <workDir>/serial-raw-<ts>.log
 * 真实传输 = serialport（RealSerialTransport，serial/serial-transport-serialport.ts）；
 * 测试经内存环回 fixture（VirtualSerialTransport，模拟）。
 */
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  FailureKind,
  SerialTransport,
  SerialVerifyArgs,
  SerialVerifyExchange,
  SerialVerifyOutcome,
} from '@forgedesk/contracts';
import { DeviceCancelledError, DeviceVerifyError, SerialTransportError } from './errors';
import type { DeviceFailureReason } from './errors';

export { SerialPortTransport as RealSerialTransport } from './serial/serial-transport-serialport';

/** profile 兼容形态：serial 段（baudRate/verifyProtocol/responseTimeoutMs）+ verifyBudgetMs */
export type SerialProfile = {
  serial?: {
    baudRate?: number;
    verifyProtocol?: { requestLine?: string; buildIdEchoPrefix?: string };
    responseTimeoutMs?: number;
  };
  verifyBudgetMs?: number;
};

/** 串口验证依赖注入：transport 工厂 + 绑定端口解析（adapter 层提供） */
export interface SerialVerifyDeps {
  createTransport(portPath: string, baudRate: number): SerialTransport;
  resolvePort(bindingId: string): Promise<string | undefined>;
}

/** 协议响应行的 nonce 标记（固件回显形态：... NONCE:<hex> ...） */
const NONCE_MARKER = 'NONCE:';

function shortToken(len: number): string {
  return randomBytes(8).toString('hex').slice(0, len);
}

function fileStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

const truncatePreview = (s: string): string => (s.length > 2000 ? s.slice(0, 2000) : s);

/**
 * 串口验证主流程：
 * 成功（nonce 匹配且 buildId 一致/未回报）返回 SerialVerifyOutcome；
 * 失败抛 DeviceVerifyError（携带本轮 exchange）；读响应阶段取消抛 DeviceCancelledError。
 */
export async function runSerialVerify(
  args: SerialVerifyArgs,
  deps: SerialVerifyDeps,
): Promise<SerialVerifyOutcome> {
  const profile = args.profile as unknown as SerialProfile;
  const serial = profile.serial;
  const verifyProtocol = serial?.verifyProtocol;
  const nonce = randomBytes(16).toString('hex');
  const now = (): string => new Date().toISOString();
  const emptyExchange = (): SerialVerifyExchange => ({
    nonce,
    sentAt: now(),
    responseRaw: '',
    responseNonceMatch: false,
    buildIdMatch: false,
    capturedAt: now(),
  });

  await mkdir(args.workDir, { recursive: true });
  // 原始串口流落盘（分页读取，不进聊天上下文）
  const rawLogPath = path.join(args.workDir, `serial-raw-${fileStamp(new Date())}-${shortToken(6)}.log`);
  const logLines: string[] = [];
  const log = (line: string): void => {
    logLines.push(line);
  };

  log('=== ForgeDesk 串口验证原始流（nonce + buildId，§8.3） ===');
  log(`taskId: ${args.taskId} bindingId: ${args.binding.id}`);
  log(`expectedBuildId: ${args.buildId ?? '(未提供，仅校验 nonce)'}`);

  const failWith = (
    reason: DeviceFailureReason,
    kind: FailureKind,
    message: string,
    exchange: SerialVerifyExchange,
    preview: string,
  ): never => {
    log(`结果: 失败 reason=${reason}；${message}`);
    throw new DeviceVerifyError({
      reason,
      kind,
      message,
      exchange,
      responsePreview: truncatePreview(preview),
      logRef: rawLogPath,
    });
  };

  let transport: SerialTransport | undefined;
  const t0 = Date.now();
  const el = (): string => `T+${Date.now() - t0}ms`;
  try {
    const port = args.binding.serialPort ?? (await deps.resolvePort(args.binding.id));
    if (!port) {
      throw new DeviceVerifyError({
        reason: 'port_missing',
        kind: 'environment_missing',
        message: '绑定无串口位置信息（serialPort 缺失），无法验证',
        exchange: emptyExchange(),
        responsePreview: '',
        logRef: rawLogPath,
      });
    }
    if (!serial || !verifyProtocol) {
      throw new DeviceVerifyError({
        reason: 'protocol_missing',
        kind: 'environment_missing',
        message: 'profile 未定义 serial.verifyProtocol（requestLine/buildIdEchoPrefix），无法验证',
        exchange: emptyExchange(),
        responsePreview: '',
        logRef: rawLogPath,
      });
    }
    const baudRate = serial.baudRate ?? 115_200;
    const responseTimeoutMs = serial.responseTimeoutMs ?? 10_000;
    const budgetMs = args.budgetMs > 0 ? args.budgetMs : profile.verifyBudgetMs ?? 120_000;
    const requestLineTemplate = verifyProtocol.requestLine;
    const buildIdEchoPrefix = verifyProtocol.buildIdEchoPrefix;

    transport = deps.createTransport(port, baudRate);
    try {
      await transport.open(port, baudRate);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failWith('connection_failure', 'connection_failure', `串口 ${port} 打开失败：${detail}`, emptyExchange(), '');
    }
    log(`[${el()}] opened ${port} @${baudRate}（transport=${transport.kind}）`);
    try {
      await transport.flush();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failWith('connection_failure', 'connection_failure', `串口 flush 失败：${detail}`, emptyExchange(), '');
    }
    log(`[${el()}] flush 完成：清空旧缓冲（旧日志不作为本轮证据）`);

    // 发送身份请求行：占位 ${nonce}/${buildId}；无模板则裸发 nonce
    const sentAt = now();
    const requestLine = requestLineTemplate
      ? requestLineTemplate.replaceAll('${nonce}', nonce).replaceAll('${buildId}', args.buildId ?? '')
      : nonce;
    try {
      await transport.writeLine(requestLine);
      log(`[${el()}] > ${requestLine}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failWith('connection_failure', 'connection_failure', `串口写入失败：${detail}`, emptyExchange(), '');
    }

    // 读响应：含 NONCE 标记的行 = 协议响应候选（本轮/旧轮 nonce 均可判，防旧响应冒充）；
    // 无标记的行按噪声记录原始流并继续等待
    const deadline = Date.now() + budgetMs;
    const noise: string[] = [];
    let responseLine = '';
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) {
        failWith(
          'budget_exceeded',
          'timeout',
          `串口验证预算超时（${budgetMs}ms），未收到含 NONCE 标记的协议响应`,
          emptyExchange(),
          noise.join('\n'),
        );
      }
      const waitMs = Math.min(responseTimeoutMs, remain);
      let line: string;
      try {
        line = await transport.readLine(waitMs);
      } catch (err) {
        if (err instanceof SerialTransportError && err.code === 'timeout') {
          failWith(
            'no_response',
            'timeout',
            `串口无响应（${responseTimeoutMs}ms 内未收到含 NONCE 标记的协议行）：设备未上电、固件不支持验证协议或波特率不匹配（inconclusive）`,
            emptyExchange(),
            noise.join('\n'),
          );
        }
        if (err instanceof SerialTransportError && (err.code === 'disconnected' || err.code === 'closed')) {
          failWith(
            'connection_failure',
            'connection_failure',
            `串口连接失败或已拔线：${err.message}`,
            emptyExchange(),
            noise.join('\n'),
          );
        }
        throw err;
      }
      log(`[${el()}] < ${line}`);
      if (line.includes(NONCE_MARKER)) {
        responseLine = line;
        break;
      }
      noise.push(line);
      if (args.signal?.aborted) {
        throw new DeviceCancelledError('after_start', '串口验证在读响应阶段被取消');
      }
    }

    // nonce 判定：响应含本轮 nonce 才算本轮证据；旧 nonce → 不作为本轮证据
    const nonceMatched = responseLine.includes(nonce);
    let responseBuildId: string | undefined;
    if (buildIdEchoPrefix && responseLine.includes(buildIdEchoPrefix)) {
      const after = responseLine.slice(responseLine.indexOf(buildIdEchoPrefix) + buildIdEchoPrefix.length);
      responseBuildId = after.split(/\s+/)[0] || undefined;
    }
    const buildIdMatched =
      args.buildId !== undefined && responseBuildId !== undefined && responseBuildId === args.buildId;
    const exchange: SerialVerifyExchange = {
      nonce,
      sentAt,
      responseRaw: responseLine,
      responseNonceMatch: nonceMatched,
      responseBuildId,
      buildIdMatch: buildIdMatched,
      capturedAt: now(),
    };
    const preview = [...noise, responseLine].join('\n');

    if (!nonceMatched) {
      failWith(
        'nonce_mismatch',
        'test_failure',
        '响应 NONCE 与本轮 nonce 不一致：旧日志/旧固件响应不作为本轮证据',
        exchange,
        preview,
      );
    }
    if (args.buildId !== undefined && responseBuildId !== undefined && responseBuildId !== args.buildId) {
      failWith(
        'build_id_mismatch',
        'test_failure',
        `设备回报 buildId=${responseBuildId} 与期望 ${args.buildId} 不一致（板上可能仍是旧固件或目标板不对）`,
        exchange,
        preview,
      );
    }
    if (args.buildId !== undefined && responseBuildId === undefined) {
      // 固件未回报 buildId：不算失败——B2/UI 显示"已烧录，运行版本未独立确认"（§8.3）
      log('固件未回报 buildId：buildIdMatch=false（已烧录，运行版本未独立确认）');
    }
    if (args.buildId === undefined) {
      log('未提供期望 buildId：本轮仅校验 nonce（buildIdMatch=false）');
    }
    log(`结果: 通过 nonceMatch=${nonceMatched} buildIdMatch=${buildIdMatched}`);
    return { exchange, responsePreview: truncatePreview(preview), logRef: rawLogPath };
  } finally {
    if (transport) {
      try {
        await transport.close();
      } catch {
        // 清理尽力
      }
    }
    try {
      await appendFile(rawLogPath, `${logLines.join('\n')}\n`, 'utf8');
    } catch {
      // 落盘尽力
    }
  }
}
