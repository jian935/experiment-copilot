import {
  BadgeCheck,
  BarChart3,
  FlaskConical,
  Gavel,
  ListTree,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import type { Analysis, Evidence } from '../../lib/decide.ts';
import type { Experiment } from '../../lib/types.ts';
import { fmtP } from '../lib/format';
import { Button, Drawer, cx } from './ui';

const KIND_META: Record<Evidence['kind'], { label: string; icon: typeof FlaskConical; cls: string }> = {
  srm: { label: 'SRM', icon: FlaskConical, cls: 'text-sky-300 bg-sky-400/10 ring-sky-400/25' },
  metric: { label: '主指标', icon: BarChart3, cls: 'text-brand2 bg-brand/10 ring-brand/25' },
  segment: { label: '分层', icon: ListTree, cls: 'text-violet-300 bg-violet-400/10 ring-violet-400/25' },
  guardrail: { label: '护栏', icon: ShieldAlert, cls: 'text-amber-300 bg-amber-400/10 ring-amber-400/25' },
  decision: { label: '结论', icon: Gavel, cls: 'text-emerald-300 bg-emerald-400/10 ring-emerald-400/25' },
};

export function EvidenceDrawer({
  open,
  onClose,
  exp,
  analysis,
  onRecalc,
  recalc,
}: {
  open: boolean;
  onClose: () => void;
  exp: Experiment;
  analysis: Analysis;
  onRecalc: () => void;
  recalc: { ok: boolean; ms: number; n: number } | null;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`证据链 · ${exp.id} ${exp.name}`}
      subtitle="每条结论都对应一条可核对的证据：数据口径、样本量、统计量与 p 值。模型不参与任何计算。"
      width={600}
      footer={
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10.5px] leading-4 text-dim">
            {recalc ? (
              <span className={recalc.ok ? 'text-ship' : 'text-noship'}>
                {recalc.ok
                  ? `✓ 复算一致（${recalc.n} 条证据，${recalc.ms.toFixed(1)}ms）`
                  : '✗ 复算结果不一致'}
              </span>
            ) : (
              '复算 = 用同一份数据重跑引擎，逐项比对数值'
            )}
          </div>
          <Button variant="primary" size="sm" onClick={onRecalc}>
            <RefreshCw size={13} /> 一键复算
          </Button>
        </div>
      }
    >
      <ol className="relative space-y-2.5 border-l border-line pl-4">
        {analysis.evidence.map((e) => {
          const meta = KIND_META[e.kind];
          const Icon = meta.icon;
          return (
            <li key={e.id} className="relative">
              <span className="absolute -left-[23px] top-2 h-2 w-2 rounded-full bg-line2 ring-4 ring-panel" />
              <div className="rounded-lg border border-line bg-panel2/50 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ring-1 ring-inset', meta.cls)}>
                    <Icon size={10} /> {meta.label}
                  </span>
                  <span className="text-[12px] font-medium text-ink">{e.label}</span>
                  <span className="ml-auto font-mono text-[10px] text-dim">{e.id}</span>
                </div>
                <p className="num mt-1.5 text-[11px] leading-5 text-muted">{e.detail}</p>
                {e.kind === 'decision' && (
                  <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-ship">
                    <BadgeCheck size={11} /> 由上面全部证据按固定优先级规则推出
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-4 rounded-lg border border-line bg-panel2/40 px-3 py-3">
        <div className="text-[11px] font-medium text-ink">数据与口径</div>
        <dl className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10.5px]">
          <Row k="主指标" v={`${exp.primaryMetric}（二值）`} />
          <Row k="检验方法" v="两比例 z（合并方差）" />
          <Row k="区间方法" v="Newcombe 混合法 95%" />
          <Row k="多重比较" v="Benjamini–Hochberg q=0.10" />
          <Row k="显著性阈值" v="α = 0.05（双侧）" />
          <Row k="SRM 阈值" v="p<0.001 且偏差>2%" />
          <Row k="样本合计" v={`${(analysis.overall.n1 + analysis.overall.n2).toLocaleString('en-US')}`} />
          <Row k="最小 p 记录" v={fmtP(Math.min(...analysis.evidence.map((x) => x.value ?? 1)))} />
        </dl>
        <p className="mt-2 text-[10px] leading-4 text-dim">
          数据为固定种子生成的合成数据（seed {exp.seed}），用于已知真值评测；不是真实业务数据。
        </p>
      </div>
    </Drawer>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/40 pb-1">
      <dt className="text-dim">{k}</dt>
      <dd className="text-right text-muted">{v}</dd>
    </div>
  );
}
