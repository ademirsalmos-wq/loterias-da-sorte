/**
 * rotina.js — O ciclo semanal, automatizado.
 *
 * O sistema tinha a matemática certa e o dia a dia errado. O ciclo real de
 * quem aposta é:
 *
 *   gerar → salvar com o concurso → jogar → sai o resultado →
 *   sincronizar → conferir → registrar o prêmio
 *
 * Três desses passos dependiam de o usuário LEMBRAR de clicar em algo. Um
 * sistema que exige disciplina para funcionar é um sistema que se abandona
 * em três semanas. Este módulo tira os três do caminho:
 *
 *  1. sincroniza as bases sozinho quando estão velhas;
 *  2. confere os bilhetes sozinho quando aparece concurso novo;
 *  3. guarda um BOLETIM do que aconteceu, que sobrevive a recarregar a
 *     página e só some quando o usuário diz que viu.
 *
 * O passo que continua sendo dele é o único que só ele sabe: quanto o
 * prêmio pagou de verdade.
 */

import { LOTERIAS, LISTA_LOTERIAS } from './config.js';
import { DB } from './db.js';
import { sincronizar, carregarHistorico } from './api.js';
import { conferirTodos } from './tickets.js';

/**
 * De quantas em quantas horas vale a pena rebaixar o histórico.
 *
 * O espelho é atualizado uma vez por dia e a Lotofácil sorteia de segunda a
 * sábado. Seis horas pega qualquer resultado novo bem antes de o usuário
 * sentir falta, sem baixar meio megabyte a cada vez que ele abre a aba.
 */
export const HORAS_ATE_RESSINCRONIZAR = 6;

const chaveVisto = (id) => `ultimoConcursoVisto:${id}`;
const chaveBoletim = (id) => `boletim:${id}`;

/* ------------------------------------------------------------------ */
/* Sincronização com bom senso                                         */
/* ------------------------------------------------------------------ */

export async function estaVelho(loteriaId, horas = HORAS_ATE_RESSINCRONIZAR) {
  const reg = await DB.lerHistorico(loteriaId);
  if (!reg?.concursos || !reg.atualizadoEm) return true;
  const idade = (Date.now() - new Date(reg.atualizadoEm).getTime()) / 3600000;
  return idade >= horas;
}

/* ------------------------------------------------------------------ */
/* Detector de defasagem                                               */
/* ------------------------------------------------------------------ */

/**
 * A falha mais grave que este sistema teve não foi usar uma fonte morta —
 * foi não perceber. Ficamos meses consumindo dados de 2024 como se fossem de
 * hoje, porque nada no código perguntava "isso aqui ainda faz sentido?".
 *
 * Esta função é essa pergunta. Ela roda toda vez que a base é lida.
 *
 * @returns {{ok, motivo, gravidade, diasParado, ultimo, dataUltimo, fonte}}
 */
export function diagnosticarBase(loteria, historico) {
  const base = {
    ok: true,
    gravidade: 'ok',      // 'ok' | 'atencao' | 'grave'
    motivo: null,
    diasParado: null,
    ultimo: null,
    dataUltimo: null,
    fonte: historico.fonte ?? null,
  };

  if (!historico.concursos?.length) {
    return { ...base, ok: false, gravidade: 'grave', motivo: 'A base está vazia.' };
  }

  const ultimo = historico.concursos[historico.concursos.length - 1];
  base.ultimo = ultimo.numero;
  base.dataUltimo = historico.dataUltimo ?? ultimo.data ?? null;

  /* Sem data não dá para medir defasagem. É o caso do espelho JSON — e foi
     exatamente por isso que os 20 meses passaram despercebidos. Então dado
     sem data não recebe atestado de saúde: recebe ressalva. */
  if (!base.dataUltimo) {
    return {
      ...base,
      ok: false,
      gravidade: 'atencao',
      motivo:
        'A base veio de uma fonte que não informa a data dos concursos, ' +
        'então não é possível saber se está atualizada.',
    };
  }

  const dias = Math.floor(
    (Date.now() - new Date(`${base.dataUltimo}T12:00:00`).getTime()) / 86400000
  );
  base.diasParado = dias;

  const limite = loteria.maxDiasSemSorteio ?? 10;

  if (dias > limite * 3) {
    return {
      ...base,
      ok: false,
      gravidade: 'grave',
      motivo:
        `O último concurso da base é de ${dias} dias atrás. A ${loteria.nome} ` +
        'sorteia várias vezes por semana — a fonte de resultados parou.',
    };
  }
  if (dias > limite) {
    return {
      ...base,
      ok: false,
      gravidade: 'atencao',
      motivo: `Faz ${dias} dias que a base não recebe concurso novo.`,
    };
  }

  return base;
}

