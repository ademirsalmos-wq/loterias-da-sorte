/**
 * api.js — De onde vêm os resultados.
 *
 * =====================================================================
 * A HISTÓRIA DESTE ARQUIVO, PORQUE ELA EXPLICA O DESENHO
 *
 * Versão 1 partiu de uma afirmação minha que era simplesmente FALSA:
 * "a API da Caixa não envia CORS, então um app front-end não consegue
 * chamá-la". Nunca foi verificado — foi afirmado de memória. Sobre essa
 * premissa se construiu tudo o que veio depois:
 *
 *   - um espelho público em JSON como fonte (que estava 527 concursos e
 *     quase dois anos atrasado, e o sistema não percebeu);
 *   - depois uma Edge Function no Netlify para "resolver o CORS".
 *
 * A Edge Function levou 403. Investigando, a verdade apareceu:
 *
 *   A API da Caixa SEMPRE enviou CORS. O que ela faz é GEOBLOQUEIO por
 *   IP: só aceita faixas brasileiras (LACNIC/NICBR). O navegador do
 *   usuário, no Brasil, é chamador legítimo. Os servidores do Netlify,
 *   fora do país, não são.
 *
 * Então o proxy não era só desnecessário — era ativamente nocivo: tirava
 * a requisição de um IP que funciona e a jogava num que é barrado.
 *
 * A arquitetura certa é a mais simples que existe: o navegador chama a
 * Caixa direto. Sem intermediário, sem espelho, sem servidor. Funciona
 * publicado e funciona no `python -m http.server` local.
 *
 * Medido no computador do usuário: 21 ms por concurso com 6 requisições
 * em paralelo — 527 concursos em ~11 segundos.
 *
 * LIÇÃO, para não repetir: verificar o comportamento real antes de
 * desenhar em cima dele. Duas vezes neste projeto uma suposição não
 * conferida custou uma arquitetura inteira.
 * =====================================================================
 */

import { APP, LOTERIAS } from './config.js';
import { DB } from './db.js';

/** A API oficial. Aceita chamada direta do navegador, de qualquer origem. */
export const CAIXA = 'https://servicebus2.caixa.gov.br/portaldeloterias/api';

/**
 * Quantas requisições simultâneas ao servidor da Caixa.
 *
 * Seis é rápido (medido: ~21 ms por concurso) e educado. Subir muito além
 * disso não acelera de forma relevante e aumenta a chance de o servidor
 * começar a recusar.
 */
const PARALELISMO = 6;

/**
 * Proxy opcional. Só faz sentido se um dia você hospedar um servidor NO
 * BRASIL — de fora do país a Caixa responde 403 e o proxy não ajuda em nada.
 * Vazio (o padrão) significa "chamar a Caixa direto", que é o certo.
 */
export async function urlDoProxy() {
  return (await DB.getConfig('fonteProxy', '')) || '';
}

