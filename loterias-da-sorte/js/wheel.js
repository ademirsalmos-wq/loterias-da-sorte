/**
 * wheel.js — Fechamentos (desdobramentos) com garantia matemática.
 *
 * Esta é a única parte do sistema que oferece uma GARANTIA de verdade,
 * e ela é um teorema, não um palpite:
 *
 *   "Escolha N dezenas. Se T das dezenas sorteadas estiverem entre essas N,
 *    então pelo menos um dos bilhetes abaixo terá no mínimo G acertos."
 *
 * Isso é um problema clássico de **cobertura de conjuntos** (covering design).
 * Não tem nada de estatística nem de sorte: ou o conjunto de bilhetes cobre
 * todas as possibilidades, ou não cobre — e a gente confere uma por uma.
 *
 * O que este módulo NÃO faz: aumentar a chance de as suas N dezenas conterem
 * as sorteadas. Essa parte continua sendo sorte pura.
 *
 * Implementação:
 *  1. Constrói um conjunto de bilhetes por algoritmo guloso randomizado.
 *  2. Poda os bilhetes redundantes.
 *  3. VERIFICA por força bruta, testando TODAS as C(N,T) possibilidades,
 *     qual é a garantia real. O número mostrado na tela é o verificado,
 *     nunca o prometido.
 */

/* ------------------------------------------------------------------ */
/* Combinatória em bitmask                                             */
/* ------------------------------------------------------------------ */

export function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

