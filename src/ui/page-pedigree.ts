/** 血统书页:五代祖先树、近交系数 Wright 路径分解、逐代祖先汇总 */
import {
  ancestorSummaries,
  buildPedigreeBook,
  describeGenotype,
  explainInbreeding,
  TRAIT_LABELS,
} from '../index.ts';
import { appState } from './app-state.ts';

appState.bootstrap();
const store = appState.store;

const params = new URLSearchParams(location.search);
let selectedId = params.get('id') ? Number(params.get('id')) : [...store.all()].at(-1)?.id;

function render(): void {
  const app = document.getElementById('app')!;
  const options = [...store.all()]
    .map((p) => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${p.ringId}(${p.sex === 'M' ? '雄' : '雌'})</option>`)
    .join('');

  app.innerHTML = `
    <div class="card">
      <h2>选择个体</h2>
      <div style="display:flex;gap:12px;align-items:center">
        <select id="sel-pigeon" style="max-width:420px">${options}</select>
        <button class="secondary" id="btn-pair">去配对预测 →</button>
      </div>
    </div>
    <div id="detail"></div>
  `;

  document.getElementById('sel-pigeon')!.onchange = (e) => {
    selectedId = Number((e.target as HTMLSelectElement).value);
    history.replaceState(null, '', `?id=${selectedId}`);
    renderDetail();
  };
  document.getElementById('btn-pair')!.onclick = () => {
    if (selectedId) location.href = `./pairing.html?sire=${selectedId}`;
  };
  renderDetail();
}

function renderDetail(): void {
  const detail = document.getElementById('detail')!;
  if (!selectedId || !store.get(selectedId)) {
    detail.innerHTML = '<div class="card"><p class="muted">请选择一只鸽子</p></div>';
    return;
  }
  const book = buildPedigreeBook(store, selectedId);
  const breakdown = explainInbreeding(store, selectedId);
  const summaries = ancestorSummaries(store, selectedId);
  const root = book.root;

  detail.innerHTML = `
    <div class="grid cols-3">
      <div class="stat"><div class="num">${(breakdown.coefficient * 100).toFixed(3)}%</div><div class="label">近交系数 F(精确)</div></div>
      <div class="stat"><div class="num">${(breakdown.wright.coefficient * 100).toFixed(3)}%</div><div class="label">Wright 路径法(五代窗口)</div></div>
      <div class="stat"><div class="num ${book.queryMs > 100 ? 'danger' : 'good'}">${book.queryMs.toFixed(3)} ms</div><div class="label">查询耗时(SLA 100ms)</div></div>
    </div>

    <div class="card">
      <h2>个体档案 · ${root.ringId}</h2>
      <div class="grid cols-2">
        <div>
          <p><span class="badge ${root.sex === 'M' ? 'male' : 'female'}">${root.sex === 'M' ? '雄' : '雌'}</span>
          第 ${root.generation} 代 · 羽色 <strong>${root.phenotype.colorName}</strong></p>
          <p class="muted">基因型:</p>
          <ul>${describeGenotype(root).map((g) => `<li class="mono" style="font-size:12px">${g}</li>`).join('')}</ul>
        </div>
        <div>
          <table>
            <thead><tr><th>性状</th><th>表型</th><th>遗传负荷</th></tr></thead>
            <tbody>
              ${(['speed', 'stamina', 'homing'] as const).map((t) => `
                <tr><td>${TRAIT_LABELS[t]}</td><td>${root.phenotype[t]}</td><td>${root.phenotype.harmfulLoad} 个发病位点</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>五代血统树(覆盖 ${book.coveredCount}/63 槽位,缺失 ${book.missingCount})</h2>
      <div class="scroll-x">${renderTree(book)}</div>
    </div>

    <div class="card">
      <h2>近交系数 Wright 路径分解</h2>
      ${breakdown.wright.contributions.length === 0
        ? '<p class="muted">五代内无共同祖先,该窗口下近交贡献为 0。</p>'
        : `<table><thead><tr><th>共同祖先</th><th>父路径 n1</th><th>母路径 n2</th><th>祖先 F_A</th><th>贡献 (½)^(n1+n2+1)·(1+F_A)</th></tr></thead>
          <tbody>${breakdown.wright.contributions.map((c) => `
            <tr><td class="mono">${c.ancestorRing}</td><td>${c.n1}</td><td>${c.n2}</td>
            <td>${(c.ancestorInbreeding * 100).toFixed(2)}%</td>
            <td class="mono">${c.contribution.toExponential(3)}</td></tr>`).join('')}</tbody></table>`}
      <p class="muted" style="margin-top:10px">
        精确算法与 Wright 五代窗口差值 Δ = ${breakdown.delta.toExponential(2)}
        (深于五代的共同祖先只计入精确值,故 Wright 为其下界)。
      </p>
    </div>

    <div class="card">
      <h2>逐代祖先性状均值</h2>
      <div class="scroll-x">
        <table><thead><tr><th>祖先世代</th><th>数量</th><th>速度均值</th><th>耐力均值</th><th>归巢均值</th></tr></thead>
        <tbody>${summaries.map((s) => `
          <tr><td>${s.generation === 0 ? '个体本身' : `上溯 ${s.generation} 代`}</td><td>${s.count}</td>
          <td>${s.traitAverages.speed ?? '—'}</td>
          <td>${s.traitAverages.stamina ?? '—'}</td>
          <td>${s.traitAverages.homing ?? '—'}</td></tr>`).join('')}</tbody></table>
      </div>
    </div>
  `;
}

/** 用 CSS Grid 按标准槽位号渲染五代树 */
function renderTree(book: ReturnType<typeof buildPedigreeBook>): string {
  const depthLabel = ['本身', '父母', '祖父母', '曾祖', '高祖', '天祖'];
  let html = '';
  for (let depth = 0; depth <= 5; depth++) {
    const start = 2 ** depth;
    const end = 2 ** (depth + 1) - 1;
    html += `<div style="margin-bottom:10px">
      <div class="muted" style="margin-bottom:4px">${depthLabel[depth]} · 第 ${depth} 层</div>
      <div class="pedigree-grid" style="grid-template-columns:repeat(${2 ** depth}, minmax(130px,1fr))">`;
    for (let slot = start; slot <= end; slot++) {
      const node = book.slots.get(slot);
      if (!node || !node.pigeon) {
        html += '<div class="pigeon-cell empty"><div class="ring">— 缺失 —</div></div>';
      } else {
        const p = node.pigeon;
        html += `<div class="pigeon-cell ${p.sex === 'M' ? 'male' : 'female'}">
          <div class="ring">${p.ringId}</div>
          <div class="muted">${p.sex === 'M' ? '雄' : '雌'} · ${p.phenotype.colorName}</div>
          <div class="muted">速${p.phenotype.speed} 耐${p.phenotype.stamina} 归${p.phenotype.homing}</div>
          <div class="muted">F ${(p.inbreeding * 100).toFixed(1)}%</div>
        </div>`;
      }
    }
    html += '</div></div>';
  }
  return html;
}

render();
