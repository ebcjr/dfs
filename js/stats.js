// ============================================================
// stats.js — Módulo de validação biométrica
// Dependências: nenhuma (zero imports)
//
// Exporta:
//   fitWeibull(arr)            → {k, lambda} | null
//   weibullQuantile(p, k, λ)  → Number
//   fitCurtis(pool)            → {b0, b1, residualMAD} | null
//   curtisResidual(b0,b1,dap,ht) → Number
//   robustMAD(arr)             → {median, mad, lower, upper} | null
//   getTailProb(sdMultiplier)  → Number
// ============================================================

const STATS_N_MIN_DAP  = 30;   // mínimo de obs para Weibull DAP
const STATS_N_MIN_HT   = 12;   // mínimo de pares para regressão Curtis
const STATS_N_MIN_INC  = 10;    // mínimo de incrementos para buffer remedição


// ============================================================
// 1. FUNÇÃO GAMA — Aproximação de Lanczos
// Necessária para o metodo dos momentos da Weibull
// ============================================================
function gamma(z) {
  const g = 7;
  const p = [
    0.99999999999980993,  676.5203681218851,  -1259.1392167224028,
    771.32342877765313,  -176.61502916214059,   12.507343278224757,
    -0.13857109526572012,  9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
  z -= 1;
  let x = p[0];
  for (let i = 1; i < g + 2; i++) x += p[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}


// ============================================================
// 2. FUNÇÃO DIGAMMA — Derivada logarítmica de Γ(z)
// Necessária para o Newton-Raphson do ajuste Weibull
// Aproximação de Bernardo (1976), precisa para z > 0
// ============================================================
function digamma(z) {
  // Recorrência para z > 6 (zona de convergência rápida da série assintótica)
  if (z < 6) return digamma(z + 1) - 1 / z;
  // Série assintótica de Stirling
  return Math.log(z) - 1 / (2 * z)
    - 1  / (12 * z ** 2)
    + 1  / (120 * z ** 4)
    - 1  / (252 * z ** 6);
}


// ============================================================
// 3. AJUSTE WEIBULL — metodo dos momentos via Newton-Raphson
//
// Modelo: F(x) = 1 - exp(-(x/λ)^k)
// Resolve k numericamente a partir do CV² amostral:
//   CV² = Γ(1+2/k) / Γ(1+1/k)² - 1
// ============================================================
export function fitWeibull(arr) {
  if (!arr || arr.length < STATS_N_MIN_DAP) return null;

  const n    = arr.length;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  if (mean <= 0) return null;

  const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return null;

  const cv2 = variance / (mean ** 2);

  // Chute inicial robusto (método de Justus como seed apenas)
  let k = Math.pow(mean / sd, 1.086);
  if (!isFinite(k) || k <= 0) k = 2.0;

  // Newton-Raphson — converge em < 10 iterações para DAP típico
  for (let i = 0; i < 30; i++) {
    const g1 = gamma(1 + 1 / k);
    const g2 = gamma(1 + 2 / k);

    // Função objetivo: f(k) = g2/g1² - 1 - cv²
    const f = g2 / (g1 ** 2) - 1 - cv2;

    // Derivada analítica: df/dk
    const dg1dk = -digamma(1 + 1 / k) * g1 / (k ** 2);
    const dg2dk = -digamma(1 + 2 / k) * g2 * 2 / (k ** 2);
    const df    = (dg2dk * g1 ** 2 - g2 * 2 * g1 * dg1dk) / (g1 ** 4);

    if (df === 0) break;
    const dk = -f / df;
    k += dk;
    if (!isFinite(k) || k <= 0) { k = 2.0; break; }
    if (Math.abs(dk) < 1e-9) break;
  }

  const lambda = mean / gamma(1 + 1 / k);
  if (!isFinite(lambda) || lambda <= 0) return null;

  return { k, lambda };
}


// ============================================================
// 4. QUANTIL WEIBULL
// Retorna o valor x tal que P(X ≤ x) = p
// ============================================================
export function weibullQuantile(p, k, lambda) {
  if (p <= 0 || p >= 1) return null;
  return lambda * Math.pow(-Math.log(1 - p), 1 / k);
}


// ============================================================
// 5. CONVERSÃO DP → PROBABILIDADE DE CAUDA
//
// Mapeia o threshold configurado pelo usuário (em unidades de DP)
// para a probabilidade de cauda de uma Normal padrão.
// Usado para parear o threshold com os quantis Weibull.
//
// Usa a aproximação logística de Bowling et al. (2009):
//   p_cauda = 1 / (1 + exp(1.7175 * z))
// Erro máximo < 0.00014 no intervalo z ∈ [0, 4]
// ============================================================
export function getTailProb(sdMultiplier) {
  return 1 / (1 + Math.exp(1.7175 * sdMultiplier));
}


// ============================================================
// 6. REGRESSÃO CURTIS — OLS fechado
//
// Modelo: ln(HT) = b0 + b1 * (1/DAP)
// Linearização exata → sem iteração, sem convergência.
//
// Pool de ajuste: apenas árvores com dap E ht medidos,
// excluindo mortas, falhas, quebradas e bifurcadas_abaixo
// (veja CURTIS_EXCLUDE em app.js).
//
// Retorna:
//   b0, b1          — coeficientes
//   residualMAD     — MAD dos resíduos (escala robusta para flags)
//   residualSd      — DP clássico dos resíduos (informativo)
//   n               — tamanho do pool de ajuste
//   r2              — R² do ajuste (informativo)
// ============================================================
export function fitCurtis(pool) {
  if (!pool || pool.length < STATS_N_MIN_HT) return null;

  const pairs = pool
    .filter(t => t.dap > 0 && t.ht > 0)
    .map(t => ({ x: 1 / t.dap, y: Math.log(t.ht), treeId: t.id }));

  if (pairs.length < STATS_N_MIN_HT) return null;

  const n  = pairs.length;
  const xm = pairs.reduce((a, b) => a + b.x, 0) / n;
  const ym = pairs.reduce((a, b) => a + b.y, 0) / n;

  let sxx = 0, sxy = 0, syy = 0;
  for (const { x, y } of pairs) {
    sxx += (x - xm) ** 2;
    sxy += (x - xm) * (y - ym);
    syy += (y - ym) ** 2;
  }
  if (sxx === 0) return null;

  const b1 = sxy / sxx;
  const b0 = ym - b1 * xm;
  const r2 = sxy ** 2 / (sxx * syy);

  // Resíduos ordinários e leverages
  // h_ii = 1/n + (x_i - x̄)² / sxx
  const residuals = pairs.map(({ x, y, treeId }) => {
    const eHat = y - (b0 + b1 * x);
    const h    = 1 / n + (x - xm) ** 2 / sxx;
    const eLoo = eHat / (1 - h);      
    return { treeId, eHat, eLoo, h };
  });

  // MAD dos resíduos LOO 
  const absLoo = residuals.map(r => Math.abs(r.eLoo)).sort((a, b) => a - b);
  const medLoo = absLoo.length % 2 === 0
    ? (absLoo[absLoo.length / 2 - 1] + absLoo[absLoo.length / 2]) / 2
    : absLoo[Math.floor(absLoo.length / 2)];
  const looMAD = medLoo * 1.4826;

  // DP clássico dos resíduos ordinários (informativo)
  const residualSd = Math.sqrt(
    residuals.reduce((a, r) => a + r.eHat ** 2, 0) / (n - 2)
  );

  return { b0, b1, r2, n, looMAD, residualSd, residuals };
}

// ============================================================
// 7. RESÍDUO CURTIS — para uma árvore individual
//
// Retorna o resíduo em unidades de ln(HT):
//   ê = ln(HT_obs) - (b0 + b1/DAP)
//
// Flag quando |ê| > threshold * residualMAD
// ============================================================
export function curtisResidual(b0, b1, dap, ht) {
  if (dap <= 0 || ht <= 0) return null;
  return Math.log(ht) - (b0 + b1 / dap);
}


// ============================================================
// 8. MAD ROBUSTO — para distribuição marginal (fallback)
//
// Usado como fallback para HT quando n < STATS_N_MIN_HT
// ou quando Curtis não converge.
//
// Retorna: {median, mad, lower(threshold), upper(threshold)}
// ============================================================
export function robustMAD(arr, threshold = 2.0) {
  if (!arr || arr.length < STATS_N_MIN_HT) return null;

  const sorted = [...arr].sort((a, b) => a - b);
  const n      = sorted.length;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];

  const devs   = sorted.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const medDev = devs.length % 2 === 0
    ? (devs[devs.length / 2 - 1] + devs[devs.length / 2]) / 2
    : devs[Math.floor(devs.length / 2)];

  const mad   = medDev * 1.4826;
  if (mad === 0) return null;

  return {
    median,
    mad,
    lower: median - threshold * mad,
    upper: median + threshold * mad,
  };
}


// ============================================================
// 9. BUFFER DE INCREMENTO — para remedições
//
// Calcula média e DP do incremento diamétrico entre ciclos
// nas árvores que eram vivas no ciclo anterior e continuam vivas.
//
// Retorna: {mean, upperBound, lowerBound} | {valid: false}
// ============================================================
export function fitIncrementBuffer(currentTrees, historyTrees, aliveCats, outlierSD) {
  const incDaps = [];

  currentTrees.forEach(t => {
    const h = historyTrees.find(
      x => x.fila === t.fila && x.cova === t.cova && x.fuste === t.fuste
    );
    // Só usa o par se ambos eram vivos E têm DAP medido
    if (h && h.dap != null && t.dap != null && aliveCats.includes(h.cat)) {
      incDaps.push(t.dap - h.dap);
    }
  });

  if (incDaps.length < STATS_N_MIN_INC) return { valid: false };

  const n    = incDaps.length;
  const mean = incDaps.reduce((a, b) => a + b, 0) / n;
  const sd   = Math.sqrt(
    incDaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  );

  return {
    valid:       true,
    mean,
    sd,
    upperBound:  mean + outlierSD * sd,
    lowerBound:  mean - outlierSD * sd,
    n,
  };
}


export { STATS_N_MIN_DAP, STATS_N_MIN_HT, STATS_N_MIN_INC };
