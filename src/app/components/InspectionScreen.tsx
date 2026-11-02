import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight, Check, ChevronDown, ChevronRight, Download, Info, ListChecks, ScanSearch, TriangleAlert,
} from 'lucide-react';
import type { Analysis } from '../../lib/decide.ts';
import type { Dataset } from '../../lib/types.ts';
import { INSPECTION_STEPS, renderMarkdown, runInspection } from '../../lib/tasks/inspection.ts';
import { MATERIALITY_REL } from '../../lib/tasks/constants.ts';
import type { InspectionItem, InspectionReport, RiskLevel } from '../../lib/tasks/types.ts';
import { C } from '../lib/palette.ts';
import { Button, DecisionBadge, Panel, PanelHead, cx } from './ui';

/**
 * 巡检：把 120 个实验收成「今天只看 5 件」。
 *
 * 这一屏与前几屏的关系：其他屏回答「这个实验怎么样」，这一屏回答
 * **「今天该看哪个」**——前者是分析器，后者是任务。所以它的顺序是
 * 结论先行（第一屏）、证据在后（分组清单）、口径最后（方法），
 * 而不是按数据库顺序把实验排一遍。
 */

const RISK_META: Record<RiskLevel, { label: string; color: string; hint: string }> = {
  critical: { label: '必须处理', color: C.noship, hint: '数据不可用、有明确坏消息，或实验根本没收到数据' },
  warn: { label: '本周处理', color: C.iterate, hint: '结论不稳、效应有边界，或这个显著是看出来的' },
  info: { label: '等你拍板', color: C.brand, hint: '可以上线，或还需要资源（补样本）' },
  ok: { label: '无需动作', color: C.dim, hint: '要么问题回答完了，要么这个实验答不了这个问题' },
};

