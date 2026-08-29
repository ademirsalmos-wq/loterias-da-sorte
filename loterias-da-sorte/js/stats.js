/**
 * stats.js — Motor estatístico.
 *
 * IMPORTANTE, e vale repetir dentro do próprio código:
 * sorteios são eventos independentes. Uma dezena "atrasada" NÃO tem
 * probabilidade maior de sair no próximo concurso — a bola não lembra do
 * passado. O que estes números servem para fazer é outra coisa, e essa sim
 * é legítima: descrever a distribuição histórica dos jogos sorteados para
 * você **calibrar filtros** e não gastar dinheiro em combinações que a
 * história mostra serem raríssimas (ex.: 15 dezenas todas pares).
 *
 * Descrever o passado: sim. Prever o futuro: não.
 */

import { PRIMOS, FIBONACCI } from './config.js';

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

export function percentil(valoresOrdenados, p) {
  if (!valoresOrdenados.length) return 0;
  const idx = (valoresOrdenados.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return valoresOrdenados[lo];
  return valoresOrdenados[lo] + (valoresOrdenados[hi] - valoresOrdenados[lo]) * (idx - lo);
}

function contarPor(valores) {
  const m = new Map();
  for (const v of valores) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function mapaParaDistribuicao(mapa, total) {
  return [...mapa.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([valor, vezes]) => ({ valor, vezes, pct: total ? (vezes / total) * 100 : 0 }));
}

/* ------------------------------------------------------------------ */
/* Características de um jogo isolado                                  */
/* ------------------------------------------------------------------ */

/** Posição de uma dezena na grade visual da loteria (linha, coluna). */
export function posicaoNaGrade(dezena, loteria) {
  const idx = dezena - loteria.min;
  return {
    linha: Math.floor(idx / loteria.grade.colunas),
    coluna: idx % loteria.grade.colunas,
  };
}

/** É dezena de moldura (borda da grade) ou de miolo? */
export function ehMoldura(dezena, loteria) {
  const { linha, coluna } = posicaoNaGrade(dezena, loteria);
  return (
    linha === 0 ||
    coluna === 0 ||
    linha === loteria.grade.linhas - 1 ||
    coluna === loteria.grade.colunas - 1
  );
}

/**
 * Extrai todas as características de um jogo (array de dezenas).
 * É o coração do gerador: os filtros comparam contra estes campos.
 */
export function caracterizar(dezenas, loteria, anterior = null) {
  const ordenado = [...dezenas].sort((a, b) => a - b);

  let pares = 0;
  let primos = 0;
  let fib = 0;
  let moldura = 0;
  let soma = 0;
  const linhas = new Array(loteria.grade.linhas).fill(0);
  const colunas = new Array(loteria.grade.colunas).fill(0);

  for (const d of ordenado) {
    soma += d;
    if (d % 2 === 0) pares++;
    if (PRIMOS.has(d)) primos++;
    if (FIBONACCI.has(d)) fib++;
    if (ehMoldura(d, loteria)) moldura++;
    const p = posicaoNaGrade(d, loteria);
    linhas[p.linha]++;
    colunas[p.coluna]++;
  }

  // Maior sequência de dezenas consecutivas (ex.: 7,8,9 -> 3)
  let maiorSequencia = ordenado.length ? 1 : 0;
  let atual = 1;
  for (let i = 1; i < ordenado.length; i++) {
    if (ordenado[i] === ordenado[i - 1] + 1) {
      atual++;
      if (atual > maiorSequencia) maiorSequencia = atual;
    } else {
      atual = 1;
    }
  }

  // Quantas dezenas se repetem em relação ao concurso anterior
  let repetidas = null;
  if (anterior) {
    const set = new Set(anterior);
    repetidas = ordenado.reduce((acc, d) => acc + (set.has(d) ? 1 : 0), 0);
  }

  return {
    dezenas: ordenado,
    soma,
    pares,
    impares: ordenado.length - pares,
    primos,
    fibonacci: fib,
    moldura,
    miolo: ordenado.length - moldura,
    maiorSequencia,
    repetidas,
    linhas,
    colunas,
    // Nº de linhas/colunas que ficaram completamente vazias
    linhasVazias: linhas.filter((v) => v === 0).length,
    colunasVazias: colunas.filter((v) => v === 0).length,
    menor: ordenado[0],
    maior: ordenado[ordenado.length - 1],
    amplitude: ordenado.length ? ordenado[ordenado.length - 1] - ordenado[0] : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Análise do histórico                                                */
/* ------------------------------------------------------------------ */

/**
 * Analisa o histórico completo (ou uma janela dos N concursos mais recentes).
 *
 * @param {Array<{numero:number,dezenas:number[]}>} concursos ordenados do mais antigo ao mais novo
 * @param {object} loteria definição vinda de config.js
 * @param {number|null} janela quantos concursos recentes considerar (null = todos)
 */
export function analisar(concursos, loteria, janela = null) {
  const usados = janela && janela > 0 ? concursos.slice(-janela) : concursos;
  const total = usados.length;

  if (!total) {
    return { vazio: true, total: 0 };
  }

  /* --- frequência e atraso por dezena --- */
  const freq = new Map();
  const ultimaVez = new Map();
  const atrasos = new Map(); // histórico de atrasos de cada dezena
  const ultimoIdxVisto = new Map();

  for (let n = loteria.min; n <= loteria.max; n++) {
    freq.set(n, 0);
    atrasos.set(n, []);
  }

  usados.forEach((c, idx) => {
    for (const d of c.dezenas) {
      freq.set(d, (freq.get(d) ?? 0) + 1);
      if (ultimoIdxVisto.has(d)) {
        atrasos.get(d).push(idx - ultimoIdxVisto.get(d) - 1);
      }
      ultimoIdxVisto.set(d, idx);
      ultimaVez.set(d, c.numero);
    }
  });

  const ultimoIdx = total - 1;
  const dezenas = [];
  for (let n = loteria.min; n <= loteria.max; n++) {
    const vezes = freq.get(n) ?? 0;
    const visto = ultimoIdxVisto.has(n) ? ultimoIdxVisto.get(n) : -1;
    const lista = atrasos.get(n);
    dezenas.push({
      dezena: n,
      vezes,
      // % dos concursos em que a dezena apareceu
      pct: (vezes / total) * 100,
      // quantos concursos se passaram desde a última aparição
      atraso: visto >= 0 ? ultimoIdx - visto : total,
      ultimoConcurso: ultimaVez.get(n) ?? null,
      atrasoMedio: lista.length ? lista.reduce((a, b) => a + b, 0) / lista.length : null,
      maiorAtraso: lista.length ? Math.max(...lista) : null,
    });
  }

  // Frequência esperada se tudo fosse perfeitamente uniforme.
  const esperado = (total * loteria.sorteadas) / loteria.universo;

  /* --- características agregadas dos jogos sorteados --- */
  const somas = [];
  const paresArr = [];
  const primosArr = [];
  const molduraArr = [];
  const seqArr = [];
  const repetidasArr = [];
  const amplitudeArr = [];

  usados.forEach((c, idx) => {
    const anterior = idx > 0 ? usados[idx - 1].dezenas : null;
    const k = caracterizar(c.dezenas, loteria, anterior);
    somas.push(k.soma);
    paresArr.push(k.pares);
    primosArr.push(k.primos);
    molduraArr.push(k.moldura);
    seqArr.push(k.maiorSequencia);
    amplitudeArr.push(k.amplitude);
    if (k.repetidas !== null) repetidasArr.push(k.repetidas);
  });

  const somasOrd = [...somas].sort((a, b) => a - b);

  /* --- pares de dezenas que mais saem juntas --- */
  const duplas = new Map();
  for (const c of usados) {
    const d = c.dezenas;
    for (let i = 0; i < d.length; i++) {
      for (let j = i + 1; j < d.length; j++) {
        const chave = d[i] * 1000 + d[j];
        duplas.set(chave, (duplas.get(chave) ?? 0) + 1);
      }
    }
  }
  const duplasTop = [...duplas.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([chave, vezes]) => ({
      a: Math.floor(chave / 1000),
      b: chave % 1000,
      vezes,
      pct: (vezes / total) * 100,
    }));

  return {
    vazio: false,
    total,
    primeiroConcurso: usados[0].numero,
    ultimoConcurso: usados[total - 1].numero,
    dezenasSorteadasUltimo: usados[total - 1].dezenas,
    esperado,

    dezenas,
    maisSorteadas: [...dezenas].sort((a, b) => b.vezes - a.vezes),
    maisAtrasadas: [...dezenas].sort((a, b) => b.atraso - a.atraso),
    duplasTop,

    soma: {
      min: Math.min(...somas),
      max: Math.max(...somas),
      media: somas.reduce((a, b) => a + b, 0) / total,
      p05: Math.round(percentil(somasOrd, 0.05)),
      p25: Math.round(percentil(somasOrd, 0.25)),
      p50: Math.round(percentil(somasOrd, 0.5)),
      p75: Math.round(percentil(somasOrd, 0.75)),
      p95: Math.round(percentil(somasOrd, 0.95)),
      distribuicao: mapaParaDistribuicao(contarPor(somas), total),
    },
    pares: mapaParaDistribuicao(contarPor(paresArr), total),
    primos: mapaParaDistribuicao(contarPor(primosArr), total),
    moldura: mapaParaDistribuicao(contarPor(molduraArr), total),
    sequencia: mapaParaDistribuicao(contarPor(seqArr), total),
    repetidas: mapaParaDistribuicao(contarPor(repetidasArr), repetidasArr.length),
    amplitude: {
      min: Math.min(...amplitudeArr),
      max: Math.max(...amplitudeArr),
      media: amplitudeArr.reduce((a, b) => a + b, 0) / total,
    },
  };
}

/**
 * A partir da análise, sugere faixas de filtro que cobrem ~90% dos
 * concursos históricos. Serve como ponto de partida do gerador: elimina o
 * absurdo estatístico sem estreitar tanto a ponto de excluir jogos normais.
 */
export function sugerirFiltros(analise) {
  if (analise.vazio) return null;

  const faixaCobrindo = (dist, cobertura = 0.9) => {
    // Ordena por frequência e vai somando até cobrir X% dos casos;
    // devolve o intervalo [min, max] dos valores escolhidos.
    const ordenado = [...dist].sort((a, b) => b.vezes - a.vezes);
    const alvo = cobertura * 100;
    let acumulado = 0;
    const escolhidos = [];
    for (const item of ordenado) {
      escolhidos.push(item.valor);
      acumulado += item.pct;
      if (acumulado >= alvo) break;
    }
    return { min: Math.min(...escolhidos), max: Math.max(...escolhidos) };
  };

  return {
    soma: { min: analise.soma.p05, max: analise.soma.p95 },
    pares: faixaCobrindo(analise.pares),
    primos: faixaCobrindo(analise.primos),
    moldura: faixaCobrindo(analise.moldura),
    repetidas: analise.repetidas.length ? faixaCobrindo(analise.repetidas) : null,
    maxSequencia: faixaCobrindo(analise.sequencia, 0.97).max,
  };
}
