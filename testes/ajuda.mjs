/**
 * ajuda.mjs — o encanamento comum a todos os testes.
 *
 * Duas decisões que valem explicação:
 *
 * 1. O HISTÓRICO É SINTÉTICO. Os testes não baixam nada da Caixa e não
 *    guardam um dump de 3.700 concursos no repositório. Um gerador com
 *    semente fixa produz sempre os mesmos sorteios, então uma falha é
 *    reproduzível e o repositório continua leve. Onde o teste precisa de
 *    um resultado REAL (conferência, prêmios), ele traz o concurso
 *    específico escrito à mão — conferido contra a API oficial.
 *
 * 2. OS TESTES CLICAM. A lição mais cara deste projeto foi descobrir que
 *    apagar um bilhete estava quebrado havia semanas: a camada de dados
 *    estava certa, a tela estava certa, e a ponte entre as duas — um
 *    `Number()` num id que virou UUID — falhava em silêncio. Os testes
 *    chamavam a função, nunca o botão. Aqui, sempre que existir botão,
 *    o teste clica no botão.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORTA = 8123;
export const ENDERECO = `http://localhost:${PORTA}/index.html`;

/* ------------------------------------------------------------------ */
/* Placar                                                              */
/* ------------------------------------------------------------------ */

/* O runner lê isto quando um arquivo estoura no meio: sem ele, um erro
   na verificação nº 24 esconderia as 23 que já tinham passado, e o
   relatório mentiria sobre o tamanho do estrago. */
export let ultimoPlacar = null;

export function placar(nome) {
  const ok = [], falhas = [];
  const p = {
    nome,
    /** @param {string} oQue  @param {boolean} passou  @param {string} [detalhe] */
    confere(oQue, passou, detalhe = '') {
      const linha = `${oQue}${detalhe ? ` — ${detalhe}` : ''}`;
      (passou ? ok : falhas).push(linha);
      console.log(`  ${passou ? '·' : '✗'} ${linha}`);
      return passou;
    },
    resultado() { return { nome, ok: ok.length, falhas }; },
  };
  ultimoPlacar = p;
  return p;
}

/* ------------------------------------------------------------------ */
/* Histórico sintético, determinístico                                 */
/* ------------------------------------------------------------------ */

