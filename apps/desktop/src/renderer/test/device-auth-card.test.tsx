/**
 * 设备授权卡：与引擎审批视觉区分（violet 类名）、范围摘要展示、批准/拒绝回调带 confirmedScope。
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PendingAuthorization } from '../contracts/runner';
import { DeviceAuthCard } from '../components/eng/DeviceAuthCard';
import { makeOperation, makeTaskOverview } from './test-utils/fixtures';
import { makeSetup, renderWithStore } from './test-utils/render';

const pending: PendingAuthorization = {
  operationId: 'op-9',
  taskId: 'task-1',
  type: 'device_flash',
  title: '向已绑定设备烧录固件',
  scopeSummary: '目标设备 dev-1（STM32F103CB，COM7）· 产物 firmware.bin · 验收：串口身份与行为验证',
  artifactSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  acceptanceDigest: 'f'.repeat(64),
  requestedAt: '2026-10-14T10:00:00.000Z',
  expiresAt: '2999-01-01T00:00:00.000Z',
};

function renderCard() {
  const setup = makeSetup();
  const task = makeTaskOverview({
    id: 'task-1',
    operations: [makeOperation({ id: 'op-9', taskId: 'task-1', type: 'device_flash', status: 'awaiting_authorization', deviceBindingId: 'dev-1' })],
  });
  setup.store.setState({ tasks: [task], activeTaskId: 'task-1', pendingAuths: [pending] });
  renderWithStore(<DeviceAuthCard pending={pending} />, setup);
  return setup;
}

describe('设备授权卡 DeviceAuthCard', () => {
  it('展示显式范围摘要：任务 + 产物哈希前 12 位 + 过期时间', () => {
    renderCard();
    const scope = screen.getByTestId('device-auth-scope');
    expect(scope).toHaveTextContent('task-1');
    expect(scope).toHaveTextContent('0123456789ab');
    expect(scope).toHaveTextContent(/过期/);
    expect(screen.getByText(/独立于引擎审批/)).toBeInTheDocument();
    expect(screen.getByText(/目标设备 dev-1/)).toBeInTheDocument();
  });

  it('使用与引擎审批区分的视觉样式（violet 主题类）', () => {
    renderCard();
    const card = screen.getByTestId('device-auth-card');
    expect(card.className).toContain('device-auth-card');
    // 与引擎审批卡（approval-card / 琥珀）不同类名
    expect(card.className).not.toContain('approval-card');
  });

  it('拒绝回调 runner.authorize(operationId, declined, confirmedScope)', async () => {
    const setup = renderCard();
    fireEvent.click(screen.getByTestId('device-auth-decline'));
    await waitFor(() => expect(setup.bridge.calls.some((c) => c.method === 'runner.authorize')).toBe(true));
    const call = setup.bridge.calls.find((c) => c.method === 'runner.authorize');
    expect(call?.args[0]).toBe('op-9');
    expect(call?.args[1]).toBe('declined');
    const scope = call?.args[2] as { taskId: string; artifactSha256?: string; deviceBindingId?: string };
    expect(scope).toMatchObject({ taskId: 'task-1', artifactSha256: pending.artifactSha256, deviceBindingId: 'dev-1' });
  });

  it('批准回调 runner.authorize(operationId, approved, confirmedScope)', async () => {
    const setup = renderCard();
    fireEvent.click(screen.getByTestId('device-auth-approve'));
    await waitFor(() =>
      expect(setup.bridge.calls.find((c) => c.method === 'runner.authorize')?.args[1]).toBe('approved'),
    );
  });
});
