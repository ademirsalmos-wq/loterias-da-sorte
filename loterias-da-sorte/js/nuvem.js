/**
 * nuvem.js — Sincronização entre aparelhos, via Supabase.
 *
 * =====================================================================
 * POR QUE SEM SDK
 *
 * O supabase-js resolveria isto em menos linhas, mas custaria: um import
 * de CDN externo (mais uma coisa que pode sair do ar ou mudar sem aviso —
 * já aprendemos essa), ~40 KB no celular, e uma dependência num projeto
 * que até aqui não tem nenhuma.
 *
 * O que usamos do Supabase são duas APIs REST simples: `/auth/v1` para o
 * login por link de e-mail e `/rest/v1` (PostgREST) para ler e gravar. Dá
 * para falar com as duas usando `fetch`, e é o que este arquivo faz.
 *
 * COMO O CONFLITO SE RESOLVE
 *
 * Cada bilhete tem `atualizadoEm`. Ao sincronizar, para cada registro
 * vence a versão com a data mais recente — em qualquer direção. É a regra
 * mais simples que funciona, e funciona bem aqui porque um bilhete quase
 * nunca é editado nos dois aparelhos ao mesmo tempo: o caso real é criar
 * no PC e conferir no celular, ou vice-versa.
 *
 * O QUE NÃO SOBE PARA A NUVEM
 *
 * O histórico de concursos. São ~10 mil registros públicos, iguais para
 * todo mundo, que cada aparelho busca da Caixa em segundos. Subir isso só
 * gastaria cota de banco e de transferência sem benefício nenhum.
 * =====================================================================
 */

import { DB } from './db.js';

const CHAVE_CONFIG = 'nuvem:config';
const CHAVE_SESSAO = 'nuvem:sessao';
const CHAVE_ULTIMA_SYNC = 'nuvem:ultimaSync';

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */

export async function lerConfig() {
  return (await DB.getConfig(CHAVE_CONFIG, null)) ?? { url: '', anonKey: '' };
}

export async function salvarConfig({ url, anonKey }) {
  const limpo = {
    url: (url ?? '').trim().replace(/\/+$/, ''),
    anonKey: (anonKey ?? '').trim(),
  };
  await DB.setConfig(CHAVE_CONFIG, limpo);
  return limpo;
}

export async function estaConfigurada() {
  const c = await lerConfig();
  return Boolean(c.url && c.anonKey);
}

/* ------------------------------------------------------------------ */
/* Sessão                                                              */
/* ------------------------------------------------------------------ */

async function lerSessao() {
  return DB.getConfig(CHAVE_SESSAO, null);
}

async function salvarSessao(s) {
  await DB.setConfig(CHAVE_SESSAO, s);
}

export async function sessaoAtual() {
  const s = await lerSessao();
  if (!s?.access_token) return null;
  return { email: s.email ?? null, expiraEm: s.expira_em ?? null };
}

export async function sair() {
  await DB.setConfig(CHAVE_SESSAO, null);
  await DB.setConfig(CHAVE_ULTIMA_SYNC, null);
}

/** Renova o token quando falta menos de um minuto para expirar. */
async function tokenValido() {
  const cfg = await lerConfig();
  const s = await lerSessao();
  if (!s?.access_token) throw new Error('Você não está conectado à nuvem.');

  const faltando = (s.expira_em ?? 0) - Date.now();
  if (faltando > 60000) return s.access_token;

  if (!s.refresh_token) throw new Error('Sessão expirada. Entre de novo.');

  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: s.refresh_token }),
  });

  if (!r.ok) {
    await DB.setConfig(CHAVE_SESSAO, null);
    throw new Error('Sessão expirada. Entre de novo com seu e-mail.');
  }

  const d = await r.json();
  const nova = {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    email: d.user?.email ?? s.email,
    expira_em: Date.now() + (d.expires_in ?? 3600) * 1000,
  };
  await salvarSessao(nova);
  return nova.access_token;
}

/* ------------------------------------------------------------------ */
/* Login por link de e-mail                                            */
/* ------------------------------------------------------------------ */

