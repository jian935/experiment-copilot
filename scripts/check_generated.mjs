/**
 * 生成物与源码同步校验（M20 / 巡检整改 P0-4）。
 *
 * 背景：2026-11-04 全量巡检发现 `data/` 下 11 份报告的 `generatedAt` 停在 11-01，
 * 其中 `novelty_report.json` 还比当前代码少了 3 个 `unit` 字段——**生成物比代码旧**。
 * 数字本身没错（重跑后逐位一致），但「对外只引实测值」这条铁律在文档层失效了。
 *
 * 做法：重跑所有确定性生成器 → 忽略 `generatedAt` 后与仓库里的版本逐位比对。
 *   - 默认（检查模式）：比对完**把文件原样写回**，本机不留任何脏改动；有差异 exit 1
 *   - `--sync`：保留重跑结果，用于「代码确实改了、有意更新生成物」
 *
 * 明确不覆盖的两处例外（写进注释而不是假装覆盖）：
 *   - `docs/ABLATION.md` / `public/data/ablation.json`：由 `npm run ablation` 生成，
 *     它读 `.local/deepseek.key` 会真实调用模型、结果带随机性，不能进确定性 CI。
 *   - `public/data/`：整目录 gitignore，没有可比对的基准版本。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const SYNC = process.argv.includes('--sync');
const DATA = resolve(root, 'data');

/** 每个命令的产物都在 data/ 下；不含 ablation（需要 Key 且随机）和 dev/preview（常驻服务） */
const COMMANDS = [
  'gen',
  'eval',
  'aa',
  'cuped',
  'forecast',
  'fwer',
  'loss',
  'multiarm',
  'novelty',
  'robust',
  'seq',
];

/** 忽略生成时间后的规范化：键排序 + 递归去掉 generatedAt，避免浮点/顺序噪声 */
function normalize(text) {
  try {
    const strip = (v) => {
      if (Array.isArray(v)) return v.map(strip);
      if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v).sort()) {
          if (k === 'generatedAt') continue;
          o[k] = strip(v[k]);
        }
        return o;
      }
      return v;
    };
    return JSON.stringify(strip(JSON.parse(text)));
  } catch {
    return text; // csv / 其它非 JSON：逐字节比
  }
}

const files = readdirSync(DATA).filter((f) => statSync(resolve(DATA, f)).isFile());
const snapshot = new Map(files.map((f) => [f, readFileSync(resolve(DATA, f))]));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const cmdErrors = []; // 生成器自己跑挂了 —— 任何模式都是失败
const drift = [];     // 生成物与仓库版本不同 —— 检查模式失败，--sync 时是预期结果
try {
  for (const cmd of COMMANDS) {
    const r = spawnSync(npm, ['run', cmd], {
      encoding: 'utf8',
      timeout: 180000,
      shell: process.platform === 'win32',
    });
    if (r.status !== 0) {
      cmdErrors.push(`命令 ${cmd} 失败（exit ${r.status}）：${(r.stderr || r.stdout || '').trim().slice(-400)}`);
      break;
    }
  }

  if (cmdErrors.length === 0) {
    for (const f of files) {
      const before = snapshot.get(f);
      const now = readFileSync(resolve(DATA, f));
      if (normalize(before.toString('utf8')) === normalize(now.toString('utf8'))) continue;
      // 给一句能直接定位的提示，而不是让人自己 diff 整个文件
      let hint = '内容不同';
      try {
        const a = JSON.parse(before.toString('utf8'));
        const b = JSON.parse(now.toString('utf8'));
        const added = Object.keys(b).filter((k) => !(k in a));
        const removed = Object.keys(a).filter((k) => !(k in b));
        if (added.length || removed.length) {
          hint = `顶层字段 +[${added.join(',')}] -[${removed.join(',')}]`;
        } else {
          const ka = JSON.stringify(a).length;
          const kb = JSON.stringify(b).length;
          hint = `字段值不同（规范化长度 ${ka} → ${kb}），常见原因：新增了字段或改了枚举值`;
        }
      } catch { /* csv：hint 保持默认 */ }
      drift.push(`${f}：${hint}`);
    }
  }
} finally {
  if (!SYNC) {
    // 检查模式：无条件还原，保证本机跑完工作树干净
    for (const [f, buf] of snapshot) writeFileSync(resolve(DATA, f), buf);
  }
}

if (cmdErrors.length) {
  console.error('✗ 生成器执行失败：');
  for (const line of cmdErrors) console.error(`  - ${line}`);
  process.exit(1);
}

if (SYNC) {
  // --sync 的语义就是「把差异留下来」，所以有 drift 是成功，不是失败
  console.log(`✓ 已重跑 ${COMMANDS.length} 条生成器并保留结果（${files.length} 个文件）`);
  if (drift.length) {
    console.log(`  本次有 ${drift.length} 个文件与旧版本不同：`);
    for (const line of drift) console.log(`  - ${line}`);
  } else {
    console.log('  生成物本来就是最新的，无内容变化。');
  }
  process.exit(0);
}

if (drift.length) {
  console.error(`✗ 生成物与当前源码不同步（${drift.length} 项）：`);
  for (const line of drift) console.error(`  - ${line}`);
  console.error('\n若代码确实改了，跑 `npm run check:generated -- --sync` 更新生成物并一起提交。');
  process.exit(1);
}

console.log(`✓ ${files.length} 个生成物与当前源码一致（重跑 ${COMMANDS.length} 条生成器，忽略 generatedAt）· 已还原，工作树无改动`);
