/**
 * db.js — Camada de persistência.
 *
 * A aplicação inteira fala com o objeto `DB` exportado no fim do arquivo.
 * Nada além deste arquivo sabe COMO os dados são guardados. Hoje o padrão
 * é IndexedDB (100% local, offline, sem custo). Se um dia você quiser
 * sincronizar entre celular e PC, preencha as credenciais em
 * `SUPABASE_CONFIG` e troque a linha final — o resto do sistema não muda.
 *
 * Stores:
 *  - historico : um registro por loteria com TODOS os concursos (blob único).
 *                Muito mais rápido do que 3.500 registros soltos.
 *  - bilhetes  : as suas apostas.
 *  - config    : chave/valor (preferências, preços, última sincronização).
 */

const DB_NOME = 'loterias-da-sorte';
const DB_VERSAO = 1;

const STORE_HISTORICO = 'historico';
const STORE_BILHETES = 'bilhetes';
const STORE_CONFIG = 'config';

/* ------------------------------------------------------------------ */
/* Adaptador IndexedDB                                                 */
/* ------------------------------------------------------------------ */

let _conexao = null;

function abrir() {
  if (_conexao) return Promise.resolve(_conexao);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOME, DB_VERSAO);

    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;

      if (!db.objectStoreNames.contains(STORE_HISTORICO)) {
        db.createObjectStore(STORE_HISTORICO, { keyPath: 'loteria' });
      }

      if (!db.objectStoreNames.contains(STORE_BILHETES)) {
        const s = db.createObjectStore(STORE_BILHETES, {
          keyPath: 'id',
          autoIncrement: true,
        });
        s.createIndex('porLoteria', 'loteria', { unique: false });
        s.createIndex('porConcurso', ['loteria', 'concurso'], { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_CONFIG)) {
        db.createObjectStore(STORE_CONFIG, { keyPath: 'chave' });
      }
    };

    req.onsuccess = () => {
      _conexao = req.result;
      resolve(_conexao);
    };
    req.onerror = () => reject(req.error);
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
          // Se fn devolveu uma IDBRequest, entrega o .result dela.
          // (Cuidado: `'result' in x` estoura se x for número ou string.)
          const ehRequest =
            resultado !== null &&
            typeof resultado === 'object' &&
            'result' in resultado;
          resolve(ehRequest ? resultado.result : resultado);
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      })
  );
}

const IndexedDBAdapter = {
  nome: 'IndexedDB (local)',

  /* ---- histórico de concursos ---- */

  async salvarHistorico(loteriaId, concursos, meta = {}) {
    return transacao(STORE_HISTORICO, 'readwrite', (os) =>
      os.put({
        loteria: loteriaId,
        concursos, // { "3401": [1,2,3,...], ... }
        atualizadoEm: new Date().toISOString(),
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

  /* ---- bilhetes ---- */

  async salvarBilhete(bilhete) {
    const registro = { ...bilhete };
    if (registro.id == null) delete registro.id;
    return transacao(STORE_BILHETES, 'readwrite', (os) => os.put(registro));
  },

  async salvarBilhetes(lista) {
    return transacao(STORE_BILHETES, 'readwrite', (os) => {
      for (const b of lista) {
        const registro = { ...b };
        if (registro.id == null) delete registro.id;
        os.put(registro);
      }
      return lista.length;
    });
  },

  async listarBilhetes(loteriaId = null) {
    return transacao(STORE_BILHETES, 'readonly', (os) =>
      loteriaId ? os.index('porLoteria').getAll(loteriaId) : os.getAll()
    );
  },

  async apagarBilhete(id) {
    return transacao(STORE_BILHETES, 'readwrite', (os) => os.delete(id));
  },

  async apagarTodosBilhetes() {
    return transacao(STORE_BILHETES, 'readwrite', (os) => os.clear());
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

/* ------------------------------------------------------------------ */
/* Adaptador Supabase (opcional — desligado por padrão)                */
/* ------------------------------------------------------------------ */

/**
 * Para ligar a sincronização em nuvem:
 *
 * 1. Crie uma NOVA organização free no Supabase (o limite de 2 projetos
 *    é por organização, não por conta — assim você não gasta os seus).
 * 2. Rode o SQL de `supabase/schema.sql` no editor do projeto.
 * 3. Preencha url e anonKey abaixo.
 * 4. Troque a última linha deste arquivo para:
 *        export const DB = SupabaseAdapter;
 *
 * O histórico de concursos continua em IndexedDB mesmo com Supabase ligado:
 * são dados públicos, pesados e idênticos para todo mundo — não faz sentido
 * ocupar banco com eles.
 */
export const SUPABASE_CONFIG = {
  url: '',
  anonKey: '',
};

export const SupabaseAdapter = {
  nome: 'Supabase (nuvem)',
  _cli: null,

  async cliente() {
    if (this._cli) return this._cli;
    if (!SUPABASE_CONFIG.url || !SUPABASE_CONFIG.anonKey) {
      throw new Error('Supabase não configurado — preencha SUPABASE_CONFIG em js/db.js');
    }
    const { createClient } = await import(
      'https://esm.sh/@supabase/supabase-js@2'
    );
    this._cli = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    return this._cli;
  },

  // Histórico continua local — dados públicos e pesados.
  salvarHistorico: IndexedDBAdapter.salvarHistorico,
  lerHistorico: IndexedDBAdapter.lerHistorico,
  limparHistorico: IndexedDBAdapter.limparHistorico,

  async salvarBilhete(bilhete) {
    const c = await this.cliente();
    const { data, error } = await c.from('bilhetes').upsert(bilhete).select().single();
    if (error) throw error;
    return data.id;
  },

  async salvarBilhetes(lista) {
    const c = await this.cliente();
    const { error } = await c.from('bilhetes').upsert(lista);
    if (error) throw error;
    return lista.length;
  },

  async listarBilhetes(loteriaId = null) {
    const c = await this.cliente();
    let q = c.from('bilhetes').select('*');
    if (loteriaId) q = q.eq('loteria', loteriaId);
    const { data, error } = await q.order('id', { ascending: false });
    if (error) throw error;
    return data;
  },

  async apagarBilhete(id) {
    const c = await this.cliente();
    const { error } = await c.from('bilhetes').delete().eq('id', id);
    if (error) throw error;
  },

  async apagarTodosBilhetes() {
    const c = await this.cliente();
    const { error } = await c.from('bilhetes').delete().neq('id', 0);
    if (error) throw error;
  },

  // Configurações continuam locais (são preferências do dispositivo).
  setConfig: IndexedDBAdapter.setConfig,
  getConfig: IndexedDBAdapter.getConfig,
  todasConfigs: IndexedDBAdapter.todasConfigs,
};

/* ------------------------------------------------------------------ */

/** Troque aqui para SupabaseAdapter quando quiser sincronizar. */
export const DB = IndexedDBAdapter;
