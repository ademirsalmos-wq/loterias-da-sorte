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

  await p.route('**/servicebus2.caixa.gov.br/**', (r) => r.abort());
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