/**
 * Manda o link mágico. Sem senha — nada para guardar, nada para vazar, e
 * funciona igual nos dois aparelhos.
 */
export async function enviarLink(email) {
  const cfg = await lerConfig();
  if (!cfg.url || !cfg.anonKey) throw new Error('Configure a URL e a chave do Supabase primeiro.');

  const destino = location.origin + location.pathname;
  const r = await fetch(`${cfg.url}/auth/v1/otp`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, create_user: true, redirect_to: destino }),
  });

  if (!r.ok) {
    const erro = await r.json().catch(() => ({}));
    throw new Error(erro.msg || erro.error_description || `Supabase respondeu ${r.status}`);
  }
  return { destino };
}

/**
 * O Supabase devolve os tokens no fragmento da URL (#access_token=...).
 * Chamado na abertura do app; se achar, guarda e limpa a barra de endereço
 * para o token não ficar exposto no histórico do navegador.
 */
export async function capturarRetornoDoLink() {
  if (!location.hash.includes('access_token')) return null;

  const p = new URLSearchParams(location.hash.slice(1));
  const access_token = p.get('access_token');
  if (!access_token) return null;

  let email = null;
  try {
    // O e-mail vem dentro do próprio JWT; evita mais uma ida ao servidor.
    email = JSON.parse(atob(access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))?.email ?? null;
  } catch { /* token opaco: seguimos sem o e-mail */ }

  await salvarSessao({
    access_token,
    refresh_token: p.get('refresh_token'),
    email,
    expira_em: Date.now() + Number(p.get('expires_in') ?? 3600) * 1000,
  });

  history.replaceState(null, '', location.pathname + location.search);
  return { email };
}

/* ------------------------------------------------------------------ */
/* Conversão entre o formato local e o do banco                        */
/* ------------------------------------------------------------------ */

const paraBanco = (b, userId) => ({
  id: b.id,
  user_id: userId,
  loteria: b.loteria,
  dezenas: b.dezenas,
  concurso: b.concurso ?? null,
  origem: b.origem ?? null,
  grupo: b.grupo ?? null,
  rotulo: b.rotulo ?? null,
  custo: b.custo ?? 0,
  conferido: Boolean(b.conferido),
  acertos: b.acertos ?? null,
  premiado: Boolean(b.premiado),
  premio: b.premio ?? 0,
  removido: Boolean(b.removido),
  criado_em: b.criadoEm ?? null,
  atualizado_em: b.atualizadoEm,
});

const paraLocal = (r) => ({
  id: r.id,
  loteria: r.loteria,
  dezenas: r.dezenas ?? [],
  concurso: r.concurso,
  origem: r.origem ?? '',
  grupo: r.grupo ?? null,
  rotulo: r.rotulo ?? '',
  custo: Number(r.custo ?? 0),
  conferido: Boolean(r.conferido),
  acertos: r.acertos,
  premiado: Boolean(r.premiado),
  premio: Number(r.premio ?? 0),
  removido: Boolean(r.removido),
  criadoEm: r.criado_em ?? null,
  atualizadoEm: r.atualizado_em,
});

/* ------------------------------------------------------------------ */
/* Sincronização                                                       */
/* ------------------------------------------------------------------ */

function idDoUsuario(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))?.sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Nome da tabela, com prefixo.
 *
 * Um projeto Supabase comporta várias aplicações — o limite do plano free é
 * de 500 MB de banco, não de tabelas. Como este sistema pode acabar dividindo
 * projeto com outro app (o ScoutStrike, por exemplo, que também é de
 * apostas), uma tabela chamada só `bilhetes` seria pedir colisão.
 */
export const TABELA = 'loterias_bilhetes';

