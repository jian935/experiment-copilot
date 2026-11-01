/**
 * 设置页的持久化层。
 *
 * 三块设置：决策口径（α / 护栏 margin / Bootstrap）、模型（provider / base / model / Key）、界面。
 * 全部存 localStorage，读取时做形状校验——坏数据（手改坏了、旧版本残留）一律回退默认，
 * 不然一个坏值就能让整个引擎的结论变得不可解释。
 */

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CONFIG, mergeConfig, type DecisionConfig } from '../../lib/config.ts';

const KEY = 'ec_settings_v1';

/** OpenAI 兼容的 provider 预设：换 base_url + model 即可，不绑定任何一家 */
export interface ProviderPreset {
  key: string;
  label: string;
  baseUrl: string;
  model: string;
  /** 是否需要 Key（本地 Ollama 不需要） */
  needsKey: boolean;
  hint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    needsKey: true,
    hint: '默认。OpenAI 兼容 + function calling；另有 deepseek-v4-pro。',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    hint: '标准 OpenAI 兼容接口，模型名可自行改写。',
  },
  {
    key: 'moonshot',
    label: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    needsKey: true,
    hint: '国内直连，OpenAI 兼容。',
  },
  {
    key: 'ollama',
    label: '本地 Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    hint: '需本地起 Ollama 且开启 CORS（OLLAMA_ORIGINS=*）。无需 Key。',
  },
  {
    key: 'custom',
    label: '自定义',
    baseUrl: '',
    model: '',
    needsKey: true,
    hint: '任意 OpenAI 兼容端点（如自建代理、vLLM）。',
  },
];

export interface LlmSettings {
  provider: string;
  baseUrl: string;
  model: string;
  /** Key 只存 localStorage，不进任何导出物、不随结论卡外传 */
  apiKey: string;
}

export interface Settings {
  config: DecisionConfig;
  llm: LlmSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  config: DEFAULT_CONFIG,
  llm: {
    provider: 'deepseek',
    baseUrl: PROVIDER_PRESETS[0].baseUrl,
    model: PROVIDER_PRESETS[0].model,
    apiKey: '',
  },
};

/** 数字校验：必须是有限数且在 (lo, hi) 内，否则回退默认 */
function num(v: unknown, def: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > lo && v < hi ? v : def;
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def;
}

type GuardMode = DecisionConfig['guardrails']['refundRate']['mode'];

function modeOf(v: unknown, def: GuardMode): GuardMode {
  const o = (v ?? {}) as Record<string, unknown>;
  const mode = o.mode;
  return mode === 'harm_and_practical' || mode === 'confirm_beyond_margin' || mode === 'non_inferiority'
    ? mode
    : def;
}

function guard(
  v: unknown,
  def: NonNullable<DecisionConfig['guardrails']['refundRate']>,
): NonNullable<DecisionConfig['guardrails']['refundRate']> {
  const o = (v ?? {}) as Record<string, unknown>;
  const validMode = modeOf(v, def.mode);
  return {
    margin: num(o.margin, def.margin, -1, 1),
    alpha: num(o.alpha, def.alpha, 0, 0.5),
    gating: bool(o.gating, def.gating),
    mode: validMode,
  };
}

/** 把任意来源（localStorage / URL / 手改）的对象收敛成合法 Settings */
export function normalizeSettings(raw: unknown): Settings {
  const o = (raw ?? {}) as Record<string, unknown>;
  const c = (o.config ?? {}) as Record<string, unknown>;
  const g = (c.guardrails ?? {}) as Record<string, unknown>;
  const l = (o.llm ?? {}) as Record<string, unknown>;

  const cfg: DecisionConfig = mergeConfig({
    alpha: num(c.alpha, DEFAULT_CONFIG.alpha, 0, 0.5),
    segmentFdr: num(c.segmentFdr, DEFAULT_CONFIG.segmentFdr, 0, 0.5),
    interactionAlpha: num(c.interactionAlpha, DEFAULT_CONFIG.interactionAlpha, 0, 0.5),
    srmAlpha: num(c.srmAlpha, DEFAULT_CONFIG.srmAlpha, 0, 0.5),
    srmMaxRelImb: num(c.srmMaxRelImb, DEFAULT_CONFIG.srmMaxRelImb, 0, 0.5),
    bootstrapReps: Math.round(num(c.bootstrapReps, DEFAULT_CONFIG.bootstrapReps, 99, 200001)),
    simSeed: Math.round(num(c.simSeed, DEFAULT_CONFIG.simSeed, 0, Number.MAX_SAFE_INTEGER)),
    guardrails: {
      refundRate: guard(g.refundRate, DEFAULT_CONFIG.guardrails.refundRate),
      complaintRate: guard(g.complaintRate, DEFAULT_CONFIG.guardrails.complaintRate),
      latencyP95: {
        ...guard(g.latencyP95, { ...DEFAULT_CONFIG.guardrails.latencyP95, margin: DEFAULT_CONFIG.guardrails.latencyP95.margin }),
        relative: bool(
          (g.latencyP95 as Record<string, unknown> | undefined)?.relative,
          DEFAULT_CONFIG.guardrails.latencyP95.relative ?? false,
        ),
        margin: num(
          (g.latencyP95 as Record<string, unknown> | undefined)?.margin,
          DEFAULT_CONFIG.guardrails.latencyP95.margin,
          -1,
          1,
        ),
        alpha: num(
          (g.latencyP95 as Record<string, unknown> | undefined)?.alpha,
          DEFAULT_CONFIG.guardrails.latencyP95.alpha,
          0,
          0.5,
        ),
        gating: bool(
          (g.latencyP95 as Record<string, unknown> | undefined)?.gating,
          DEFAULT_CONFIG.guardrails.latencyP95.gating,
        ),
        mode: modeOf(g.latencyP95, DEFAULT_CONFIG.guardrails.latencyP95.mode),
      },
    },
  } as Partial<DecisionConfig>);

  const preset = PROVIDER_PRESETS.find((p) => p.key === l.provider) ?? PROVIDER_PRESETS[0];
  return {
    config: cfg,
    llm: {
      provider: preset.key,
      baseUrl: typeof l.baseUrl === 'string' && l.baseUrl.trim() ? l.baseUrl.trim() : preset.baseUrl,
      model: typeof l.model === 'string' && l.model.trim() ? l.model.trim() : preset.model,
      apiKey: typeof l.apiKey === 'string' ? l.apiKey : '',
    },
  };
}

function read(): Settings {
  try {
    const s = globalThis.localStorage?.getItem(KEY);
    if (!s) return DEFAULT_SETTINGS;
    return normalizeSettings(JSON.parse(s));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function write(s: Settings): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* 隐私模式下 localStorage 不可用：设置只在本次会话生效，不影响引擎 */
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(read);

  useEffect(() => {
    write(settings);
  }, [settings]);

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => normalizeSettings({ ...prev, ...p }));
  }, []);

  const patchConfig = useCallback((p: Partial<DecisionConfig>) => {
    setSettings((prev) => normalizeSettings({ ...prev, config: { ...prev.config, ...p } }));
  }, []);

  const patchLlm = useCallback((p: Partial<LlmSettings>) => {
    setSettings((prev) => normalizeSettings({ ...prev, llm: { ...prev.llm, ...p } }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULT_SETTINGS), []);

  return { settings, setSettings, patch, patchConfig, patchLlm, reset };
}
