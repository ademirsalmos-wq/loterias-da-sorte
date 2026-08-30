/**
 * nuvem.js — Contas e sincronização entre aparelhos, via Firebase.
 *
 * =====================================================================
 * POR QUE FIREBASE, E POR QUE SEM SDK
 *
 * Antes era Supabase. A troca não foi por gosto: o plano free do
 * Supabase permite 2 projetos ativos POR ORGANIZAÇÃO, e o limite conta
 * os projetos de todos os Owners — então criar uma organização nova não
 * libera um terceiro projeto para quem trabalha sozinho. O sistema
 * acabava morando numa base emprestada de outro app. Some a isso que
 * projeto free do Supabase é pausado após 7 dias de baixa atividade.
 *
 * O Firebase não documenta limite de projetos no plano Spark e não
 * pausa por inatividade.
 *
 * O SDK do Firebase resolveria isto em menos linhas, mas custaria uns
 * 100 KB no celular e uma dependência de CDN num projeto que até aqui
 * não tem nenhuma — e a lição do espelho JSON morto foi justamente essa.
 * O que usamos são duas APIs REST simples: `identitytoolkit` para as
 * contas e `firestore.googleapis.com` para os dados. `fetch` dá conta.
 *
 * COMO O CONFLITO SE RESOLVE
 *
 * Cada bilhete tem `atualizadoEm`. Ao sincronizar, para cada registro
 * vence a versão com a data mais recente — em qualquer direção. É a
 * regra mais simples que funciona, e funciona bem aqui porque um
 * bilhete quase nunca é editado nos dois aparelhos ao mesmo tempo: o
 * caso real é criar no PC e conferir no celular, ou vice-versa.
 *
 * O QUE NÃO SOBE PARA A NUVEM
 *
 * O histórico de concursos. São ~10 mil registros públicos, iguais para
 * todo mundo, que cada aparelho busca da Caixa em segundos. Subir isso
 * só gastaria cota de leitura e escrita sem benefício nenhum.
 * =====================================================================
 */

import { DB } from './db.js';
import { FIREBASE, COLECAO_USUARIOS, COLECAO_BILHETES, nuvemConfigurada } from './configuracao.js';

const CHAVE_SESSAO = 'nuvem:sessao';
const CHAVE_ULTIMA_SYNC = 'nuvem:ultimaSync';

const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts';
/* A renovação do token mora em OUTRO host, e é o único endpoint de
   autenticação que não fala JSON. Ver `renovarToken()`. */
const TOKEN = 'https://securetoken.googleapis.com/v1/token';
const FIRESTORE = 'https://firestore.googleapis.com/v1';

export { nuvemConfigurada };

/** Herdado da versão Supabase; a tela ainda pergunta isto. */
export async function estaConfigurada() {
  return nuvemConfigurada();
}

/* ------------------------------------------------------------------ */
/* Erros: inglês cru vira português com o que fazer a respeito          */
/* ------------------------------------------------------------------ */

/**
 * O Firebase devolve o código em `error.message`, às vezes com um
 * detalhe colado depois de " : " — daí o uso de `startsWith` e não `===`.
 */
