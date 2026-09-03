/**
 * espaco.js — O espaço de combinações que passa nos filtros.
 *
 * ---------------------------------------------------------------------
 * A PERGUNTA QUE ESTE MÓDULO RESPONDE
 *
 * "Se eu apertar os filtros até sobrarem poucos bilhetes, esses bilhetes
 * acertam mais?"
 *
 * A resposta curta é NÃO, e ela é um teorema, não uma medição. Para
 * qualquer bilhete FIXO de `t` dezenas, o número de acertos contra um
 * sorteio uniforme de `s` dezenas num universo de `u` segue exatamente a
 * distribuição hipergeométrica:
 *
 *     P(k acertos) = C(t,k) · C(u−t, s−k) / C(u,s)
 *
 * Repare no que essa fórmula NÃO tem: as dezenas do bilhete. Ela depende
 * só de quantas dezenas ele tem. Dois bilhetes da Lotofácil — um com soma
 * 195 e 8 pares, outro sendo 1-2-3-4-5-6-7-8-9-10-11-12-13-14-15 — têm a
 * mesmíssima distribuição de acertos. Logo, nenhum subconjunto do espaço,
 * escolhido por qualquer critério que olhe só para as dezenas, pode ter
 * média de acertos diferente do espaço inteiro.
 *
 * Na Lotofácil a média é sempre 9,0000 acertos por bilhete. Sempre. É
 * linearidade da esperança: cada uma das suas 15 dezenas tem 15/25 de
 * chance de ser sorteada, e 15 × 0,6 = 9. Não existe filtro que mude isso.
 *
 * ---------------------------------------------------------------------
 * ENTÃO POR QUE ESTE MÓDULO EXISTE?
 *
 * Por três motivos, e nenhum deles é "achar o filtro mágico":
 *
 *  1. Para MOSTRAR o teorema com os números do próprio usuário. Ler que
 *     não muda é uma coisa; ver o filtro cortar 95% do espaço e a coluna
 *     de acertos não se mexer é outra. Cura ilusão melhor que argumento.
 *
 *  2. Para separar sinal de ruído. Contra a história REAL sempre aparece
 *     alguma diferença — os 3.775 concursos são uma amostra finita. Um
 *     filtro calibrado nessa mesma história vai parecer bom por
 *     construção. Por isso toda diferença sai daqui com intervalo de
 *     confiança (bootstrap sobre os concursos) e o veredito explícito de
 *     estar ou não dentro do ruído.
 *
 *  3. Porque existe UM efeito real, e ele é de dinheiro, não de acerto:
 *     o prêmio é rateado. Fugir de padrão popular não muda a chance de
 *     ganhar, muda quanto você leva quando ganha. Com os rateios reais
 *     baixados da Caixa, isso finalmente dá para medir em reais.
 *
 * ---------------------------------------------------------------------
 * COMO ELE FAZ
 *
 * Enumeração exaustiva com poda incremental. A busca abandona um ramo
 * assim que ele já não pode dar certo — se a soma parcial mais a MENOR
 * soma possível do que falta já estoura o teto, nenhuma continuação
 * daquele ramo serve, e o ramo inteiro morre ali.
 *
 * A poda é só um acelerador: ela nunca decide sozinha o que entra. Toda
 * decisão de aceitar ou recusar usa os mesmos critérios do `generator.js`,
 * e `testes/espaco.teste.mjs` confere a contagem podada contra uma força
 * bruta sem poda nenhuma. Duas implementações do mesmo filtro que discordam
 * em silêncio seriam o pior defeito possível aqui — estatística sobre
 * espaço errado não dá erro, dá número errado com cara de certo.
 *
 * Escala medida (Node, desktop):
 *   Lotofácil 15/25 — 3.268.760 combinações, 155 ms.
 *   Mega-Sena 6/60 — 50.063.860 combinações, 1,5 s.
 *   Lotomania 50/100 — 1,0 × 10²⁹. Não é questão de paciência: a um bilhão
 *   por segundo levaria 3 trilhões de anos. Por isso `espacoDisponivel`
 *   é `false` para ela no config, como já acontece com o fechamento.
 */

import { PRIMOS } from './config.js';
import { ehMoldura } from './stats.js';
import { pontuacaoPopularidade } from './generator.js';
import { valorDaFaixa } from './premios.js';

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

