/**
 * 代码差异面板：统一 patch 解析、文件清单+增删、>500 行分块加载、无文本时的诚实回退。
 */
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffPanel } from '../views/DiffPanel';
import { PatchCard } from '../components/chat/PatchCard';
import { makeSetup, renderWithStore } from './test-utils/render';

function unified(lines: number): string {
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (let i = 0; i < lines; i++) {
    if (i % 3 === 0) {
      body.push(`-old line ${i}`);
      oldCount += 1;
    } else if (i % 3 === 1) {
      body.push(`+new line ${i}`);
      newCount += 1;
    } else {
      body.push(` ctx line ${i}`);
      oldCount += 1;
      newCount += 1;
    }
  }
  return [
    '--- a/src/big.ts',
    '+++ b/src/big.ts',
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...body,
  ].join('\n');
}

function seedPatch(store: ReturnType<typeof makeSetup>['store']) {
  store.getState().applyEngineEvent({
    seq: 1,
    connectionGeneration: 1,
    threadId: 'th-1',
    turnId: 't1',
    emittedAt: '2026-10-14T10:00:00.000Z',
    type: 'patch/applied',
    files: [
      { path: 'src/big.ts', changeType: 'modified' },
      { path: 'README.md', changeType: 'added' },
    ],
    patchRef: 'patch-1',
    additions: 200,
    deletions: 100,
  });
}

describe('DiffPanel 代码差异面板', () => {
  it('patch 卡点击"查看差异"→ 侧滑面板：文件清单+增删统计；>500 行只渲染首块并可加载更多', async () => {
    const setup = makeSetup(undefined, { patchContent: async () => unified(1200) });
    seedPatch(setup.store);
    renderWithStore(
      <>
        <PatchCard patch={setup.store.getState().conversation.messages[0].patches[0]} />
        <DiffPanel />
      </>,
      setup,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看差异' }));

    await waitFor(() => expect(screen.getByTestId('diff-panel')).toBeInTheDocument());
    expect(screen.getAllByText('+200').length).toBeGreaterThan(0);
    expect(screen.getAllByText('−100').length).toBeGreaterThan(0);
    expect(screen.getAllByText('src/big.ts').length).toBeGreaterThan(0);
    expect(screen.getAllByText('README.md').length).toBeGreaterThan(0);

    const more = screen.getByTestId('diff-load-more');
    expect(more).toHaveTextContent('剩余');
    fireEvent.click(more);
    // 每次扩 500 行，1200+ 行需多次加载
    expect(screen.getByTestId('diff-load-more')).toBeInTheDocument();
  });

  it('主进程未提供差异文本时：仍显示文件清单+统计，并如实说明文本不可用', () => {
    const setup = makeSetup(); // 未注入 patchContent（当前契约缺口）
    seedPatch(setup.store);
    renderWithStore(
      <>
        <PatchCard patch={setup.store.getState().conversation.messages[0].patches[0]} />
        <DiffPanel />
      </>,
      setup,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看差异' }));
    expect(screen.getByText(/完整差异文本|尚未提供/)).toBeInTheDocument();
    expect(screen.getAllByText('src/big.ts').length).toBeGreaterThan(0);
  });
  it('非法 diff 文本回退纯文本展示，不伪造解析', async () => {
    const setup = makeSetup(undefined, { patchContent: async () => '不是一段 diff' });
    seedPatch(setup.store);
    renderWithStore(
      <>
        <PatchCard patch={setup.store.getState().conversation.messages[0].patches[0]} />
        <DiffPanel />
      </>,
      setup,
    );
    fireEvent.click(screen.getByRole('button', { name: '查看差异' }));
    await waitFor(() => expect(screen.getByText('不是一段 diff')).toBeInTheDocument());
  });
});
