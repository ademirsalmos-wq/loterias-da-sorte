/**
 * tickets.js — Gestão e conferência das apostas.
 *
 * Aqui não tem estatística nenhuma: é contabilidade. E é, no fim das
 * contas, a parte do sistema que mais dinheiro economiza — porque mostra
 * preto no branco quanto você gastou e quanto voltou.
 */

import { LOTERIAS, brl } from './config.js';
import { binomial } from './wheel.js';
import { DB } from './db.js';

/**
 * Custo de uma aposta.
 * Marcar mais dezenas do que o mínimo equivale a jogar todas as
 * combinações possíveis: 16 dezenas na Lotofácil = C(16,15) = 16 apostas.
 */
export function custoAposta(loteria, qtdDezenas, precoBase = null) {
  const preco = precoBase ?? loteria.precoBase;
  const combinacoes = binomial(qtdDezenas, loteria.marcarMin);
  return { combinacoes, custo: combinacoes * preco };
}

export function custoLote(loteria, jogos, precoBase = null) {
  return jogos.reduce(
    (acc, j) => acc + custoAposta(loteria, j.length, precoBase).custo,
    0
  );
}

/** Cria os objetos de bilhete a partir de uma lista de jogos gerados. */
export function montarBilhetes(loteriaId, jogos, meta = {}) {
  const loteria = LOTERIAS[loteriaId];
  const grupo = meta.grupo ?? `${loteriaId}-${Date.now()}`;
  const agora = new Date().toISOString();

  return jogos.map((dezenas) => ({
    loteria: loteriaId,
    dezenas: [...dezenas].sort((a, b) => a - b),
    concurso: meta.concurso ?? null,
    origem: meta.origem ?? 'manual',
    grupo,
    rotulo: meta.rotulo ?? '',
    criadoEm: agora,
    custo: custoAposta(loteria, dezenas.length, meta.precoBase).custo,
    conferido: false,
    acertos: null,
    premiado: false,
    premio: 0,
  }));
}

/**
 * Confere um bilhete contra um resultado.
 * Cuidado especial com a Lotomania: 0 acerto também é faixa premiada.
 */
export function conferirBilhete(bilhete, dezenasSorteadas) {
  const loteria = LOTERIAS[bilhete.loteria];
  const sorteadas = new Set(dezenasSorteadas);
  let acertos = 0;
  for (const d of bilhete.dezenas) if (sorteadas.has(d)) acertos++;

  return {
    ...bilhete,
    conferido: true,
    acertos,
    premiado: loteria.faixas.includes(acertos),
  };
}

/**
 * Confere todos os bilhetes contra o histórico local.
 *
 * Os dois motivos de um bilhete não ser conferido são bem diferentes e
 * precisam de respostas diferentes, então voltam separados:
 *
 *  - semConcurso: o bilhete não diz contra qual sorteio conferir. É um
 *    problema que o usuário resolve agora, informando o número.
 *  - aguardando: o concurso está definido, mas ainda não foi sorteado.
 *    Não é problema nenhum — é só esperar.
 *
 * `conferidos` conta quantos bilhetes têm resultado disponível, não quantos
 * mudaram. Reconferir uma lista já conferida não deve reportar zero.
 *
 * @returns {{total, conferidos, premiados, semConcurso, aguardando, bilhetes}}
 */
export async function conferirTodos(loteriaId, historico) {
  const porNumero = new Map(historico.map((c) => [c.numero, c.dezenas]));
  const bilhetes = await DB.listarBilhetes(loteriaId);

  const atualizados = [];
  let conferidos = 0;
  let premiados = 0;
  let semConcurso = 0;
  let aguardando = 0;

  for (const b of bilhetes) {
    if (b.concurso == null) { semConcurso++; continue; }
    const sorteio = porNumero.get(Number(b.concurso));
    if (!sorteio) { aguardando++; continue; }

    const novo = conferirBilhete(b, sorteio);
    // Preserva o valor do prêmio já digitado pelo usuário.
    novo.premio = b.premio ?? 0;
    conferidos++;
    if (novo.premiado) premiados++;
    atualizados.push(novo);
  }

  if (atualizados.length) await DB.salvarBilhetes(atualizados);

  return {
    total: bilhetes.length,
    conferidos,
    premiados,
    semConcurso,
    aguardando,
    // mantido por compatibilidade com chamadas antigas
    pendentes: semConcurso + aguardando,
    bilhetes: atualizados,
  };
}

/** Balanço financeiro por loteria. */
export function balanco(bilhetes) {
  let gasto = 0;
  let retorno = 0;
  let premiadosCount = 0;
  const porFaixa = new Map();

  for (const b of bilhetes) {
    gasto += b.custo ?? 0;
    retorno += b.premio ?? 0;
    if (b.premiado) premiadosCount++;
    if (b.conferido && b.acertos != null) {
      porFaixa.set(b.acertos, (porFaixa.get(b.acertos) ?? 0) + 1);
    }
  }

  return {
    total: bilhetes.length,
    gasto,
    retorno,
    saldo: retorno - gasto,
    roi: gasto > 0 ? ((retorno - gasto) / gasto) * 100 : 0,
    premiados: premiadosCount,
    porFaixa: [...porFaixa.entries()].sort((a, b) => b[0] - a[0]),
    resumo: `${brl(retorno)} de retorno sobre ${brl(gasto)} apostados`,
  };
}

/** Exporta os bilhetes num formato fácil de conferir na lotérica. */
export function exportarTexto(loteriaId, bilhetes) {
  const loteria = LOTERIAS[loteriaId];
  const linhas = [
    `${loteria.nome} — ${bilhetes.length} apostas`,
    bilhetes[0]?.concurso ? `Concurso ${bilhetes[0].concurso}` : '',
    ''.padEnd(40, '-'),
  ].filter(Boolean);

  bilhetes.forEach((b, i) => {
    const nums = b.dezenas.map((d) => String(d).padStart(2, '0')).join(' ');
    linhas.push(`${String(i + 1).padStart(3, ' ')}. ${nums}`);
  });

  linhas.push(''.padEnd(40, '-'));
  linhas.push(`Custo total: ${brl(bilhetes.reduce((a, b) => a + (b.custo ?? 0), 0))}`);
  return linhas.join('\n');
}

/** Exporta em CSV (abre no Excel). */
export function exportarCSV(bilhetes) {
  const cab = [
    'loteria', 'concurso', 'dezenas', 'origem', 'custo',
    'conferido', 'acertos', 'premiado', 'premio', 'criadoEm',
  ];
  const linhas = [cab.join(';')];
  for (const b of bilhetes) {
    linhas.push([
      b.loteria,
      b.concurso ?? '',
      b.dezenas.map((d) => String(d).padStart(2, '0')).join(' '),
      b.origem ?? '',
      String(b.custo ?? 0).replace('.', ','),
      b.conferido ? 'sim' : 'não',
      b.acertos ?? '',
      b.premiado ? 'sim' : 'não',
      String(b.premio ?? 0).replace('.', ','),
      b.criadoEm ?? '',
    ].join(';'));
  }
  return linhas.join('\n');
}
