/** 总览页:种群统计、个体名录、数据导入导出 */
import { TRAIT_KEYS, TRAIT_LABELS, type Pigeon } from '../index.ts';
import { appState } from './app-state.ts';

appState.bootstrap();
const store = appState.store;

function traitAvg(trait: (typeof TRAIT_KEYS)[number]): number {
  let sum = 0;
  let n = 0;
  for (const p of store.all()) {
    sum += p.phenotype[trait];
    n++;
  }
  return n ? sum / n : 0;
}

function render(): void {
  const app = document.getElementById('app')!;
  const males = [...store.all()].filter((p) => p.sex === 'M').length;
  const females = store.size - males;
  const avgF = [...store.all()].reduce((a, p) => a + p.inbreeding, 0) / Math.max(1, store.size);
  const disorder = [...store.all()].filter((p) => p.phenotype.harmfulLoad > 0).length;

  app.innerHTML = `
    <div class="grid cols-4">
      <div class="stat"><div class="num">${store.size}</div><div class="label">在册鸽子</div></div>
      <div class="stat"><div class="num">${males} / ${females}</div><div class="label">雄 / 雌</div></div>
      <div class="stat"><div class="num">${(avgF * 100).toFixed(2)}%</div><div class="label">平均近交系数</div></div>
      <div class="stat"><div class="num">${disorder}</div><div class="label">携带发病位点个体</div></div>
    </div>

    <div class="card">
      <h2>三性状群体均值</h2>
      <div class="grid cols-3">
        ${TRAIT_KEYS.map((t) => {
          const v = traitAvg(t);
          return `<div class="stat">
            <div class="num">${v.toFixed(1)}</div>
            <div class="label">${TRAIT_LABELS[t]}(0–99)</div>
            <div class="bar" style="margin-top:8px"><span style="width:${v}%"></span></div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="card">
      <h2>数据管理</h2>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="btn-save">保存到本地浏览器</button>
        <button class="secondary" id="btn-export">导出 JSON 快照</button>
        <label class="btn secondary" style="margin:0">导入快照
          <input type="file" id="file-import" accept=".json" hidden />
        </label>
        <button class="secondary" id="btn-load">读取本地存档</button>
        <button class="danger" id="btn-clear">清除本地存档</button>
      </div>
      <p class="muted" style="margin-top:10px">
        快照带 magic 与版本校验;大种群(数十万级)建议走 NDJSON 流式接口,见 services/repository.ts。
      </p>
    </div>

    <div class="card">
      <h2>个体名录(最新 ${Math.min(store.size, 50)} 只)</h2>
      <div class="scroll-x">
        <table>
          <thead><tr><th>鸽环号</th><th>性别</th><th>世代</th><th>羽色</th><th>速度</th><th>耐力</th><th>归巢</th><th>近交 F</th><th>操作</th></tr></thead>
          <tbody>
            ${[...store.all()].slice(-50).reverse().map(rowHtml).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  document.getElementById('btn-save')!.onclick = () => {
    appState.saveLocal();
    toast('已保存到本地浏览器');
  };
  document.getElementById('btn-export')!.onclick = () => appState.exportFile();
  document.getElementById('btn-load')!.onclick = () => {
    if (appState.loadLocal()) {
      render();
      toast('本地存档已载入');
    } else toast('未找到本地存档', true);
  };
  document.getElementById('btn-clear')!.onclick = () => {
    appState.clearLocal();
    toast('本地存档已清除');
  };
  document.getElementById('file-import')!.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try {
      await appState.importFile(file);
      render();
      toast(`已导入 ${store.size} 只`);
    } catch (err) {
      toast(`导入失败:${(err as Error).message}`, true);
    }
  };
  app.querySelectorAll('[data-pedigree]').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number((el as HTMLElement).dataset.pedigree);
      location.href = `./pedigree.html?id=${id}`;
    });
  });
}

function rowHtml(p: Pigeon): string {
  return `<tr>
    <td class="mono">${p.ringId}</td>
    <td><span class="badge ${p.sex === 'M' ? 'male' : 'female'}">${p.sex === 'M' ? '雄' : '雌'}</span></td>
    <td>${p.generation}</td>
    <td>${p.phenotype.colorName}</td>
    <td>${p.phenotype.speed}</td>
    <td>${p.phenotype.stamina}</td>
    <td>${p.phenotype.homing}</td>
    <td class="${p.inbreeding > 0.125 ? 'warn' : ''}">${(p.inbreeding * 100).toFixed(2)}%</td>
    <td><button class="secondary" data-pedigree="${p.id}">血统书</button></td>
  </tr>`;
}

function toast(msg: string, isError = false): void {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if (isError) el.style.borderColor = 'var(--accent-2)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

render();
