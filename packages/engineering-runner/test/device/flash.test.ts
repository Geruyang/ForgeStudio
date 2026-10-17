// fixture 模拟测试——非实机验收。
// 烧录：成功（receipt 落盘 + 板内状态更新）/失败/崩溃→unknown/超时→unknown（M9）/
// 取消在启动前→cancelled；启动后取消不强杀；taskkill /T 树杀。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeviceBinding, DeviceFlashArgs } from '@forgedesk/contracts';
import { runFlash } from '../../src/device/flash.ts';
import { DeviceCancelledError, DeviceOperationError } from '../../src/device/errors.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const toolPath = path.join(fixturesDir, 'virtual-flash-tool.mjs');

let workDir: string;
let stateDir: string;
let artifactPath: string;
let artifactSha: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-flash-work-'));
  stateDir = await mkdtemp(path.join(tmpdir(), 'forgedesk-flash-state-'));
  const buf = randomBytes(256);
  artifactPath = path.join(workDir, 'firmware.bin');
  await writeFile(artifactPath, buf);
  artifactSha = createHash('sha256').update(buf).digest('hex');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

const binding: DeviceBinding = {
  schemaVersion: 1,
  id: 'dev-flash-test',
  profileId: 'example-embedded-stm32',
  identity: { usbVid: 0x0483, usbPid: 0x3748, probeSerial: '00000000001A', source: 'usb_hub' },
  chipTarget: 'STM32F103C8',
  identityEvidence: 'fixture：虚拟探针（模拟）',
  confirmedByUser: false,
  createdAt: new Date().toISOString(),
};

/** 构造烧录参数：flashCommand 指向虚拟烧录工具，${artifact} 占位替换 */
function makeArgs(extraToolArgs: string[], opts?: { budgetMs?: number; readback?: boolean; signal?: AbortSignal }): DeviceFlashArgs {
  const profile = {
    chipTarget: 'STM32F103C8',
    identity: { usbVid: 0x0483, usbPid: 0x3748, expectProbeSerial: false },
    flashCommand: {
      exe: process.execPath,
      args: [toolPath, '--artifact', '${artifact}', '--state', stateDir, ...extraToolArgs],
      timeoutMs: 300_000,
    },
    flashBudgetMs: 300_000,
    verifyBudgetMs: 120_000,
    ...(opts?.readback
      ? {
          readbackCommand: {
            exe: process.execPath,
            args: [toolPath, '--artifact', '${artifact}', '--state', stateDir, '--verify'],
            timeoutMs: 30_000,
          },
        }
      : {}),
  };
  return {
    taskId: 'task-flash-test',
    artifactPath,
    artifactSha256: artifactSha,
    buildId: 'bld-abc123',
    binding,
    profile,
    workDir,
    budgetMs: opts?.budgetMs ?? 300_000,
    signal: opts?.signal,
  };
}

describe('烧录：成功路径（模拟）', () => {
  it('exit 0 → succeeded：receipt 落盘（stdout 全量）+ 板内固件状态更新', async () => {
    const outcome = await runFlash(makeArgs(['--build-id', 'bld-abc123']));
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    expect(outcome.readbackVerified).toBeUndefined();

    const receipt = await readFile(outcome.toolReceiptPath, 'utf8');
    expect(receipt).toContain('[stdout] [virtual-flash-tool] Flash OK');
    expect(receipt).toContain(`artifactSha256: ${artifactSha}`);
    expect(receipt).toContain('bindingId: dev-flash-test');

    const fw = JSON.parse(await readFile(path.join(stateDir, 'device-firmware.json'), 'utf8')) as {
      sha256: string;
      buildId: string;
    };
    expect(fw.sha256).toBe(artifactSha); // 产物哈希已写入板内状态
    expect(fw.buildId).toBe('bld-abc123');
  });

  it('${artifact} 占位符替换为产物绝对路径（回执 command 行可见）', async () => {
    const outcome = await runFlash(makeArgs([]));
    const receipt = await readFile(outcome.toolReceiptPath, 'utf8');
    expect(receipt).not.toContain('${artifact}');
    expect(receipt).toContain(artifactPath);
  });

  it('有 readbackCommand → 执行读回校验 readbackVerified=true', async () => {
    const outcome = await runFlash(makeArgs(['--build-id', 'bld-abc123'], { readback: true }));
    expect(outcome.readbackVerified).toBe(true);
    const receipt = await readFile(outcome.toolReceiptPath, 'utf8');
    expect(receipt).toContain('VERIFY_OK');
  });
});

