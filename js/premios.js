/**
 * premios.js — quanto vale UM bilhete que fez N acertos.
 *
 * Existe como arquivo próprio porque três lugares muito diferentes precisam
 * responder exatamente à mesma pergunta e não podem responder diferente:
 * a conferência dos bilhetes de verdade (tickets.js), a varredura
 * retrospectiva (backtest.js) e a tabela de prêmios da tela (retro-ui.js).
 * Quando essa conta mora em três lugares, ela diverge em três lugares.
 *
 * =====================================================================
 * O ZERO QUE NÃO É ZERO
 *
 * A Caixa devolve, por concurso, quanto cada faixa pagou e quantos
 * ganhadores teve. Quando a faixa acumula, vem assim:
 *
 *     { "descricaoFaixa": "15 acertos", "numeroDeGanhadores": 0,
 *       "valorPremio": 0.0 }
 *
 * Esse `0.0` não quer dizer "quem acertasse 15 levava nada". Quer dizer
 * "ninguém acertou 15". Se um bilhete tivesse acertado, teria levado o
 * acumulado — que costuma ser o maior número da tabela inteira.
 *
 * Ler esse zero como valor faria a Retrospectiva anunciar R$ 0,00 de
 * retorno justamente nos concursos em que o prêmio máximo saiu para o
 * bilhete simulado. Seria o pior tipo de defeito deste projeto: não dá
 * erro, dá número errado com cara de certo.
 *
 * Por isso `ganhadores === 0` devolve fonte `'acumulou'` com valor 0, e não
 * um valor de verdade. Quem chama decide o que fazer — a Retrospectiva cai
 * na estimativa do usuário e diz em quantos concursos isso aconteceu.
 * =====================================================================
 */

/**
 * @typedef {'apurado'|'fixo'|'acumulou'|'estimado'|null} FontePremio
 *
 *  - `apurado`  — o rateio real que a Caixa publicou naquele concurso.
 *                 É fato, não estimativa.
 *  - `fixo`     — valor garantido por regulamento (Lotofácil 11, 12 e 13).
 *  - `acumulou` — a faixa existiu e ninguém levou. Valor desconhecido.
 *  - `estimado` — o palpite que o usuário digitou na tabela de prêmios.
 *  - `null`     — este número de acertos não paga nada nesta modalidade.
 */

/**
 * @param {object} loteria           entrada de LOTERIAS
 * @param {number} acertos
 * @param {object|null} rateio       `{ acertos: [valor, ganhadores] }` do concurso
 * @param {object} [estimados]       `{ acertos: valorEstimado }` do usuário
 * @returns {{valor:number, fonte:FontePremio}}
 */
export function valorDaFaixa(loteria, acertos, rateio, estimados = {}) {
  if (!loteria.faixas.includes(acertos)) return { valor: 0, fonte: null };

  const linha = rateio?.[acertos];
  if (Array.isArray(linha)) {
    const [valor, ganhadores] = linha;
    /* Houve ganhador: este é o valor real daquele concurso, e ele vence até
       a tabela de valores fixos — as faixas fixas da Lotofácil mudaram de
       valor ao longo do tempo (7/14/35 só valem a partir do concurso 3439),
       e o apurado sabe disso concurso a concurso. */
    if (ganhadores > 0) return { valor, fonte: 'apurado' };
  }

  const fixo = loteria.premios?.[acertos];
  if (fixo?.fixo && fixo.valor) return { valor: fixo.valor, fonte: 'fixo' };

  // A faixa existiu no concurso e ninguém levou: valor desconhecido, não zero.
  if (Array.isArray(linha)) return { valor: 0, fonte: 'acumulou' };

  const chute = Number(estimados?.[acertos]) || 0;
  return { valor: chute, fonte: 'estimado' };
}

/** Quantos concursos do intervalo já têm rateio guardado. */
export function coberturaNoIntervalo(concursos, rateios) {
  let com = 0;
  for (const c of concursos) if (rateios?.[c.numero]) com++;
  return { com, total: concursos.length };
}
