/**
 * backtest.js — Varredura retrospectiva.
 *
 * Pega um conjunto de bilhetes e passa ele por TODOS os concursos já
 * realizados, respondendo: em quais concursos esses jogos teriam ido bem?
 *
 * ---------------------------------------------------------------------
 * O que este módulo diz e o que ele NÃO diz
 *
 * DIZ: como esses jogos específicos se comportaram contra o histórico real.
 * Quantas vezes teriam premiado, em quais concursos, qual o melhor acerto,
 * quanto teriam custado e quanto teriam voltado. É medição, não opinião.
 *
 * NÃO DIZ: que eles vão se comportar assim de novo. Um jogo que fez 14
 * pontos no concurso 2.145 não tem chance nenhuma a mais de fazer 14 no
 * próximo. Backtest de loteria não é como backtest de estratégia de bolsa:
 * lá existe a hipótese (discutível) de que padrões se repetem; aqui a
 * independência dos sorteios é fato matemático, não hipótese.
 *
 * Então para que serve? Para duas coisas concretas:
 *  1. Calibrar expectativa. Ver que um conjunto de 30 bilhetes premiaria em
 *     40% dos concursos, quase sempre na faixa de 11 pontos (R$ 7), cura
 *     muita ilusão antes de gastar dinheiro.
 *  2. COMPARAR estratégias sob as mesmas condições. Rodar o seu fechamento e
 *     um conjunto aleatório de mesmo custo contra os mesmos 3.400 concursos
 *     mostra, com número, se a estratégia entrega mais prêmios secundários.
 *     Para fechamentos, entrega mesmo — e dá para ver quanto.
 * ---------------------------------------------------------------------
 */

import { LOTERIAS, universoDe } from './config.js';

/* ------------------------------------------------------------------ */
/* Núcleo da varredura                                                 */
/* ------------------------------------------------------------------ */

/**
 * Conta acertos de cada bilhete em cada concurso.
 *
 * Estratégia de performance: em vez de fazer interseção de Sets (que aloca
 * objetos a cada concurso), marcamos as dezenas sorteadas num Uint8Array
 * reaproveitado e só contamos consultas diretas. Para 3.400 concursos ×
 * 100 bilhetes × 15 dezenas dá ~5 milhões de leituras — roda em milissegundos.
 */
function varrerAcertos(jogos, concursos, loteria, aoProgredir) {
  const marca = new Uint8Array(loteria.max + 1);
  const porConcurso = new Array(concursos.length);
  const faixasSet = new Set(loteria.faixas);

  for (let c = 0; c < concursos.length; c++) {
    const sorteio = concursos[c].dezenas;

    // marca as dezenas deste concurso
    for (let i = 0; i < sorteio.length; i++) marca[sorteio[i]] = 1;

    let melhor = -1;
    let melhorIdx = -1;   // qual bilhete foi o campeão deste concurso
    let premiados = 0;
    const contagemFaixa = new Map();
    let somaAcertos = 0;

    for (let b = 0; b < jogos.length; b++) {
      const jogo = jogos[b];
      let acertos = 0;
      for (let d = 0; d < jogo.length; d++) acertos += marca[jogo[d]];

      somaAcertos += acertos;
      if (acertos > melhor) { melhor = acertos; melhorIdx = b; }
      if (faixasSet.has(acertos)) {
        premiados++;
        contagemFaixa.set(acertos, (contagemFaixa.get(acertos) ?? 0) + 1);
      }
    }

    // limpa as marcas para o próximo concurso
    for (let i = 0; i < sorteio.length; i++) marca[sorteio[i]] = 0;

    porConcurso[c] = {
      numero: concursos[c].numero,
      dezenas: sorteio,
      melhor,
      melhorIdx,
      premiados,
      mediaAcertos: somaAcertos / jogos.length,
      faixas: contagemFaixa,
    };

    if (aoProgredir && c % 500 === 0) aoProgredir(c, concursos.length);
  }

  return porConcurso;
}

/** Quanto este concurso teria pago, dada a tabela de prêmios informada. */
function retornoDoConcurso(linha, premios) {
  let fixo = 0;
  let estimado = 0;
  for (const [acertos, quantidade] of linha.faixas) {
    const p = premios?.[acertos];
    if (!p || !p.valor) continue;
    if (p.fixo) fixo += p.valor * quantidade;
    else estimado += p.valor * quantidade;
  }
  return { fixo, estimado, total: fixo + estimado };
}