/** C(n,k) exato para os tamanhos que aparecem aqui. */
export function combinacoes(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}

/* Tabela de 16 bits para contar bits acesos. Duas consultas por máscara
   de 32 bits, quatro por bilhete de até 64 dezenas. */
const POP = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) POP[i] = POP[i >> 1] + (i & 1);
const bits = (x) => POP[x & 0xffff] + POP[(x >>> 16) & 0xffff];

/**
 * Limite de dezenas no universo. As máscaras são dois inteiros de 32 bits,
 * então cabem 64 dezenas — folgado para Lotofácil (25) e Mega-Sena (60),
 * insuficiente para a Lotomania (100), que de todo modo não é enumerável.
 */
export const MAX_UNIVERSO = 64;

/**
 * Notação científica legível em português: 1,0 × 10²⁹.
 *
 * Existe porque `toExponential()` devolve "1.0e+29", que num aviso para o
 * usuário parece defeito do programa, não o tamanho do problema.
 */
const SOBRESCRITO = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
export function emPotencia(n) {
  const [mant, exp] = n.toExponential(1).split('e');
  const expoente = String(Number(exp)).replace(/./g, (c) => SOBRESCRITO[c] ?? c);
  return `${mant.replace('.', ',')} × 10${expoente}`;
}

/* ------------------------------------------------------------------ */
/* Viabilidade — a conta que se faz ANTES de rodar                     */
/* ------------------------------------------------------------------ */

/**
 * Quantas combinações existem antes de qualquer filtro, e se dá para
 * enumerá-las nesta vida.
 *
 * Esta função é chamada pela tela antes de o usuário apertar qualquer
 * botão. O número tem que aparecer ANTES, não depois de dois minutos de
 * barra de progresso — a lição do download de prêmios foi essa.
 */
export function viabilidade(loteria, filtros = {}) {
  const tamanho = filtros.dezenasPorJogo ?? loteria.marcarMin;
  const excluidas = new Set(filtros.excluidas ?? []);
  const fixas = [...new Set(filtros.fixas ?? [])].filter(
    (d) => d >= loteria.min && d <= loteria.max && !excluidas.has(d)
  );

  const disponiveis = loteria.universo - excluidas.size - fixas.length;
  const aEscolher = tamanho - fixas.length;
  const bruto = combinacoes(disponiveis, aEscolher);

  if (loteria.espacoDisponivel === false) {
    return {
      viavel: false,
      bruto,
      tamanho,
      motivo:
        `A ${loteria.nome} tem ${emPotencia(bruto)} ` +
        `combinações possíveis. Enumerar todas não é questão de paciência — ` +
        `a um bilhão por segundo levaria trilhões de anos. Use o Gerador com ` +
        `filtros, que sorteia bilhetes sem precisar listar o espaço inteiro.`,
    };
  }

  if (loteria.universo > MAX_UNIVERSO) {
    return {
      viavel: false, bruto, tamanho,
      motivo: `Universo de ${loteria.universo} dezenas — acima do limite de ${MAX_UNIVERSO}.`,
    };
  }

  if (aEscolher < 0) {
    return {
      viavel: false, bruto, tamanho,
      motivo: `Você fixou ${fixas.length} dezenas, mas o bilhete tem ${tamanho}.`,
    };
  }
  if (disponiveis < aEscolher) {
    return {
      viavel: false, bruto, tamanho,
      motivo: `Sobraram ${disponiveis} dezenas disponíveis para escolher ${aEscolher}.`,
    };
  }

  /* Teto de segurança. Não é sobre memória — a amostragem por reservatório
     usa memória constante — é sobre TEMPO: a busca visita cada folha uma
     vez, e acima disso a espera deixa de ser razoável num celular. */
  const TETO = 120_000_000;
  if (bruto > TETO) {
    return {
      viavel: false, bruto, tamanho,
      motivo:
        `São ${bruto.toLocaleString('pt-BR')} combinações a percorrer — acima do ` +
        `teto de ${TETO.toLocaleString('pt-BR')}. Fixe ou exclua algumas dezenas ` +
        `no volante para reduzir o universo.`,
    };
  }

  return { viavel: true, bruto, tamanho, fixas, disponiveis, motivo: null };
}

/* ------------------------------------------------------------------ */
/* Enumeração                                                          */
/* ------------------------------------------------------------------ */

