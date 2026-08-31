/**
 * db.js — Camada de persistência.
 *
 * A aplicação inteira fala com o objeto `DB`. Nada além deste arquivo sabe
 * COMO os dados são guardados.
 *
 * =====================================================================
 * LOCAL-FIRST, NÃO "OU LOCAL OU NUVEM"
 *
 * O desenho é: **IndexedDB é sempre a base de trabalho**. Tudo é lido e
 * escrito aqui, instantâneo e offline. A nuvem (js/nuvem.js) é um espelho
 * que sincroniza por cima, quando dá.
 *
 * Isso importa porque a alternativa — falar direto com o Supabase — faria
 * o app depender de internet para abrir uma tela, e travaria no celular
 * em elevador. Além de gastar cota de banco para ler o que já está aqui.
 *
 * Três consequências no formato dos registros:
 *
 *  1. `id` é um UUID, não um número sequencial. Com dois aparelhos, dois
 *     contadores independentes gerariam o id 1 nos dois e um sobrescreveria
 *     o outro na nuvem, em silêncio. UUID torna isso impossível.
 *
 *  2. Todo bilhete carrega `atualizadoEm`. É por essa data que o conflito
 *     entre aparelhos se resolve: vence a alteração mais recente.
 *
 *  3. Apagar é marcar `removido: true`, não sumir com o registro. Sem essa
 *     lápide, o aparelho que não viu a exclusão ressuscitaria o bilhete na
 *     próxima sincronização.
 * =====================================================================
 */

const DB_NOME = 'loterias-da-sorte';
const DB_VERSAO = 2;

const STORE_HISTORICO = 'historico';
const STORE_BILHETES = 'bilhetes';
const STORE_CONFIG = 'config';

/** Identificador único, com plano B para navegador sem crypto.randomUUID. */
export function novoId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

const agora = () => new Date().toISOString();

/* ------------------------------------------------------------------ */
/* Abertura e migração                                                 */
/* ------------------------------------------------------------------ */

let _conexao = null;

function criarStores(db) {
  if (!db.objectStoreNames.contains(STORE_HISTORICO)) {
    db.createObjectStore(STORE_HISTORICO, { keyPath: 'loteria' });
  }
  if (!db.objectStoreNames.contains(STORE_CONFIG)) {
    db.createObjectStore(STORE_CONFIG, { keyPath: 'chave' });
  }
}

/**
 * v1 → v2: bilhetes deixam de ter id sequencial e passam a ter UUID.
 *
 * Não dá para mudar `autoIncrement` de um object store existente, então o
 * caminho é: ler tudo, destruir, recriar e regravar com o id novo. Roda
 * dentro da transação de upgrade, que continua viva entre os callbacks.
 */
function migrarParaUUID(db, tx, aoTerminar) {
  if (!db.objectStoreNames.contains(STORE_BILHETES)) {
    const s = db.createObjectStore(STORE_BILHETES, { keyPath: 'id' });
    s.createIndex('porLoteria', 'loteria', { unique: false });
    s.createIndex('porConcurso', ['loteria', 'concurso'], { unique: false });
    aoTerminar();
    return;
  }

  const pedido = tx.objectStore(STORE_BILHETES).getAll();
  pedido.onsuccess = () => {
    const antigos = pedido.result ?? [];

    db.deleteObjectStore(STORE_BILHETES);
    const novo = db.createObjectStore(STORE_BILHETES, { keyPath: 'id' });
    novo.createIndex('porLoteria', 'loteria', { unique: false });
    novo.createIndex('porConcurso', ['loteria', 'concurso'], { unique: false });

    for (const b of antigos) {
      novo.put({
        ...b,
        id: novoId(),
        idAntigo: b.id ?? null,        // rastro, caso algo precise ser conferido
        removido: false,
        atualizadoEm: b.criadoEm ?? agora(),
      });
    }
    aoTerminar(antigos.length);
  };
  pedido.onerror = () => aoTerminar(0);
}

function abrir() {
  if (_conexao) return Promise.resolve(_conexao);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOME, DB_VERSAO);

    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      const tx = ev.target.transaction;

      criarStores(db);

      if (ev.oldVersion < 2) {
        migrarParaUUID(db, tx, (quantos) => {
          if (quantos) console.info(`[db] ${quantos} bilhete(s) migrados para UUID.`);
        });
      }
    };

    req.onsuccess = () => {
      _conexao = req.result;
      resolve(_conexao);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('Feche as outras abas do sistema para atualizar o banco.'));
  });
}