/* ------------------------------------------------------------------ */
/* Boletim                                                             */
/* ------------------------------------------------------------------ */

/**
 * Monta o resumo do que os bilhetes do usuário fizeram nos concursos que
 * acabaram de sair. Só entra no boletim concurso em que ele tinha bilhete —
 * avisar "saiu o 3401" para quem não jogou é barulho, não notícia.
 */
async function montarBoletim(loteriaId, numerosNovos, historico) {
  if (!numerosNovos.length) return null;

  const bilhetes = await DB.listarBilhetes(loteriaId);
  if (!bilhetes.length) return null;

  const porNumero = new Map(historico.map((c) => [c.numero, c]));
  const loteria = LOTERIAS[loteriaId];
  const concursos = [];

  for (const n of numerosNovos) {
    const sorteio = porNumero.get(n);
    if (!sorteio) continue;

    const meus = bilhetes.filter((b) => Number(b.concurso) === n);
    if (!meus.length) continue;

    const faixas = new Map();
    let melhor = -1;
    let premiados = 0;

    for (const b of meus) {
      const acertos = b.acertos ?? 0;
      if (acertos > melhor) melhor = acertos;
      if (loteria.faixas.includes(acertos)) {
        premiados++;
        faixas.set(acertos, (faixas.get(acertos) ?? 0) + 1);
      }
    }

    concursos.push({
      numero: n,
      dezenas: sorteio.dezenas,
      bilhetes: meus.length,
      premiados,
      melhor,
      custo: meus.reduce((a, b) => a + (b.custo ?? 0), 0),
      faixas: [...faixas.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([acertos, quantos]) => ({ acertos, quantos })),
    });
  }

  if (!concursos.length) return null;
  return { loteria: loteriaId, concursos, criadoEm: new Date().toISOString() };
}

export async function lerBoletim(loteriaId) {
  return DB.getConfig(chaveBoletim(loteriaId), null);
}

export async function dispensarBoletim(loteriaId) {
  await DB.setConfig(chaveBoletim(loteriaId), null);
}

/* ------------------------------------------------------------------ */
/* A rotina                                                            */
/* ------------------------------------------------------------------ */

/**
 * Roda o ciclo de uma modalidade.
 *
 * @param {string} loteriaId
 * @param {object} opcoes
 * @param {boolean} opcoes.forcar  ignora a idade da base e baixa de qualquer jeito
 * @param {function} opcoes.aoProgredir
 * @returns {{sincronizou, concursosNovos, conferidos, premiados, boletim}}
 */
