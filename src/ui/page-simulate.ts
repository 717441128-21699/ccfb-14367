/** 批量模拟页:参数配置、实时进度、性状漂移 SVG 曲线、天花板与近交预警 */
import {
  DEFAULT_SIMULATION,
  PedigreeStore,
  runSimulation,
  TRAIT_KEYS,
  TRAIT_LABELS,
  type GenerationStats,
  type MatingScheme,
  type SimulationResult,
} from '../index.ts';

const app = document.getElementById('app')!;

function renderForm(): void {
  app.innerHTML = `
    <div class="card">
      <h2>模拟参数</h2>
      <div class="grid cols-4">
        <div><label>种群规模(偶数)</label><input type="number" id="cfg-n" value="${DEFAULT_SIMULATION.populationSize}" min="100" step="100"></div>
        <div><label>繁育世代数</label><input type="number" id="cfg-gens" value="${DEFAULT_SIMULATION.generations}" min="1" max="200"></div>
        <div><label>留种比例(选择压)</label><input type="number" id="cfg-frac" value="${DEFAULT_SIMULATION.selectionFraction}" min="0.05" max="1" step="0.05"></div>
        <div><label>随机种子</label><input type="number" id="cfg-seed" value="${DEFAULT_SIMULATION.seed}"></div>
      </div>
      <div class="grid cols-3" style="margin-top:14px">
        <div><label>速度选择权重</label><input type="number" id="w-speed" value="${DEFAULT_SIMULATION.selectionWeights.speed}" step="0.1"></div>
        <div><label>耐力选择权重</label><input type="number" id="w-stamina" value="${DEFAULT_SIMULATION.selectionWeights.stamina}" step="0.1"></div>
        <div><label>归巢选择权重</label><input type="number" id="w-homing" value="${DEFAULT_SIMULATION.selectionWeights.homing}" step="0.1"></div>
      </div>
      <div class="grid cols-2" style="margin-top:14px">
        <div><label>交配策略</label>
          <select id="cfg-scheme">
            <option value="random">随机交配</option>
            <option value="assortative">同型选配(精英配精英)</option>
            <option value="avoidKin">避近亲交配</option>
          </select>
        </div>
        <div style="display:flex;align-items:flex-end">
          <button id="btn-run" style="width:100%">▶ 开始模拟</button>
        </div>
      </div>
      <p class="muted" style="margin-top:10px">
        默认 10,000 只 × 50 代,基准耗时 SLA ≤ 20 秒。亲缘只追踪留种精英池,近交系数与标准列表法一致。
      </p>
    </div>
    <div id="progress" hidden>
      <div class="card">
        <h2 id="progress-title">模拟进行中…</h2>
        <div class="progress-track"><div id="progress-bar" style="width:0%"></div></div>
        <p class="muted" id="progress-text" style="margin-top:8px"></p>
      </div>
    </div>
    <div id="result"></div>
  `;

  document.getElementById('btn-run')!.onclick = run;
}