/**
 * Traços que valem por dezena isolada — todos podados pela mesma máquina.
 *
 * Cada um vira um vetor de 0/1 sobre o pool, mais as somas de sufixo, que
 * respondem em O(1) "quantas dezenas com este traço ainda posso pegar
 * daqui para frente?". Sem isso a poda de mínimo custaria um laço por nó.
 */
function tracosDoPool(pool, loteria, ultimoSorteio) {
  const n = pool.length;
  const anterior = ultimoSorteio ? new Set(ultimoSorteio) : null;

  const traco = {
    pares: new Uint8Array(n),
    primos: new Uint8Array(n),
    moldura: new Uint8Array(n),
    repetidas: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) {
    const d = pool[i];
    traco.pares[i] = d % 2 === 0 ? 1 : 0;
    traco.primos[i] = PRIMOS.has(d) ? 1 : 0;
    traco.moldura[i] = ehMoldura(d, loteria) ? 1 : 0;
    traco.repetidas[i] = anterior && anterior.has(d) ? 1 : 0;
  }

  /* sufixo[i] = quantas dezenas com o traço existem em pool[i..n-1] */
  const sufixo = {};
  for (const nome of Object.keys(traco)) {
    const s = new Int32Array(n + 1);
    for (let i = n - 1; i >= 0; i--) s[i] = s[i + 1] + traco[nome][i];
    sufixo[nome] = s;
  }

  /* Somas de sufixo do valor das dezenas, para a poda da soma: como o pool
     é crescente, a MAIOR soma possível de `r` dezenas são as r últimas do
     pool, e `maiorRestante[N-r]` responde isso em O(1). */
  const maiorRestante = new Float64Array(n + 2);
  for (let i = n - 1; i >= 0; i--) maiorRestante[i] = maiorRestante[i + 1] + pool[i];

  return { traco, sufixo, maiorRestante };
}

/**
 * Percorre TODAS as combinações que passam nos filtros.
 *
 * Devolve a contagem exata sempre, e uma amostra dos bilhetes:
 *  - se o espaço couber no reservatório, a amostra É o espaço inteiro e
 *    `exata` vem `true`;
 *  - se não couber, a amostra é uniforme (algoritmo do reservatório) e
 *    `exata` vem `false`, com `amostrados` dizendo quantos.
 *
 * Reservatório e não "os N primeiros" de propósito: os primeiros bilhetes
 * de uma busca em profundidade começam todos por 1-2-3-4… e não se parecem
 * nada com o espaço. Medir sobre eles daria número errado com cara de certo.
 *
 * @param {object} loteria
 * @param {object} filtros            os mesmos do generator.js
 * @param {object} opcoes
 * @param {number} opcoes.reservatorio  quantos bilhetes guardar (padrão 50 mil)
 * @param {object} opcoes.contexto      {ultimoSorteio, combinacoesSorteadas}
 * @param {Function} opcoes.aoProgredir (visitados, aceitos) — chamado de vez em quando
 * @param {Function} opcoes.cancelado   () => boolean
 * @param {number} opcoes.semente       torna a amostra reproduzível nos testes
 */