function popcount(x) {
  x = x - ((x >> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >> 2) & 0x33333333);
  x = (x + (x >> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >> 24;
}

/** Todos os subconjuntos de tamanho k de {0..n-1}, como bitmasks. */
export function subconjuntos(n, k) {
  const total = binomial(n, k);
  const out = new Int32Array(total);
  const idx = new Array(k);
  for (let i = 0; i < k; i++) idx[i] = i;

  let p = 0;
  while (true) {
    let m = 0;
    for (let i = 0; i < k; i++) m |= 1 << idx[i];
    out[p++] = m;

    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

function maskParaIndices(mask, n) {
  const out = [];
  for (let i = 0; i < n; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

/* ------------------------------------------------------------------ */
/* Limites de viabilidade                                              */
/* ------------------------------------------------------------------ */

export const LIMITE_ALVOS = 400000;

/** Cobertura teórica de um único bilhete (vale por simetria para qualquer um). */
export function coberturaPorBilhete(n, j, t, g) {
  let soma = 0;
  const maxI = Math.min(j, t);
  for (let i = g; i <= maxI; i++) soma += binomial(j, i) * binomial(n - j, t - i);
  return soma;
}

/** Limite inferior de bilhetes necessários (cota de Schönheim simplificada). */
export function minimoTeorico(n, j, t, g) {
  const cob = coberturaPorBilhete(n, j, t, g);
  if (cob <= 0) return Infinity;
  return Math.ceil(binomial(n, t) / cob);
}

/**
 * Probabilidade de o cenário assumido realmente acontecer.
 *
 * Esta é a informação que quase nenhum sistema de fechamento mostra — e é a
 * mais importante das duas. A garantia é certa; o cenário em que ela vale, não.
 *
 * P(exatamente t das S sorteadas caírem entre as suas N dezenas)
 *   = C(N,t) · C(U-N, S-t) / C(U,S)          [distribuição hipergeométrica]
 *
 * A garantia continua valendo se caírem MAIS do que t (o conjunto só melhora),
 * então o número que interessa é o acumulado de t para cima.
 */
export function probabilidadeCenario(universo, sorteadas, n, t) {
  const denominador = binomial(universo, sorteadas);
  if (!denominador) return { exata: 0, acumulada: 0 };

  const pExata = (x) =>
    (binomial(n, x) * binomial(universo - n, sorteadas - x)) / denominador;

  let acumulada = 0;
  for (let x = t; x <= Math.min(n, sorteadas); x++) acumulada += pExata(x);

  return { exata: pExata(t), acumulada };
}

/** "1 em 47" é mais legível do que "2,1%". */
export function umEmQuantos(p) {
  if (!p || p <= 0) return null;
  return Math.round(1 / p);
}

export function validarPedido({ n, j, t, g }) {
  if (j > n) return `Cada bilhete tem ${j} dezenas, mas você só escolheu ${n}.`;
  if (t > n) return `Você espera ${t} acertos dentro de ${n} dezenas — impossível.`;
  if (g > Math.min(j, t)) {
    return `Garantia de ${g} pontos é impossível: o máximo com ${j} dezenas por bilhete e ${t} acertos no grupo é ${Math.min(j, t)}.`;
  }
  const alvos = binomial(n, t);
  if (alvos > LIMITE_ALVOS) {
    return `Combinações demais para verificar (${alvos.toLocaleString('pt-BR')}). Reduza o número de dezenas do fechamento.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Construção                                                          */
/* ------------------------------------------------------------------ */

function blocoAleatorio(alvoMask, n, j) {
  const dentro = maskParaIndices(alvoMask, n);
  const fora = [];
  for (let i = 0; i < n; i++) if (!(alvoMask & (1 << i))) fora.push(i);

  const embaralhar = (a) => {
    for (let i = a.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [a[i], a[k]] = [a[k], a[i]];
    }
    return a;
  };

  let escolhidos;
  if (j >= dentro.length) {
    escolhidos = dentro.concat(embaralhar(fora).slice(0, j - dentro.length));
  } else {
    escolhidos = embaralhar(dentro).slice(0, j);
  }

  let m = 0;
  for (const i of escolhidos) m |= 1 << i;
  return m;
}

function construir(alvos, n, j, g, variantes) {
  let restantes = Array.from(alvos);
  const solucao = [];
  let guarda = 0;

  while (restantes.length > 0 && guarda++ < 200000) {
    let melhor = 0;
    let melhorCob = -1;

    for (let v = 0; v < variantes; v++) {
      const alvo = restantes[(Math.random() * restantes.length) | 0];
      const bloco = blocoAleatorio(alvo, n, j);

      let cob = 0;
      for (let i = 0; i < restantes.length; i++) {
        if (popcount(bloco & restantes[i]) >= g) cob++;
      }
      if (cob > melhorCob) {
        melhorCob = cob;
        melhor = bloco;
      }
    }

    if (melhorCob <= 0) break; // não deveria acontecer; evita laço infinito
    solucao.push(melhor);
    restantes = restantes.filter((a) => popcount(melhor & a) < g);
  }

  return solucao;
}

/** Remove bilhetes cuja retirada não quebra a cobertura. */
function podar(solucao, alvos, g) {
  const contagem = new Int32Array(alvos.length);
  for (const b of solucao) {
    for (let i = 0; i < alvos.length; i++) {
      if (popcount(b & alvos[i]) >= g) contagem[i]++;
    }
  }

  const manter = new Array(solucao.length).fill(true);
  for (let s = solucao.length - 1; s >= 0; s--) {
    const b = solucao[s];
    let redundante = true;
    for (let i = 0; i < alvos.length; i++) {
      if (popcount(b & alvos[i]) >= g && contagem[i] < 2) { redundante = false; break; }
    }
    if (redundante) {
      manter[s] = false;
      for (let i = 0; i < alvos.length; i++) {
        if (popcount(b & alvos[i]) >= g) contagem[i]--;
      }
    }
  }

  return solucao.filter((_, i) => manter[i]);
}

/**
 * VERIFICAÇÃO EXATA. Percorre todas as C(n,t) possibilidades e devolve a
 * pior nota — ou seja, a garantia que o conjunto realmente entrega.
 */
export function verificarGarantia(solucao, alvos, n) {
  let pior = Infinity;
  const histograma = new Map();

  for (let i = 0; i < alvos.length; i++) {
    let melhor = 0;
    for (const b of solucao) {
      const p = popcount(b & alvos[i]);
      if (p > melhor) melhor = p;
    }
    if (melhor < pior) pior = melhor;
    histograma.set(melhor, (histograma.get(melhor) ?? 0) + 1);
  }

  return {
    garantiaReal: pior === Infinity ? 0 : pior,
    distribuicao: [...histograma.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([acertos, casos]) => ({
        acertos,
        casos,
        pct: (casos / alvos.length) * 100,
      })),
    totalCenarios: alvos.length,
  };
}

/* ------------------------------------------------------------------ */
/* API principal                                                       */
/* ------------------------------------------------------------------ */

/**
 * Monta o fechamento.
 *
 * @param {number[]} dezenas    as N dezenas escolhidas (valores reais, ex.: [1,3,7,...])
 * @param {object}   opcoes
 * @param {number}   opcoes.porJogo   dezenas em cada bilhete (j)
 * @param {number}   opcoes.acertosNoGrupo  quantas das sorteadas você assume estar dentro das N (t)
 * @param {number}   opcoes.garantia  pontos garantidos (g)
 * @param {number}   opcoes.tentativas  quantas construções tentar (fica com a menor)
 */
export function fechar(dezenas, opcoes) {
  const n = dezenas.length;
  const j = opcoes.porJogo;
  const t = opcoes.acertosNoGrupo;
  const g = opcoes.garantia;
  const erro = validarPedido({ n, j, t, g });
  if (erro) throw new Error(erro);

  const ordenadas = [...dezenas].sort((a, b) => a - b);
  const alvos = subconjuntos(n, t);

  // Auto-regulagem do esforço: problemas pequenos ganham mais tentativas
  // (sai um conjunto menor); problemas grandes rodam mais enxuto para não
  // travar o navegador.
  const escala = alvos.length;
  const tentativas =
    opcoes.tentativas ?? (escala < 2000 ? 12 : escala < 20000 ? 4 : 2);
  const variantes =
    opcoes.variantes ?? (escala < 2000 ? 64 : escala < 20000 ? 24 : 12);

  let melhor = null;
  for (let r = 0; r < tentativas; r++) {
    const bruto = construir(alvos, n, j, g, variantes);
    const podado = podar(bruto, alvos, g);
    if (!melhor || podado.length < melhor.length) melhor = podado;
  }

  const verificacao = verificarGarantia(melhor, alvos, n);

  return {
    jogos: melhor.map((m) => maskParaIndices(m, n).map((i) => ordenadas[i])),
    dezenas: ordenadas,
    parametros: { n, j, t, g },
    ...verificacao,
    minimoTeorico: minimoTeorico(n, j, t, g),
    // Se a verificação bateu com o pedido, a garantia está honrada.
    garantiaAtendida: verificacao.garantiaReal >= g,
  };
}

/**
 * Sugere combinações (t, g) interessantes para uma quantidade de dezenas,
 * já com a estimativa de quantos jogos e quanto custa.
 */
export function sugestoes(loteria, n, porJogo) {
  const s = loteria.sorteadas;
  const out = [];
  for (let t = s; t >= Math.max(s - 3, Math.min(porJogo, s) - 3); t--) {
    if (t > n) continue;
    for (let g of loteria.faixas) {
      if (g > Math.min(porJogo, t)) continue;
      if (g < Math.min(porJogo, t) - 3) continue;
      const min = minimoTeorico(n, porJogo, t, g);
      if (!Number.isFinite(min) || min > 5000) continue;
      out.push({
        acertosNoGrupo: t,
        garantia: g,
        minimoTeorico: min,
        alvos: binomial(n, t),
      });
    }
  }
  return out.sort((a, b) => a.minimoTeorico - b.minimoTeorico);
}