async function run(): Promise<void> {
  const n = Number((document.getElementById('cfg-n') as HTMLInputElement).value);
  const gens = Number((document.getElementById('cfg-gens') as HTMLInputElement).value);
  const fraction = Number((document.getElementById('cfg-frac') as HTMLInputElement).value);
  const seed = Number((document.getElementById('cfg-seed') as HTMLInputElement).value);
  const scheme = (document.getElementById('cfg-scheme') as HTMLSelectElement).value as MatingScheme;
  const weights = {
    speed: Number((document.getElementById('w-speed') as HTMLInputElement).value),
    stamina: Number((document.getElementById('w-stamina') as HTMLInputElement).value),
    homing: Number((document.getElementById('w-homing') as HTMLInputElement).value),
  };

  const progress = document.getElementById('progress')!;
  const bar = document.getElementById('progress-bar')! as HTMLElement;
  const text = document.getElementById('progress-text')!;
  const title = document.getElementById('progress-title')!;
  const btn = document.getElementById('btn-run') as HTMLButtonElement;
  btn.disabled = true;
  progress.hidden = false;

  // 让浏览器先绘制进度条,再启动同步重计算
  await new Promise((r) => setTimeout(r, 30));
  const t0 = performance.now();
  const store = new PedigreeStore();
  const result = runSimulation(
    store,
    {
      populationSize: n,
      generations: gens,
      selectionFraction: fraction,
      selectionWeights: weights,
      matingScheme: scheme,
      avoidKinTries: DEFAULT_SIMULATION.avoidKinTries,
      seed,
      retainGenerations: 6,
    },
    {
      onGeneration: (stats, index, total) => {
        const pct = Math.round((index / total) * 100);
        bar.style.width = `${pct}%`;
        text.textContent = `第 ${index}/${total} 代 · 速度均值 ${stats.mean.speed} · 平均 F ${(stats.meanInbreeding * 100).toFixed(2)}%`;
      },
    },
  );
  const wall = performance.now() - t0;
  title.textContent = '模拟完成';
  text.textContent = `墙钟耗时 ${wall.toFixed(0)} ms,引擎计时 ${result.elapsedMs} ms,累计出生 ${result.totalBorn.toLocaleString()} 只`;
  btn.disabled = false;
  renderResult(result);
}

const COLORS = { speed: '#4d9de0', stamina: '#3fb950', homing: '#d29922' };

function renderResult(result: SimulationResult): void {
  const data = result.perGeneration;
  const last = data[data.length - 1]!;
  const el = document.getElementById('result')!;

  // 天花板检测:末代触顶率 >10% 视为该性状逼近天花板
  const ceilingAlerts = TRAIT_KEYS.filter((t) => last.ceilingRate[t] > 0.1);

  el.innerHTML = `
    <div class="card">
      <h2>关键结果</h2>
      <div class="grid cols-4">
        <div class="stat"><div class="num">${result.elapsedMs} ms</div><div class="label">引擎耗时(SLA 20000ms)</div></div>
        <div class="stat"><div class="num">${(last.meanInbreeding * 100).toFixed(2)}%</div><div class="label">末代平均近交 F</div></div>
        <div class="stat"><div class="num">${(last.maxInbreeding * 100).toFixed(2)}%</div><div class="label">末代最高 F</div></div>
        <div class="stat"><div class="num">${last.meanHarmfulLoad.toFixed(2)}</div><div class="label">平均遗传负荷</div></div>
      </div>
      ${ceilingAlerts.length > 0 ? `
        <p class="warn" style="margin-top:14px">⚠ 天花板预警:${ceilingAlerts.map((t) => TRAIT_LABELS[t]).join('、')}
        末代触顶率(≥95)超过 10%,继续选育增益将显著收窄。</p>` : '<p class="good" style="margin-top:14px">✓ 三性状均未触及天花板,仍有选育空间。</p>'}
    </div>

    <div class="card">
      <h2>性状均值漂移(0–99 量表)</h2>
      ${lineChart(data, (s) => s.mean, 0, 100)}
    </div>
    <div class="card">
      <h2>触顶率漂移(表型 ≥95 的个体比例)</h2>
      ${lineChart(data, (s) => Object.fromEntries(TRAIT_KEYS.map((t) => [t, s.ceilingRate[t] * 100])) as Record<string, number>, 0, 100, '%')}
    </div>
    <div class="card">
      <h2>平均近交系数漂移</h2>
      ${singleLine(data.map((s) => s.meanInbreeding * 100), '#e15554', '%')}
    </div>

    <div class="card">
      <h2>逐代明细</h2>
      <div class="scroll-x" style="max-height:360px;overflow-y:auto">
        <table><thead><tr>
          <th>代</th><th>速度均值</th><th>耐力均值</th><th>归巢均值</th><th>速度触顶%</th><th>平均F%</th><th>最高F%</th><th>主要羽色</th>
        </tr></thead><tbody>
          ${data.map((s) => `<tr>
            <td>${s.generation}</td><td>${s.mean.speed}</td><td>${s.mean.stamina}</td><td>${s.mean.homing}</td>
            <td>${(s.ceilingRate.speed * 100).toFixed(1)}</td>
            <td>${(s.meanInbreeding * 100).toFixed(2)}</td>
            <td>${(s.maxInbreeding * 100).toFixed(2)}</td>
            <td>${s.colorDistribution[0]?.name ?? '—'} ${((s.colorDistribution[0]?.rate ?? 0) * 100).toFixed(0)}%</td>
          </tr>`).join('')}
        </tbody></table>
      </div>
    </div>
  `;
}

