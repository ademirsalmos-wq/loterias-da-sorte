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
 * Ritmo das requisições à Caixa.
 *
 * Medido no volume real: com 6 em paralelo e sem pausa, os primeiros ~20
 * concursos passam e depois o servidor começa a recusar — numa carga de 527
 * chegaram a falhar 407. Os mesmos concursos respondiam 200 na hora seguinte,
 * refeitos devagar: não é dado ausente, é rajada demais.
 *
 * Daí o desenho atual: menos paralelismo, uma pausa entre blocos, e rodadas
 * de repescagem cada vez mais lentas para o que sobrar.
 */
const PARALELISMO = 4;
const PAUSA_ENTRE_BLOCOS = 90;      // ms
const RODADAS_REPESCAGEM = 3;

/** Teto por sincronização, para uma base vazia não virar uma sessão eterna. */
const MAX_POR_SYNC = 1500;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

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

/**
 * `listaRateioPremio` → `{ acertos: [valor, ganhadores] }`.
 *
 * O rótulo da faixa vem em `descricaoFaixa` como texto: "15 acertos",
 * "6 acertos", "0 acertos". Conferido nos quatro extremos que o sistema
 * cobre — Lotofácil 3774, Mega-Sena 2920 e 1 (1996), Lotomania 2820 e 1
 * (1999): o formato é o mesmo desde sempre, inclusive o zero da Lotomania.
 * O número de faixas NÃO é estável — a Lotomania de 1999 tinha 6, hoje tem
 * 7 —, então aqui se lê o que veio, sem supor a lista completa.
 *
 * **O nº de ganhadores é guardado junto de propósito.** Quando a faixa
 * acumula, a Caixa devolve `valorPremio: 0` com `numeroDeGanhadores: 0`, e
 * esse zero NÃO quer dizer "esta faixa pagava zero" — quer dizer "ninguém
 * levou". Um bilhete premiado ali teria levado o acumulado. Tratar os dois
 * zeros como a mesma coisa transformaria o prêmio máximo em R$ 0,00 em toda
 * a contabilidade: número errado com cara de certo, que é o defeito que
 * este projeto mais persegue. Quem lê decide o que fazer; aqui só se
 * registra o que a Caixa disse.
 */
function extrairRateio(bruto, loteria) {
  const lista = bruto?.listaRateioPremio;
  if (!Array.isArray(lista) || !lista.length) return null;

  const faixas = new Set(loteria.faixas);
  const out = {};
  for (const item of lista) {
    const m = String(item?.descricaoFaixa ?? '').match(/(\d+)\s*acerto/i);
    if (!m) continue;
    const acertos = Number(m[1]);
    if (!faixas.has(acertos)) continue;      // faixa que esta modalidade não paga

    const valor = Number(item.valorPremio);
    const ganhadores = Number(item.numeroDeGanhadores);
    out[acertos] = [
      Number.isFinite(valor) ? valor : 0,
      Number.isFinite(ganhadores) ? ganhadores : 0,
    ];
  }
  return Object.keys(out).length ? out : null;
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

  return {
    numero,
    dezenas,
    data: paraISO(bruto.dataApuracao),
    rateio: extrairRateio(bruto, loteria),
  };
}