describe('烧录：失败与未知（M9 语义，模拟）', () => {
  it('非 0 退出 → failed（tool_nonzero_exit），回执仍落盘', async () => {
    const err = await runFlash(makeArgs(['--fail'])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceOperationError);
    const opErr = err as DeviceOperationError;
    expect(opErr.status).toBe('failed');
    expect(opErr.reason).toBe('tool_nonzero_exit');
    expect(opErr.outcome?.toolReceiptPath).toBeTruthy();
    const receipt = await readFile(opErr.outcome!.toolReceiptPath!, 'utf8');
    expect(receipt).toContain('ERROR: flash verify failed');
    // 失败不写板内状态
    await expect(readFile(path.join(stateDir, 'device-firmware.json'), 'utf8')).rejects.toThrow();
  });

  it('进程崩溃（NTSTATUS 大退出码）→ unknown（abnormal_termination，不自动重试）', async () => {
    const err = await runFlash(makeArgs(['--crash'])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceOperationError);
    const opErr = err as DeviceOperationError;
    expect(opErr.status).toBe('unknown');
    expect(opErr.reason).toBe('abnormal_termination');
    expect(opErr.kind).toBe('unknown_result');
  });

  it('预算超时 → taskkill /T /F 杀进程树 → unknown（timeout；超时不证明设备停止）', { timeout: 30_000 }, async () => {
    const err = await runFlash(makeArgs(['--hang-with-child', '8000'], { budgetMs: 700 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceOperationError);
    const opErr = err as DeviceOperationError;
    expect(opErr.status).toBe('unknown');
    expect(opErr.reason).toBe('budget_timeout');
    const receipt = await readFile(opErr.outcome!.toolReceiptPath!, 'utf8');
    expect(receipt).toContain('taskkill /T /F');

    // 树杀验证：孙进程（virtual-child.pid）也必须被终止（§11：不能只杀父进程）
    const childPid = Number(await readFile(path.join(stateDir, 'virtual-child.pid'), 'utf8'));
    await new Promise((r) => setTimeout(r, 300)); // taskkill 完成时序余量
    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

describe('烧录：取消（§11：烧录开始后是否可取消由工具能力决定）', () => {
  it('启动前取消 → cancelled（before_start，无副作用）', async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await runFlash(makeArgs([], { signal: ac.signal })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceCancelledError);
    expect((err as DeviceCancelledError).stage).toBe('before_start');
    // 无副作用：不产生回执、不写板内状态
    await expect(readFile(path.join(stateDir, 'device-firmware.json'), 'utf8')).rejects.toThrow();
  });

  it('启动后取消 → 不强杀烧录进程，等待工具自然结束（真实结果 exit 0 → succeeded）', { timeout: 30_000 }, async () => {
    const ac = new AbortController();
    const outcomePromise = runFlash(makeArgs(['--hang', '900'], { budgetMs: 8_000, signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 250)); // 等工具已启动
    ac.abort();
    const outcome = await outcomePromise; // 未抛 cancelled：按工具自然结束归类
    expect(outcome.durationMs).toBeGreaterThan(500);
    const receipt = await readFile(outcome.toolReceiptPath, 'utf8');
    expect(receipt).toContain('烧录中取消请求');
    expect(receipt).toContain('等待工具自然结束');
    // 工具自然结束 exit 0 → 板内状态仍被写入（副作用真实发生）
    const fw = JSON.parse(await readFile(path.join(stateDir, 'device-firmware.json'), 'utf8')) as { sha256: string };
    expect(fw.sha256).toBe(artifactSha);
  });
});
