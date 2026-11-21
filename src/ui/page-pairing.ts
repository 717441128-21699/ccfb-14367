/** 配对预测页:选父本母本 → 羽色精确概率、三性状分布、近交与遗传负荷预警 */
import {
  predictPairing,
  TRAIT_KEYS,
  type PairingReport,
  type TraitDistribution,
} from '../index.ts';
import { appState } from './app-state.ts';

appState.bootstrap();
const store = appState.store;

const params = new URLSearchParams(location.search);
let sireId = params.get('sire') ? Number(params.get('sire')) : undefined;
let damId: number | undefined;

function pigeonOptions(sex: 'M' | 'F', selected?: number): string {
  return [...store.all()]
    .filter((p) => p.sex === sex)
    .map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${p.ringId} · ${p.phenotype.colorName}</option>`)
    .join('');
}

function render(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <div class="card">
      <h2>选择配对</h2>
      <div class="grid cols-2">
        <div>
          <label>父本(雄)</label>
          <select id="sel-sire"><option value="">— 请选择 —</option>${pigeonOptions('M', sireId)}</select>
        </div>
        <div>
          <label>母本(雌)</label>
          <select id="sel-dam"><option value="">— 请选择 —</option>${pigeonOptions('F', damId)}</select>
        </div>
      </div>
    </div>
    <div id="report"></div>
  `;
  document.getElementById('sel-sire')!.onchange = (e) => {
    sireId = Number((e.target as HTMLSelectElement).value) || undefined;
    renderReport();
  };
  document.getElementById('sel-dam')!.onchange = (e) => {
    damId = Number((e.target as HTMLSelectElement).value) || undefined;
    renderReport();
  };
  renderReport();
}

function renderReport(): void {
  const el = document.getElementById('report')!;
  if (!sireId || !damId) {
    el.innerHTML = '<div class="card"><p class="muted">选择父本与母本后,这里展示后代的完整概率分布(精确枚举,非蒙特卡洛)。</p></div>';
    return;
  }
  let report: PairingReport;
  try {
    report = predictPairing(store, sireId, damId);
  } catch (err) {
    el.innerHTML = `<div class="card"><p class="danger">${(err as Error).message}</p></div>`;
    return;
  }

  const fPct = (report.offspringInbreeding * 100).toFixed(2);
  const fLevel =
    report.offspringInbreeding > 0.25 ? 'danger' : report.offspringInbreeding > 0.125 ? 'warn' : 'good';

  el.innerHTML = `
    <div class="grid cols-3">
      <div class="stat"><div class="num ${fLevel}">${fPct}%</div><div class="label">后代预期近交 F</div></div>
      <div class="stat"><div class="num ${report.anyDisorderProbability > 0.05 ? 'danger' : ''}">${(report.anyDisorderProbability * 100).toFixed(2)}%</div><div class="label">至少一个遗传病发病概率</div></div>
      <div class="stat"><div class="num">${report.color.outcomes.length}</div><div class="label">可能羽色表现型数</div></div>
    </div>

    <div class="card">
      <h2>后代羽色概率分布(精确枚举)</h2>
      ${report.color.outcomes.slice(0, 12).map((o) => `
        <div class="prob-row">
          <div class="name">${o.name}</div>
          <div class="track bar"><span style="width:${(o.probability * 100).toFixed(2)}%"></span></div>
          <div class="pct mono">${(o.probability * 100).toFixed(2)}%</div>
        </div>`).join('')}
      <p class="muted">概率总和 = ${report.color.outcomes.reduce((a, o) => a + o.probability, 0).toFixed(6)}(已按雌雄 1:1 加权)</p>
    </div>

    <div class="card">
      <h2>三性状后代概率分布(多基因 + 环境 + 近交衰退)</h2>
      <div class="grid cols-3">
        ${TRAIT_KEYS.map((t) => traitCard(report.traits[t]!)).join('')}
      </div>
    </div>

    <div class="card">
      <h2>遗传负荷:6 个有害隐性位点</h2>
      <table><thead><tr><th>位点</th><th>隐性纯合发病概率</th></tr></thead><tbody>
        ${report.disorderLoci.map((d) => `
          <tr><td>有害位点 #${d.locus + 1}</td>
          <td class="${d.probability > 0 ? 'warn' : ''} mono">${(d.probability * 100).toFixed(2)}%</td></tr>`).join('')}
      </tbody></table>
    </div>
  `;
}

function traitCard(d: TraitDistribution): string {
  const pct = d.percentiles;
  const maxProb = Math.max(...d.histogram.map((h) => h.probability));
  return `<div style="background:var(--panel-2);border-radius:10px;padding:14px">
    <h3 style="margin:0 0 8px;font-size:14px">${d.label}</h3>
    <p class="muted" style="margin:4px 0">均值 <strong>${d.mean}</strong> · SD ${d.sd}</p>
    <p class="muted" style="margin:4px 0;font-size:12px">
      近交衰退 -${d.inbreedingPenalty} · 负荷期望 -${d.expectedLoadPenalty}
    </p>
    <div class="histogram">
      ${d.histogram.map((h) => `<div class="h-col" style="height:${(h.probability / maxProb) * 100}%" title="${h.binStart}–${h.binStart + 5}: ${(h.probability * 100).toFixed(1)}%"></div>`).join('')}
    </div>
    <table style="margin-top:10px;font-size:12px">
      <tr><td>P5</td><td>P25</td><td>中位</td><td>P75</td><td>P95</td></tr>
      <tr><td>${pct.p5}</td><td>${pct.p25}</td><td>${pct.p50}</td><td>${pct.p75}</td><td>${pct.p95}</td></tr>
    </table>
    <p class="muted" style="font-size:12px;margin-bottom:0">
      触顶(≥95)概率 <span class="${d.ceilingProbability > 0.1 ? 'warn' : ''}">${(d.ceilingProbability * 100).toFixed(1)}%</span>
      · 触底(≤5) ${(d.floorProbability * 100).toFixed(1)}%
    </p>
  </div>`;
}

render();
