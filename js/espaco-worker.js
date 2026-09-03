/**
 * espaco-worker.js — a enumeração roda FORA da thread da tela.
 *
 * Por que um Worker, e não `await esperarPintura()` como as outras
 * operações demoradas deste app:
 *
 * As outras cabem em blocos curtos. Esta não cabe em bloco nenhum — a
 * busca em profundidade percorre até 50 milhões de folhas numa única
 * recursão, e não existe ponto natural para devolver o controle ao
 * navegador sem reescrever a busca inteira como máquina de estados.
 * Segurar a thread principal por 30 segundos congela tudo: o botão não
 * responde, a barra não anda, o celular oferece "fechar a página".
 *
 * E há a lição que já custou caro aqui: `requestAnimationFrame` não
 * dispara em aba escondida nem com a tela do celular apagada. Justamente
 * as operações que dá vontade de deixar rodando são as que travavam. Num
 * Worker isso não acontece — ele não depende de quadro nenhum para
 * continuar.
 *
 * CANCELAR é `worker.terminate()`, do lado de quem chamou. De propósito:
 * enquanto a busca roda, o Worker não processa mensagem nenhuma (é
 * single-thread também), então um `postMessage({tipo:'cancelar'})` só
 * seria lido depois que a busca terminasse — ou seja, nunca a tempo.
 * Um botão de cancelar que só funciona depois de pronto é pior que não
 * ter botão.
 */

import { LOTERIAS } from './config.js';
import { explorar, medir, bootstrap, veredito, viabilidade, mapaSorteados } from './espaco.js';

/** Envia progresso sem afogar a thread principal de mensagens. */
function fazerRelator(fase, minIntervaloMs = 120) {
  let ultimo = 0;
  return (feito, total) => {
    const agora = Date.now();
    if (agora - ultimo < minIntervaloMs) return;
    ultimo = agora;
    self.postMessage({ tipo: 'progresso', fase, feito, total });
  };
}

self.onmessage = (ev) => {
  const msg = ev.data ?? {};
  if (msg.tipo !== 'medir') return;

  try {
    const loteria = LOTERIAS[msg.loteriaId];
    if (!loteria) throw new Error(`Modalidade desconhecida: ${msg.loteriaId}`);

    const via = viabilidade(loteria, msg.filtros);
    if (!via.viavel) throw new Error(via.motivo);

    const concursos = msg.concursos ?? [];
    if (!concursos.length) throw new Error('A base de resultados está vazia.');

    const tamanho = via.tamanho;

    /* O reservatório é dimensionado pelo custo da medição, não por gosto:
       a varredura faz (bilhetes × concursos) comparações, e é ela que
       domina o tempo. Fixamos o orçamento e derivamos quantos bilhetes
       cabem — assim o tempo de espera não explode quando a base cresce. */
    const ORCAMENTO = 200_000_000;
    const reservatorio = Math.max(
      20_000,
      Math.min(400_000, Math.round(ORCAMENTO / Math.max(1, concursos.length)))
    );

    const contexto = {
      ultimoSorteio: msg.ultimoSorteio ?? null,
      mapaSorteados: msg.filtros?.evitarJaSorteados
        ? mapaSorteados(concursos, loteria, tamanho)
        : null,
    };

    self.postMessage({ tipo: 'fase', fase: 'enumerando', bruto: via.bruto });

    const espaco = explorar(loteria, msg.filtros, {
      reservatorio,
      contexto,
      semente: msg.semente ?? null,
      aoProgredir: fazerRelator('enumerando'),
    });

    if (!espaco.total) {
      self.postMessage({
        tipo: 'vazio',
        bruto: espaco.bruto,
        visitados: espaco.visitados,
        ms: espaco.ms,
      });
      return;
    }

    self.postMessage({ tipo: 'fase', fase: 'medindo', bilhetes: espaco.amostra.n });

    const medicao = medir(espaco.amostra, concursos, loteria, {
      tamanho,
      rateios: msg.rateios ?? {},
      estimados: msg.estimados ?? {},
      aoProgredir: fazerRelator('medindo'),
    });

    const ic = bootstrap(medicao.porConcurso, { rodadas: msg.rodadas ?? 400 });

    /* `porConcurso` são milhares de objetos que a tela não usa — só o
       bootstrap precisava deles, e ele já rodou aqui. Mandar de volta
       custaria a serialização inteira à toa. */
    const { porConcurso, ...resumoMedicao } = medicao;

    self.postMessage({
      tipo: 'pronto',
      espaco: {
        total: espaco.total,
        bruto: espaco.bruto,
        fracao: espaco.fracao,
        exata: espaco.exata,
        amostrados: espaco.amostra.n,
        tamanho: espaco.tamanho,
        visitados: espaco.visitados,
        ms: espaco.ms,
      },
      medicao: resumoMedicao,
      ic,
      veredito: veredito(medicao, ic, loteria),
    });
  } catch (e) {
    self.postMessage({ tipo: 'erro', mensagem: e?.message ?? String(e) });
  }
};