/** 多性状折线图(SVG) */
function lineChart(
  data: GenerationStats[],
  accessor: (s: GenerationStats) => Record<string, number>,
  min: number,
  max: number,
  unit = '',
): string {
  const W = 900;
  const H = 280;
  const pad = 40;
  const x = (i: number): number => pad + (i / Math.max(1, data.length - 1)) * (W - pad * 2);
  const y = (v: number): number => H - pad - ((v - min) / (max - min)) * (H - pad * 2);
  const paths = TRAIT_KEYS.map((t) => {
    const pts = data.map((s, i) => `${x(i)},${y(accessor(s)[t] ?? 0)}`).join(' ');
    return `<polyline points="${pts}" fill="none" stroke="${COLORS[t]}" stroke-width="2"/>`;
  }).join('');
  const legend = TRAIT_KEYS.map((t) =>
    `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:16px">
      <span style="width:12px;height:12px;background:${COLORS[t]};border-radius:2px"></span>${TRAIT_LABELS[t]}${unit ? `(${unit})` : ''}</span>`).join('');
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:640px">
    ${gridLines(W, H, pad, min, max)}${paths}
    ${xAxisLabels(data, W, H, pad)}
  </svg></div><div style="margin-top:8px">${legend}</div>`;
}

function singleLine(values: number[], color: string, unit: string): string {
  const stats = values.map((v, i) => ({ generation: i, mean: { x: v } } as unknown as GenerationStats));
  // 复用多线框架,构造单性状
  const W = 900;
  const H = 240;
  const pad = 40;
  const max = Math.max(1, ...values);
  const x = (i: number) => pad + (i / Math.max(1, values.length - 1)) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return `<div style="overflow-x:auto"><svg viewBox="0 0 ${W} ${H}" style="width:100%;min-width:640px">
    ${gridLines(W, H, pad, 0, max)}
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2"/>
    ${xAxisLabels(stats, W, H, pad)}
    <text x="${W - pad}" y="${pad - 12}" fill="${color}" text-anchor="end">最高 ${max.toFixed(2)}${unit}</text>
  </svg></div>`;
}

function gridLines(W: number, H: number, pad: number, min: number, max: number): string {
  let out = '';
  for (let i = 0; i <= 4; i++) {
    const yy = pad + (i / 4) * (H - pad * 2);
    const val = max - (i / 4) * (max - min);
    out += `<line x1="${pad}" y1="${yy}" x2="${W - pad}" y2="${yy}" stroke="#2f3b4d" stroke-width="1"/>
      <text x="${pad - 6}" y="${yy + 4}" fill="#8b98a8" font-size="11" text-anchor="end">${val.toFixed(0)}</text>`;
  }
  return out;
}

function xAxisLabels(data: GenerationStats[], W: number, H: number, pad: number): string {
  const step = Math.max(1, Math.floor(data.length / 10));
  let out = '';
  data.forEach((s, i) => {
    if (i % step !== 0) return;
    const xx = pad + (i / Math.max(1, data.length - 1)) * (W - pad * 2);
    out += `<text x="${xx}" y="${H - pad + 18}" fill="#8b98a8" font-size="11" text-anchor="middle">${s.generation}</text>`;
  });
  return out;
}

renderForm();