async function chamarRest(caminho, opcoes = {}) {
  const cfg = await lerConfig();
  const token = await tokenValido();

  const r = await fetch(`${cfg.url}/rest/v1/${caminho}`, {
    ...opcoes,
    headers: {
      apikey: cfg.anonKey,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(opcoes.headers ?? {}),
    },
  });

  if (!r.ok) {
    const corpo = await r.text().catch(() => '');
    if (r.status === 404 || /relation .* does not exist/i.test(corpo)) {
      throw new Error(
        `A tabela "${TABELA}" não existe neste projeto. Rode o supabase/schema.sql no SQL Editor.`
      );
    }
    throw new Error(`Supabase respondeu ${r.status}. ${corpo.slice(0, 160)}`);
  }

  return r.status === 204 ? null : r.json();
}

/**
 * Uma rodada completa: empurra o que mudou aqui, puxa o que mudou lá, e
 * resolve cada conflito pela data mais recente.
 *
 * @returns {{enviados, recebidos, aplicados, quando}}
 */
export async function sincronizar({ completa = false } = {}) {
  const token = await tokenValido();
  const userId = idDoUsuario(token);
  if (!userId) throw new Error('Não consegui identificar o usuário na sessão.');

  /* O cursor serve só para o ENVIO — ali comparamos o nosso relógio com as
     nossas próprias datas, que é uma comparação legítima. */
  const desde = completa ? null : await DB.getConfig(CHAVE_ULTIMA_SYNC, null);
  const inicio = new Date().toISOString();

  /* ---- empurrar ---- */
  const locais = await DB.listarBilhetes(null, true);
  const aEnviar = desde
    ? locais.filter((b) => (b.atualizadoEm ?? '') > desde)
    : locais;

  if (aEnviar.length) {
    // resolution=merge-duplicates faz o upsert por chave primária.
    await chamarRest(`${TABELA}?on_conflict=id`, {
      method: 'POST',
      headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(aEnviar.map((b) => paraBanco(b, userId))),
    });
  }

  /* ---- puxar: TUDO, sempre ----
     A tentação aqui é puxar só o que mudou desde a última vez, filtrando por
     `atualizado_em > desde`. Testado, e está errado — deixa registro para trás:

       o celular edita um bilhete às 15h00 (data gravada: 15h00);
       o PC sincroniza às 15h01 (cursor do PC vai para 15h01);
       o celular só consegue enviar às 15h02 (o registro sobe com 15h00);
       o PC sincroniza de novo e pede "o que mudou depois de 15h01" —
       o registro tem 15h00 e fica invisível para sempre.

     O cursor mede o relógio de QUEM sincroniza; a data mede quando o OUTRO
     editou. Comparar os dois é a origem do buraco.

     A correção certa seria uma coluna preenchida pelo servidor no momento da
     gravação. A correção suficiente, para o tamanho deste app, é puxar tudo:
     algumas centenas de bilhetes são poucos KB, e some uma classe inteira de
     bug silencioso. Se um dia forem dezenas de milhares, aí sim vale a coluna. */
  const remotos = await chamarRest(`${TABELA}?select=*`);

  /* ---- mesclar: vence a data mais recente ---- */
  const porId = new Map(locais.map((b) => [b.id, b]));
  const aplicar = [];

  for (const r of remotos ?? []) {
    const vindo = paraLocal(r);
    const aqui = porId.get(vindo.id);
    if (!aqui || (vindo.atualizadoEm ?? '') > (aqui.atualizadoEm ?? '')) {
      aplicar.push(vindo);
    }
  }

  if (aplicar.length) await DB.gravarComoEsta(aplicar);

  await DB.setConfig(CHAVE_ULTIMA_SYNC, inicio);

  return {
    enviados: aEnviar.length,
    recebidos: (remotos ?? []).length,
    aplicados: aplicar.length,
    quando: inicio,
  };
}

/** Confere se dá para falar com o banco, sem mexer em nada. */
export async function testarConexao() {
  const r = await chamarRest(`${TABELA}?select=id&limit=1`);
  const s = await lerSessao();
  return { ok: true, email: s?.email ?? null, registros: Array.isArray(r) ? r.length : 0 };
}

export async function ultimaSincronizacao() {
  return DB.getConfig(CHAVE_ULTIMA_SYNC, null);
}
