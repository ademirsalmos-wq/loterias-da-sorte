/**
 * api.js — De onde vêm os resultados.
 *
 * ---------------------------------------------------------------------
 * A LIÇÃO QUE CUSTOU CARO
 *
 * A primeira versão deste arquivo usava um espelho público em JSON que se
 * anunciava como "atualizado todos os dias com Cron Job via GitHub Actions".
 * Era verdade um dia. Quando fomos usar, ele estava parado no concurso 3246
 * da Lotofácil — mais de 500 concursos e quase dois anos atrás. E o sistema
 * consumiu esse dado velho sem reclamar uma única vez.
 *
 * Duas correções vieram daí, e as duas estão neste arquivo:
 *
 *  1. A fonte principal passou a ser a PRÓPRIA CAIXA, através de uma Edge
 *     Function que resolve o CORS (netlify/edge-functions/loterias.js).
 *     Intermediário que pode morrer em silêncio deixou de ser o padrão.
 *
 *  2. Toda sincronização agora devolve a DATA do último concurso, e o
 *     sistema checa se ela faz sentido. Fonte velha vira aviso na tela,
 *     não normalidade silenciosa.
 * ---------------------------------------------------------------------
 */

import { APP, LOTERIAS } from './config.js';
import { DB } from './db.js';

/** Onde mora o proxy. Relativo: funciona publicado e com `netlify dev`. */
export const PROXY_PADRAO = '/api/loterias';

/** Tamanho do lote — precisa bater com o MAX_LOTE da Edge Function. */
const MAX_LOTE = 60;

export async function urlDoProxy() {
  return (await DB.getConfig('fonteProxy', PROXY_PADRAO)) || PROXY_PADRAO;
}

