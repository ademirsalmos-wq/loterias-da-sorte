/**
 * generator.js — Gerador de bilhetes com filtros.
 *
 * O que o filtro faz e o que não faz:
 *
 *  NÃO FAZ: aumentar a probabilidade de um jogo específico ser sorteado.
 *  Toda combinação tem exatamente a mesma chance, sempre. Um jogo com soma
 *  190 e 8 pares tem a mesmíssima probabilidade de sair que 1-2-3-4-5-6.
 *
 *  FAZ: (1) concentrar o seu dinheiro em combinações que se parecem com o
 *  que historicamente é sorteado — o que não muda a chance de UM jogo, mas
 *  evita que você gaste em jogos com perfil que quase nunca apareceu;
 *  (2) fugir de padrões que MUITA gente joga, o que não muda a chance de
 *  ganhar mas muda quanto você leva se ganhar, porque o prêmio é rateado.
 *
 * O item (2) é o único ganho financeiro real e mensurável deste módulo.
 */

import { caracterizar } from './stats.js';
import { universoDe } from './config.js';

/* ------------------------------------------------------------------ */
/* Popularidade — o quanto um jogo "parece" com o que o povo marca      */
/* ------------------------------------------------------------------ */

/**
 * Pontuação 0–100. Quanto MAIOR, mais gente provavelmente joga algo
 * parecido, e mais você divide o prêmio se ganhar.
 */
export function pontuacaoPopularidade(dezenas, loteria) {
  const k = caracterizar(dezenas, loteria);
  const n = dezenas.length;
  let p = 0;

  // 1. Aniversários: quase todo apostador casual marca datas (1 a 31).
  //    Um jogo inteiramente dentro de 1–31 compete com milhares.
  if (loteria.max > 31) {
    const dentroDatas = dezenas.filter((d) => d <= 31).length;
    const frac = dentroDatas / n;
    if (frac === 1) p += 35;
    else if (frac >= 0.85) p += 22;
    else if (frac >= 0.7) p += 10;
  }

  // 2. Sequências longas (1-2-3-4-5-6 e primos irmãos).
  if (k.maiorSequencia >= 6) p += 30;
  else if (k.maiorSequencia >= 4) p += 15;
  else if (k.maiorSequencia === 3) p += 5;

  // 3. Progressão aritmética exata (5-10-15-20-25-30).
  if (n >= 4) {
    const passo = k.dezenas[1] - k.dezenas[0];
    let pa = true;
    for (let i = 2; i < n; i++) {
      if (k.dezenas[i] - k.dezenas[i - 1] !== passo) { pa = false; break; }
    }
    if (pa) p += 30;
  }

  // 4. Todos múltiplos de um mesmo número (5-10-15-20...).
  for (const m of [3, 5, 7, 10]) {
    if (dezenas.every((d) => d % m === 0)) { p += 20; break; }
  }

  // 5. Uma linha ou coluna inteira da grade (o "risco reto" do volante).
  const linhaCheia = k.linhas.some((v) => v === loteria.grade.colunas);
  const colunaCheia = k.colunas.some((v) => v === loteria.grade.linhas);
  if (linhaCheia || colunaCheia) p += 18;

  // 6. Extremos de paridade — "só par" / "só ímpar" é escolha consciente
  //    e comum de apostador iniciante.
  if (k.pares === 0 || k.impares === 0) p += 15;

  // 7. Números "da sorte" clássicos concentrados (7, 13, 17, 21).
  const sorte = [7, 13, 17, 21, 23].filter((d) => dezenas.includes(d)).length;
  if (sorte >= 4) p += 8;

  return Math.min(100, p);
}

/* ------------------------------------------------------------------ */
/* Filtros                                                             */
/* ------------------------------------------------------------------ */

export function filtrosPadrao(loteria) {
  return {
    dezenasPorJogo: loteria.marcarMin,
    fixas: [],
    excluidas: [],
    soma: null,          // {min, max}
    pares: null,         // {min, max}
    primos: null,        // {min, max}
    moldura: null,       // {min, max}
    repetidas: null,     // {min, max} em relação ao último concurso
    maxSequencia: null,  // número máximo de dezenas consecutivas
    evitarPopulares: true,
    limitePopularidade: 25,
    // Evita gerar um jogo idêntico a algum já sorteado na história.
    evitarJaSorteados: true,
    // Nº máximo de dezenas em comum entre dois bilhetes gerados.
    // Menor = mais espalhado = cobre mais terreno.
    sobreposicaoMax: null,
  };
}