export async function rodarRotina(loteriaId, opcoes = {}) {
  const resultado = {
    loteria: loteriaId,
    sincronizou: false,
    erroSync: null,
    concursosNovos: [],
    conferidos: 0,
    premiados: 0,
    boletim: null,
    diagnostico: null,
  };

  const antesDoSync = await carregarHistorico(loteriaId);
  const ultimoAntes = antesDoSync.concursos.length
    ? antesDoSync.concursos[antesDoSync.concursos.length - 1].numero
    : 0;

  if (opcoes.forcar || (await estaVelho(loteriaId))) {
    try {
      opcoes.aoProgredir?.(`Buscando resultados da ${LOTERIAS[loteriaId].nome}…`);
      await sincronizar(loteriaId);
      resultado.sincronizou = true;
    } catch (e) {
      // Ficar offline não pode quebrar a abertura do sistema: seguimos com
      // o que já está gravado localmente.
      resultado.erroSync = e.message;
    }
  }

  const historico = await carregarHistorico(loteriaId);
  const { concursos } = historico;
  resultado.diagnostico = diagnosticarBase(LOTERIAS[loteriaId], historico);
  if (!concursos.length) return resultado;

  const ultimoAgora = concursos[concursos.length - 1].numero;

  /* Primeira vez que vemos esta modalidade: marca onde estamos e não gera
     boletim. Avisar "saiu o concurso 3400" para quem acabou de instalar
     seria ruído, não notícia. */
  const visto = await DB.getConfig(chaveVisto(loteriaId), null);
  if (visto == null) {
    await DB.setConfig(chaveVisto(loteriaId), ultimoAgora);
    return resultado;
  }

  const referencia = Math.max(Number(visto), ultimoAntes);
  for (let n = referencia + 1; n <= ultimoAgora; n++) resultado.concursosNovos.push(n);

  // Conferir sempre, não só quando há concurso novo: o usuário pode ter
  // cadastrado bilhetes de um sorteio antigo desde a última visita.
  const conf = await conferirTodos(loteriaId, concursos);
  resultado.conferidos = conf.conferidos;
  resultado.premiados = conf.premiados;

  if (resultado.concursosNovos.length) {
    const boletim = await montarBoletim(loteriaId, resultado.concursosNovos, concursos);
    if (boletim) {
      // Se já havia um boletim não lido, junta os dois em vez de descartar
      // o anterior — quem passou uma semana fora não perde nada.
      const anterior = await lerBoletim(loteriaId);
      if (anterior?.concursos?.length) {
        const jaTem = new Set(boletim.concursos.map((c) => c.numero));
        boletim.concursos = [
          ...anterior.concursos.filter((c) => !jaTem.has(c.numero)),
          ...boletim.concursos,
        ].sort((a, b) => a.numero - b.numero);
      }
      await DB.setConfig(chaveBoletim(loteriaId), boletim);
      resultado.boletim = boletim;
    }
    await DB.setConfig(chaveVisto(loteriaId), ultimoAgora);
  }

  return resultado;
}

/** Roda a rotina para todas as modalidades. */
export async function rodarRotinaCompleta(opcoes = {}) {
  const saidas = [];
  for (const l of LISTA_LOTERIAS) {
    saidas.push(await rodarRotina(l.id, opcoes));
  }
  return saidas;
}

/* ------------------------------------------------------------------ */
/* O que está valendo para os próximos sorteios                        */
/* ------------------------------------------------------------------ */

/**
 * Bilhetes apontando para concursos que ainda não saíram — o que você tem
 * "na mão" agora. É a resposta para "eu já joguei essa semana?".
 */
export async function bilhetesEmAberto(loteriaId, historico) {
  const bilhetes = await DB.listarBilhetes(loteriaId);
  const sorteados = new Set(historico.map((c) => c.numero));

  const porConcurso = new Map();
  let semConcurso = 0;

  for (const b of bilhetes) {
    if (b.concurso == null) { semConcurso++; continue; }
    const n = Number(b.concurso);
    if (sorteados.has(n)) continue;          // já saiu, não está em aberto

    if (!porConcurso.has(n)) porConcurso.set(n, { concurso: n, bilhetes: 0, custo: 0 });
    const alvo = porConcurso.get(n);
    alvo.bilhetes++;
    alvo.custo += b.custo ?? 0;
  }

  return {
    semConcurso,
    concursos: [...porConcurso.values()].sort((a, b) => a.concurso - b.concurso),
    total: [...porConcurso.values()].reduce((a, c) => a + c.bilhetes, 0),
    custo: [...porConcurso.values()].reduce((a, c) => a + c.custo, 0),
  };
}