function transacao(store, modo, fn) {
  return abrir().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, modo);
        const os = tx.objectStore(store);
        let resultado;
        try {
          resultado = fn(os);
        } catch (e) {
          reject(e);
          return;
        }
        tx.oncomplete = () => {
          // Cuidado: `'result' in x` estoura se x for número ou string.
          const ehRequest =
            resultado !== null && typeof resultado === 'object' && 'result' in resultado;
          resolve(ehRequest ? resultado.result : resultado);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

/* ------------------------------------------------------------------ */
/* Adaptador IndexedDB                                                 */
/* ------------------------------------------------------------------ */

export const DB = {
  nome: 'IndexedDB (local)',

  /* ---- histórico de concursos ---- */

  async salvarHistorico(loteriaId, concursos, meta = {}) {
    return transacao(STORE_HISTORICO, 'readwrite', (os) =>
      os.put({
        loteria: loteriaId,
        concursos,
        atualizadoEm: agora(),
        ...meta,
      })
    );
  },

  async lerHistorico(loteriaId) {
    return transacao(STORE_HISTORICO, 'readonly', (os) => os.get(loteriaId));
  },

  async limparHistorico(loteriaId) {
    return transacao(STORE_HISTORICO, 'readwrite', (os) => os.delete(loteriaId));
  },

  /**
   * Junta rateios ao registro do histórico, mexendo SÓ nessa parte.
   *
   * `salvarHistorico` substitui o registro inteiro, o que aqui seria um
   * desastre: o download de prêmios roda em lotes de centenas de rodadas, e
   * uma delas gravando o registro inteiro com um `concursos` desatualizado
   * apagaria a base de sorteios de quem sincronizou no meio. Esta função lê,
   * mescla e regrava tudo o que já existia; o único campo que ela introduz é
   * `rateios`.
   *
   * Grava numa transação só, e não em `readonly` + `readwrite` separados,
   * porque duas transações deixam uma janela entre a leitura e a escrita.
   *
   * @param {string} loteriaId
   * @param {object} novos  `{ numero: { acertos: [valor, ganhadores] } }`
   * @returns {number} quantos concursos entraram
   */
  async mesclarRateios(loteriaId, novos) {
    const quantos = Object.keys(novos ?? {}).length;
    if (!quantos) return 0;

    return transacao(STORE_HISTORICO, 'readwrite', (os) => {
      const pedido = os.get(loteriaId);
      pedido.onsuccess = () => {
        const reg = pedido.result;
        // Sem histórico gravado não há em que pendurar o rateio. Criar um
        // registro só com prêmios deixaria uma base sem sorteio nenhum.
        if (!reg) return;
        os.put({
          ...reg,
          rateios: { ...(reg.rateios ?? {}), ...novos },
          rateiosAtualizadoEm: agora(),
        });
      };
      return quantos;
    });
  },

  /* ---- bilhetes ---- */

  /** Normaliza o registro: garante id, data de alteração e lápide. */
  _preparar(b) {
    return {
      ...b,
      id: b.id ?? novoId(),
      removido: b.removido ?? false,
      atualizadoEm: b.atualizadoEm ?? agora(),
    };
  },

  async salvarBilhete(bilhete) {
    const reg = DB._preparar({ ...bilhete, atualizadoEm: agora() });
    await transacao(STORE_BILHETES, 'readwrite', (os) => os.put(reg));
    return reg.id;
  },

  async salvarBilhetes(lista) {
    const regs = lista.map((b) => DB._preparar({ ...b, atualizadoEm: agora() }));
    await transacao(STORE_BILHETES, 'readwrite', (os) => {
      for (const r of regs) os.put(r);
      return regs.length;
    });
    return regs;
  },

  /**
   * Grava exatamente como veio, sem mexer em `atualizadoEm`.
   * É o que a sincronização usa ao trazer registros da nuvem — carimbar a
   * data de novo faria o registro parecer mais novo do que é e criaria um
   * pingue-pongue infinito entre os aparelhos.
   */
  async gravarComoEsta(lista) {
    return transacao(STORE_BILHETES, 'readwrite', (os) => {
      for (const b of lista) os.put(DB._preparar(b));
      return lista.length;
    });
  },

  /** Por padrão esconde os removidos; `incluirRemovidos` é para a sincronização. */
  async listarBilhetes(loteriaId = null, incluirRemovidos = false) {
    const todos = await transacao(STORE_BILHETES, 'readonly', (os) =>
      loteriaId ? os.index('porLoteria').getAll(loteriaId) : os.getAll()
    );
    return incluirRemovidos ? todos : todos.filter((b) => !b.removido);
  },

  /**
   * Apagar é marcar, não sumir. Sem a lápide, o outro aparelho não fica
   * sabendo da exclusão e devolve o bilhete na próxima sincronização.
   */
  async apagarBilhete(id) {
    const atual = await transacao(STORE_BILHETES, 'readonly', (os) => os.get(id));
    if (!atual) return;
    return transacao(STORE_BILHETES, 'readwrite', (os) =>
      os.put({ ...atual, removido: true, atualizadoEm: agora() })
    );
  },

  async apagarTodosBilhetes() {
    const todos = await DB.listarBilhetes(null, true);
    const marcados = todos
      .filter((b) => !b.removido)
      .map((b) => ({ ...b, removido: true, atualizadoEm: agora() }));
    if (!marcados.length) return 0;
    return transacao(STORE_BILHETES, 'readwrite', (os) => {
      for (const b of marcados) os.put(b);
      return marcados.length;
    });
  },

  /** Remove de vez as lápides antigas — a nuvem já as propagou faz tempo. */
  async limparLapides(diasParaGuardar = 90) {
    const corte = Date.now() - diasParaGuardar * 86400000;
    const todos = await DB.listarBilhetes(null, true);
    const velhas = todos.filter(
      (b) => b.removido && new Date(b.atualizadoEm ?? 0).getTime() < corte
    );
    if (!velhas.length) return 0;
    return transacao(STORE_BILHETES, 'readwrite', (os) => {
      for (const b of velhas) os.delete(b.id);
      return velhas.length;
    });
  },

  /* ---- configurações ---- */

  async setConfig(chave, valor) {
    return transacao(STORE_CONFIG, 'readwrite', (os) => os.put({ chave, valor }));
  },

  async getConfig(chave, padrao = null) {
    const r = await transacao(STORE_CONFIG, 'readonly', (os) => os.get(chave));
    return r ? r.valor : padrao;
  },

  async todasConfigs() {
    const linhas = await transacao(STORE_CONFIG, 'readonly', (os) => os.getAll());
    return Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
  },
};