export async function definirProxy(url) {
  await DB.setConfig('fonteProxy', url || PROXY_PADRAO);
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

async function buscarJson(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-cache' });
    if (!r.ok) {
      let detalhe = `HTTP ${r.status}`;
      try {
        const corpo = await r.json();
        if (corpo?.erro) detalhe = corpo.erro;
      } catch { /* resposta não era JSON */ }
      throw new Error(detalhe);
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Junta concursos novos ao que já está gravado, sem perder o antigo. */
async function gravarMesclado(loteriaId, novos, meta) {
  const atual = await DB.lerHistorico(loteriaId);
  const concursos = { ...(atual?.concursos ?? {}) };
  const datas = { ...(atual?.datas ?? {}) };

  for (const c of novos) {
    concursos[c.numero] = c.dezenas;
    if (c.data) datas[c.numero] = c.data;
  }

  const numeros = Object.keys(concursos).map(Number);
  const ultimo = numeros.length ? Math.max(...numeros) : 0;

  await DB.salvarHistorico(loteriaId, concursos, {
    datas,
    ultimo,
    dataUltimo: datas[ultimo] ?? null,
    ...meta,
  });

  return { total: numeros.length, ultimo, dataUltimo: datas[ultimo] ?? null };
}

/* ------------------------------------------------------------------ */
/* Fonte principal: a Caixa, via proxy                                 */
/* ------------------------------------------------------------------ */

/**
 * Sincroniza pela API oficial. Busca só o que falta: se a base já vai até o
 * 3.700 e a Caixa está no 3.773, baixa 73 concursos, não 3.773.
 *
 * @returns {{total, ultimo, dataUltimo, baixados, fonte}}
 */
export async function sincronizarPelaCaixa(loteriaId, onProgresso = () => {}) {
  const loteria = LOTERIAS[loteriaId];
  const modalidade = loteria.apiCaixa ?? loteria.id;
  const base = await urlDoProxy();

  // Sondagem curta: se o proxy não existe (rodando local sem Netlify), o
  // 404 é imediato; se existir mas estiver pendurado, não vale travar a
  // abertura do sistema por 25 segundos esperando.
  onProgresso(`Consultando a Caixa (${loteria.nome})…`);
  const cabeca = await buscarJson(`${base}/${modalidade}`, 8000);
  const ultimoOficial = cabeca?.concursos?.[0]?.numero ?? cabeca?.ultimo;

  if (!Number.isFinite(Number(ultimoOficial))) {
    throw new Error('O proxy respondeu, mas em formato inesperado.');
  }

  const atual = await DB.lerHistorico(loteriaId);
  const jaTemos = atual?.concursos ? Object.keys(atual.concursos).map(Number) : [];
  const ultimoLocal = jaTemos.length ? Math.max(...jaTemos) : 0;

  const novos = [...(cabeca.concursos ?? [])];
  const primeiroFaltando = ultimoLocal + 1;
  const ultimoFaltando = Number(ultimoOficial) - 1;

  let baixados = novos.length;

  if (primeiroFaltando <= ultimoFaltando) {
    const totalFaltando = ultimoFaltando - primeiroFaltando + 1;
    let feitos = 0;

    for (let de = primeiroFaltando; de <= ultimoFaltando; de += MAX_LOTE) {
      const ate = Math.min(de + MAX_LOTE - 1, ultimoFaltando);
      onProgresso(
        `Baixando ${loteria.nome}: ${feitos}/${totalFaltando} concursos…`
      );
      const lote = await buscarJson(`${base}/${modalidade}/lote?de=${de}&ate=${ate}`);
      novos.push(...(lote.concursos ?? []));
      feitos += ate - de + 1;
      baixados += lote.concursos?.length ?? 0;
    }
  }

  const r = await gravarMesclado(loteriaId, novos, {
    origem: `Caixa (proxy ${base})`,
    fonte: 'caixa',
  });

  return { ...r, baixados, fonte: 'caixa' };
}

/* ------------------------------------------------------------------ */
/* Reserva: o espelho em JSON                                          */
/* ------------------------------------------------------------------ */

function normalizarEspelho(bruto, loteria) {
  const out = [];
  for (const [concurso, dezenas] of Object.entries(bruto)) {
    const n = Number(concurso);
    if (!Number.isFinite(n) || !Array.isArray(dezenas)) continue;

    const nums = dezenas
      .map((d) => Number(d))
      .filter((d) => Number.isFinite(d) && d >= loteria.min && d <= loteria.max);

    if (nums.length !== loteria.sorteadas) continue;
    out.push({ numero: n, dezenas: nums.sort((a, b) => a - b), data: null });
  }
  return out;
}

/**
 * Só use como último recurso. O espelho não traz datas e já provou que pode
 * congelar sem avisar — por isso a origem gravada diz "espelho", e o detector
 * de defasagem trata dado sem data com desconfiança.
 */
export async function sincronizarPeloEspelho(loteriaId, onProgresso = () => {}) {
  const loteria = LOTERIAS[loteriaId];
  const urls = [
    `${APP.cdnBase}/${loteria.arquivo}.json`,
    `${APP.cdnFallback}/${loteria.arquivo}.json`,
  ];

  let bruto = null;
  let ultimoErro = null;

  for (const url of urls) {
    try {
      onProgresso(`Tentando espelho de reserva (${loteria.nome})…`);
      bruto = await buscarJson(url, 30000);
      break;
    } catch (e) {
      ultimoErro = e;
    }
  }

  if (!bruto) throw new Error(ultimoErro?.message ?? 'Espelho indisponível.');

  const novos = normalizarEspelho(bruto, loteria);
  if (!novos.length) throw new Error('O espelho respondeu vazio.');

  const r = await gravarMesclado(loteriaId, novos, {
    origem: 'espelho JSON (sem datas, pode estar defasado)',
    fonte: 'espelho',
  });
  return { ...r, baixados: novos.length, fonte: 'espelho' };
}

/* ------------------------------------------------------------------ */
/* A porta de entrada                                                  */
/* ------------------------------------------------------------------ */

/**
 * Tenta a Caixa; se o proxy não estiver no ar, cai no espelho e avisa que a
 * base pode estar velha. Nunca falha em silêncio.
 */
export async function sincronizar(loteriaId, onProgresso = () => {}) {
  try {
    return await sincronizarPelaCaixa(loteriaId, onProgresso);
  } catch (eCaixa) {
    try {
      const r = await sincronizarPeloEspelho(loteriaId, onProgresso);
      return { ...r, avisoFonte: `Proxy da Caixa indisponível (${eCaixa.message}).` };
    } catch (eEspelho) {
      throw new Error(
        `Nenhuma fonte respondeu. Caixa: ${eCaixa.message}. Espelho: ${eEspelho.message}.`
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Import manual                                                       */
/* ------------------------------------------------------------------ */

/**
 * Plano B que sempre funciona, sem depender de rede nenhuma.
 *
 * Aceita, na prática, qualquer coisa que tenha um número de concurso seguido
 * das dezenas na mesma linha — que é o formato dos arquivos de resultado que
 * circulam por aí, incluindo os exportados em CSV de planilha. Também aceita
 * o JSON do espelho.
 *
 * Datas no meio da linha (dd/mm/aaaa) são reconhecidas e guardadas.
 */
export async function importarArquivo(loteriaId, texto) {
  const loteria = LOTERIAS[loteriaId];
  const novos = [];
  const limpo = texto.trim();

  if (limpo.startsWith('{')) {
    novos.push(...normalizarEspelho(JSON.parse(limpo), loteria));
  } else {
    for (const linha of limpo.split(/\r?\n/)) {
      if (!linha.trim()) continue;

      // A data, se houver, sai da linha antes de olharmos os números —
      // senão "27/08/2026" viraria três dezenas.
      let data = null;
      const semData = linha.replace(
        /(\d{2})[/-](\d{2})[/-](\d{4})/,
        (_, d, m, a) => { data = `${a}-${m}-${d}`; return ' '; }
      );

      const numeros = semData.split(/[^0-9]+/).filter(Boolean).map(Number);
      if (numeros.length < loteria.sorteadas + 1) continue;

      const concurso = numeros[0];
      if (!Number.isFinite(concurso) || concurso < 1) continue;

      // As dezenas são os primeiros valores após o concurso que caibam no
      // intervalo válido — o resto da linha (prêmios, ganhadores) é ignorado.
      const dezenas = [];
      for (let i = 1; i < numeros.length && dezenas.length < loteria.sorteadas; i++) {
        const d = numeros[i];
        if (d >= loteria.min && d <= loteria.max && !dezenas.includes(d)) dezenas.push(d);
      }

      if (dezenas.length !== loteria.sorteadas) continue;
      novos.push({ numero: concurso, dezenas: dezenas.sort((a, b) => a - b), data });
    }
  }

  if (!novos.length) {
    throw new Error(
      'Nenhum concurso válido encontrado. O arquivo precisa ter, em cada linha, ' +
        `o número do concurso seguido das ${loteria.sorteadas} dezenas.`
    );
  }

  const r = await gravarMesclado(loteriaId, novos, {
    origem: 'import manual',
    fonte: 'manual',
  });
  return { ...r, baixados: novos.length, fonte: 'manual' };
}

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

export async function carregarHistorico(loteriaId) {
  const reg = await DB.lerHistorico(loteriaId);
  if (!reg?.concursos) {
    return { concursos: [], atualizadoEm: null, fonte: null, dataUltimo: null };
  }

  const datas = reg.datas ?? {};
  const concursos = Object.entries(reg.concursos)
    .map(([numero, dezenas]) => ({
      numero: Number(numero),
      dezenas,
      data: datas[numero] ?? null,
    }))
    .sort((a, b) => a.numero - b.numero);

  return {
    concursos,
    atualizadoEm: reg.atualizadoEm ?? null,
    origem: reg.origem,
    fonte: reg.fonte ?? null,
    dataUltimo: reg.dataUltimo ?? (concursos.length ? concursos[concursos.length - 1].data : null),
  };
}

export async function ultimoConcurso(loteriaId) {
  const { concursos } = await carregarHistorico(loteriaId);
  return concursos.length ? concursos[concursos.length - 1] : null;
}