function RiskBadge({ risk }: { risk: RiskLevel }) {
  const m = RISK_META[risk];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-[2px] text-[10.5px] font-medium"
      style={{ color: m.color, background: `color-mix(in srgb, ${m.color} 12%, transparent)` }}
      title={m.hint}
    >
      <i className="h-1.5 w-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}

function Count({ n, label, color, hint }: { n: number; label: string; color: string; hint: string }) {
  return (
    <div className="min-w-0 flex-1 px-4 py-3" title={hint}>
      <div className="num text-[22px] font-semibold leading-7" style={{ color }}>
        {n}
      </div>
      <div className="mt-0.5 text-[11px] text-muted">{label}</div>
    </div>
  );
}

/** 一条巡检结论。信号默认收起——第一屏的作用是「告诉你是什么事」，细节点开再看 */
function ItemRow({
  item,
  expanded,
  onToggle,
  onOpen,
}: {
  item: InspectionItem;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const weighty = item.signals.filter((s) => s.weight > 0);
  return (
    <div className="border-b border-line/70 last:border-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-panel2/40"
        aria-expanded={expanded}
      >
        <span className="mt-0.5 shrink-0 text-dim">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-dim">{item.expId}</span>
            <span className="truncate text-[12.5px] font-medium text-ink">{item.name}</span>
            <RiskBadge risk={item.risk} />
            <DecisionBadge decision={item.decision} size="sm" />
          </div>
          <div className="mt-1 text-[11.5px] leading-5 text-muted">{item.why}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-[10px] text-dim">下一步</div>
          <div className="text-[11.5px] font-medium text-ink">{item.next.label}</div>
        </div>
      </button>

      {expanded && (
        <div className="bg-panel2/30 px-4 pb-4 pl-11">
          <ul className="space-y-2 pt-1">
            {weighty.map((s, i) => (
              <li key={`${s.code}-${i}`} className="text-[11.5px] leading-5">
                <span className="mr-1.5 rounded bg-panel px-1.5 py-[1px] text-[10px] text-muted ring-1 ring-inset ring-line">
                  {s.label}
                </span>
                <span className="text-muted">{s.detail}</span>
                {s.cites.length > 0 && (
                  <span className="ml-1 font-mono text-[10px] text-dim">[{s.cites.join('][')}]</span>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-3 rounded-lg border border-line bg-panel px-3 py-2">
            <div className="text-[10.5px] text-dim">下一步 · {item.next.label}</div>
            <div className="mt-0.5 text-[11.5px] leading-5 text-ink">{item.next.detail}</div>
            {item.next.forecast && (
              <div className="mt-1.5 border-t border-line/60 pt-1.5 font-mono text-[10px] leading-4 text-dim">
                {item.next.forecast.nPerArm !== null && (
                  <div>
                    每臂约需 {item.next.forecast.nPerArm.toLocaleString('en-US')} 人
                    {item.next.forecast.days !== null ? ` · 约 ${item.next.forecast.days} 天` : ''}
                  </div>
                )}
                <div>{item.next.forecast.note}</div>
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center gap-3 text-[10.5px] text-dim">
            <span>数据 {item.rowCount} 行</span>
            {item.lastDate && <span>最后一天 {item.lastDate}</span>}
            <button
              type="button"
              onClick={onOpen}
              className="ml-auto inline-flex items-center gap-1 text-brand2 hover:underline"
            >
              打开证据链 <ArrowRight size={11} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Group({
  risk,
  items,
  open,
  onOpenGroup,
  expandedId,
  onToggleItem,
  onOpenExp,
}: {
  risk: RiskLevel;
  items: InspectionItem[];
  open: boolean;
  onOpenGroup: () => void;
  expandedId: string | null;
  onToggleItem: (id: string) => void;
  onOpenExp: (id: string) => void;
}) {
  if (!items.length) return null;
  const m = RISK_META[risk];
  return (
    <Panel className="mt-4">
      <button
        type="button"
        onClick={onOpenGroup}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <span className="text-dim">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        <i className="h-2 w-2 rounded-full" style={{ background: m.color }} />
        <span className="text-[13px] font-medium text-ink">{m.label}</span>
        <span className="num text-[12px] text-dim">{items.length}</span>
        <span className="ml-1 hidden text-[11px] text-dim sm:inline">· {m.hint}</span>
      </button>
      {open && (
        <div className="border-t border-line">
          {items.map((x) => (
            <ItemRow
              key={x.expId}
              item={x}
              expanded={expandedId === x.expId}
              onToggle={() => onToggleItem(x.expId)}
              onOpen={() => onOpenExp(x.expId)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

export function InspectionScreen({
  dataset,
  analyses,
  onOpen,
}: {
  dataset: Dataset;
  analyses: Map<string, Analysis>;
  onOpen: (id: string) => void;
}) {
  const report: InspectionReport = useMemo(() => runInspection(dataset, analyses), [dataset, analyses]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [group, setGroup] = useState<RiskLevel | null>('warn');

  const byRisk = (r: RiskLevel) => report.items.filter((x) => x.risk === r);
  const p = report.power;

  // 导出是「浏览器另存一个文件」：页面本身一个字节都不会变，
  // 点了没反应和点了成功在用户眼里完全一样。所以给两秒确认态——
  // 这不是装饰，是这颗按钮唯一能证明自己生效了的东西。
  const [exported, setExported] = useState(false);
  const exportTimer = useRef<number | null>(null);
  useEffect(() => () => { if (exportTimer.current) window.clearTimeout(exportTimer.current); }, []);

  const download = () => {
    const md = renderMarkdown(report);
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `实验巡检周报-${report.asOf}.md`;
    a.click();
    // 不 revoke 会让 blob 一直占内存；给浏览器一点时间发起下载再释放
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setExported(true);
    if (exportTimer.current) window.clearTimeout(exportTimer.current);
    exportTimer.current = window.setTimeout(() => setExported(false), 2000);
  };

  return (
    <div className="mx-auto max-w-[1120px] px-3 py-5 sm:px-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[17px] font-semibold text-ink">
            <ScanSearch size={17} className="text-brand2" />
            实验巡检
          </h1>
          <p className="mt-1 text-[11.5px] leading-5 text-muted">
            基准日 <b className="text-ink">{report.asOf}</b>（取数据里最晚的一天，不是系统时钟）·
            {' '}{report.totals.experiments} 个实验 · {report.totals.rows.toLocaleString('en-US')} 行。
            它回答的是<b className="text-ink">「今天该看哪个」</b>，不是「所有实验都正常」。
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={download} title="导出完整周报（Markdown）">
          {exported ? <Check size={13} /> : <Download size={13} />}
          {exported ? '已导出' : '导出周报'}
        </Button>
      </div>

      {/* 四个数：结论先行 */}
      <Panel className="mt-4">
        <div className="flex divide-x divide-line">
          <Count n={report.totals.critical} label="必须处理" color={C.noship} hint={RISK_META.critical.hint} />
          <Count n={report.totals.warn} label="本周处理" color={C.iterate} hint={RISK_META.warn.hint} />
          <Count n={report.totals.info} label="等你拍板" color={C.brand} hint={RISK_META.info.hint} />
          <Count n={report.totals.ok} label="无需动作" color={C.dim} hint={RISK_META.ok.hint} />
        </div>
      </Panel>

      {report.systemic && (
        <div
          className="mt-4 flex gap-2.5 rounded-xl border px-4 py-3"
          style={{ borderColor: `color-mix(in srgb, ${C.noship} 35%, transparent)`, background: `color-mix(in srgb, ${C.noship} 8%, transparent)` }}
        >
          <TriangleAlert size={15} className="mt-[2px] shrink-0" style={{ color: C.noship }} />
          <div>
            <div className="text-[12px] font-medium" style={{ color: C.noship }}>
              疑似系统性问题（优先查一件共用的事，不要逐个实验调）
            </div>
            <div className="mt-1 text-[11.5px] leading-5 text-muted">{report.systemic}</div>
          </div>
        </div>
      )}

      {/* 第一屏 */}
      <Panel className="mt-4">
        <PanelHead
          title={
            <span className="flex items-center gap-2">
              <ListChecks size={14} className="text-brand2" />
              今天只看这几件
            </span>
          }
          hint="按「不处理的代价」排序，不是按效应大小；同类原因只留一个代表（其余在下面的分组里）"
          right={<span className="num text-[11px] text-dim">{report.mustLook.length} 件</span>}
        />
        {report.mustLook.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted">
            今天没有必须处理的事——所有实验要么已有结论，要么还在正常积累数据。
          </div>
        ) : (
          <div>
            {report.mustLook.map((x) => (
              <ItemRow
                key={x.expId}
                item={x}
                expanded={expanded === x.expId}
                onToggle={() => setExpanded(expanded === x.expId ? null : x.expId)}
                onOpen={() => onOpen(x.expId)}
              />
            ))}
          </div>
        )}
      </Panel>

      {/* 样本量：集体事实 */}
      {p.inconclusive > 0 && (
        <Panel className="mt-4">
          <PanelHead
            title="样本量：这批实验大多回答不了业务问题"
            hint={`业务门槛 = 相对对照基线 ${(MATERIALITY_REL * 100).toFixed(0)}% 的提升（可在设置里改）`}
          />
          <div className="px-4 py-3 text-[11.5px] leading-6 text-muted">
            {p.insufficient > 0 ? (
              <>
                <b className="text-ink">{p.inconclusive}</b> 个实验没有结论，其中{' '}
                <b className="text-ink">{p.insufficient}</b> 个（
                {((p.insufficient / p.inconclusive) * 100).toFixed(0)}%）是
                <b className="text-ink">设计不足</b>：按现在的规模，能检出的最小相对效应中位数是{' '}
                <b className="text-ink">
                  {p.medianMdeRel !== null ? `${(p.medianMdeRel * 100).toFixed(1)}%` : '—'}
                </b>
                ，而业务门槛是 {(p.materialityRel * 100).toFixed(0)}% 的提升
                {p.medianNMultiple !== null && (
                  <>
                    ——要检出它，样本量需要放大 <b className="text-ink">{p.medianNMultiple.toFixed(0)} 倍</b>
                  </>
                )}
                。
                <div className="mt-2 rounded-lg border border-line bg-panel2/50 px-3 py-2">
                  <b className="text-ink">这批数据的「不显著」不能被读成「没效果」。</b>
                  它的分辨率比要回答的问题粗一个量级，所以「没效果」这个结论在这里根本没有被检验过。
                  补样本不现实——下次设计时先把样本量算出来（
                  <a href="#/plan" className="text-brand2 hover:underline">
                    实验设计
                  </a>
                  那一屏就是干这个的）。
                </div>
              </>
            ) : (
              <>
                {p.inconclusive} 个实验没有结论，其中 {p.fixable} 个补样本可行——见下表的每臂人数与天数。
              </>
            )}
          </div>
        </Panel>
      )}

      {(['warn', 'info', 'ok'] as RiskLevel[]).map((r) => (
        <Group
          key={r}
          risk={r}
          items={byRisk(r)}
          open={group === r}
          onOpenGroup={() => setGroup(group === r ? null : r)}
          expandedId={expanded}
          onToggleItem={(id) => setExpanded(expanded === id ? null : id)}
          onOpenExp={onOpen}
        />
      ))}

      {/* 必须处理的完整清单（第一屏只放代表） */}
      {byRisk('critical').length > report.mustLook.length && (
        <Group
          risk="critical"
          items={byRisk('critical')}
          open={group === 'critical'}
          onOpenGroup={() => setGroup(group === 'critical' ? null : 'critical')}
          expandedId={expanded}
          onToggleItem={(id) => setExpanded(expanded === id ? null : id)}
          onOpenExp={onOpen}
        />
      )}

      {/* 口径与方法：读者能自己算、也能看出边界 */}
      <Panel className="mt-4">
        <PanelHead
          title={
            <span className="flex items-center gap-2">
              <Info size={14} className="text-dim" />
              这份报告怎么来的
            </span>
          }
          hint="全部确定性：不调模型、不看系统时钟、不重算统计量——所以同一份数据永远得到同一份周报"
        />
        <ol className="space-y-1.5 px-4 py-3 text-[11.5px] leading-5 text-muted">
          {INSPECTION_STEPS.map((s, i) => (
            <li key={s} className="flex gap-2">
              <span className="num shrink-0 text-dim">{i + 1}.</span>
              <span>{s}</span>
            </li>
          ))}
        </ol>
        <div className="border-t border-line px-4 py-3">
          <div className="text-[10.5px] font-medium text-ink">这份报告不回答什么</div>
          <ul className="mt-1 space-y-1 text-[11px] leading-5 text-dim">
            {report.scope.map((s) => (
              <li key={s} className="flex gap-1.5">
                <span>·</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5 text-[10.5px] text-dim">
          <span>
            证据引用 <b className="text-muted">{report.digest.evidenceCites}</b> 处，平均每个实验{' '}
            {report.digest.evidencePerItem.toFixed(2)} 处
          </span>
          <span>
            引擎判无结论却硬给方向的次数 <b className="text-muted">{report.digest.hardVerdictsOnInconclusive}</b>
          </span>
          <span className="ml-auto hidden sm:inline">
            命令：<code className="rounded bg-panel2 px-1 font-mono">npm run inspect</code>
          </span>
        </div>
      </Panel>

      <div className={cx('py-6 text-center text-[10.5px] text-dim')}>
        所有数字来自引擎，每条结论都带证据编号；点开任意一条可以跳到详情页复算。
      </div>
    </div>
  );
}