export function explorar(loteria, filtros, opcoes = {}) {
  const via = viabilidade(loteria, filtros);
  if (!via.viavel) throw new Error(via.motivo);

  const t0 = Date.now();
  const K = Math.max(1, opcoes.reservatorio ?? 50_000);
  const aoProgredir = opcoes.aoProgredir ?? null;
  const cancelado = opcoes.cancelado ?? null;
  const contexto = opcoes.contexto ?? {};

  const tamanho = via.tamanho;
  const excluidas = new Set(filtros.excluidas ?? []);
  const fixas = via.fixas;
  const fixasSet = new Set(fixas);

  /* O pool é o universo menos as excluídas. As FIXAS continuam no pool,
     marcadas como obrigatórias: tirá-las e somar depois quebraria a conta
     de dezenas consecutivas, que depende da ordem real. */
  const pool = [];
  for (let d = loteria.min; d <= loteria.max; d++) {
    if (!excluidas.has(d)) pool.push(d);
  }
  const N = pool.length;
  const obrigatoria = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (fixasSet.has(pool[i])) obrigatoria[i] = 1;

  /* proxObrig[i] = índice da próxima dezena obrigatória em pool[i..]. A
     busca nunca pode pular por cima de uma obrigatória. */
  const proxObrig = new Int32Array(N + 1).fill(N);
  for (let i = N - 1; i >= 0; i--) proxObrig[i] = obrigatoria[i] ? i : proxObrig[i + 1];
  const obrigRestantes = new Int32Array(N + 1);
  for (let i = N - 1; i >= 0; i--) obrigRestantes[i] = obrigRestantes[i + 1] + obrigatoria[i];

  const { traco, sufixo, maiorRestante } = tracosDoPool(pool, loteria, contexto.ultimoSorteio);

  /* Quais faixas estão ligadas. `repetidas` só existe se houver um último
     sorteio para comparar — sem ele o filtro é ignorado, como no gerador. */
  const faixas = [];
  for (const nome of ['pares', 'primos', 'moldura', 'repetidas']) {
    const f = filtros[nome];
    if (!f) continue;
    if (nome === 'repetidas' && !contexto.ultimoSorteio) continue;
    faixas.push({ nome, min: f.min ?? null, max: f.max ?? null, t: traco[nome], s: sufixo[nome] });
  }
  const somaMin = filtros.soma?.min ?? null;
  const somaMax = filtros.soma?.max ?? null;
  const maxSeq = filtros.maxSequencia ?? null;

  /* A pontuação de popularidade não se calcula por dezena isolada: ela olha
     o jogo inteiro (progressão aritmética, linha cheia do volante...). Então
     não dá para podar por ela — só para conferir na folha, um jogo de cada
     vez. É de longe o filtro mais caro daqui: medido na Lotofácil inteira,
     a enumeração sai de 0,37 s para 4,5 s — mais de dez vezes. Vale saber
     disso antes de culpar a máquina do usuário pela espera.

     Chamamos `pontuacaoPopularidade` diretamente, e não `motivoRecusa`, para
     não recalcular as faixas que a poda já garantiu — `motivoRecusa` roda
     `caracterizar` duas vezes por jogo, e isso dobrava o custo à toa. É a
     MESMA função que o Gerador usa para este filtro, então não há como as
     duas telas discordarem; e `testes/espaco.teste.mjs` confere a contagem
     inteira contra uma força bruta que usa `motivoRecusa`, justamente para
     que essa equivalência não fique no campo da confiança. */
  const conferirNaFolha = filtros.evitarPopulares === true;
  const limitePop = filtros.limitePopularidade ?? 25;
  const jaSorteados = filtros.evitarJaSorteados ? (contexto.mapaSorteados ?? null) : null;

  /* --- estado da busca --- */
  const jogo = new Int32Array(tamanho);
  const resLo = new Uint32Array(K);
  const resHi = new Uint32Array(K);
  let total = 0;          // quantos passaram em tudo
  let visitados = 0;      // nós abertos, para a barra de progresso
  let guardados = 0;
  let recusasFolha = 0;
  let parou = false;

  /* Gerador reproduzível: com semente, os testes conferem sempre a mesma
     amostra; sem ela, Math.random. */
  let semente = opcoes.semente ?? null;
  const aleatorio = semente == null
    ? Math.random
    : () => {
        semente = (semente * 1664525 + 1013904223) >>> 0;
        return semente / 4294967296;
      };

  const contadorCorrente = new Int32Array(faixas.length);

  function aceitar(mascaraLo, mascaraHi) {
    total++;
    if (guardados < K) {
      resLo[guardados] = mascaraLo;
      resHi[guardados] = mascaraHi;
      guardados++;
    } else {
      /* Algoritmo R: o i-ésimo item entra com probabilidade K/i, e o que
         sai é escolhido uniformemente. Mantém o reservatório uniforme
         sobre tudo o que já passou, sem saber o total de antemão. */
      const j = Math.floor(aleatorio() * total);
      if (j < K) { resLo[j] = mascaraLo; resHi[j] = mascaraHi; }
    }
  }

  function dfs(i, idx, soma, seqAtual, mascLo, mascHi) {
    if (parou) return;
    if (i === tamanho) {
      /* Filtros que só o jogo inteiro responde. */
      if (jaSorteados) {
        const his = jaSorteados.get(mascLo);
        if (his !== undefined && his.includes(mascHi)) { recusasFolha++; return; }
      }
      if (conferirNaFolha) {
        if (pontuacaoPopularidade(Array.from(jogo), loteria) > limitePop) {
          recusasFolha++;
          return;
        }
      }
      aceitar(mascLo, mascHi);
      return;
    }

    const restam = tamanho - i;
    /* Não dá para pular por cima de uma dezena obrigatória. */
    const limite = Math.min(proxObrig[idx], N - restam);

    for (let j = idx; j <= limite; j++) {
      if ((visitados++ & 0x3ffff) === 0) {
        if (cancelado && cancelado()) { parou = true; return; }
        if (aoProgredir) aoProgredir(visitados, total);
      }

      /* Ainda cabem todas as obrigatórias que faltam? */
      if (obrigRestantes[j] > restam) break;

      const d = pool[j];
      const s2 = soma + d;

      /* --- poda da soma ---
         A menor soma possível para o resto são as (restam-1) dezenas
         imediatamente seguintes; se nem assim cabe no teto, nenhuma
         escolha maior cabe, e o laço inteiro morre (o pool é crescente). */
      if (somaMax != null) {
        let menor = 0;
        for (let k = 1; k < restam; k++) menor += pool[j + k];
        if (s2 + menor > somaMax) break;
      }
      if (somaMin != null) {
        /* A maior soma possível para o resto são as (restam-1) últimas. */
        const maior = maiorRestante[N - (restam - 1)];
        if (s2 + maior < somaMin) continue;
      }

      /* --- poda das faixas por traço --- */
      let corta = false;
      for (let f = 0; f < faixas.length; f++) {
        const fx = faixas[f];
        const v = contadorCorrente[f] + fx.t[j];
        if (fx.max != null && v > fx.max) { corta = true; break; }
        /* Quantas ainda posso somar daqui para frente, no melhor caso? */
        if (fx.min != null) {
          const aindaPossivel = Math.min(restam - 1, fx.s[j + 1]);
          if (v + aindaPossivel < fx.min) { corta = true; break; }
        }
      }
      if (corta) continue;

      /* --- poda das consecutivas --- */
      let seq2 = 1;
      if (i > 0 && jogo[i - 1] === d - 1) seq2 = seqAtual + 1;
      if (maxSeq != null && seq2 > maxSeq) continue;

      /* desce */
      jogo[i] = d;
      for (let f = 0; f < faixas.length; f++) contadorCorrente[f] += faixas[f].t[j];
      if (j < 32) dfs(i + 1, j + 1, s2, seq2, mascLo | (1 << j), mascHi);
      else dfs(i + 1, j + 1, s2, seq2, mascLo, mascHi | (1 << (j - 32)));
      for (let f = 0; f < faixas.length; f++) contadorCorrente[f] -= faixas[f].t[j];
      if (parou) return;
    }
  }

  dfs(0, 0, 0, 0, 0, 0);

  return {
    total,
    bruto: via.bruto,
    fracao: via.bruto ? total / via.bruto : 0,
    exata: total <= K && !parou,
    amostra: { lo: resLo.subarray(0, guardados), hi: resHi.subarray(0, guardados), n: guardados },
    pool,
    tamanho,
    visitados,
    recusasFolha,
    cancelado: parou,
    ms: Date.now() - t0,
  };
}