function erroDeAuth(codigo) {
  const c = String(codigo || '');
  const eh = (p) => c.startsWith(p);

  if (eh('EMAIL_EXISTS')) {
    return 'Já existe conta com este e-mail. Use <b>Entrar</b> — e se esqueceu a senha, peça a redefinição.';
  }
  /* Projetos criados a partir de set/2023 têm proteção contra
     enumeração de e-mails ligada: senha errada e e-mail inexistente
     voltam com o MESMO código, de propósito. Não dá para distinguir, e
     a mensagem não deve fingir que dá. */
  if (eh('INVALID_LOGIN_CREDENTIALS') || eh('INVALID_PASSWORD') || eh('EMAIL_NOT_FOUND')) {
    return 'E-mail ou senha não conferem. Se é a primeira vez neste aparelho, use <b>Criar conta</b>.';
  }
  if (eh('WEAK_PASSWORD')) {
    return 'Senha fraca demais para o Firebase — ele exige pelo menos 6 caracteres.';
  }
  if (eh('INVALID_EMAIL')) return 'Esse e-mail não parece válido.';
  if (eh('MISSING_PASSWORD')) return 'Informe a senha.';
  if (eh('USER_DISABLED')) return 'Esta conta foi desativada no console do Firebase.';
  if (eh('TOO_MANY_ATTEMPTS_TRY_LATER')) {
    return 'O Firebase bloqueou temporariamente as tentativas deste aparelho. Espere alguns minutos.';
  }
  if (eh('OPERATION_NOT_ALLOWED')) {
    return 'O login por e-mail e senha está desligado neste projeto. Ligue em ' +
           'Authentication → Sign-in method → E-mail/senha.';
  }
  if (eh('USER_NOT_FOUND')) return 'Não achei uma conta com este e-mail.';
  if (eh('INVALID_ID_TOKEN') || eh('TOKEN_EXPIRED')) {
    return 'Sua sessão expirou. Entre de novo.';
  }
  if (eh('API_KEY_INVALID') || eh('API key not valid')) {
    return 'A <code>apiKey</code> em <code>js/configuracao.js</code> não é válida para este projeto.';
  }
  if (eh('CONFIGURATION_NOT_FOUND')) {
    return 'O projeto existe, mas a autenticação por e-mail e senha nunca foi ligada. ' +
           'Vá em Authentication → Get started → E-mail/senha → Ativar.';
  }
  return c ? `Firebase: ${c}` : 'O Firebase recusou a chamada, sem dizer o motivo.';
}

