/**
 * 计划卡：把 update_plan 类工具调用的输出预览解析为步骤列表。
 * 解析失败时退化为普通工具卡展示，不伪造步骤。
 */
import type { ToolCallView } from '../../lib/events';
import { PLAN_STEP_LABELS_ZH, PLAN_STEP_TONE } from '../../lib/labels';
import { Badge } from '../common/Badge';
import { ToolCard } from './ToolCard';

export interface PlanStep {
  text: string;
  status: string;
}

/** 从 outputPreview 提取 steps；提取不出返回 null（回退工具卡） */
export function parsePlanSteps(call: ToolCallView): PlanStep[] | null {
  const source = call.outputPreview || call.argsPreview;
  if (!source) return null;
  const candidates: unknown[] = [];
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      candidates.push(JSON.parse(source.slice(start, end + 1)));
    } catch {
      /* 继续尝试整体 */
    }
  }
  candidates.push(source);
  for (const c of candidates) {
    const steps = extractSteps(c);
    if (steps && steps.length > 0) return steps;
  }
  return null;
}

function extractSteps(v: unknown): PlanStep[] | null {
  if (typeof v === 'string') {
    const m = v.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return extractSteps(JSON.parse(m[0]));
    } catch {
      return null;
    }
  }
  if (typeof v !== 'object' || v === null) return null;
  const raw = (v as Record<string, unknown>).steps;
  if (!Array.isArray(raw)) return null;
  const steps: PlanStep[] = [];
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue;
    const rec = s as Record<string, unknown>;
    const text = typeof rec.step === 'string' ? rec.step : typeof rec.title === 'string' ? rec.title : '';
    const status = typeof rec.status === 'string' ? rec.status : 'planned';
    if (!text) continue;
    steps.push({ text, status });
  }
  return steps.length > 0 ? steps : null;
}

export function PlanCard({ call }: { call: ToolCallView }) {
  const steps = parsePlanSteps(call);
  if (!steps) return <ToolCard call={call} />;
  const done = steps.filter((s) => s.status === 'completed').length;
  return (
    <div className="plan-card" data-testid="plan-card">
      <div className="plan-card__title">
        计划
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>
          {done}/{steps.length} 步已完成
        </span>
      </div>
      {steps.map((step, i) => (
        <div key={i} className={`plan-step${step.status === 'completed' ? ' plan-step--done' : ''}${step.status === 'in_progress' ? ' plan-step--doing' : ''}`}>
          <span className="plan-step__index">{i + 1}</span>
          <span className="plan-step__text">{step.text}</span>
          <span className="plan-step__status">
            <Badge tone={PLAN_STEP_TONE[step.status] ?? 'neutral'}>
              {PLAN_STEP_LABELS_ZH[step.status] ?? step.status}
            </Badge>
          </span>
        </div>
      ))}
    </div>
  );
}
