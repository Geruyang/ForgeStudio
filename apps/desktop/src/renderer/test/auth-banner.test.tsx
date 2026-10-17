/**
 * 全局横幅：模型认证缺失 / 引擎未启动 / runner 不可用（真实语义，不假造数据）。
 */
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppInfo } from '../contracts/ipc';
import { GlobalBanners } from '../views/GlobalBanners';
import { makeSetup, renderWithStore } from './test-utils/render';

const appInfo: AppInfo = {
  name: 'ForgeStudio',
  version: '0.1.0',
  platform: 'win32',
  electronVersion: '44.7.2',
  nodeVersion: '22.0.0',
  homeDir: 'C:\\Users\\tester',
  dataDir: 'C:\\ForgeStudio\\data',
  engineHome: 'C:\\ForgeStudio\\engine-home',
  engineCliPath: 'C:\\ForgeStudio\\engine-home\\codex.exe',
};

describe('全局横幅 GlobalBanners', () => {
  it('模型认证缺失：显示横幅 + 引导文案（含 engineHome），不出现密钥字面量', () => {
    const setup = makeSetup();
    setup.store.setState({
      appInfo,
      authStatus: { mode: 'none', ok: false },
    });
    renderWithStore(<GlobalBanners />, setup);
    const banner = screen.getByTestId('auth-missing-banner');
    expect(banner).toHaveTextContent('模型认证缺失');
    expect(banner).toHaveTextContent('未配置');
    expect(banner).toHaveTextContent('C:\\ForgeStudio\\engine-home');
    expect(banner).not.toHaveTextContent('sk-');
  });

  it('认证正常时不显示认证横幅', () => {
    const setup = makeSetup();
    setup.store.setState({
      appInfo,
      authStatus: { mode: 'api_key', ok: true, accountHint: '已配置' },
    });
    renderWithStore(<GlobalBanners />, setup);
    expect(screen.queryByTestId('auth-missing-banner')).not.toBeInTheDocument();
  });

  it('引擎未启动提示真实语义', () => {
    const setup = makeSetup();
    setup.store.setState({ engineStatus: 'stopped', authStatus: { mode: 'api_key', ok: true } });
    renderWithStore(<GlobalBanners />, setup);
    expect(screen.getByText(/引擎未启动/)).toBeInTheDocument();
  });

  it('runner 不可用横幅：runnerReachable=false 才显示', () => {
    const setup = makeSetup();
    setup.store.setState({ runnerReachable: false, authStatus: { mode: 'api_key', ok: true } });
    const first = renderWithStore(<GlobalBanners />, setup);
    expect(screen.getByText(/工程执行器（runner）不可用/)).toBeInTheDocument();
    first.unmount();

    const setupOk = makeSetup();
    setupOk.store.setState({ runnerReachable: true, authStatus: { mode: 'api_key', ok: true } });
    renderWithStore(<GlobalBanners />, setupOk);
    expect(screen.queryByText(/工程执行器（runner）不可用/)).not.toBeInTheDocument();
  });

  it('未探测（runnerReachable=null）不显示 runner 横幅——不假造数据', () => {
    const setup = makeSetup();
    setup.store.setState({ runnerReachable: null, authStatus: { mode: 'api_key', ok: true } });
    renderWithStore(<GlobalBanners />, setup);
    expect(screen.queryByText(/工程执行器（runner）不可用/)).not.toBeInTheDocument();
  });
});
