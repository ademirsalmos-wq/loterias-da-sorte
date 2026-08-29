/**
 * pwa.js — Instalação no aparelho e controle de versão do app.
 *
 * A parte delicada aqui não é instalar: é a ATUALIZAÇÃO.
 *
 * Um service worker mal feito guarda o app em cache e serve a versão velha
 * para sempre — o usuário corrige um bug, publica, e continua vendo o erro
 * sem entender por quê. Neste projeto já se perdeu tempo demais com "será
 * que a versão nova subiu?", então o desenho aqui é explícito:
 *
 *  - o service worker busca da rede primeiro (ver sw.js);
 *  - quando uma versão nova é detectada, uma faixa aparece no topo e o
 *    usuário decide quando recarregar — sem recarregar sozinho no meio de
 *    um fechamento de 500 bilhetes;
 *  - a página recarrega uma única vez quando o worker novo assume, com uma
 *    trava para não entrar em laço.
 */

let promptInstalacao = null;
let recarregando = false;

/* ------------------------------------------------------------------ */
/* Registro e atualização                                              */
/* ------------------------------------------------------------------ */

export async function registrarServiceWorker({ aoAtualizar } = {}) {
  if (!('serviceWorker' in navigator)) return null;
  // file:// não tem service worker, e não faz sentido tentar.
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return null;

  /* Havia um service worker no comando ANTES de registrarmos?
     Isso separa dois casos que parecem iguais e não são:
      - primeira visita: o worker assume o controle pela primeira vez e
        `controllerchange` dispara — recarregar aqui seria um susto sem
        motivo (e, dependendo do timing, um laço);
      - atualização: já havia um worker antigo, o novo assumiu, e aí sim a
        página precisa recarregar para rodar o código novo. */
  const tinhaControlador = Boolean(navigator.serviceWorker.controller);

  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });

    // Já existe um worker novo esperando (usuário abriu depois do deploy).
    if (reg.waiting && navigator.serviceWorker.controller) aoAtualizar?.(reg);

    reg.addEventListener('updatefound', () => {
      const novo = reg.installing;
      if (!novo) return;
      novo.addEventListener('statechange', () => {
        // `controller` existente significa que NÃO é a primeira instalação:
        // é atualização de verdade, e vale avisar.
        if (novo.state === 'installed' && navigator.serviceWorker.controller) {
          aoAtualizar?.(reg);
        }
      });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!tinhaControlador) return;   // primeira instalação: nada a recarregar
      if (recarregando) return;
      recarregando = true;
      location.reload();
    });

    // Procura versão nova a cada 30 min e quando a aba volta ao foco.
    setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) reg.update().catch(() => {});
    });

    return reg;
  } catch (e) {
    console.warn('[pwa] service worker não registrado:', e.message);
    return null;
  }
}

export function aplicarAtualizacao(reg) {
  if (reg?.waiting) reg.waiting.postMessage('assumir');
  else location.reload();
}

/* ------------------------------------------------------------------ */
/* Instalação                                                          */
/* ------------------------------------------------------------------ */

export function estaInstalado() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

/**
 * O Chrome dispara `beforeinstallprompt` e deixa a gente chamar o instalador
 * na hora certa. O Safari do iPhone não tem esse evento: lá só existe o
 * caminho manual, então detectamos e explicamos em vez de mostrar um botão
 * que não faria nada.
 */
export function prepararInstalacao({ aoPoderInstalar } = {}) {
  window.addEventListener('beforeinstallprompt', (ev) => {
    ev.preventDefault();
    promptInstalacao = ev;
    aoPoderInstalar?.({ automatico: true });
  });

  window.addEventListener('appinstalled', () => {
    promptInstalacao = null;
    aoPoderInstalar?.({ instalado: true });
  });

  if (!estaInstalado() && ehIOS()) aoPoderInstalar?.({ automatico: false, ios: true });
}

function ehIOS() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

export async function instalar() {
  if (!promptInstalacao) {
    return {
      ok: false,
      manual: true,
      ios: ehIOS(),
    };
  }
  promptInstalacao.prompt();
  const escolha = await promptInstalacao.userChoice;
  promptInstalacao = null;
  return { ok: escolha.outcome === 'accepted' };
}
