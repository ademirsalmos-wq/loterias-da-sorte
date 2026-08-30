/**
 * Firebase de mentira, fiel o bastante para pegar erro de verdade:
 *  - inteiro vai e volta como STRING (integerValue)
 *  - o refresh mora noutro host, fala form-urlencoded e responde snake_case
 *  - a listagem PAGINA, e devolve menos do que o pageSize pedido
 *  - as regras de seguranca sao aplicadas de fato (403 fora do proprio uid)
 */
export function instalarFirebaseFalso(estado) {
  const AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts';
  const TOKEN = 'https://securetoken.googleapis.com/v1/token';
  const FS = 'https://firestore.googleapis.com/v1';

  estado.usuarios ??= new Map();   // email -> {senha, uid}
  estado.docs ??= new Map();       // caminho completo -> fields
  estado.tokens ??= new Map();     // idToken -> {uid, expira}
  estado.emails ??= 0;
  estado.chamadas ??= [];

  let seq = 0;
  const novoToken = (uid, segundos) => {
    const t = `id-${uid}-${++seq}`;
    estado.tokens.set(t, { uid, expira: Date.now() + segundos * 1000 });
    return t;
  };

  return async function roteador(url, init = {}) {
    const met = (init.method || 'GET').toUpperCase();
    estado.chamadas.push(`${met} ${url.split('?')[0]}`);
    const corpo = () => JSON.parse(init.body || '{}');
    const ok = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    const erro = (s, msg, status) => new Response(
      JSON.stringify({ error: { code: s, message: msg, status } }),
      { status: s, headers: { 'content-type': 'application/json' } });

    // ---------- AUTH ----------
    if (url.startsWith(AUTH)) {
      if (!url.includes('key=')) return erro(400, 'API key not valid', 'INVALID_ARGUMENT');
      const acao = url.slice(AUTH.length + 1).split('?')[0];
      const b = corpo();

      if (acao === 'signUp') {
        if (estado.usuarios.has(b.email)) return erro(400, 'EMAIL_EXISTS', 'INVALID_ARGUMENT');
        if ((b.password || '').length < 6) return erro(400, 'WEAK_PASSWORD : Password should be at least 6 characters', 'INVALID_ARGUMENT');
        const uid = `uid-${estado.usuarios.size + 1}`;
        estado.usuarios.set(b.email, { senha: b.password, uid });
        return ok({ idToken: novoToken(uid, estado.vidaDoToken ?? 3600), refreshToken: `rt-${uid}`,
                    localId: uid, email: b.email, expiresIn: String(estado.vidaDoToken ?? 3600) });
      }
      if (acao === 'signInWithPassword') {
        const u = estado.usuarios.get(b.email);
        // projeto moderno: nao distingue senha errada de e-mail inexistente
        if (!u || u.senha !== b.password) return erro(400, 'INVALID_LOGIN_CREDENTIALS', 'INVALID_ARGUMENT');
        return ok({ idToken: novoToken(u.uid, estado.vidaDoToken ?? 3600), refreshToken: `rt-${u.uid}`,
                    localId: u.uid, email: b.email, expiresIn: String(estado.vidaDoToken ?? 3600), registered: true });
      }
      if (acao === 'sendOobCode') {
        if (b.requestType === 'PASSWORD_RESET' && !estado.usuarios.has(b.email)) {
          return erro(400, 'EMAIL_NOT_FOUND', 'INVALID_ARGUMENT');
        }
        estado.emails++;
        return ok({ email: b.email });
      }
      if (acao === 'update') {
        const s = estado.tokens.get(b.idToken);
        if (!s) return erro(400, 'INVALID_ID_TOKEN', 'INVALID_ARGUMENT');
        if ((b.password || '').length < 6) return erro(400, 'WEAK_PASSWORD', 'INVALID_ARGUMENT');
        const par = [...estado.usuarios.entries()].find(([, u]) => u.uid === s.uid);
        par[1].senha = b.password;
        // trocar a senha INVALIDA os tokens antigos
        for (const [t, v] of estado.tokens) if (v.uid === s.uid) estado.tokens.delete(t);
        return ok({ localId: s.uid, email: par[0], idToken: novoToken(s.uid, 3600),
                    refreshToken: `rt-${s.uid}`, expiresIn: '3600' });
      }
      return erro(400, 'OPERATION_NOT_ALLOWED', 'INVALID_ARGUMENT');
    }

    // ---------- REFRESH ----------
    if (url.startsWith(TOKEN)) {
      const ct = init.headers?.['content-type'] ?? init.headers?.['Content-Type'] ?? '';
      const corpoTexto = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body ?? '');
      if (ct && ct.includes('application/json')) {
        estado.erroDeContentType = true;
        return erro(400, 'INVALID_GRANT_TYPE', 'INVALID_ARGUMENT');
      }
      const p = new URLSearchParams(corpoTexto);
      if (p.get('grant_type') !== 'refresh_token') return erro(400, 'INVALID_GRANT_TYPE', 'INVALID_ARGUMENT');
      const uid = (p.get('refresh_token') || '').replace(/^rt-/, '');
      if (!uid) return erro(400, 'INVALID_REFRESH_TOKEN', 'INVALID_ARGUMENT');
      estado.renovacoes = (estado.renovacoes ?? 0) + 1;
      // snake_case de proposito
      return ok({ id_token: novoToken(uid, 3600), refresh_token: `rt-${uid}`,
                  user_id: uid, expires_in: '3600', token_type: 'Bearer' });
    }

    // ---------- FIRESTORE ----------
    if (url.startsWith(FS)) {
      const auth = init.headers?.authorization ?? init.headers?.Authorization ?? '';
      const tok = auth.replace(/^Bearer /, '');
      const s = estado.tokens.get(tok);
      if (!s) return erro(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED');
      if (s.expira < Date.now()) return erro(401, 'expired', 'UNAUTHENTICATED');

      const semHost = url.slice(FS.length + 1);
      const [caminho, query] = semHost.split('?');
      const q = new URLSearchParams(query || '');

      if (caminho.endsWith(':commit')) {
        const writes = corpo().writes || [];
        for (const w of writes) {
          const nome = w.update.name;
          // REGRA DE SEGURANCA: so debaixo do proprio uid
          if (!nome.includes(`/usuarios/${s.uid}/`)) {
            return erro(403, 'Missing or insufficient permissions.', 'PERMISSION_DENIED');
          }
          estado.docs.set(nome, w.update.fields);
        }
        return ok({ writeResults: writes.map(() => ({ updateTime: new Date().toISOString() })),
                    commitTime: new Date().toISOString() });
      }

      // listagem
      const m = caminho.match(/^(projects\/[^/]+\/databases\/\(default\)\/documents\/usuarios\/([^/]+)\/bilhetes)$/);
      if (m && met === 'GET') {
        const [, base, uid] = m;
        if (uid !== s.uid) return erro(403, 'Missing or insufficient permissions.', 'PERMISSION_DENIED');
        const todos = [...estado.docs.entries()]
          .filter(([k]) => k.startsWith(base + '/'))
          .map(([name, fields]) => ({ name, fields }));
        // PAGINA de proposito, e devolve MENOS que o pageSize pedido
        const porPagina = estado.porPagina ?? 3;
        const de = Number(q.get('pageToken') || 0);
        const fatia = todos.slice(de, de + porPagina);
        const prox = de + porPagina;
        estado.paginasServidas = (estado.paginasServidas ?? 0) + 1;
        return ok({ documents: fatia, ...(prox < todos.length ? { nextPageToken: String(prox) } : {}) });
      }
      return erro(404, 'not found', 'NOT_FOUND');
    }

    return erro(404, 'sem rota', 'NOT_FOUND');
  };
}
