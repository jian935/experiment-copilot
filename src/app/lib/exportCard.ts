import type { Analysis } from '../../lib/decide.ts';
import type { Experiment } from '../../lib/types.ts';
import { DECISION_META, REASON_META, fmtNum, fmtP, fmtPP, fmtPct, type Tone } from './format';

const W = 880;
const H = 600;

const TONE_HEX: Record<Tone, string> = {
  ship: '#34d399',
  noship: '#fb7185',
  iterate: '#fbbf24',
  incon: '#94a3b8',
};

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 中英混排的粗估宽度：CJK 按 1em，其他按 0.55em */
function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.55;
  }
  return w;
}

function wrap(text: string, maxWidth: number, size: number, maxLines: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (textWidth(cur + ch, size) > maxWidth) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) break;
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (lines.length === maxLines) {
    const joined = lines.join('');
    if (joined.length < text.length) lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…';
  }
  return lines;
}

export function buildCardSvg(exp: Experiment, a: Analysis, meta: { datasetVersion: string; seed: string }): string {
  const dm = DECISION_META[a.decision] ?? DECISION_META.inconclusive;
  const tone = dm.tone as Tone;
  const color = TONE_HEX[tone];

  const srmOk = !a.srm.flagged;
  const sigOk = a.overall.p < 0.05;
  const gate = a.guardrails.find((g) => g.gating && g.worse);
  const checks: { ok: boolean; label: string; value: string }[] = [
    { ok: srmOk, label: 'SRM 分流', value: `偏差 ${(a.srm.relImb * 100).toFixed(2)}%` },
    { ok: sigOk, label: '主指标显著性', value: `p = ${fmtP(a.overall.p)}` },
    { ok: !gate, label: '硬护栏', value: gate ? `${gate.label} ${fmtPP(gate.diff)}` : '未恶化' },
  ];

  const reasonLines = wrap(a.reason, 800, 15, 3);
  const shift = (3 - reasonLines.length) * 24;
  const Hd = H - shift;
  const metrics = [
    { k: '绝对差值', v: fmtPP(a.overall.diff), c: a.overall.diff > 0 ? '#34d399' : '#fb7185' },
    { k: '95% 置信区间', v: `[${(a.overall.ci95[0] * 100).toFixed(2)}, ${(a.overall.ci95[1] * 100).toFixed(2)}]pp`, c: '#e9eef8' },
    { k: 'p 值', v: fmtP(a.overall.p), c: '#e9eef8' },
    { k: '总样本', v: fmtNum(a.overall.n1 + a.overall.n2), c: '#e9eef8' },
  ];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${Hd}" viewBox="0 0 ${W} ${Hd}">
  <defs>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${color}" stop-opacity="0.16"/>
      <stop offset="0.55" stop-color="${color}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${Hd}" fill="#0a0f1a"/>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${Hd - 1}" fill="none" stroke="#1e2a3d"/>
  <rect width="${W}" height="196" fill="url(#glow)"/>

  <!-- header -->
  <rect x="40" y="34" width="22" height="22" rx="6" fill="#6366f1" fill-opacity="0.18" stroke="#6366f1" stroke-opacity="0.5"/>
  <path d="M45 50 l4 -5 3.5 3 5 -6.5" fill="none" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="72" y="50" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="13.5" font-weight="600" fill="#e9eef8">Experiment Copilot</text>
  <text x="${72 + textWidth('Experiment Copilot', 13.5) * 1.06 + 14}" y="50" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="11.5" fill="#6b7c96">实验结论官 · 可复算的实验决策</text>
  <text x="${W - 40}" y="50" text-anchor="end" font-family="SFMono-Regular, Consolas, monospace" font-size="11" fill="#4d5a70">${esc(meta.datasetVersion)}</text>

  <!-- title -->
  <rect x="40" y="78" width="${Math.max(52, textWidth(exp.id, 11) + 18)}" height="20" rx="5" fill="#121a2b" stroke="#1e2a3d"/>
  <text x="${40 + Math.max(52, textWidth(exp.id, 11) + 18) / 2}" y="92" text-anchor="middle" font-family="SFMono-Regular, Consolas, monospace" font-size="11" fill="#93a3bb">${esc(exp.id)}</text>
  <text x="40" y="136" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="26" font-weight="600" fill="#e9eef8">${esc(exp.name)}</text>
  <text x="40" y="160" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="12" fill="#6b7c96">${esc(exp.primaryMetric)}（二值） · ${esc(exp.startDate)} → ${esc(exp.endDate)} · ${esc(exp.trafficSplit)}</text>

  <!-- decision -->
  <text x="40" y="222" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="42" font-weight="700" fill="${color}">${esc(dm.label)}</text>
  <text x="${40 + textWidth(dm.label, 42) + 16}" y="220" font-family="SFMono-Regular, Consolas, monospace" font-size="12" fill="${color}" fill-opacity="0.75">规则 ${esc(a.reasonCode)} · ${esc(REASON_META[a.reasonCode])}</text>
  ${reasonLines
    .map(
      (line, i) =>
        `<text x="40" y="${258 + i * 24}" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="15" fill="#c3cfe2">${esc(line)}</text>`,
    )
    .join('\n  ')}

  <!-- metrics -->
  <line x1="40" y1="${352 - shift}" x2="${W - 40}" y2="${352 - shift}" stroke="#1e2a3d"/>
  ${metrics
    .map(
      (m, i) => `<text x="${40 + i * 205}" y="${380 - shift}" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="11" fill="#6b7c96">${esc(m.k)}</text>
  <text x="${40 + i * 205}" y="${408 - shift}" font-family="SFMono-Regular, Consolas, monospace" font-size="20" font-weight="600" fill="${m.c}">${esc(m.v)}</text>`,
    )
    .join('\n  ')}

  <!-- checks -->
  <line x1="40" y1="${434 - shift}" x2="${W - 40}" y2="${434 - shift}" stroke="#1e2a3d"/>
  ${checks
    .map((c, i) => {
      const x = 40 + i * 274;
      const ink = c.ok ? '#34d399' : '#fb7185';
      return `<circle cx="${x + 5}" cy="${462 - shift}" r="4.5" fill="${ink}"/>
  <text x="${x + 18}" y="${466 - shift}" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="12.5" fill="#e9eef8">${esc(c.label)}</text>
  <text x="${x + 18}" y="${484 - shift}" font-family="SFMono-Regular, Consolas, monospace" font-size="10.5" fill="#6b7c96">${esc(c.value)}</text>`;
    })
    .join('\n  ')}

  <!-- footer -->
  <line x1="40" y1="${512 - shift}" x2="${W - 40}" y2="${512 - shift}" stroke="#1e2a3d"/>
  <text x="40" y="${540 - shift}" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="11" fill="#4d5a70">统计与决策全部由确定性引擎计算，模型不参与任何数值；合成数据 seed ${esc(meta.seed)}</text>
  <text x="${W - 40}" y="${540 - shift}" text-anchor="end" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="11" fill="#4d5a70">作者：绝望的土豆泥</text>
  <text x="40" y="${566 - shift}" font-family="PingFang SC, Microsoft YaHei, Segoe UI, sans-serif" font-size="10.5" fill="#3d4b63">control ${fmtPct(a.overall.controlRate, 3)} → treatment ${fmtPct(a.overall.treatmentRate, 3)} · n₁=${fmtNum(a.overall.n1)} / n₂=${fmtNum(a.overall.n2)}</text>
</svg>`;
}

/** 把结论卡渲染成 2 倍图 PNG 并触发下载（不依赖任何第三方截图库） */
export async function exportConclusionCard(
  exp: Experiment,
  a: Analysis,
  meta: { datasetVersion: string; seed: string },
): Promise<void> {
  const svg = buildCardSvg(exp, a, meta);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('结论卡渲染失败'));
      img.src = url;
    });
    const m = /height="(\d+)"/.exec(svg);
    const cardH = m ? Number(m[1]) : H;
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = cardH * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('当前浏览器不支持 canvas');
    ctx.fillStyle = '#0a0f1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, W * scale, cardH * scale);
    const png = canvas.toDataURL('image/png');
    const a2 = document.createElement('a');
    a2.href = png;
    a2.download = `${exp.id}-${exp.name.replace(/[\\/:*?"<>|]/g, '')}-结论卡.png`;
    document.body.appendChild(a2);
    a2.click();
    a2.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