async function chamarAuth(metodo, corpo) {
  if (!nuvemConfigurada()) {
    throw new Error('Falta preencher a apiKey e o projectId em <code>js/configuracao.js</code>.');
  }
  let r;
  try {
    r = await fetch(`${AUTH}:${metodo}?key=${encodeURIComponent(FIREBASE.apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
  } catch {
    throw new Error('Não consegui falar com o Firebase. Verifique sua conexão.');
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(erroDeAuth(d?.error?.message));
  return d;
}

/* ------------------------------------------------------------------ */
/* Sessão                                                              */
/* ------------------------------------------------------------------ */

const lerSessao = () => DB.getConfig(CHAVE_SESSAO, null);

async function salvarSessao(s) {
  await DB.setConfig(CHAVE_SESSAO, s);
  return s;
}

/** Guarda o que o Firebase devolve depois de um login bem-sucedido. */
function daResposta(d) {
  return {
    idToken: d.idToken,
    refreshToken: d.refreshToken,
    uid: d.localId,
    email: d.email ?? null,
    expiraEm: Date.now() + Number(d.expiresIn ?? 3600) * 1000,
  };
}

export async function sessaoAtual() {
  const s = await lerSessao();
  if (!s?.idToken) return null;
  return { email: s.email ?? null, uid: s.uid ?? null, expiraEm: s.expiraEm ?? null };
}

export async function sair() {
  await DB.setConfig(CHAVE_SESSAO, null);
  await DB.setConfig(CHAVE_ULTIMA_SYNC, null);
}

/**
 * Renova o token quando falta menos de um minuto para expirar.
 *
 * Este endpoint é a exceção de toda a API: mora em `securetoken`, fala
 * `x-www-form-urlencoded` em vez de JSON, e devolve os campos em
 * snake_case (`id_token`) em vez de camelCase (`idToken`). Errar isso
 * dá um 400 silencioso que parece "sessão expirada" sem ser.
 *
 * Sobre não mandar o `content-type` na mão: passar um `URLSearchParams`
 * como corpo faz o navegador pôr o cabeçalho certo sozinho, e evita um
 * preflight de CORS que pode ser recusado.
 */
async function renovarToken(s) {
  const r = await fetch(`${TOKEN}?key=${encodeURIComponent(FIREBASE.apiKey)}`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: s.refreshToken }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    await DB.setConfig(CHAVE_SESSAO, null);
    throw new Error('Sua sessão expirou. Entre de novo.');
  }
  return salvarSessao({
    idToken: d.id_token,
    refreshToken: d.refresh_token,
    uid: d.user_id ?? s.uid,
    email: s.email,
    expiraEm: Date.now() + Number(d.expires_in ?? 3600) * 1000,
  });
}

/** Devolve uma sessão com token válido, renovando se preciso. */
async function sessaoValida() {
  const s = await lerSessao();
  if (!s?.idToken) throw new Error('Você não está conectado.');
  if ((s.expiraEm ?? 0) - Date.now() > 60000) return s;
  if (!s.refreshToken) {
    await DB.setConfig(CHAVE_SESSAO, null);
    throw new Error('Sua sessão expirou. Entre de novo.');
  }
  return renovarToken(s);
}

/* ------------------------------------------------------------------ */
/* Conta                                                               */
/* ------------------------------------------------------------------ */

export async function criarConta(email, senha) {
  const d = await chamarAuth('signUp', { email, password: senha, returnSecureToken: true });
  const s = await salvarSessao(daResposta(d));
  return { entrou: true, email: s.email };
}

export async function entrarComSenha(email, senha) {
  const d = await chamarAuth('signInWithPassword', { email, password: senha, returnSecureToken: true });
  const s = await salvarSessao(daResposta(d));
  return { email: s.email };
}

export async function pedirRedefinicaoDeSenha(email) {
  await chamarAuth('sendOobCode', { requestType: 'PASSWORD_RESET', email });
  return { email };
}

/**
 * Troca a senha da sessão aberta.
 *
 * Trocar a senha INVALIDA os tokens antigos e o Firebase devolve um par
 * novo. Sem regravar a sessão aqui, a próxima sincronização levaria um
 * 401 e o usuário seria expulso logo depois de mudar a senha.
 */
export async function trocarSenha(nova) {
  const s = await sessaoValida();
  const d = await chamarAuth('update', { idToken: s.idToken, password: nova, returnSecureToken: true });
  await salvarSessao({
    idToken: d.idToken ?? s.idToken,
    refreshToken: d.refreshToken ?? s.refreshToken,
    uid: d.localId ?? s.uid,
    email: d.email ?? s.email,
    expiraEm: Date.now() + Number(d.expiresIn ?? 3600) * 1000,
  });
  return { email: d.email ?? s.email };
}

/* ------------------------------------------------------------------ */
/* Firestore: conversão entre o formato local e o do banco             */
/*                                                                     */
/* O Firestore não guarda JSON solto: cada campo é um objeto que diz o  */
/* próprio tipo. Inteiro vai como STRING (`{integerValue:"15"}`) — é    */
/* assim mesmo, para caber int64 sem perder precisão em JavaScript.     */
/* ------------------------------------------------------------------ */

const txt = (v) => ({ stringValue: String(v) });
const num = (v) => ({ integerValue: String(Math.trunc(v)) });
const bool = (v) => ({ booleanValue: Boolean(v) });
const nulo = { nullValue: null };
const dec = (v) => ({ doubleValue: Number(v) });

const talvezNum = (v) => (v == null ? nulo : num(v));

function valorParaJs(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(valorParaJs);
  return null;
}

/**
 * `atualizadoEm` vai como STRING, não como timestamp do Firestore.
 *
 * É deliberado. A resolução de conflito compara essa data texto a texto,
 * e o Firestore normaliza timestamps na volta (mexe em casas decimais e
 * no sufixo). Guardar como string devolve exatamente o que foi gravado,
 * e a comparação continua idêntica à da versão anterior. Nada aqui
 * consulta o banco por data, então não se perde nada em troca.
 */
const paraBanco = (b) => ({
  fields: {
    loteria: txt(b.loteria),
    dezenas: { arrayValue: { values: (b.dezenas ?? []).map(num) } },
    concurso: talvezNum(b.concurso),
    origem: b.origem ? txt(b.origem) : nulo,
    grupo: b.grupo ? txt(b.grupo) : nulo,
    rotulo: b.rotulo ? txt(b.rotulo) : nulo,
    custo: dec(b.custo ?? 0),
    conferido: bool(b.conferido),
    acertos: talvezNum(b.acertos),
    premiado: bool(b.premiado),
    premio: dec(b.premio ?? 0),
    removido: bool(b.removido),
    criadoEm: b.criadoEm ? txt(b.criadoEm) : nulo,
    atualizadoEm: txt(b.atualizadoEm),
  },
});

function paraLocal(doc) {
  const f = doc.fields ?? {};
  const v = (k) => valorParaJs(f[k]);
  return {
    id: doc.name.split('/').pop(),
    loteria: v('loteria'),
    dezenas: (v('dezenas') ?? []).map(Number),
    concurso: v('concurso'),
    origem: v('origem') ?? '',
    grupo: v('grupo'),
    rotulo: v('rotulo') ?? '',
    custo: Number(v('custo') ?? 0),
    conferido: Boolean(v('conferido')),
    acertos: v('acertos'),
    premiado: Boolean(v('premiado')),
    premio: Number(v('premio') ?? 0),
    removido: Boolean(v('removido')),
    criadoEm: v('criadoEm'),
    atualizadoEm: v('atualizadoEm'),
  };
}

/* ------------------------------------------------------------------ */
/* Firestore: chamadas                                                 */
/* ------------------------------------------------------------------ */

const raiz = () => `projects/${FIREBASE.projectId}/databases/(default)/documents`;
const caminhoDosBilhetes = (uid) => `${raiz()}/${COLECAO_USUARIOS}/${uid}/${COLECAO_BILHETES}`;

async function chamarFirestore(url, opcoes = {}) {
  const s = await sessaoValida();
  const r = await fetch(url, {
    ...opcoes,
    headers: {
      authorization: `Bearer ${s.idToken}`,
      'content-type': 'application/json',
      ...(opcoes.headers ?? {}),
    },
  });

  if (!r.ok) {
    const corpo = await r.json().catch(() => ({}));
    const st = corpo?.error?.status;

    /* 403 é regra de segurança recusando; 401 é token inválido. Nunca
       ramificar pelo texto da mensagem, que não é documentado. */
    if (r.status === 403 || st === 'PERMISSION_DENIED') {
      throw new Error(
        'O Firestore recusou o acesso. Publique as regras de ' +
        '<code>firebase/firestore.rules</code> em Firestore Database → Regras.'
      );
    }
    if (r.status === 401) throw new Error('Sua sessão expirou. Entre de novo.');
    if (r.status === 404 || st === 'NOT_FOUND') {
      throw new Error(
        'Não achei o banco neste projeto. No console do Firebase, ' +
        'crie o Firestore Database (modo Nativo) uma vez.'
      );
    }
    throw new Error(`Firestore respondeu ${r.status}. ${corpo?.error?.message ?? ''}`.trim());
  }

  return r.status === 204 ? null : r.json();
}

/**
 * Lista TODOS os bilhetes do usuário.
 *
 * O Google não publica o padrão nem o teto do `pageSize`, e a própria
 * documentação avisa que o Firestore "pode devolver menos que esse
 * valor". Então a única leitura correta é seguir o `nextPageToken` até
 * ele sumir — nunca deduzir que acabou porque vieram menos documentos
 * do que o pedido.
 */
async function listarRemotos(uid) {
  const docs = [];
  let token = '';
  do {
    const url = `${FIRESTORE}/${caminhoDosBilhetes(uid)}?pageSize=300` +
                (token ? `&pageToken=${encodeURIComponent(token)}` : '');
    const p = await chamarFirestore(url);
    docs.push(...(p?.documents ?? []));
    token = p?.nextPageToken ?? '';
  } while (token);
  return docs;
}

/** Grava vários bilhetes de uma vez. */
async function gravarRemotos(uid, bilhetes) {
  const LOTE = 200;   // o teto por commit não é documentado; conservador de propósito
  for (let i = 0; i < bilhetes.length; i += LOTE) {
    const writes = bilhetes.slice(i, i + LOTE).map((b) => ({
      /* Sem `updateMask`, o PATCH é substituição completa — que é o que
         queremos: o bilhete local é a verdade inteira sobre ele. */
      update: { name: `${caminhoDosBilhetes(uid)}/${b.id}`, ...paraBanco(b) },
    }));
    await chamarFirestore(`${FIRESTORE}/projects/${FIREBASE.projectId}/databases/(default)/documents:commit`, {
      method: 'POST',
      body: JSON.stringify({ writes }),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Sincronização                                                       */
/* ------------------------------------------------------------------ */

/**
 * Uma rodada completa: empurra o que mudou aqui, puxa o que mudou lá, e
 * resolve cada conflito pela data mais recente.
 *
 * @returns {{enviados, recebidos, aplicados, quando}}
 */
export async function sincronizar({ completa = false } = {}) {
  const s = await sessaoValida();
  const uid = s.uid;
  if (!uid) throw new Error('Não consegui identificar o usuário na sessão.');

  /* O cursor serve só para o ENVIO — ali comparamos o nosso relógio com
     as nossas próprias datas, que é uma comparação legítima. */
  const desde = completa ? null : await DB.getConfig(CHAVE_ULTIMA_SYNC, null);
  const inicio = new Date().toISOString();

  /* ---- empurrar ---- */
  const locais = await DB.listarBilhetes(null, true);
  const aEnviar = desde ? locais.filter((b) => (b.atualizadoEm ?? '') > desde) : locais;
  if (aEnviar.length) await gravarRemotos(uid, aEnviar);

  /* ---- puxar: TUDO, sempre ----
     A tentação aqui é puxar só o que mudou desde a última vez. Testado,
     e está errado — deixa registro para trás:

       o celular edita um bilhete às 15h00 (data gravada: 15h00);
       o PC sincroniza às 15h01 (cursor do PC vai para 15h01);
       o celular só consegue enviar às 15h02 (o registro sobe com 15h00);
       o PC sincroniza de novo e pede "o que mudou depois de 15h01" —
       o registro tem 15h00 e fica invisível para sempre.

     O cursor mede o relógio de QUEM sincroniza; a data mede quando o
     OUTRO editou. Comparar os dois é a origem do buraco.

     Puxar tudo custa uma leitura por bilhete. Com centenas de bilhetes
     e o teto de 50 mil leituras por dia do plano gratuito, sobra folga
     de duas ordens de grandeza. */
  const remotos = await listarRemotos(uid);

  /* ---- mesclar: vence a data mais recente ---- */
  const porId = new Map(locais.map((b) => [b.id, b]));
  const aplicar = [];
  for (const doc of remotos) {
    const vindo = paraLocal(doc);
    const aqui = porId.get(vindo.id);
    if (!aqui || (vindo.atualizadoEm ?? '') > (aqui.atualizadoEm ?? '')) aplicar.push(vindo);
  }
  if (aplicar.length) await DB.gravarComoEsta(aplicar);

  await DB.setConfig(CHAVE_ULTIMA_SYNC, inicio);

  return {
    enviados: aEnviar.length,
    recebidos: remotos.length,
    aplicados: aplicar.length,
    quando: inicio,
  };
}

/** Confere se dá para falar com o banco, sem mexer em nada. */
export async function testarConexao() {
  const s = await sessaoValida();
  const p = await chamarFirestore(`${FIRESTORE}/${caminhoDosBilhetes(s.uid)}?pageSize=1`);
  return { ok: true, email: s.email ?? null, registros: (p?.documents ?? []).length };
}

export async function ultimaSincronizacao() {
  return DB.getConfig(CHAVE_ULTIMA_SYNC, null);
}

/* ------------------------------------------------------------------ */
/* Compatibilidade com a versão Supabase                               */
/*                                                                     */
/* A tela antiga chamava estas funções. Elas somem quando a interface   */
/* nova estiver publicada, mas enquanto convivem é melhor existir e     */
/* explicar do que estourar um "not a function" no console.             */
/* ------------------------------------------------------------------ */

export async function lerConfig() {
  return { url: FIREBASE.projectId, anonKey: FIREBASE.apiKey };
}

export async function salvarConfig() {
  throw new Error('As chaves agora ficam em <code>js/configuracao.js</code>, não nesta tela.');
}

export async function capturarRetornoDoLink() {
  return null;   // o Firebase não devolve sessão pela URL neste fluxo
}