/** Gerador com semente: mesma semente, mesma sequência, sempre. */
function aleatorio(semente) {
  let s = semente >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sorteio(rnd, min, max, quantas) {
  const pool = [];
  for (let d = min; d <= max; d++) pool.push(d);
  for (let i = 0; i < quantas; i++) {
    const j = i + Math.floor(rnd() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, quantas).sort((a, b) => a - b);
}

const MODALIDADES = {
  lotofacil: { min: 1, max: 25, sorteadas: 15, quantos: 400 },
  megasena:  { min: 1, max: 60, sorteadas: 6,  quantos: 300 },
  lotomania: { min: 0, max: 99, sorteadas: 20, quantos: 300 },
};

/**
 * Monta o espelho que o app consome quando a Caixa está fora do ar.
 * O formato é o mesmo do espelho real: `{ "1": [dezenas], ... }`.
 */
export function historicoFalso(loteria) {
  const m = MODALIDADES[loteria];
  const rnd = aleatorio(loteria.length * 7919 + 42);
  const out = {};
  for (let n = 1; n <= m.quantos; n++) out[n] = sorteio(rnd, m.min, m.max, m.sorteadas);
  return out;
}

/* ------------------------------------------------------------------ */
/* Caixa de mentira, no formato exato da de verdade                    */
/* ------------------------------------------------------------------ */

/**
 * As faixas premiadas de cada modalidade, na ordem em que a Caixa devolve
 * (do maior acerto para o menor, com o zero da Lotomania no fim).
 */
const FAIXAS = {
  lotofacil: [15, 14, 13, 12, 11],
  megasena: [6, 5, 4],
  lotomania: [20, 19, 18, 17, 16, 15, 0],
};

/**
 * Monta `listaRateioPremio` no formato conferido contra a API real em
 * Lotofácil 3774, Mega-Sena 2920 e 1 (1996) e Lotomania 2820 e 1 (1999):
 * `descricaoFaixa` é sempre o texto "N acertos", inclusive "0 acertos".
 *
 * Dois detalhes são reproduzidos de propósito, porque são as armadilhas:
 *
 *  1. A FAIXA MÁXIMA ACUMULA em parte dos concursos — vem com
 *     `numeroDeGanhadores: 0` e `valorPremio: 0.0`. Esse zero não é o valor
 *     do prêmio, é "ninguém levou". Quem ler como valor faz a Retrospectiva
 *     anunciar retorno zero justo onde o prêmio teria sido o maior.
 *  2. As faixas fixas da Lotofácil (11, 12, 13) vêm com o valor de
 *     regulamento, e as demais variam a cada concurso.
 */
export function rateioFalso(loteria, numero) {
  const rnd = aleatorio(numero * 31 + loteria.length);
  const acumulou = numero % 3 === 0;          // 1 em cada 3 concursos

  const fixos = loteria === 'lotofacil' ? { 11: 7, 12: 14, 13: 35 } : {};

  return FAIXAS[loteria].map((acertos, i) => {
    const maxima = i === 0;
    if (maxima && acumulou) {
      return { descricaoFaixa: `${acertos} acertos`, faixa: i + 1,
               numeroDeGanhadores: 0, valorPremio: 0.0 };
    }
    if (fixos[acertos] != null) {
      return { descricaoFaixa: `${acertos} acertos`, faixa: i + 1,
               numeroDeGanhadores: 1000 + numero, valorPremio: fixos[acertos] };
    }
    const valor = Math.round((maxima ? 500000 : 500) * (1 + rnd()) * 100) / 100;
    return { descricaoFaixa: `${acertos} acertos`, faixa: i + 1,
             numeroDeGanhadores: 1 + Math.floor(rnd() * 50), valorPremio: valor };
  });
}

/** Uma resposta completa da Caixa para um concurso do histórico sintético. */
export function respostaCaixaFalsa(loteria, numero) {
  const dezenas = historicoFalso(loteria)[numero];
  if (!dezenas) return null;
  const m = MODALIDADES[loteria];
  return {
    numero,
    listaDezenas: dezenas.map((d) => String(d).padStart(2, '0')),
    dataApuracao: '01/03/2026',
    listaRateioPremio: rateioFalso(loteria, numero),
    tipoJogo: loteria.toUpperCase(),
    numeroConcursoAnterior: numero - 1,
    acumulado: numero % 3 === 0,
    quantos: m.quantos,
  };
}

/* ------------------------------------------------------------------ */
/* Navegador                                                           */
/* ------------------------------------------------------------------ */

/**
 * Abre uma página com a rede controlada: a Caixa é sempre recusada (os
 * testes não dependem de internet nem de geolocalização) e o espelho
 * devolve o histórico sintético.
 *
 * @param {object} [opcoes]
 * @param {{width:number,height:number}} [opcoes.tela]
 * @param {(url:string, init:object) => Promise<{status:number,corpo:string}>} [opcoes.firebase]
 *        quando presente, intercepta as chamadas ao Firebase.
 */
export async function abrirPagina(navegador, opcoes = {}) {
  const ctx = await navegador.newContext(
    opcoes.baixar ? { acceptDownloads: true } : {}
  );
  const p = await ctx.newPage();

  p.erros = [];
  p.on('pageerror', (e) => p.erros.push(`erro de página: ${e.message}`));
  p.on('console', (m) => {
    /* ERR_FAILED é a Caixa sendo recusada de propósito pela rota abaixo. */
    if (m.type() === 'error' && !/ERR_FAILED|Failed to load resource/.test(m.text())) {
      p.erros.push(`console: ${m.text()}`);
    }
  });
  /* Diálogos de confirmação: o teste sempre aceita. */
  p.on('dialog', (d) => d.accept());

  /* Por padrão a Caixa é recusada: a maioria dos testes não deve depender
     dela, e o app cai no espelho. Com `opcoes.caixa`, ela responde — é o
     que os testes de prêmio precisam, porque o rateio só existe ali. */
  if (opcoes.caixa) {
    p.pedidosCaixa = 0;
    await p.route('**/servicebus2.caixa.gov.br/**', (r) => {
      const url = new URL(r.request().url());
      const partes = url.pathname.split('/').filter(Boolean);
      const modalidade = partes[partes.length - (/^\d+$/.test(partes.at(-1)) ? 2 : 1)];
      if (!MODALIDADES[modalidade]) return r.abort();

      const ultimo = MODALIDADES[modalidade].quantos;
      const numero = /^\d+$/.test(partes.at(-1)) ? Number(partes.at(-1)) : ultimo;
      p.pedidosCaixa++;

      const corpo = respostaCaixaFalsa(modalidade, numero);
      if (!corpo) return r.fulfill({ status: 404, body: 'nao existe' });
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(corpo),
      });
    });
  } else {
    await p.route('**/servicebus2.caixa.gov.br/**', (r) => r.abort());
  }
  await p.route('**/loteria.json/**', (r) => {
    const nome = r.request().url().split('/').pop().replace('.json', '');
    if (!MODALIDADES[nome]) return r.abort();
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(historicoFalso(nome)),
    });
  });

  if (opcoes.firebase) {
    await p.exposeFunction('__firebaseFalso', opcoes.firebase);
    await p.addInitScript(() => {
      const real = window.fetch.bind(window);
      window.fetch = async (entrada, init = {}) => {
        const url = typeof entrada === 'string' ? entrada : entrada.url;
        if (!/identitytoolkit|securetoken|firestore\.googleapis/.test(url)) {
          return real(entrada, init);
        }
        const corpo = init.body instanceof URLSearchParams
          ? init.body.toString()
          : (init.body ?? null);
        const r = await window.__firebaseFalso(url, {
          method: init.method, headers: init.headers, body: corpo,
        });
        return new Response(r.corpo, {
          status: r.status, headers: { 'content-type': 'application/json' },
        });
      };
    });
  }

  if (opcoes.tela) await p.setViewportSize(opcoes.tela);
  await p.goto(ENDERECO, { waitUntil: 'domcontentloaded' });
  await esperarPronto(p);
  return p;
}