/** Junta concursos novos ao que já está gravado, sem perder o antigo. */
async function gravarMesclado(loteriaId, novos, meta) {
  const atual = await DB.lerHistorico(loteriaId);
  const concursos = { ...(atual?.concursos ?? {}) };
  const datas = { ...(atual?.datas ?? {}) };
  const rateios = { ...(atual?.rateios ?? {}) };

  for (const c of novos) {
    concursos[c.numero] = c.dezenas;
    if (c.data) datas[c.numero] = c.data;
    // O rateio vem no MESMO pedido que trouxe as dezenas: para concurso
    // novo ele sai de graça, sem nenhuma requisição a mais. O download em
    // lote (baixarRateios) existe só para os concursos que já estavam na
    // base antes desta versão.
    if (c.rateio) rateios[c.numero] = c.rateio;
  }

  const numeros = Object.keys(concursos).map(Number);
  const ultimo = numeros.length ? Math.max(...numeros) : 0;

  await DB.salvarHistorico(loteriaId, concursos, {
    datas,
    rateios,
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
  const temLocal = new Set(
    atual?.concursos ? Object.keys(atual.concursos).map(Number) : []
  );

  const novos = ultimoOficialC ? [ultimoOficialC] : [];
  if (ultimoOficialC) temLocal.add(ultimoOficialC.numero);

  /* Busca TUDO que falta entre 1 e o último oficial — não só o que vem
     depois do último que temos. Assim a base se conserta sozinha se ficou
     com buracos numa tentativa anterior, em vez de carregar o defeito para
     sempre e estragar a estatística em silêncio. */
  let faltando = [];
  for (let n = 1; n < ultimoOficial; n++) if (!temLocal.has(n)) faltando.push(n);

  const excedente = Math.max(0, faltando.length - MAX_POR_SYNC);
  if (excedente) faltando = faltando.slice(-MAX_POR_SYNC);   // os mais recentes primeiro

  const buscarLista = async (lista, paralelo, pausa) => {
    const falhas = [];
    for (let i = 0; i < lista.length; i += paralelo) {
      const bloco = lista.slice(i, i + paralelo);
      onProgresso(
        `Baixando ${loteria.nome}: ${novos.length}/${faltando.length + 1} concursos…`
      );
      const saidas = await Promise.allSettled(
        bloco.map((n) => buscarJson(enderecoCaixa(base, modalidade, n), 20000))
      );
      saidas.forEach((sa, k) => {
        const c = sa.status === 'fulfilled' ? normalizarCaixa(sa.value, loteria) : null;
        if (c) novos.push(c);
        else falhas.push(bloco[k]);
      });
      if (pausa) await dormir(pausa);
    }
    return falhas;
  };

  let falhas = await buscarLista(faltando, PARALELISMO, PAUSA_ENTRE_BLOCOS);

  /* Repescagem: o que falhou quase sempre é recusa por excesso de rajada,
     não concurso inexistente. Cada rodada vai mais devagar que a anterior. */
  for (let rodada = 1; rodada <= RODADAS_REPESCAGEM && falhas.length; rodada++) {
    onProgresso(
      `Refazendo ${falhas.length} concurso(s) que a Caixa recusou (tentativa ${rodada})…`
    );
    await dormir(400 * rodada);
    falhas = await buscarLista(falhas, Math.max(1, 3 - rodada), 150 * rodada);
  }

  const r = await gravarMesclado(loteriaId, novos, {
    origem: base ? `Caixa via proxy ${base}` : 'Caixa (API oficial)',
    fonte: 'caixa',
  });

  return {
    ...r,
    baixados: novos.length,
    falhas,
    naoTentados: excedente,
    fonte: 'caixa',
  };
}

/* ------------------------------------------------------------------ */
/* Rateio: quanto cada faixa pagou, concurso a concurso                */
/* ------------------------------------------------------------------ */

/**
 * Quantos concursos por chamada de `baixarRateios`.
 *
 * Não é um limite da Caixa — é o tamanho do pedaço que a tela consegue
 * mostrar andando. A cada lote a função volta, o app pinta o progresso e
 * grava o que já veio; se o usuário fechar a aba no meio, o próximo lote
 * recomeça de onde parou em vez de perder tudo. Com 300, um histórico de
 * 3.774 concursos são 13 rodadas de uns 25 segundos.
 */
export const RATEIOS_POR_LOTE = 300;

/**
 * Quais concursos ainda não têm rateio guardado.
 *
 * "Não tem" é a ausência da chave. Um concurso já baixado em que TODAS as
 * faixas acumularam fica gravado com zeros e ganhadores zero — e continua
 * baixado. Se a ausência fosse deduzida do valor, esses concursos seriam
 * rebaixados para sempre, a cada rodada, sem nunca sair da lista.
 */
export async function coberturaDeRateios(loteriaId) {
  const reg = await DB.lerHistorico(loteriaId);
  const concursos = reg?.concursos ?? {};
  const rateios = reg?.rateios ?? {};

  const numeros = Object.keys(concursos).map(Number).sort((a, b) => a - b);
  const faltando = numeros.filter((n) => !rateios[n]);

  return {
    total: numeros.length,
    comRateio: numeros.length - faltando.length,
    faltando,
  };
}

/**
 * Baixa o rateio de UM LOTE de concursos e grava o que conseguiu.
 *
 * Por que em lotes, e não tudo de uma vez: são ~9.400 concursos somando as
 * três modalidades, e a Caixa recusa rajada — a prova está no cabeçalho
 * deste arquivo, 407 falhas em 527 pedidos. No ritmo seguro isso passa de
 * dez minutos. Uma função que só volta no fim seria dez minutos de tela
 * parada, sem progresso e sem nada gravado se algo interrompesse. Em lotes,
 * cada rodada grava o seu pedaço e a seguinte continua dali.
 *
 * O ritmo (paralelismo 4, pausa de 90 ms, repescagem cada vez mais lenta) é
 * o mesmo já calibrado para a sincronização — não há motivo para inventar
 * outro, e ter dois ritmos diferentes só criaria uma segunda coisa para
 * ajustar quando a Caixa mudar de humor.
 *
 * @param {string} loteriaId
 * @param {object} [opcoes]
 * @param {number} [opcoes.limite]      quantos concursos neste lote
 * @param {(txt:string, feitos:number, doLote:number)=>void} [opcoes.onProgresso]
 * @param {() => boolean} [opcoes.pedidoDeParar]  consultado entre blocos
 * @returns {{baixados, gravados, falhas, restantes, total, comRateio, parou}}
 */
export async function baixarRateios(loteriaId, opcoes = {}) {
  const loteria = LOTERIAS[loteriaId];
  const modalidade = loteria.apiCaixa ?? loteria.id;
  const base = await urlDoProxy();

  const limite = opcoes.limite ?? RATEIOS_POR_LOTE;
  const onProgresso = opcoes.onProgresso ?? (() => {});
  const pedidoDeParar = opcoes.pedidoDeParar ?? (() => false);

  const antes = await coberturaDeRateios(loteriaId);

  /* Do mais recente para o mais antigo: são os concursos em que o usuário
     tem bilhete, e os valores de 2026 valem mais para ele que os de 1996. */
  const doLote = antes.faltando.slice(-limite).reverse();
  if (!doLote.length) {
    return { baixados: 0, gravados: 0, falhas: [], restantes: 0,
             total: antes.total, comRateio: antes.comRateio, parou: false };
  }

  const colhidos = {};
  let parou = false;

  const buscarLista = async (lista, paralelo, pausa) => {
    const falhas = [];
    for (let i = 0; i < lista.length; i += paralelo) {
      if (pedidoDeParar()) { parou = true; return falhas.concat(lista.slice(i)); }

      const bloco = lista.slice(i, i + paralelo);
      onProgresso(
        `Baixando prêmios ${loteria.nome}: ${Object.keys(colhidos).length}/${doLote.length}…`,
        Object.keys(colhidos).length,
        doLote.length
      );

      const saidas = await Promise.allSettled(
        bloco.map((n) => buscarJson(enderecoCaixa(base, modalidade, n), 20000))
      );
      saidas.forEach((sa, k) => {
        const numero = bloco[k];
        const r = sa.status === 'fulfilled' ? extrairRateio(sa.value, loteria) : null;
        if (r) colhidos[numero] = r;
        else falhas.push(numero);
      });
      if (pausa) await dormir(pausa);
    }
    return falhas;
  };

  let falhas = await buscarLista(doLote, PARALELISMO, PAUSA_ENTRE_BLOCOS);

  for (let rodada = 1; rodada <= RODADAS_REPESCAGEM && falhas.length && !parou; rodada++) {
    onProgresso(
      `Refazendo ${falhas.length} concurso(s) que a Caixa recusou (tentativa ${rodada})…`,
      Object.keys(colhidos).length, doLote.length
    );
    await dormir(400 * rodada);
    falhas = await buscarLista(falhas, Math.max(1, 3 - rodada), 150 * rodada);
  }

  /* Grava o que veio ANTES de olhar o que faltou: se o usuário parar no meio
     ou a rede cair na repescagem, o trabalho já feito fica. */
  const gravados = await DB.mesclarRateios(loteriaId, colhidos);
  const depois = await coberturaDeRateios(loteriaId);

  return {
    baixados: Object.keys(colhidos).length,
    gravados,
    falhas,
    restantes: depois.faltando.length,
    total: depois.total,
    comRateio: depois.comRateio,
    parou,
  };
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
    rateios: reg.rateios ?? {},
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