/** Verifica se um jogo passa em todos os filtros. Devolve null ou o motivo da recusa. */
export function motivoRecusa(dezenas, loteria, filtros, contexto = {}) {
  const k = caracterizar(dezenas, loteria, contexto.ultimoSorteio ?? null);

  const faixa = (valor, f, nome) => {
    if (!f) return null;
    if (f.min != null && valor < f.min) return `${nome} abaixo da faixa`;
    if (f.max != null && valor > f.max) return `${nome} acima da faixa`;
    return null;
  };

  return (
    faixa(k.soma, filtros.soma, 'soma') ||
    faixa(k.pares, filtros.pares, 'pares') ||
    faixa(k.primos, filtros.primos, 'primos') ||
    faixa(k.moldura, filtros.moldura, 'moldura') ||
    (k.repetidas !== null ? faixa(k.repetidas, filtros.repetidas, 'repetidas') : null) ||
    (filtros.maxSequencia != null && k.maiorSequencia > filtros.maxSequencia
      ? 'consecutivas demais'
      : null) ||
    (filtros.evitarPopulares &&
    pontuacaoPopularidade(dezenas, loteria) > filtros.limitePopularidade
      ? 'padrão popular demais (prêmio muito rateado)'
      : null)
  );
}

/* ------------------------------------------------------------------ */
/* Geração                                                             */
/* ------------------------------------------------------------------ */

function sorteioAleatorio(pool, quantidade, fixas) {
  // Fisher–Yates parcial sobre uma cópia do pool.
  const copia = [...pool];
  const restam = quantidade - fixas.length;
  const escolhidas = [...fixas];
  for (let i = 0; i < restam; i++) {
    const j = i + Math.floor(Math.random() * (copia.length - i));
    [copia[i], copia[j]] = [copia[j], copia[i]];
    escolhidas.push(copia[i]);
  }
  return escolhidas.sort((a, b) => a - b);
}

const chaveDe = (dezenas) => dezenas.join('-');

/**
 * Gera N bilhetes que passam nos filtros.
 *
 * @returns {{jogos:number[][], tentativas:number, recusas:Object, incompleto:boolean}}
 */
export function gerar(quantidade, loteria, filtros, contexto = {}) {
  const f = { ...filtrosPadrao(loteria), ...filtros };
  const tamanho = f.dezenasPorJogo;

  const fixas = [...new Set(f.fixas)].filter((d) => d >= loteria.min && d <= loteria.max);
  const excluidas = new Set(f.excluidas);

  for (const d of fixas) {
    if (excluidas.has(d)) {
      throw new Error(`A dezena ${d} está ao mesmo tempo fixa e excluída.`);
    }
  }
  if (fixas.length > tamanho) {
    throw new Error(`Você fixou ${fixas.length} dezenas, mas o jogo tem ${tamanho}.`);
  }

  const pool = universoDe(loteria).filter(
    (d) => !excluidas.has(d) && !fixas.includes(d)
  );
  if (pool.length + fixas.length < tamanho) {
    throw new Error(
      `Sobraram só ${pool.length + fixas.length} dezenas disponíveis para um jogo de ${tamanho}.`
    );
  }

  const jaSorteados = f.evitarJaSorteados && contexto.combinacoesSorteadas
    ? contexto.combinacoesSorteadas
    : null;

  const jogos = [];
  const vistos = new Set();
  const recusas = {};
  const maxTentativas = Math.max(20000, quantidade * 3000);
  let tentativas = 0;

  while (jogos.length < quantidade && tentativas < maxTentativas) {
    tentativas++;
    const jogo = sorteioAleatorio(pool, tamanho, fixas);
    const chave = chaveDe(jogo);

    if (vistos.has(chave)) continue;
    if (jaSorteados && jaSorteados.has(chave)) {
      recusas['jogo já sorteado no passado'] = (recusas['jogo já sorteado no passado'] ?? 0) + 1;
      continue;
    }

    const motivo = motivoRecusa(jogo, loteria, f, contexto);
    if (motivo) {
      recusas[motivo] = (recusas[motivo] ?? 0) + 1;
      continue;
    }

    // Espalhamento: limita quantas dezenas o jogo novo tem em comum com os já aceitos.
    if (f.sobreposicaoMax != null) {
      let conflito = false;
      for (const anterior of jogos) {
        const set = new Set(anterior);
        let comum = 0;
        for (const d of jogo) if (set.has(d)) comum++;
        if (comum > f.sobreposicaoMax) { conflito = true; break; }
      }
      if (conflito) {
        recusas['sobreposição com outro bilhete'] =
          (recusas['sobreposição com outro bilhete'] ?? 0) + 1;
        continue;
      }
    }

    vistos.add(chave);
    jogos.push(jogo);
  }

  return {
    jogos,
    tentativas,
    recusas,
    incompleto: jogos.length < quantidade,
  };
}

/** Conjunto das combinações já sorteadas (para o filtro evitarJaSorteados). */
export function combinacoesSorteadas(concursos) {
  return new Set(concursos.map((c) => chaveDe(c.dezenas)));
}
