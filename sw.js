/**
 * sw.js — Service worker.
 *
 * O que ele faz: guarda os arquivos do app para funcionar sem internet.
 * O que ele NÃO faz, de propósito: guardar resultados de loteria.
 *
 * ---------------------------------------------------------------------
 * DUAS DECISÕES QUE MERECEM EXPLICAÇÃO
 *
 * 1. NUNCA tocamos nas chamadas à API da Caixa.
 *    Um resultado de concurso cacheado é pior que nenhum: o sistema
 *    inteiro foi reconstruído por causa de dados velhos servidos como se
 *    fossem novos. Requisição para outro domínio passa direto, sem o
 *    service worker se meter.
 *
 * 2. Rede primeiro, cache só como rede reserva.
 *    O caminho mais comum de service worker é "cache primeiro", que é
 *    mais rápido — e faz o usuário continuar rodando código velho depois
 *    de você publicar uma correção. Neste projeto já perdemos tempo
 *    demais com "será que a versão nova subiu?". O app tem uns 250 KB;
 *    rede primeiro custa milissegundos e elimina essa classe de dúvida.
 *    Sem internet, o cache assume e o app abre normalmente.
 * ---------------------------------------------------------------------
 */

/** Mude ao publicar: é o que dispara a limpeza do cache antigo. */
const VERSAO = 'v22-2026-08-31';
const CACHE = `loterias-${VERSAO}`;

/** O esqueleto do app. Se um destes faltar, a tela não abre. */
const ESSENCIAIS = [
  './',
  './index.html',
  './css/style.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/api.js',
  './js/backtest.js',
  './js/config.js',
  './js/configuracao.js',
  './js/db.js',
  './js/generator.js',
  './js/nuvem.js',
  './js/premios.js',
  './js/pwa.js',
  './js/resultados-ui.js',
  './js/retro-ui.js',
  './js/rotina.js',
  './js/stats.js',
  './js/tickets.js',
  './js/wheel.js',
  './icones/icone-192.png',
  './icones/icone-512.png',
];

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // addAll falha inteiro se um arquivo falhar; guardamos um a um para
      // um 404 isolado não impedir a instalação.
      await Promise.all(
        ESSENCIAIS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
        )
      );
    })()
  );
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(
        nomes.filter((n) => n.startsWith('loterias-') && n !== CACHE)
             .map((n) => caches.delete(n))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * A página manda "assumir agora" quando o usuário aceita atualizar.
 * Sem isso, o service worker novo fica esperando todas as abas fecharem.
 */
self.addEventListener('message', (ev) => {
  if (ev.data === 'assumir') self.skipWaiting();
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Outro domínio (a Caixa, o espelho, o Supabase): passa direto.
  // Nada de cachear resultado de sorteio nem resposta de banco.
  if (url.origin !== self.location.origin) return;

  ev.respondWith(
    (async () => {
      try {
        const daRede = await fetch(req);
        if (daRede && daRede.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, daRede.clone());
        }
        return daRede;
      } catch {
        const doCache = await caches.match(req);
        if (doCache) return doCache;

        // Navegação offline sem cache da rota: entrega o index.
        if (req.mode === 'navigate') {
          const raiz = await caches.match('./index.html');
          if (raiz) return raiz;
        }
        throw new Error('sem rede e sem cache');
      }
    })()
  );
});
