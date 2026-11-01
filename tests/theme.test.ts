import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { C, C_VARS, resolvePalette } from '../src/app/lib/palette.ts';
import { readChoice, resolveDark, THEME_LABEL } from '../src/app/lib/theme.ts';

/**
 * 主题（F5）的一致性锁。
 *
 * 「深色模式」最常见的失败方式不是不好看，而是**不一致**：
 * 类名切了、SVG 没切；卡片切了、图表没切；或者某个变量只在一套主题里定义了，
 * 另一套下回落到初始值——那时候看到的是一块块深浅不一的补丁。
 * 所以这里把三处（CSS 变量 / Tailwind 令牌 / SVG 色板）逐一对账。
 */
const css = readFileSync(new URL('../src/app/index.css', import.meta.url), 'utf8');
const tw = readFileSync(new URL('../tailwind.config.js', import.meta.url), 'utf8');

function varsIn(selector: string): Set<string> {
  const i = css.indexOf(selector);
  expect(i).toBeGreaterThan(-1);
  // 到下一个顶层选择器为止
  const rest = css.slice(i);
  const end = rest.search(/\n  \}/);
  const block = rest.slice(0, end > 0 ? end : rest.length);
  return new Set([...block.matchAll(/--c-([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

const lightVars = varsIn(':root {');
const darkVars = varsIn(':root.dark {');

describe('F5 · 主题', () => {
  it('两套主题定义了同一批变量（少一个就会回落到初始值，视觉上是一块补丁）', () => {
    const missing = [...lightVars].filter((v) => !darkVars.has(v));
    const extra = [...darkVars].filter((v) => !lightVars.has(v));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(lightVars.size).toBeGreaterThanOrEqual(15);
  });

  it('Tailwind 的每个颜色令牌都指向一个已定义的变量', () => {
    // 令牌是 `base: c('base')` 这种写法，所以要取 c() 的实参
    const tokens = [...tw.matchAll(/^\s{8}(\w+):\s*c\('([a-z0-9-]+)'\),$/gm)];
    expect(tokens.length).toBeGreaterThanOrEqual(13);
    for (const [, token, name] of tokens) {
      expect(lightVars.has(name), `令牌 ${token} 指向未定义的 --c-${name}`).toBe(true);
    }
    // 注释里也会出现 `--c-…`，只对账真正的引用（模板串里的 `${name}` 不算）
    const used = [...tw.matchAll(/var\(--c-([a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(lightVars.has(name), `--c-${name} 未定义`).toBe(true);
    // 必须写成带 alpha 槽的 rgb()，否则 `bg-brand/10` 这类透明度语法会失效
    const colors = tw.slice(tw.indexOf('colors: {'), tw.indexOf('fontFamily'));
    for (const line of colors.split('\n')) {
      if (line.includes('rgb(')) expect(line).toContain('<alpha-value>');
    }
  });

  it('SVG 色板与 Tailwind 共用同一批变量（不是两套十六进制）', () => {
    for (const [key, value] of Object.entries(C)) {
      expect(value).toBe(`rgb(var(--c-${C_VARS[key as keyof typeof C]}))`);
      expect(lightVars.has(C_VARS[key as keyof typeof C])).toBe(true);
    }
    // 旧的十六进制写法一旦回来，主题就不能切了
    expect(JSON.stringify(C)).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('深色主题真的是深的、浅色主题真的是浅的（按亮度断言，不靠肉眼）', () => {
    const pick = (sel: string, name: string) => {
      const m = new RegExp(`--c-${name}:\\s*([0-9]{1,3}) ([0-9]{1,3}) ([0-9]{1,3})`).exec(
        css.slice(css.indexOf(sel)),
      );
      expect(m, `${sel} 缺少 ${name}`).toBeTruthy();
      return [Number(m![1]), Number(m![2]), Number(m![3])].map((v) => v / 255);
    };
    const luma = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

    for (const name of ['base', 'panel', 'ink']) {
      const light = pick(':root {', name);
      const dark = pick(':root.dark {', name);
      if (name === 'ink') {
        // 正文色：浅主题要深、深主题要浅，否则字看不见
        expect(luma(dark)).toBeGreaterThan(0.6);
        expect(luma(light)).toBeLessThan(0.25);
      } else {
        expect(luma(dark)).toBeLessThan(0.2);
        expect(luma(light)).toBeGreaterThan(0.9);
      }
    }
    // 语义色在深色下要提亮：绿/红/橙压在纯黑面板上会很刺眼
    for (const name of ['ship', 'noship', 'iterate']) {
      expect(luma(pick(':root.dark {', name))).toBeGreaterThan(luma(pick(':root {', name)));
    }
  });

  it('resolveDark：三档选择 × 系统偏好都要有确定答案', () => {
    expect(resolveDark('light', false)).toBe(false);
    expect(resolveDark('light', true)).toBe(false); // 显式浅色不受系统影响
    expect(resolveDark('dark', false)).toBe(true);
    expect(resolveDark('dark', true)).toBe(true);
    expect(resolveDark('follow', false)).toBe(false);
    expect(resolveDark('follow', true)).toBe(true);
  });

  it('readChoice：只认三个合法值，坏数据/隐私模式一律回到 follow', () => {
    expect(readChoice({ getItem: () => 'dark' })).toBe('dark');
    expect(readChoice({ getItem: () => 'DARK' })).toBe('follow');
    expect(readChoice({ getItem: () => null })).toBe('follow');
    expect(readChoice({ getItem: () => '{}' })).toBe('follow');
    expect(readChoice(null)).toBe('follow');
    // localStorage 抛错（Safari 隐私模式）不能让主题挂掉
    expect(readChoice({ getItem: () => { throw new Error('denied'); } })).toBe('follow');
  });

  it('三档都有中文标签（顶栏 title 不能出现 undefined）', () => {
    for (const k of ['light', 'dark', 'follow'] as const) {
      expect(THEME_LABEL[k]).toBeTruthy();
    }
  });

  it('resolvePalette 在没有 DOM 时原样返回（导出卡片的单测环境没有 document）', () => {
    const p = resolvePalette(null);
    expect(p.ship).toBe(C.ship);
  });
});