/**
 * Espera o app terminar a carga inicial.
 *
 * Não é `waitForTimeout` com um número chutado: o teste pergunta ao
 * IndexedDB se o histórico já entrou. Assim o teste não fica lento à toa
 * numa máquina rápida nem instável numa lenta.
 */
export async function esperarPronto(p, limiteMs = 45000) {
  await p.waitForFunction(
    () => document.querySelector('#cardsPainel')?.children.length > 0,
    null,
    { timeout: limiteMs }
  );
  await p.waitForTimeout(300);
}

/**
 * Espera a base de concursos encher.
 *
 * `esperarPronto` só garante que a TELA montou. Com a Caixa de mentira
 * ligada, o app baixa concurso a concurso — centenas de requisições com
 * pausa entre blocos —, e a tela fica pronta muito antes de a base estar
 * completa. Sem esta espera, o teste lê um histórico vazio e falha por um
 * motivo que não tem nada a ver com o que ele queria verificar.
 */
export async function esperarBase(p, loteria, minimo = 1, limiteMs = 90000) {
  /* Laço aqui no Node, e não `waitForFunction`: a condição precisa de
     `await import` e de uma leitura do IndexedDB, ou seja, é assíncrona —
     e uma função assíncrona devolve uma Promise, que o waitForFunction lê
     como valor VERDADEIRO na primeira tentativa. A espera passava na hora,
     sem esperar nada. */
  const fim = Date.now() + limiteMs;
  for (;;) {
    const quantos = await p.evaluate(async (lot) => {
      const { DB } = await import('/js/db.js');
      const h = await DB.lerHistorico(lot);
      return Object.keys(h?.concursos ?? {}).length;
    }, loteria);
    if (quantos >= minimo) return quantos;
    if (Date.now() > fim) {
      throw new Error(`a base de ${loteria} parou em ${quantos}, esperava ${minimo}`);
    }
    await p.waitForTimeout(400);
  }
}

/**
 * Apaga os rateios guardados, mantendo os concursos.
 *
 * É como fica a base de quem já usava o sistema antes desta versão: os
 * sorteios estão lá, os prêmios não. É esse o estado que o download em
 * lote existe para consertar, então é nele que ele tem que ser testado —
 * numa base recém-sincronizada não haveria nada para baixar, porque o
 * rateio vem junto com o resultado.
 */
export async function esquecerRateios(p, loteria) {
  return p.evaluate(async (lot) => {
    const { DB } = await import('/js/db.js');
    const h = await DB.lerHistorico(lot);
    const { rateios, ...resto } = h;
    await DB.salvarHistorico(lot, h.concursos, { ...resto, rateios: {} });
    return Object.keys(h.concursos).length;
  }, loteria);
}

/** Troca de aba pelo clique, como o usuário faz. */
export async function irPara(p, aba) {
  await p.click(`.aba[data-alvo=${aba}]`);
  await p.waitForTimeout(500);
}

/** Troca de modalidade e espera a tela se refazer. */
export async function trocarLoteria(p, id) {
  await p.click(`.chip-loteria[data-id=${id}]`);
  await p.waitForTimeout(1800);
}

/** Cria bilhetes direto no banco — atalho para preparar cenário. */
export async function semearBilhetes(p, loteria, jogos, extra = {}) {
  return p.evaluate(async ([lot, js, ex]) => {
    const { DB } = await import('/js/db.js');
    const { montarBilhetes } = await import('/js/tickets.js');
    const bs = montarBilhetes(lot, js, ex);
    await DB.salvarBilhetes(bs);
    return bs.length;
  }, [loteria, jogos, extra]);
}

/** Quantos bilhetes visíveis existem agora. */
export const contarBilhetes = (p, loteria = null) =>
  p.evaluate(async (l) => {
    const { DB } = await import('/js/db.js');
    return (await DB.listarBilhetes(l)).length;
  }, loteria);

/** Faz a tabela de Meus bilhetes se montar (ela depende dos filtros). */
export async function abrirTabelaDeBilhetes(p) {
  await irPara(p, 'painel');
  await irPara(p, 'bilhetes');
  await p.evaluate(() => {
    const so = document.querySelector('#soPremiados');
    if (so) { so.checked = false; so.dispatchEvent(new Event('change', { bubbles: true })); }
    const f = document.querySelector('#filtroConcurso');
    if (f) { f.value = ''; f.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await p.waitForSelector('#tabelaBilhetes tbody tr', { timeout: 10000 }).catch(() => {});
}

export { chromium, fs, path };