export async function definirProxy(url) {
  await DB.setConfig('fonteProxy', (url ?? '').trim());
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

async function buscarJson(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) {
      if (r.status === 403) {
        throw new Error(
          'A Caixa recusou a conexão (403). Ela só aceita acessos com IP do ' +
            'Brasil — verifique se há VPN ou proxy ativo.'
        );
      }
      throw new Error(`HTTP ${r.status}`);
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** "27/08/2026" → "2026-08-27", que ordena e compara sem surpresa. */
function paraISO(dataBR) {
  const m = String(dataBR ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Resposta crua da Caixa → o formato enxuto que o sistema usa. */
function normalizarCaixa(bruto, loteria) {
  if (!bruto || typeof bruto !== 'object') return null;

  const numero = Number(bruto.numero);
  if (!Number.isFinite(numero) || numero < 1) return null;

  const dezenas = (bruto.listaDezenas ?? bruto.dezenasSorteadasOrdemSorteio ?? [])
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d) && d >= loteria.min && d <= loteria.max)
    .sort((a, b) => a - b);

  // Concurso incompleto ou de outra modalidade: melhor descartar do que
  // gravar algo que vai bagunçar a estatística depois.
  if (dezenas.length !== loteria.sorteadas) return null;

  return { numero, dezenas, data: paraISO(bruto.dataApuracao) };
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
/* Fonte principal: a Caixa, direto                                    */
/* ------------------------------------------------------------------ */

function enderecoCaixa(base, modalidade, numero) {
  const raiz = base || CAIXA;
  return numero ? `${raiz}/${modalidade}/${numero}` : `${raiz}/${modalidade}`;
}

/**
 * Sincroniza pela API oficial, baixando só o que falta: se a base já vai
 * até o 3.246 e a Caixa está no 3.773, busca 527 — não 3.773.
 */
export async function sincronizarPelaCaixa(loteriaId, onProgresso = () => {}) {
  const loteria = LOTERIAS[loteriaId];
  const modalidade = loteria.apiCaixa ?? loteria.id;
  const base = await urlDoProxy();   // vazio = direto na Caixa

  onProgresso(`Consultando a Caixa (${loteria.nome})…`);
  const cabeca = await buscarJson(enderecoCaixa(base, modalidade, null), 15000);

  const ultimoOficialC = normalizarCaixa(cabeca, loteria);
  const ultimoOficial = ultimoOficialC?.numero ?? Number(cabeca?.numero);
  if (!Number.isFinite(ultimoOficial)) {
    throw new Error('A Caixa respondeu, mas em formato inesperado.');
  }

  const atual = await DB.lerHistorico(loteriaId);
  const jaTemos = atual?.concursos ? Object.keys(atual.concursos).map(Number) : [];
  const ultimoLocal = jaTemos.length ? Math.max(...jaTemos) : 0;

  const novos = ultimoOficialC ? [ultimoOficialC] : [];
  const faltando = [];
  for (let n = ultimoLocal + 1; n < ultimoOficial; n++) faltando.push(n);

  const falhas = [];

  for (let i = 0; i < faltando.length; i += PARALELISMO) {
    const bloco = faltando.slice(i, i + PARALELISMO);
    onProgresso(
      `Baixando ${loteria.nome}: ${i}/${faltando.length} concursos…`
    );

    const saidas = await Promise.allSettled(
      bloco.map((n) => buscarJson(enderecoCaixa(base, modalidade, n), 20000))
    );

    saidas.forEach((s, k) => {
      const c = s.status === 'fulfilled' ? normalizarCaixa(s.value, loteria) : null;
      if (c) novos.push(c);
      else falhas.push(bloco[k]);
    });
  }

  const r = await gravarMesclado(loteriaId, novos, {
    origem: base ? `Caixa via proxy ${base}` : 'Caixa (API oficial)',
    fonte: 'caixa',
  });

  return { ...r, baixados: novos.length, falhas, fonte: 'caixa' };
}

/* ------------------------------------------------------------------ */
/* Último recurso: o espelho em JSON                                   */
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
 * Este espelho já provou que congela sem avisar, e não traz datas — o que
 * impede o sistema de perceber que congelou. Só entra se a Caixa estiver
 * inalcançável, e a origem gravada deixa o rastro para o diagnóstico.
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
  return { ...r, baixados: novos.length, falhas: [], fonte: 'espelho' };
}

/* ------------------------------------------------------------------ */
/* A porta de entrada                                                  */
/* ------------------------------------------------------------------ */

export async function sincronizar(loteriaId, onProgresso = () => {}) {
  try {
    return await sincronizarPelaCaixa(loteriaId, onProgresso);
  } catch (eCaixa) {
    try {
      const r = await sincronizarPeloEspelho(loteriaId, onProgresso);
      return { ...r, avisoFonte: `Caixa indisponível (${eCaixa.message}).` };
    } catch (eEspelho) {
      throw new Error(
        `Nenhuma fonte respondeu. Caixa: ${eCaixa.message} · Espelho: ${eEspelho.message}`
      );
    }
  }
}

/** Consulta rápida usada pelo botão "Testar conexão". */
export async function testarFonte(loteriaId) {
  const loteria = LOTERIAS[loteriaId];
  const modalidade = loteria.apiCaixa ?? loteria.id;
  const base = await urlDoProxy();

  const bruto = await buscarJson(enderecoCaixa(base, modalidade, null), 15000);
  const c = normalizarCaixa(bruto, loteria);
  if (!c) throw new Error('Resposta em formato inesperado.');
  return { ...c, via: base || 'direto na Caixa' };
}

/* ------------------------------------------------------------------ */
/* Import manual                                                       */
/* ------------------------------------------------------------------ */

/**
 * Plano B que não depende de rede nenhuma. Aceita o JSON do espelho ou
 * qualquer arquivo que tenha, em cada linha, o número do concurso seguido
 * das dezenas — inclusive CSV exportado de planilha. Datas dd/mm/aaaa no
 * meio da linha são reconhecidas e aproveitadas.
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

      // A data sai da linha antes de olharmos os números — senão
      // "27/08/2026" viraria três dezenas.
      let data = null;
      const semData = linha.replace(
        /(\d{2})[/-](\d{2})[/-](\d{4})/,
        (_, d, m, a) => { data = `${a}-${m}-${d}`; return ' '; }
      );

      const numeros = semData.split(/[^0-9]+/).filter(Boolean).map(Number);
      if (numeros.length < loteria.sorteadas + 1) continue;

      const concurso = numeros[0];
      if (!Number.isFinite(concurso) || concurso < 1) continue;

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
      'Nenhum concurso válido encontrado. Cada linha precisa ter o número do ' +
        `concurso seguido das ${loteria.sorteadas} dezenas.`
    );
  }

  const r = await gravarMesclado(loteriaId, novos, {
    origem: 'import manual',
    fonte: 'manual',
  });
  return { ...r, baixados: novos.length, falhas: [], fonte: 'manual' };
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
    dataUltimo:
      reg.dataUltimo ?? (concursos.length ? concursos[concursos.length - 1].data : null),
  };
}

export async function ultimoConcurso(loteriaId) {
  const { concursos } = await carregarHistorico(loteriaId);
  return concursos.length ? concursos[concursos.length - 1] : null;
}
