/**
 * config.js — Definições das loterias e constantes globais.
 *
 * Cada loteria é descrita por um objeto declarativo. Adicionar uma nova
 * modalidade (Quina, Dupla Sena, Dia de Sorte...) é só acrescentar uma
 * entrada aqui — o resto do sistema lê tudo daqui.
 */

export const APP = {
  nome: 'Loterias da Sorte',
  versao: '1.0.0',
  // FONTE DE RESERVA — não é mais a principal.
  //
  // Este espelho se anuncia como atualizado diariamente, e por um tempo foi.
  // Quando fomos usar, estava parado no concurso 3246 da Lotofácil: mais de
  // 500 concursos e quase dois anos de atraso, sem nenhum aviso.
  //
  // A fonte principal hoje é a própria Caixa, via Edge Function
  // (netlify/edge-functions/loterias.js). Isto aqui só entra se o proxy não
  // estiver no ar, e o sistema avisa quando isso acontece.
  cdnBase: 'https://raw.githubusercontent.com/guilhermeasn/loteria.json/master/data',
  cdnFallback: 'https://cdn.jsdelivr.net/gh/guilhermeasn/loteria.json@master/data',
};

/** Números primos até 100 — usados nos filtros de todas as modalidades. */
export const PRIMOS = new Set([
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47,
  53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
]);

/**
 * Fibonacci até 100 — filtro opcional, mais curiosidade que estatística.
 */
export const FIBONACCI = new Set([1, 2, 3, 5, 8, 13, 21, 34, 55, 89]);

export const LOTERIAS = {
  lotofacil: {
    id: 'lotofacil',
    nome: 'Lotofácil',
    arquivo: 'lotofacil',
    // Nome da modalidade na API oficial da Caixa (via nosso proxy).
    apiCaixa: 'lotofacil',
    // Sorteia de segunda a sábado. Mais de 10 dias sem concurso novo
    // significa que a fonte parou, não que a Caixa parou.
    maxDiasSemSorteio: 10,
    cor: '#930089',
    // Universo de dezenas: 1..25
    min: 1,
    max: 25,
    universo: 25,
    // Dezenas sorteadas por concurso
    sorteadas: 15,
    // Quantas dezenas o apostador pode marcar
    marcarMin: 15,
    marcarMax: 20,
    // Faixas premiadas (nº de acertos que paga algo)
    faixas: [11, 12, 13, 14, 15],
    // Prêmio por faixa. `fixo: true` são valores garantidos por regulamento
    // (conferidos no portal da Caixa). `fixo: false` é rateio: varia a cada
    // concurso conforme arrecadação e número de ganhadores — o valor aqui é
    // só um chute inicial, para o usuário substituir pelo que fizer sentido.
    premios: {
      11: { valor: 7.0, fixo: true },
      12: { valor: 14.0, fixo: true },
      13: { valor: 35.0, fixo: true },
      14: { valor: 0, fixo: false },
      15: { valor: 0, fixo: false },
    },
    // Preço da aposta simples (editável em Configurações)
    precoBase: 3.5,
    // Grade visual: 5 colunas x 5 linhas
    grade: { colunas: 5, linhas: 5 },
    // Fechamentos viáveis: C(22,15) = 170.544 cenários no pior caso
    fechamentoDisponivel: true,
    fechamentoMaxDezenas: 22,
    padding: 2,
  },

  megasena: {
    id: 'megasena',
    nome: 'Mega-Sena',
    arquivo: 'megasena',
    apiCaixa: 'megasena',
    maxDiasSemSorteio: 12,
    cor: '#209869',
    min: 1,
    max: 60,
    universo: 60,
    sorteadas: 6,
    marcarMin: 6,
    marcarMax: 20,
    faixas: [4, 5, 6],
    // Na Mega-Sena TODAS as faixas são rateio — não existe prêmio fixo.
    premios: {
      4: { valor: 0, fixo: false },
      5: { valor: 0, fixo: false },
      6: { valor: 0, fixo: false },
    },
    precoBase: 6.0,
    grade: { colunas: 10, linhas: 6 },
    // C(24,6) = 134.596 cenários — pesado, mas com bitmask a verificação
    // completa roda em menos de um segundo.
    fechamentoDisponivel: true,
    fechamentoMaxDezenas: 24,
    padding: 2,
  },

  lotomania: {
    id: 'lotomania',
    nome: 'Lotomania',
    arquivo: 'lotomania',
    apiCaixa: 'lotomania',
    maxDiasSemSorteio: 12,
    cor: '#F78100',
    /* Laranja é vizinho do amarelo `--alerta` usado para marcar as dezenas
       repetidas do concurso anterior: sem um fio escuro entre os dois, a
       borda desaparece na célula marcada. Nas outras modalidades (magenta,
       verde) o contraste já é grande e o fio não é necessário. */
    marcaPrecisaSeparacao: true,
    // Universo 0..99 — única modalidade que usa o zero
    min: 0,
    max: 99,
    universo: 100,
    sorteadas: 20,
    // Na Lotomania você marca sempre 50 dezenas
    marcarMin: 50,
    marcarMax: 50,
    // Atenção: 0 acertos também é faixa premiada
    faixas: [0, 15, 16, 17, 18, 19, 20],
    // Lotomania também é 100% rateio.
    premios: {
      0: { valor: 0, fixo: false },
      15: { valor: 0, fixo: false },
      16: { valor: 0, fixo: false },
      17: { valor: 0, fixo: false },
      18: { valor: 0, fixo: false },
      19: { valor: 0, fixo: false },
      20: { valor: 0, fixo: false },
    },
    precoBase: 3.0,
    grade: { colunas: 10, linhas: 10 },
    // C(100,50) é astronômico — fechamento com garantia não é viável aqui.
    fechamentoDisponivel: false,
    fechamentoMaxDezenas: 0,
    padding: 2,
  },
};

/** Lista ordenada para os menus. */
export const LISTA_LOTERIAS = Object.values(LOTERIAS);

/** Retorna o array completo de dezenas de uma loteria. */
export function universoDe(loteria) {
  const out = [];
  for (let n = loteria.min; n <= loteria.max; n++) out.push(n);
  return out;
}

/** Formata uma dezena com o zero à esquerda (2 -> "02"). */
export function fmt(n, loteria) {
  return String(n).padStart(loteria?.padding ?? 2, '0');
}

/** Formata moeda em real. */
export function brl(v) {
  return (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
