/**
 * loterias.js — Edge Function: ponte para a API oficial da Caixa.
 *
 * POR QUE ISSO EXISTE
 * A API da Caixa (servicebus2.caixa.gov.br/portaldeloterias/api) não devolve
 * o cabeçalho `Access-Control-Allow-Origin`. O navegador bloqueia a resposta
 * antes do JavaScript ver qualquer coisa — não é limitação do nosso código,
 * é política do servidor deles. A única saída é alguém buscar o dado
 * server-side e reservi-lo com CORS liberado. É o que esta função faz.
 *
 * POR QUE EDGE FUNCTION E NÃO FUNCTION NORMAL
 * No plano free do Netlify, as Functions comuns consomem do bolo de 300
 * créditos/mês que também paga banda e deploys — e quando esse bolo acaba, o
 * site sai do ar. Edge Functions têm 1.000.000 de invocações/mês em pool
 * separado. Nosso uso real é da ordem de 100/mês. Fica de graça e não
 * ameaça os deploys.
 *
 * ROTAS
 *   /api/loterias/lotofacil                  → último concurso
 *   /api/loterias/lotofacil/3773             → um concurso específico
 *   /api/loterias/lotofacil/lote?de=&ate=    → um intervalo (para o histórico)
 *
 * A resposta é normalizada para o formato que o app usa:
 *   { numero, dezenas: [1,2,...], data: "2026-08-27" }
 */

/**
 * Lista branca. Sem ela isto seria um proxy aberto — qualquer um poderia
 * usar o seu domínio para buscar qualquer coisa na Caixa.
 */
const MODALIDADES = new Set([
  'lotofacil',
  'megasena',
  'lotomania',
  'quina',
  'duplasena',
  'diadesorte',
  'timemania',
  'supersete',
  'maismilionaria',
]);

const BASE = 'https://servicebus2.caixa.gov.br/portaldeloterias/api';

/** Quantos concursos buscar em paralelo. */
const PARALELISMO = 12;
/** Teto de concursos por chamada de lote — o edge tem tempo limitado. */
const MAX_LOTE = 60;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(corpo, status = 200, cacheSegundos = 0) {
  return new Response(JSON.stringify(corpo), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSegundos
        ? `public, max-age=${cacheSegundos}, s-maxage=${cacheSegundos}`
        : 'no-store',
      ...CORS,
    },
  });
}

/**
 * A Caixa responde a "dataApuracao" no formato brasileiro (27/08/2026).
 * Guardamos em ISO (2026-08-27), que ordena e compara sem surpresa.
 */
function paraISO(dataBR) {
  if (!dataBR || typeof dataBR !== 'string') return null;
  const m = dataBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function normalizar(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const numero = Number(bruto.numero);
  if (!Number.isFinite(numero)) return null;

  const lista = bruto.listaDezenas ?? bruto.dezenasSorteadasOrdemSorteio ?? [];
  const dezenas = lista
    .map((d) => Number(d))
    .filter((d) => Number.isFinite(d))
    .sort((a, b) => a - b);

  if (!dezenas.length) return null;

  return {
    numero,
    dezenas,
    data: paraISO(bruto.dataApuracao),
    acumulou: bruto.acumulado ?? null,
  };
}

async function buscarConcurso(modalidade, numero) {
  const url = numero ? `${BASE}/${modalidade}/${numero}` : `${BASE}/${modalidade}`;

  const r = await fetch(url, {
    headers: {
      // A Caixa recusa alguns clientes sem User-Agent de navegador.
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept: 'application/json',
    },
  });

  if (!r.ok) throw new Error(`Caixa respondeu ${r.status}`);
  return normalizar(await r.json());
}

/** Busca vários concursos com paralelismo controlado. */
async function buscarLote(modalidade, de, ate) {
  const numeros = [];
  for (let n = de; n <= ate; n++) numeros.push(n);

  const resultados = [];
  const falhas = [];

  for (let i = 0; i < numeros.length; i += PARALELISMO) {
    const bloco = numeros.slice(i, i + PARALELISMO);
    const saidas = await Promise.allSettled(
      bloco.map((n) => buscarConcurso(modalidade, n))
    );
    saidas.forEach((s, k) => {
      if (s.status === 'fulfilled' && s.value) resultados.push(s.value);
      else falhas.push(bloco[k]);
    });
  }

  return { resultados, falhas };
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  // /api/loterias/<modalidade>[/<concurso>|/lote]
  const partes = url.pathname.split('/').filter(Boolean);
  const idx = partes.indexOf('loterias');
  const modalidade = (partes[idx + 1] ?? '').toLowerCase();
  const alvo = (partes[idx + 2] ?? '').toLowerCase();

  if (!MODALIDADES.has(modalidade)) {
    return json(
      {
        erro: 'Modalidade não permitida.',
        modalidadesAceitas: [...MODALIDADES],
      },
      400
    );
  }

  try {
    /* ---- intervalo ---- */
    if (alvo === 'lote') {
      const de = Number(url.searchParams.get('de'));
      const ate = Number(url.searchParams.get('ate'));

      if (!Number.isFinite(de) || !Number.isFinite(ate) || de < 1 || ate < de) {
        return json({ erro: 'Parâmetros "de" e "ate" inválidos.' }, 400);
      }
      if (ate - de + 1 > MAX_LOTE) {
        return json(
          { erro: `No máximo ${MAX_LOTE} concursos por chamada.`, max: MAX_LOTE },
          400
        );
      }

      const { resultados, falhas } = await buscarLote(modalidade, de, ate);
      // Concursos antigos nunca mudam: vale cachear por bastante tempo.
      return json({ modalidade, concursos: resultados, falhas }, 200, 86400);
    }

    /* ---- concurso específico ---- */
    if (alvo) {
      const numero = Number(alvo);
      if (!Number.isFinite(numero) || numero < 1) {
        return json({ erro: 'Número de concurso inválido.' }, 400);
      }
      const c = await buscarConcurso(modalidade, numero);
      if (!c) return json({ erro: 'Concurso não encontrado.' }, 404);
      return json({ modalidade, concursos: [c], falhas: [] }, 200, 86400);
    }

    /* ---- último ---- */
    const ultimo = await buscarConcurso(modalidade, null);
    if (!ultimo) return json({ erro: 'Resposta inesperada da Caixa.' }, 502);
    // O último muda a cada sorteio: cache curto.
    return json({ modalidade, concursos: [ultimo], falhas: [], ultimo: ultimo.numero }, 200, 300);
  } catch (e) {
    return json(
      {
        erro: 'Não consegui falar com a API da Caixa.',
        detalhe: String(e?.message ?? e),
      },
      502
    );
  }
};

export const config = { path: '/api/loterias/*' };