/* ------------------------------------------------------------------ */
/* API principal                                                       */
/* ------------------------------------------------------------------ */

/**
 * @param {number[][]} jogos      conjunto de bilhetes (arrays de dezenas)
 * @param {Array<{numero,dezenas}>} concursos  histórico ordenado
 * @param {object} loteria
 * @param {object} opcoes
 * @param {object} opcoes.premios       tabela {acertos: {valor, fixo}}
 * @param {number} opcoes.custoPorConcurso  quanto o conjunto custa por concurso
 * @param {number} opcoes.topN          quantos concursos listar no ranking
 */
export function varrer(jogos, concursos, loteria, opcoes = {}) {
  if (!jogos.length) throw new Error('Nenhum jogo para varrer.');
  if (!concursos.length) throw new Error('A base de resultados está vazia.');

  const premios = opcoes.premios ?? loteria.premios ?? {};
  const topN = opcoes.topN ?? 25;
  const custoPorConcurso = opcoes.custoPorConcurso ?? 0;

  const linhas = varrerAcertos(jogos, concursos, loteria, opcoes.aoProgredir);

  /* --- distribuição do melhor acerto por concurso --- */
  const distMelhor = new Map();
  /* --- quantas vezes cada faixa foi batida (somando bilhetes) --- */
  const totalPorFaixa = new Map();
  /* --- em quantos concursos a faixa apareceu pelo menos uma vez --- */
  const concursosComFaixa = new Map();

  let concursosPremiados = 0;
  let retornoFixo = 0;
  let retornoEstimado = 0;
  let somaMelhor = 0;
  let somaMedia = 0;

  // maior sequência de concursos seguidos sem nenhum prêmio
  let secaAtual = 0;
  let maiorSeca = 0;
  let secaInicio = null;
  let piorSeca = null;

  for (const linha of linhas) {
    distMelhor.set(linha.melhor, (distMelhor.get(linha.melhor) ?? 0) + 1);
    somaMelhor += linha.melhor;
    somaMedia += linha.mediaAcertos;

    for (const [acertos, q] of linha.faixas) {
      totalPorFaixa.set(acertos, (totalPorFaixa.get(acertos) ?? 0) + q);
      concursosComFaixa.set(acertos, (concursosComFaixa.get(acertos) ?? 0) + 1);
    }

    const r = retornoDoConcurso(linha, premios);
    linha.retorno = r;
    retornoFixo += r.fixo;
    retornoEstimado += r.estimado;

    if (linha.premiados > 0) {
      concursosPremiados++;
      if (secaAtual > maiorSeca) {
        maiorSeca = secaAtual;
        piorSeca = { de: secaInicio, ate: linha.numero - 1, tamanho: secaAtual };
      }
      secaAtual = 0;
      secaInicio = null;
    } else {
      if (secaAtual === 0) secaInicio = linha.numero;
      secaAtual++;
    }
  }
  if (secaAtual > maiorSeca) {
    maiorSeca = secaAtual;
    piorSeca = {
      de: secaInicio,
      ate: linhas[linhas.length - 1].numero,
      tamanho: secaAtual,
    };
  }

  /* --- ranking dos melhores concursos --- */
  const melhores = [...linhas]
    .sort(
      (a, b) =>
        b.retorno.total - a.retorno.total ||
        b.melhor - a.melhor ||
        b.premiados - a.premiados ||
        b.numero - a.numero
    )
    .slice(0, topN);

  const total = linhas.length;
  const custoTotal = custoPorConcurso * total;

  return {
    linhas,
    melhores,
    resumo: {
      concursos: total,
      primeiro: linhas[0].numero,
      ultimo: linhas[total - 1].numero,
      bilhetes: jogos.length,

      concursosPremiados,
      pctPremiados: (concursosPremiados / total) * 100,
      // "1 a cada N concursos"
      umACada: concursosPremiados ? Math.round(total / concursosPremiados) : null,

      melhorDeTodos: Math.max(...linhas.map((l) => l.melhor)),
      mediaMelhor: somaMelhor / total,
      mediaPorBilhete: somaMedia / total,

      maiorSeca,
      piorSeca,

      distribuicaoMelhor: [...distMelhor.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([acertos, concursos]) => ({
          acertos,
          concursos,
          pct: (concursos / total) * 100,
        })),

      porFaixa: loteria.faixas
        .map((f) => ({
          acertos: f,
          bilhetesPremiados: totalPorFaixa.get(f) ?? 0,
          concursos: concursosComFaixa.get(f) ?? 0,
          pctConcursos: ((concursosComFaixa.get(f) ?? 0) / total) * 100,
          premio: premios[f] ?? null,
        }))
        .sort((a, b) => b.acertos - a.acertos),
    },
    financeiro: {
      custoPorConcurso,
      custoTotal,
      retornoFixo,
      retornoEstimado,
      retornoTotal: retornoFixo + retornoEstimado,
      saldo: retornoFixo + retornoEstimado - custoTotal,
      roi: custoTotal ? ((retornoFixo + retornoEstimado - custoTotal) / custoTotal) * 100 : 0,
      // Há faixa de rateio sem valor informado? Então o retorno está incompleto.
      faltamValores: loteria.faixas.filter(
        (f) => premios[f] && !premios[f].fixo && !premios[f].valor
      ),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Baseline aleatório                                                  */
/* ------------------------------------------------------------------ */

function jogoAleatorio(pool, tamanho) {
  const c = [...pool];
  const out = [];
  for (let i = 0; i < tamanho; i++) {
    const j = i + Math.floor(Math.random() * (c.length - i));
    [c[i], c[j]] = [c[j], c[i]];
    out.push(c[i]);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Roda a mesma varredura com bilhetes aleatórios de mesmo tamanho e mesma
 * quantidade — ou seja, mesmo custo. É o comparativo justo.
 *
 * Repete `rodadas` vezes e devolve a média, porque uma única amostra
 * aleatória pode dar sorte ou azar e enganar a leitura.
 */
export function compararComAleatorio(jogos, concursos, loteria, opcoes = {}) {
  const rodadas = opcoes.rodadas ?? 5;
  const pool = universoDe(loteria);
  const tamanhos = jogos.map((j) => j.length);

  const amostras = [];
  for (let r = 0; r < rodadas; r++) {
    const aleatorios = tamanhos.map((t) => jogoAleatorio(pool, t));
    amostras.push(varrer(aleatorios, concursos, loteria, { ...opcoes, topN: 1 }));
  }

  const media = (fn) => amostras.reduce((s, a) => s + fn(a), 0) / rodadas;

  return {
    rodadas,
    pctPremiados: media((a) => a.resumo.pctPremiados),
    mediaMelhor: media((a) => a.resumo.mediaMelhor),
    retornoTotal: media((a) => a.financeiro.retornoTotal),
    maiorSeca: media((a) => a.resumo.maiorSeca),
    porFaixa: loteria.faixas
      .map((f) => ({
        acertos: f,
        concursos: media(
          (a) => a.resumo.porFaixa.find((x) => x.acertos === f)?.concursos ?? 0
        ),
      }))
      .sort((a, b) => b.acertos - a.acertos),
  };
}

/* ------------------------------------------------------------------ */
/* Entrada de jogos avulsos                                            */
/* ------------------------------------------------------------------ */

/**
 * Lê jogos colados em texto — um por linha, dezenas separadas por qualquer
 * coisa que não seja dígito.
 */
export function lerJogosDeTexto(texto, loteria) {
  const jogos = [];
  const erros = [];

  texto.split(/\r?\n/).forEach((linha, i) => {
    const bruta = linha.trim();
    if (!bruta) return;

    const nums = [...new Set(bruta.split(/[^0-9]+/).filter(Boolean).map(Number))];
    if (!nums.length) return;

    if (nums.some((d) => d < loteria.min || d > loteria.max)) {
      erros.push(`Linha ${i + 1}: dezena fora do intervalo ${loteria.min}–${loteria.max}.`);
      return;
    }
    if (nums.length < loteria.marcarMin || nums.length > loteria.marcarMax) {
      erros.push(
        `Linha ${i + 1}: ${nums.length} dezenas (a ${loteria.nome} aceita de ` +
          `${loteria.marcarMin} a ${loteria.marcarMax}).`
      );
      return;
    }
    jogos.push(nums.sort((a, b) => a - b));
  });

  return { jogos, erros };
}