/**
 * Mapa das combinações já sorteadas, na forma que a busca consulta sem
 * alocar nada na folha: máscara baixa -> lista de máscaras altas.
 *
 * Só entram sorteios do MESMO tamanho do bilhete — um sorteio de 15
 * dezenas nunca é igual a um bilhete de 18, e comparar os dois só
 * gastaria tempo.
 */
export function mapaSorteados(concursos, loteria, tamanho) {
  const m = new Map();
  for (const c of concursos) {
    if (!c.dezenas || c.dezenas.length !== tamanho) continue;
    let lo = 0, hi = 0;
    let fora = false;
    for (const d of c.dezenas) {
      const j = d - loteria.min;
      if (j < 0 || j >= MAX_UNIVERSO) { fora = true; break; }
      if (j < 32) lo |= 1 << j; else hi |= 1 << (j - 32);
    }
    if (fora) continue;
    lo >>>= 0; hi >>>= 0;
    const lista = m.get(lo);
    if (lista) { if (!lista.includes(hi)) lista.push(hi); }
    else m.set(lo, [hi]);
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* A linha teórica — exata, sem simulação                              */
/* ------------------------------------------------------------------ */

/**
 * Distribuição hipergeométrica de acertos de UM bilhete qualquer.
 *
 * Vale para qualquer bilhete do universo, filtrado ou não, porque não
 * depende de quais dezenas ele tem — só de quantas. É esta a linha contra
 * a qual todo resultado filtrado é comparado, e ela sai de fórmula
 * fechada: não tem amostragem, não tem ruído, não tem margem de erro.
 */
export function baselineTeorico(loteria, tamanho) {
  const u = loteria.universo;
  const s = loteria.sorteadas;
  const total = combinacoes(u, s);

  const p = new Map();
  let media = 0;
  const kMax = Math.min(tamanho, s);
  for (let k = 0; k <= kMax; k++) {
    const casos = combinacoes(tamanho, k) * combinacoes(u - tamanho, s - k);
    const prob = casos / total;
    if (prob > 0) { p.set(k, prob); media += k * prob; }
  }

  const faixasSet = new Set(loteria.faixas ?? []);
  let pPremiado = 0;
  for (const [k, prob] of p) if (faixasSet.has(k)) pPremiado += prob;

  return { p, media, pPremiado, tamanho };
}

/**
 * Retorno esperado, em reais, de UM bilhete qualquer num concurso — a
 * contrapartida financeira do baseline, também em forma fechada.
 *
 * Só soma faixas com valor que é FATO (rateio apurado ou fixo por
 * regulamento). Faixa acumulada não entra: ali o valor real teria sido o
 * acumulado, que a Caixa não publica por bilhete. Somar zero faria a linha
 * teórica desabar justamente nos concursos do prêmio máximo — o mesmo erro
 * que a Retrospectiva já pagou uma vez.
 */
export function retornoEsperadoTeorico(base, loteria, rateio, estimados = {}) {
  let valorTotal = 0;
  let acumuladas = 0;
  for (const [k, prob] of base.p) {
    if (!(loteria.faixas ?? []).includes(k)) continue;
    const { valor, fonte } = valorDaFaixa(loteria, k, rateio, estimados);
    if (fonte === 'acumulou') { acumuladas += prob; continue; }
    if (!valor) continue;
    if (fonte === 'apurado' || fonte === 'fixo') valorTotal += valor * prob;
  }
  return { valor: valorTotal, acumuladas };
}

/* ------------------------------------------------------------------ */
/* Medição contra a história real                                      */
/* ------------------------------------------------------------------ */

/**
 * Passa a amostra do espaço filtrado por cada concurso e mede.
 *
 * Devolve os números POR CONCURSO, não só as médias. É o que permite o
 * bootstrap depois — sem a série por concurso não há como dizer se uma
 * diferença é sinal ou é o ruído dos 3.775 sorteios que existiram.
 */
export function medir(amostra, concursos, loteria, opcoes = {}) {
  const t0 = Date.now();
  const { lo, hi, n } = amostra;
  if (!n) throw new Error('Amostra vazia — nenhum bilhete passou nos filtros.');
  if (!concursos.length) throw new Error('A base de resultados está vazia.');

  const tamanho = opcoes.tamanho ?? loteria.marcarMin;
  const base = baselineTeorico(loteria, tamanho);
  const rateios = opcoes.rateios ?? {};
  const estimados = opcoes.estimados ?? {};
  const faixasSet = new Set(loteria.faixas ?? []);
  const aoProgredir = opcoes.aoProgredir ?? null;

  /* Valor de cada faixa, por concurso, resolvido UMA vez — não uma vez
     por bilhete. Com 50 mil bilhetes × 3.775 concursos, resolver dentro
     do laço seria 190 milhões de chamadas para 5 valores distintos. */
  const histTotal = new Float64Array(loteria.sorteadas + 1);

  const porConcurso = new Array(concursos.length);
  let semRateio = 0;
  let acumuladasFiltrado = 0;

  for (let c = 0; c < concursos.length; c++) {
    const dz = concursos[c].dezenas;
    let dLo = 0, dHi = 0;
    for (const d of dz) {
      const j = d - loteria.min;
      if (j < 32) dLo |= 1 << j; else dHi |= 1 << (j - 32);
    }
    dLo >>>= 0; dHi >>>= 0;

    const rateio = rateios[concursos[c].numero] ?? null;
    if (!rateio) semRateio++;

    /* tabela faixa -> {valor, fonte} deste concurso */
    const valorFaixa = new Float64Array(loteria.sorteadas + 1);
    const acumulou = new Uint8Array(loteria.sorteadas + 1);
    for (const k of loteria.faixas ?? []) {
      const v = valorDaFaixa(loteria, k, rateio, estimados);
      if (v.fonte === 'acumulou') acumulou[k] = 1;
      else if (v.fonte === 'apurado' || v.fonte === 'fixo') valorFaixa[k] = v.valor ?? 0;
    }

    let premiados = 0;
    let somaAcertos = 0;
    let retorno = 0;
    let acumuladas = 0;
    const hist = new Float64Array(loteria.sorteadas + 1);

    for (let i = 0; i < n; i++) {
      const k = bits(lo[i] & dLo) + bits(hi[i] & dHi);
      hist[k]++;
      somaAcertos += k;
      if (faixasSet.has(k)) {
        premiados++;
        if (acumulou[k]) acumuladas++;
        else retorno += valorFaixa[k];
      }
    }
    for (let k = 0; k < hist.length; k++) histTotal[k] += hist[k];
    acumuladasFiltrado += acumuladas;

    /* A linha teórica para ESTE concurso, com os valores deste concurso. */
    const teo = retornoEsperadoTeorico(base, loteria, rateio, estimados);

    porConcurso[c] = {
      numero: concursos[c].numero,
      mediaAcertos: somaAcertos / n,
      pctPremiado: premiados / n,
      retornoPorBilhete: retorno / n,
      acumuladas: acumuladas / n,
      teoricoPctPremiado: base.pPremiado,
      teoricoRetornoPorBilhete: teo.valor,
    };

    if (aoProgredir && (c & 0xff) === 0) aoProgredir(c, concursos.length);
  }

  const nc = concursos.length;
  const soma = (fn) => porConcurso.reduce((s, l) => s + fn(l), 0);

  return {
    concursos: nc,
    primeiro: concursos[0].numero,
    ultimo: concursos[nc - 1].numero,
    bilhetesMedidos: n,

    /* Distribuição de acertos observada sobre a amostra × concursos. */
    distribuicao: Array.from(histTotal, (v, k) => ({
      acertos: k,
      pct: v / (n * nc),
      teorico: base.p.get(k) ?? 0,
    })).filter((x) => x.pct > 0 || x.teorico > 0),

    filtrado: {
      mediaAcertos: soma((l) => l.mediaAcertos) / nc,
      pctPremiado: soma((l) => l.pctPremiado) / nc,
      retornoPorBilhete: soma((l) => l.retornoPorBilhete) / nc,
    },
    teorico: {
      mediaAcertos: base.media,
      pctPremiado: base.pPremiado,
      retornoPorBilhete: soma((l) => l.teoricoRetornoPorBilhete) / nc,
    },

    porConcurso,
    concursosSemRateio: semRateio,
    /* Faixas batidas em concurso que acumulou: o retorno medido é um PISO,
       não um teto, exatamente como na Retrospectiva. */
    acumuladasPorBilhete: acumuladasFiltrado / (n * nc),
    ms: Date.now() - t0,
  };
}

/* ------------------------------------------------------------------ */
/* Sinal ou ruído — o veredito                                         */
/* ------------------------------------------------------------------ */

/**
 * Intervalo de confiança para a diferença entre o filtrado e o teórico,
 * por reamostragem dos CONCURSOS.
 *
 * A escolha de reamostrar concursos, e não bilhetes, é o ponto central e
 * vale explicar. Bilhete não é a fonte de incerteza aqui: a teoria dá o
 * valor exato para qualquer bilhete. A incerteza vem de só existirem
 * ~3.775 sorteios na história — uma amostra finita de um processo
 * aleatório. Reamostrar bilhetes daria um intervalo apertadíssimo e
 * falso, que declararia "sinal" em cima de puro acaso.
 *
 * Se o intervalo contém zero, a diferença observada é indistinguível de
 * ruído. Não é "quase lá", não é "tendência": é indistinguível.
 */
export function bootstrap(porConcurso, opcoes = {}) {
  const R = opcoes.rodadas ?? 400;
  const nc = porConcurso.length;
  let semente = opcoes.semente ?? 20260831;
  const rnd = () => {
    semente = (semente * 1664525 + 1013904223) >>> 0;
    return semente / 4294967296;
  };

  const difPct = new Float64Array(nc);
  const difRet = new Float64Array(nc);
  for (let i = 0; i < nc; i++) {
    difPct[i] = porConcurso[i].pctPremiado - porConcurso[i].teoricoPctPremiado;
    difRet[i] = porConcurso[i].retornoPorBilhete - porConcurso[i].teoricoRetornoPorBilhete;
  }

  const amostrasPct = new Float64Array(R);
  const amostrasRet = new Float64Array(R);
  for (let r = 0; r < R; r++) {
    let sp = 0, sr = 0;
    for (let i = 0; i < nc; i++) {
      const j = Math.floor(rnd() * nc);
      sp += difPct[j];
      sr += difRet[j];
    }
    amostrasPct[r] = sp / nc;
    amostrasRet[r] = sr / nc;
  }

  const intervalo = (arr) => {
    const s = Array.from(arr).sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
    const lo = q(0.025);
    const hi = q(0.975);
    return { lo, hi, contemZero: lo <= 0 && hi >= 0 };
  };

  const media = (arr) => Array.from(arr).reduce((s, v) => s + v, 0) / arr.length;

  return {
    rodadas: R,
    pctPremiado: { diferenca: media(amostrasPct), ...intervalo(amostrasPct) },
    retorno: { diferenca: media(amostrasRet), ...intervalo(amostrasRet) },
  };
}

/**
 * O veredito em português, que é o que a tela mostra em cima de tudo.
 *
 * Escrito para ser lido por quem vai gastar dinheiro com a resposta, e
 * não para agradar: quando a diferença está dentro do ruído, o texto diz
 * isso com todas as letras, sem "porém" nem "mas note que".
 */
export function veredito(medicao, ic, loteria) {
  const d = ic.pctPremiado;
  const pp = (v) => (v * 100).toFixed(3).replace('.', ',');

  const acertos =
    `Média de acertos: ${medicao.filtrado.mediaAcertos.toFixed(4).replace('.', ',')} ` +
    `no espaço filtrado, ${medicao.teorico.mediaAcertos.toFixed(4).replace('.', ',')} ` +
    `no espaço inteiro. São iguais por teorema, não por coincidência — ` +
    `nenhum filtro pode mudar esse número.`;

  const premio = d.contemZero
    ? `A diferença na taxa de prêmio (${pp(d.diferenca)} pontos percentuais) está ` +
      `DENTRO do ruído: o intervalo de 95% vai de ${pp(d.lo)} a ${pp(d.hi)} e contém zero. ` +
      `Com ${medicao.concursos} concursos, este filtro é indistinguível de não filtrar.`
    : `A diferença na taxa de prêmio (${pp(d.diferenca)} pontos percentuais) ficou FORA ` +
      `do ruído (intervalo de 95%: ${pp(d.lo)} a ${pp(d.hi)}). Cuidado antes de comemorar: ` +
      `se estes filtros foram calibrados nesta mesma história, o resultado é esperado por ` +
      `construção, não é descoberta. O teste honesto é medir num período que você não usou ` +
      `para escolher as faixas.`;

  const r = ic.retorno;
  const dinheiro = r.contemZero
    ? `No dinheiro a conclusão é a mesma: a diferença de retorno por bilhete não se ` +
      `distingue de zero.`
    : `No dinheiro há diferença mensurável: ${r.diferenca >= 0 ? '+' : ''}` +
      `${r.diferenca.toFixed(4).replace('.', ',')} por bilhete por concurso. ` +
      `Este é o efeito que pode ser real — o prêmio é rateado, e fugir de padrão ` +
      `popular muda quanto você leva, não se você leva.`;

  return {
    dentroDoRuido: d.contemZero,
    acertos,
    premio,
    dinheiro,
    ressalva:
      medicao.acumuladasPorBilhete > 0
        ? `O retorno medido é um PISO: ${(medicao.acumuladasPorBilhete * 100).toFixed(2)
            .replace('.', ',')}% dos bilhetes bateram uma faixa que acumulou, ` +
          `cujo valor a Caixa não publica por bilhete.`
        : null,
  };
}
