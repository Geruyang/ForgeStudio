// fixture 模拟测试——非实机验收。
// VirtualSerialTransport：内存环回串口（kind:'fixture'），按 <stateDir>/device-firmware.json
// 模拟板内固件的串口验证响应（回 nonce + buildId，§8.3 协议）。
// 可配置：
//   - staleLines        旧缓冲污染（open 后即可读的旧日志行；flush 后应被丢弃——M6）
//   - responseDelayMs   延迟响应（慢固件）
//   - disconnectOnRequest 收到验证请求即模拟拔线
//   - echoWrongNonce    回伪造的旧 nonce（防旧响应冒充本轮证据）
//   - respondWithoutBuildId 固件不回报 buildId（"已烧录，运行版本未独立确认"语义）
//   - extraNoiseLines   响应前先回噪声行（不带 NONCE 标记）
// 固件状态文件不存在 → 静默无响应（设备无固件/固件不支持协议）。
// 端口占用注册表语义复用 FixtureSerialTransport（同进程内模拟 Windows 串口物理独占）。
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { SerialTransport } from '@forgedesk/contracts';
import { FixtureSerialTransport, type FixtureLineHandler } from '../../../src/device/serial/serial-transport-fixture';

export interface VirtualSerialTransportOptions {
  /** device-firmware.json 所在目录（虚拟烧录工具写入） */
  stateDir: string;
  portPath: string;
  /** false → open 报 open_failed（模拟未插/已拔出的端口） */
  portExists?: boolean;
  /** 旧缓冲污染行（open 后即可读；flush 丢弃） */
  staleLines?: string[];
  responseDelayMs?: number;
  /** 收到验证请求即拔线 */
  disconnectOnRequest?: boolean;
  /** 回伪造旧 nonce（验证 nonce_mismatch 判定） */
  echoWrongNonce?: boolean;
  /** 固件不回报 buildId */
  respondWithoutBuildId?: boolean;
  /** 响应前先回的噪声行 */
  extraNoiseLines?: string[];
  /** 响应行中的 nonce 标记（默认 'NONCE:'） */
  nonceMarker?: string;
  /** 响应行中的 buildId 前缀（默认 'BUILD_ID:'，与 profile.buildIdEchoPrefix 对应） */
  buildIdEchoPrefix?: string;
}

interface FirmwareState {
  schemaVersion: number;
  sha256: string;
  buildId?: string;
  supportsBuildIdEcho?: boolean;
  flashedAt: string;
}

const NONCE_RE = /[0-9a-f]{32}/;

export class VirtualSerialTransport implements SerialTransport {
  readonly kind = 'fixture' as const;

  private fw: FirmwareState | null = null;
  private readonly inner: FixtureSerialTransport;
  private readonly opts: Required<Pick<VirtualSerialTransportOptions, 'nonceMarker' | 'buildIdEchoPrefix'>> &
    VirtualSerialTransportOptions;

  constructor(options: VirtualSerialTransportOptions) {
    this.opts = {
      nonceMarker: options.nonceMarker ?? 'NONCE:',
      buildIdEchoPrefix: options.buildIdEchoPrefix ?? 'BUILD_ID:',
      ...options,
    };
    this.inner = new FixtureSerialTransport({
      portPath: this.opts.portPath,
      portExists: this.opts.portExists,
      preloadedLines: this.opts.staleLines,
      handler: (line) => this.firmwareHandler(line),
    });
  }

  /** 固件模拟：解析入站请求行 → 组装响应 */
  private firmwareHandler(line: string): ReturnType<FixtureLineHandler> {
    if (this.opts.disconnectOnRequest) return { kind: 'disconnect' };
    if (!this.fw) return { kind: 'silent' }; // 板上无固件状态 → 无响应
    const nonceMatch = NONCE_RE.exec(line);
    if (!nonceMatch) return { kind: 'silent' }; // 非验证协议行 → 固件不回

    const nonce = this.opts.echoWrongNonce
      ? 'deadbeefdeadbeefdeadbeefdeadbeef' // 伪造的"上一轮"nonce
      : nonceMatch[0];
    const echoBuildId =
      !this.opts.respondWithoutBuildId &&
      this.fw.supportsBuildIdEcho !== false &&
      typeof this.fw.buildId === 'string';
    const response = echoBuildId
      ? `VERIFY OK ${this.opts.buildIdEchoPrefix}${this.fw.buildId} ${this.opts.nonceMarker}${nonce}`
      : `VERIFY OK ${this.opts.nonceMarker}${nonce}`;
    const lines = [...(this.opts.extraNoiseLines ?? []), response];
    return { kind: 'reply', lines, delayMs: this.opts.responseDelayMs ?? 0 };
  }

  async open(portPath: string, baudRate: number): Promise<void> {
    // 打开前读取板内固件状态（虚拟烧录工具写入 device-firmware.json）
    try {
      this.fw = JSON.parse(await readFile(path.join(this.opts.stateDir, 'device-firmware.json'), 'utf8'));
    } catch {
      this.fw = null;
    }
    await this.inner.open(portPath, baudRate);
  }

  async flush(): Promise<void> {
    await this.inner.flush();
  }

  async writeLine(line: string): Promise<void> {
    await this.inner.writeLine(line);
  }

  async readLine(timeoutMs: number): Promise<string> {
    return this.inner.readLine(timeoutMs);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
