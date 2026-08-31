/**
 * app.js — Orquestração da interface.
 */

import { LOTERIAS, LISTA_LOTERIAS, universoDe, fmt, brl } from './config.js';
import { DB } from './db.js';
import {
  sincronizar, importarArquivo, carregarHistorico,
  urlDoProxy, definirProxy, testarFonte, CAIXA,
  baixarRateios, coberturaDeRateios,
} from './api.js';
import { analisar, sugerirFiltros } from './stats.js';
import { gerar, filtrosPadrao, combinacoesSorteadas, pontuacaoPopularidade } from './generator.js';
import {
  fechar, minimoTeorico, binomial, probabilidadeCenario, umEmQuantos,
} from './wheel.js';
import {
  custoAposta, montarBilhetes, conferirTodos, balanco,
  exportarTexto, exportarCSV,
} from './tickets.js';
import { iniciarRetrospectiva, atualizarRetrospectiva } from './retro-ui.js';
import {
  rodarRotinaCompleta, lerBoletim, dispensarBoletim, bilhetesEmAberto,
  diagnosticarBase,
} from './rotina.js';
import {
  registrarServiceWorker, aplicarAtualizacao, prepararInstalacao,
  instalar, estaInstalado,
} from './pwa.js';
import * as Nuvem from './nuvem.js';
import { iniciarResultados, atualizarResultados } from './resultados-ui.js';

/* ------------------------------------------------------------------ */
/* Estado                                                              */
/* ------------------------------------------------------------------ */

const estado = {
  loteriaId: 'lotofacil',
  historico: [],
  rateios: {},   // {concurso: {acertos: [valor, ganhadores]}} — o que a Caixa pagou
  atualizadoEm: null,
  analise: null,
  janela: 0,
  precos: {},
  premios: {},   // estimativas do usuário para as faixas de rateio
  volanteGerador: new Map(),   // dezena -> 'fixa' | 'excluida'
  volanteFechamento: new Set(),
  jogosGerados: [],
  fechamentoAtual: null,
  // O usuário mexeu no seletor de cenário? Se não, ele acompanha o volante.
  cenarioManual: false,
  garantiaManual: false,
  trocouLoteria: true,
  /** Mensagem da última falha de sincronização, ou null. */
  erroNuvem: null,
  trocouRetro: true,
  infoBase: null,
  diagnostico: null,
};

const loteria = () => LOTERIAS[estado.loteriaId];
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

/* ------------------------------------------------------------------ */
/* Utilidades de UI                                                    */
/* ------------------------------------------------------------------ */

let timerToast;
/**
 * As mensagens de erro da nuvem trazem `<b>` e `<code>` porque nascem para
 * o recado do login, que é renderizado como HTML. No toast, que usa
 * `textContent` por segurança, elas apareciam com as tags à mostra —
 * "Publique as regras de <code>firebase/firestore.rules</code>".
 *
 * A saída é tirar as tags aqui, e não passar a renderizar HTML no toast:
 * parte dessas mensagens carrega texto vindo da API do Firebase, e isso
 * não deve virar marcação.
 */
const semTags = (s) => String(s)
  .replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

function toast(msg, erro = false) {
  const el = $('#toast');
  const texto = semTags(msg);
  el.textContent = texto;
  el.classList.toggle('erro', erro);
  el.classList.add('visivel');
  clearTimeout(timerToast);
  /* Um recado de três linhas não se lê em 3,6 s. O tempo acompanha o
     tamanho, com teto para não ficar preso na tela. */
  const tempo = Math.min(12000, Math.max(3600, texto.length * 65));
  timerToast = setTimeout(() => el.classList.remove('visivel'), tempo);
}

/**
 * Dá ao navegador uma folga para desenhar o "Gerando…" antes de o cálculo
 * pesado travar a thread.
 *
 * O `requestAnimationFrame` sozinho NÃO serve: quando a aba está em segundo
 * plano ou a tela do celular apagou, o navegador para de pintar e o quadro
 * nunca chega. A promessa ficava pendente para sempre, o `finally` que
 * devolve o botão ao normal nunca rodava, e o botão congelava em "Gerando…"
 * até recarregar a página. Acontecia justamente nas operações demoradas —
 * gerador, fechamento, varredura — que são as que dá vontade de deixar
 * rodando enquanto se faz outra coisa.
 *
 * Por isso o quadro corre contra um relógio: se não vier, seguimos assim
 * mesmo. Não há nada para pintar numa aba invisível.
 */
function esperarPintura() {
  return new Promise((r) => {
    let pronto = false;
    const seguir = () => { if (!pronto) { pronto = true; r(); } };
    requestAnimationFrame(() => setTimeout(seguir, 0));
    setTimeout(seguir, 60);
  });
}

/**
 * De onde saiu o valor do prêmio — a coluna sozinha não conta essa história.
 *
 * Sem isto, R$ 1.784,10 preenchido pelo sistema e R$ 1.784,10 digitado à
 * mão ficam idênticos na tela, e o usuário não tem como saber qual número
 * ele ainda precisa conferir no comprovante.
 */
const FONTE_PREMIO = {
  apurado: ['apurado', 'Rateio que a Caixa pagou nesta faixa, neste concurso'],
  fixo: ['fixo', 'Valor garantido por regulamento'],
  manual: ['seu', 'Você digitou este valor — a conferência não mexe nele'],
};

function seloDoPremio(bilhete) {
  const f = FONTE_PREMIO[bilhete.premioFonte];
  if (!f || !(bilhete.premio > 0)) return '';
  return `<span class="selo fonte-premio" title="${f[1]}">${f[0]}</span>`;
}

function bolinhas(dezenas, destaque = new Set(), classe = 'acerto') {
  return dezenas
    .map((d) => `<span class="bolinha ${destaque.has(d) ? classe : ''}">${fmt(d, loteria())}</span>`)
    .join('');
}

/**
 * Gráfico de barras horizontais.
 *
 * `base` desloca o zero da escala. Serve para frequências: quando todas as
 * dezenas saíram entre 2.049 e 2.111 vezes, barras a partir do zero ficam
 * todas iguais e o gráfico não diz nada. Com a base no menor valor, a
 * diferença aparece — desde que fique claro que ela é ruído, não tendência.
 */
function grafico(itens, { max = null, base = 0, formatar = (v) => v } = {}) {
  if (!itens.length) return '<p class="vazio">Sem dados.</p>';
  const teto = max ?? Math.max(...itens.map((i) => i.valor));
  const faixa = teto - base || 1;
  return itens
    .map((i) => {
      const largura = Math.max(0, Math.min(100, ((i.valor - base) / faixa) * 100));
      return `
      <div class="barra-linha">
        <span class="barra-rotulo">${i.rotulo}</span>
        <div class="barra-trilho"><div class="barra-preenchida" style="width:${largura}%"></div></div>
        <span class="barra-valor">${formatar(i.valor, i)}</span>
      </div>`;
    })
    .join('');
}

function corDoCalor(t) {
  // t de 0 (menos sorteada) a 1 (mais sorteada)
  const paradas = [
    [30, 58, 95], [37, 99, 235], [74, 222, 128], [251, 191, 36], [248, 113, 113],
  ];
  const p = Math.max(0, Math.min(0.9999, t)) * (paradas.length - 1);
  const i = Math.floor(p);
  const f = p - i;
  const c = paradas[i].map((v, k) => Math.round(v + (paradas[i + 1][k] - v) * f));
  return `rgb(${c.join(',')})`;
}

/* ------------------------------------------------------------------ */
/* Navegação                                                           */
/* ------------------------------------------------------------------ */

$$('.aba').forEach((aba) => {
  aba.addEventListener('click', () => {
    $$('.aba').forEach((a) => a.classList.remove('ativa'));
    $$('.tela').forEach((t) => t.classList.remove('ativa'));
    aba.classList.add('ativa');
    $(`#${aba.dataset.alvo}`).classList.add('ativa');
    window.scrollTo({ top: 0, behavior: 'smooth' });

    /* As tabelas de Configurações são retratos do banco, e eram desenhadas
       uma única vez no arranque — antes de a sincronização terminar. Quem
       abrisse a aba depois via "0 de 0 concursos" numa base cheia: a tela
       afirmando algo que o banco desmentia. Refazer ao abrir custa duas
       leituras e elimina a classe inteira desse defeito. */
    if (aba.dataset.alvo === 'config') renderConfig();
  });
});

function montarSeletorLoteria() {
  $('#seletorLoteria').innerHTML = LISTA_LOTERIAS.map(
    (l) => `<button class="chip-loteria ${l.id === estado.loteriaId ? 'ativa' : ''}" data-id="${l.id}">${l.nome}</button>`
  ).join('');

  $$('.chip-loteria').forEach((chip) => {
    chip.addEventListener('click', async () => {
      estado.loteriaId = chip.dataset.id;
      estado.volanteGerador.clear();
      estado.volanteFechamento.clear();
      estado.jogosGerados = [];
      estado.fechamentoAtual = null;
      estado.cenarioManual = false;
      estado.garantiaManual = false;
      estado.trocouLoteria = true;
      estado.trocouRetro = true;
      // Resultados e filtros de outra modalidade não fazem sentido aqui.
      $('#caixaResultadoGerador').hidden = true;
      $('#listaGerados').innerHTML = '';
      $('#infoGeracao').innerHTML = '';
      $('#caixaResultadoFechamento').hidden = true;
      $('#listaFechamento').innerHTML = '';
      montarSeletorLoteria();
      await trocarLoteria();
    });
  });

  const l = loteria();
  document.documentElement.style.setProperty('--loteria', l.cor);
  /* A marca de "repetiu do concurso anterior" é amarela. Onde a cor da
     modalidade é próxima do amarelo — a Lotomania é laranja — a borda
     some em cima da célula marcada. Nesse caso entra um fio escuro por
     dentro para separar as duas cores. `transparent` desenha nada, então
     nas outras modalidades a regra do CSS é a mesma sem efeito nenhum. */
  document.documentElement.style.setProperty(
    '--separa-marca', l.marcaPrecisaSeparacao ? 'var(--fundo)' : 'transparent'
  );
}

/* ------------------------------------------------------------------ */
/* Carregamento de dados                                               */
/* ------------------------------------------------------------------ */

async function trocarLoteria() {
  /* `montarOpcoesGerador()` CONSOME e zera `estado.trocouLoteria`, e roda
     antes de `preencherConcursoAlvo()`. Guardar aqui é o que faz o campo de
     concurso alvo saber que a modalidade mudou. */
  const trocou = estado.trocouLoteria;
  const hist = await carregarHistorico(estado.loteriaId);
  estado.historico = hist.concursos;
  estado.rateios = hist.rateios ?? {};
  estado.atualizadoEm = hist.atualizadoEm;
  estado.infoBase = hist;
  estado.diagnostico = diagnosticarBase(loteria(), hist);
  estado.analise = hist.concursos.length
    ? analisar(hist.concursos, loteria(), estado.janela || null)
    : null;

  renderPainel();
  renderEstatisticas();
  montarVolanteGerador();
  montarVolanteFechamento();
  montarOpcoesGerador();
  montarOpcoesFechamento();
  preencherConcursoAlvo({ trocouLoteria: trocou });
  renderAlertaBase();
  atualizarResultados();
  await renderBilhetes();
  await renderBoletim();
  await renderEmAberto();
  await atualizarRetrospectiva(estado.trocouRetro);
  estado.trocouRetro = false;
}

async function sincronizarLoteria(id, silencioso = false) {
  const btn = $('#btnSincronizar');
  /* Guardar o rótulo em vez de escrever um fixo no `finally`.
     Havia um "Atualizar resultados" cravado ali, mas o botão do Painel se
     chama "Verificar agora" — então usar "Baixar tudo de novo" nas
     Configurações RENOMEAVA o botão do Painel, permanentemente, sem o
     usuário estar sequer olhando para ele. */
  const rotulo = btn?.textContent ?? 'Verificar agora';
  if (btn) { btn.disabled = true; btn.textContent = 'Baixando…'; }
  try {
    const r = await sincronizar(id, (m) => { if (!silencioso) $('#notaSync').textContent = m; });
    if (!silencioso) toast(`${LOTERIAS[id].nome}: ${r.total} concursos, até o ${r.ultimo}.`);
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = rotulo; }
    if (!silencioso) $('#notaSync').textContent = '';
  }
}

/* ------------------------------------------------------------------ */
/* Painel                                                              */
/* ------------------------------------------------------------------ */

async function renderPainel() {
  const l = loteria();
  const a = estado.analise;

  /* cards */
  const bilhetes = await DB.listarBilhetes(estado.loteriaId);
  const b = balanco(bilhetes);
  const cards = [
    { rotulo: 'Concursos na base', valor: estado.historico.length.toLocaleString('pt-BR'),
      rodape: estado.historico.length ? `até o nº ${estado.historico[estado.historico.length - 1].numero}` : 'base vazia' },
    { rotulo: 'Bilhetes cadastrados', valor: b.total, rodape: `${b.premiados} premiados` },
    { rotulo: 'Investido', valor: brl(b.gasto), rodape: 'soma das apostas' },
    { rotulo: 'Saldo', valor: brl(b.saldo), classe: b.saldo >= 0 ? 'positivo' : 'negativo',
      rodape: b.gasto ? `${b.roi.toFixed(1)}% de retorno` : '—' },
  ];
  $('#cardsPainel').innerHTML = cards.map(
    (c) => `<div class="card">
      <div class="rotulo">${c.rotulo}</div>
      <div class="valor ${c.classe ?? ''}">${c.valor}</div>
      <div class="rodape">${c.rodape}</div>
    </div>`
  ).join('');

  /* último sorteio */
  if (!estado.historico.length) {
    $('#ultimoSorteio').innerHTML = '<p class="vazio">Base vazia — clique em "Verificar agora", logo abaixo.</p>';
  } else {
    const u = estado.historico[estado.historico.length - 1];
    $('#ultimoSorteio').innerHTML = `
      <p class="nota">Concurso <b>${u.numero}</b></p>
      <div class="jogo" style="border:none;padding:0;background:none">
        ${u.dezenas.map((d) => `<span class="bolinha sorteada">${fmt(d, l)}</span>`).join('')}
      </div>`;
  }

  /* status da base */
  const quando = estado.atualizadoEm
    ? new Date(estado.atualizadoEm).toLocaleString('pt-BR')
    : 'nunca';
  $('#statusBase').innerHTML = `
    <table>
      <tr><td>Modalidade</td><td><b>${l.nome}</b></td></tr>
      <tr><td>Dezenas</td><td>${l.marcarMin}${l.marcarMax > l.marcarMin ? ` a ${l.marcarMax}` : ''} de ${l.universo}</td></tr>
      <tr><td>Sorteadas</td><td>${l.sorteadas}</td></tr>
      <tr><td>Aposta simples</td><td>${brl(precoDe(l))}</td></tr>
      <tr><td>Última atualização</td><td>${quando}</td></tr>
    </table>`;

  /* balanço */
  $('#balancoPainel').innerHTML = b.total
    ? `<div class="cards">
        <div class="card"><div class="rotulo">Apostado</div><div class="valor">${brl(b.gasto)}</div></div>
        <div class="card"><div class="rotulo">Recebido</div><div class="valor">${brl(b.retorno)}</div></div>
        <div class="card"><div class="rotulo">Saldo</div><div class="valor ${b.saldo >= 0 ? 'positivo' : 'negativo'}">${brl(b.saldo)}</div></div>
       </div>
       ${b.porFaixa.length ? `<table><thead><tr><th>Acertos</th><th>Bilhetes</th></tr></thead><tbody>
         ${b.porFaixa.map(([ac, q]) => `<tr><td>${ac}${l.faixas.includes(ac) ? ' 🏆' : ''}</td><td>${q}</td></tr>`).join('')}
       </tbody></table>` : ''}`
    : '<p class="vazio">Nenhum bilhete cadastrado ainda.</p>';
}

/**
 * O aviso que faltava.
 *
 * O sistema passou meses conferindo bilhetes contra um histórico de 2024 sem
 * dizer nada, porque nenhuma tela tinha a obrigação de perguntar se o dado
 * ainda fazia sentido. Agora tem: este bloco.
 */
function renderAlertaBase() {
  const d = estado.diagnostico;
  const el = $('#alertaBase');
  if (!d || d.ok) { el.innerHTML = ''; return; }

  const l = loteria();
  const comoResolver = d.buracos
    ? `<p class="nota">Clique em <b>Buscar agora</b> — a sincronização preenche os
       que faltam sozinha. Se sobrar algum, rode de novo: a Caixa às vezes recusa
       quando recebe muitas requisições seguidas.</p>`
    : d.gravidade === 'grave'
    ? `<p class="nota">Enquanto isso não for resolvido, <b>não confie nas conferências</b>:
       os concursos que você está vendo não são os que estão sendo sorteados agora.
       Configure o proxy da Caixa em <b>Configurações</b>, ou use o import manual
       de um arquivo atualizado.</p>`
    : `<p class="nota">Vale conferir a fonte em <b>Configurações</b> antes de
       confiar nas conferências.</p>`;

  el.innerHTML = `
    <div class="alerta-base ${d.gravidade}">
      <div class="texto">
        <b>${d.buracos
          ? 'A base está incompleta'
          : d.gravidade === 'grave'
            ? 'A base de resultados está desatualizada'
            : 'Atenção com a base de resultados'}</b>
        ${d.motivo}
        ${d.ultimo ? `<p class="nota">Último concurso na base: <b>${d.ultimo}</b>${
          d.dataUltimo ? ` (${new Date(`${d.dataUltimo}T12:00:00`).toLocaleDateString('pt-BR')})` : ''
        }${d.fonte ? ` · fonte: ${d.fonte}` : ''}.</p>` : ''}
        ${comoResolver}
      </div>
      <button class="btn" id="btnVerificarAlerta">Buscar agora</button>
    </div>`;

  $('#btnVerificarAlerta').addEventListener('click', () => {
    executarRotina({ forcar: true, silencioso: false });
  });
}

/**
 * O boletim: "saiu o concurso X, você fez tanto". Fica na tela até o usuário
 * dizer que viu — um toast que some em três segundos não serve para dar a
 * notícia mais importante do sistema.
 */
async function renderBoletim() {
  const l = loteria();
  const b = await lerBoletim(estado.loteriaId);
  const el = $('#boletim');

  if (!b?.concursos?.length) { el.innerHTML = ''; return; }

  const totalPremiados = b.concursos.reduce((a, c) => a + c.premiados, 0);
  const melhorGeral = Math.max(...b.concursos.map((c) => c.melhor));
  const ganhou = totalPremiados > 0;

  const manchete = ganhou
    ? `Você premiou em ${totalPremiados} bilhete${totalPremiados === 1 ? '' : 's'}.`
    : `Dessa vez não deu. Melhor resultado: ${melhorGeral} pontos.`;

  el.innerHTML = `
    <div class="boletim ${ganhou ? '' : 'sem-premio'}">
      <div class="topo-boletim">
        <div>
          <h2>${b.concursos.length === 1
            ? `Saiu o concurso ${b.concursos[0].numero}`
            : `Saíram ${b.concursos.length} concursos novos`} — ${l.nome}</h2>
          <div class="manchete ${ganhou ? 'ganhou' : ''}">${manchete}</div>
        </div>
        <button class="btn fantasma" id="btnDispensarBoletim">Ok, vi</button>
      </div>

      ${b.concursos.map((c) => `
        <div class="boletim-concurso">
          <div class="boletim-linha">
            <b>Concurso ${c.numero}</b>
            <span class="dezenas-concurso">${c.dezenas
              .map((d) => `<span class="bolinha sorteada">${fmt(d, l)}</span>`).join('')}</span>
          </div>
          <div class="boletim-linha">
            <span class="nota">${c.bilhetes} bilhete(s) seus · ${brl(c.custo)} apostados
              · melhor acerto: <b>${c.melhor}</b> pontos</span>
            ${c.faixas.map((f) =>
              `<span class="faixa-premio">🏆 ${f.quantos}× ${f.acertos} pontos</span>`).join('')}
          </div>
          ${c.premiados
            ? `<button class="link" data-ver-concurso="${c.numero}">ver esses bilhetes e registrar o prêmio</button>`
            : ''}
        </div>`).join('')}
    </div>`;

  $('#btnDispensarBoletim').addEventListener('click', async () => {
    await dispensarBoletim(estado.loteriaId);
    await renderBoletim();
  });

  $$('#boletim [data-ver-concurso]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      $('#filtroConcurso').value = btn.dataset.verConcurso;
      $('#soPremiados').checked = true;
      await renderBilhetes();
      $$('.aba').forEach((a) => a.classList.remove('ativa'));
      $$('.tela').forEach((t) => t.classList.remove('ativa'));
      $('.aba[data-alvo="bilhetes"]').classList.add('ativa');
      $('#bilhetes').classList.add('ativa');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

/**
 * "Valendo agora": os bilhetes apontando para concursos que ainda não saíram.
 * Responde de relance a pergunta que o usuário faz toda semana — eu já joguei?
 */
async function renderEmAberto() {
  const l = loteria();
  const r = await bilhetesEmAberto(estado.loteriaId, estado.historico);
  const el = $('#emAberto');

  const partes = [];

  if (r.concursos.length) {
    partes.push(`<div class="em-aberto">${r.concursos.map((c) => `
      <div class="linha-aberto">
        <span class="qual"><b>${c.bilhetes} bilhete${c.bilhetes === 1 ? '' : 's'}</b>
          no concurso ${c.concurso}</span>
        <span class="quanto">${brl(c.custo)} apostados · aguardando o sorteio</span>
      </div>`).join('')}</div>`);
  } else {
    partes.push(`<p class="vazio">Você não tem bilhetes valendo para os próximos sorteios.
      ${estado.historico.length
        ? `O próximo concurso da ${l.nome} é o <b>${proximoConcurso()}</b>.`
        : ''}</p>`);
  }

  if (r.semConcurso) {
    partes.push(`<p class="nota" style="color:var(--alerta);margin-top:.6rem">
      ${r.semConcurso} bilhete(s) estão sem concurso definido e por isso não entram nesta
      conta nem são conferidos. Resolva em <b>Meus bilhetes</b>.</p>`);
  }

  el.innerHTML = partes.join('');
  el.classList.toggle('vazio', !r.concursos.length);
}

function precoDe(l) {
  return estado.precos[l.id] ?? l.precoBase;
}

/**
 * O concurso para o qual os jogos gerados agora provavelmente vão.
 * Como o histórico só contém concursos já sorteados, o alvo natural é o
 * seguinte ao último conhecido.
 */
function proximoConcurso() {
  if (!estado.historico.length) return null;
  return estado.historico[estado.historico.length - 1].numero + 1;
}

/**
 * Preenche os campos "Concurso alvo" com o próximo concurso.
 *
 * Deixar esse campo vazio era um erro de desenho: o caminho natural
 * (gerar → salvar) produzia bilhetes sem concurso, e bilhete sem concurso
 * não tem contra o que ser conferido. O botão "Conferir todos" ficava sem
 * nada para fazer e parecia quebrado.
 */
function preencherConcursoAlvo({ trocouLoteria = false } = {}) {
  const prox = proximoConcurso();
  for (const sel of ['#concursoAlvoGerador', '#concursoAlvoFech']) {
    const el = $(sel);
    if (!el) continue;
    el.placeholder = prox ? `${prox}` : 'ex.: 3450';
    /* Ao TROCAR de modalidade o número tem de ser reescrito, não preservado.
       Antes só preenchia quando o campo estava vazio — e como ele já vinha
       preenchido da primeira carga, trocar da Lotofácil para a Mega-Sena
       deixava lá o 3.451 da Lotofácil. Os bilhetes eram salvos apontando
       para um concurso da Mega-Sena que só sai daqui a anos (ficam
       "valendo" para sempre, nunca conferidos), ou, no sentido inverso,
       para um concurso da Lotofácil que já saiu — e aí entram no balanço
       como dinheiro gasto num sorteio antigo, com acertos aleatórios.
       Tudo em silêncio, porque o placeholder é invisível quando há valor. */
    if (prox && (trocouLoteria || !el.value)) el.value = prox;
  }
  const man = $('#concursoManual');
  if (man && prox) man.placeholder = `${prox - 1}`;
}

/* ------------------------------------------------------------------ */
/* Estatísticas                                                        */
/* ------------------------------------------------------------------ */

function renderEstatisticas() {
  const l = loteria();
  const a = estado.analise;

  if (!a || a.vazio) {
    $('#mapaCalor').innerHTML = '<p class="vazio">Baixe os resultados no Painel primeiro.</p>';
    ['#graficoFrequencia', '#graficoAtraso', '#graficoSoma', '#graficoPares',
     '#graficoRepetidas', '#tabelaDuplas'].forEach((s) => { $(s).innerHTML = ''; });
    $('#resumoJanela').textContent = '';
    return;
  }

  $('#resumoJanela').textContent =
    `${a.total.toLocaleString('pt-BR')} concursos analisados (do ${a.primeiroConcurso} ao ${a.ultimoConcurso}). ` +
    `Se tudo fosse perfeitamente uniforme, cada dezena sairia ${a.esperado.toFixed(1)} vezes.`;

  /* mapa de calor */
  const vezes = a.dezenas.map((d) => d.vezes);
  const min = Math.min(...vezes);
  const max = Math.max(...vezes);
  const span = max - min || 1;
  $('#mapaCalor').style.gridTemplateColumns = `repeat(${l.grade.colunas}, minmax(30px, 46px))`;
  $('#mapaCalor').innerHTML = a.dezenas.map((d) => {
    const t = (d.vezes - min) / span;
    const cor = corDoCalor(t);
    return `<div class="celula-calor" style="background:${cor};color:#06131f"
      title="Dezena ${fmt(d.dezena, l)} — saiu ${d.vezes}x (${d.pct.toFixed(1)}% dos concursos). Atraso atual: ${d.atraso} concursos.">
      ${fmt(d.dezena, l)}<small>${d.vezes}</small></div>`;
  }).join('');

  /* frequência — com base deslocada e o desvio em relação ao esperado */
  const menorFreq = Math.min(...a.dezenas.map((d) => d.vezes));
  $('#graficoFrequencia').innerHTML =
    grafico(
      a.maisSorteadas.slice(0, 12).map((d) => ({ rotulo: fmt(d.dezena, l), valor: d.vezes })),
      {
        base: menorFreq * 0.995,
        formatar: (v) => {
          const desvio = v - a.esperado;
          const sinal = desvio >= 0 ? '+' : '';
          return `${v}x <span style="opacity:.6">(${sinal}${desvio.toFixed(0)})</span>`;
        },
      }
    ) +
    `<p class="nota" style="margin-top:.6rem">O número entre parênteses é a diferença
     para a média esperada (${a.esperado.toFixed(0)}). A escala começa no menor valor
     para a diferença ficar visível — mas ela é pequena, e num sorteio justo
     desvios desse tamanho são exatamente o que se espera ver.</p>`;

  /* atraso */
  $('#graficoAtraso').innerHTML = grafico(
    a.maisAtrasadas.slice(0, 12).map((d) => ({ rotulo: fmt(d.dezena, l), valor: d.atraso })),
    { formatar: (v) => `${v}` }
  );

  /* soma — agrupa em faixas para não virar espaguete */
  const faixas = 14;
  const passo = Math.max(1, Math.ceil((a.soma.max - a.soma.min + 1) / faixas));
  const buckets = new Map();
  for (const s of a.soma.distribuicao) {
    const base = a.soma.min + Math.floor((s.valor - a.soma.min) / passo) * passo;
    buckets.set(base, (buckets.get(base) ?? 0) + s.vezes);
  }
  $('#graficoSoma').innerHTML = grafico(
    [...buckets.entries()].sort((x, y) => x[0] - y[0])
      .map(([base, v]) => ({ rotulo: `${base}+`, valor: v })),
    { formatar: (v) => `${((v / a.total) * 100).toFixed(1)}%` }
  );
  $('#resumoSoma').textContent =
    `Faixa central: ${a.soma.p25} a ${a.soma.p75} (metade dos concursos). ` +
    `90% ficaram entre ${a.soma.p05} e ${a.soma.p95}. Mediana ${a.soma.p50}.`;

  /* pares */
  $('#graficoPares').innerHTML = grafico(
    a.pares.map((p) => ({ rotulo: `${p.valor}`, valor: p.vezes })),
    { formatar: (v) => `${((v / a.total) * 100).toFixed(1)}%` }
  );

  /* repetidas */
  $('#graficoRepetidas').innerHTML = grafico(
    a.repetidas.map((p) => ({ rotulo: `${p.valor}`, valor: p.vezes })),
    { formatar: (v, i) => `${i.valor ? '' : ''}${((v / Math.max(1, a.total - 1)) * 100).toFixed(1)}%` }
  );

  /* duplas */
  $('#tabelaDuplas').innerHTML = `<div class="rolagem"><table>
    <thead><tr><th>Dupla</th><th>Juntas</th><th>%</th></tr></thead>
    <tbody>${a.duplasTop.slice(0, 12).map((d) => `
      <tr><td><span class="bolinha">${fmt(d.a, l)}</span> <span class="bolinha">${fmt(d.b, l)}</span></td>
      <td>${d.vezes}x</td><td>${d.pct.toFixed(1)}%</td></tr>`).join('')}
    </tbody></table></div>`;
}

$('#janelaAnalise').addEventListener('change', (e) => {
  estado.janela = Number(e.target.value);
  estado.analise = estado.historico.length
    ? analisar(estado.historico, loteria(), estado.janela || null)
    : null;
  renderEstatisticas();
});

/* ------------------------------------------------------------------ */
/* Volantes                                                            */
/* ------------------------------------------------------------------ */

function montarVolanteGerador() {
  const l = loteria();
  const el = $('#volanteGerador');
  el.style.gridTemplateColumns = `repeat(${l.grade.colunas}, minmax(30px, 44px))`;
  el.innerHTML = universoDe(l).map((d) => {
    const st = estado.volanteGerador.get(d);
    return `<div class="dezena ${st ?? ''}" data-d="${d}">${fmt(d, l)}</div>`;
  }).join('');

  el.querySelectorAll('.dezena').forEach((cel) => {
    cel.addEventListener('click', () => {
      const d = Number(cel.dataset.d);
      const atual = estado.volanteGerador.get(d);
      if (!atual) estado.volanteGerador.set(d, 'fixa');
      else if (atual === 'fixa') estado.volanteGerador.set(d, 'excluida');
      else estado.volanteGerador.delete(d);
      montarVolanteGerador();
    });
  });

  const fixas = [...estado.volanteGerador].filter(([, v]) => v === 'fixa').length;
  const excl = [...estado.volanteGerador].filter(([, v]) => v === 'excluida').length;
  $('#resumoVolante').textContent = `${fixas} fixa(s), ${excl} excluída(s)`;
}

function montarVolanteFechamento() {
  const l = loteria();
  const el = $('#volanteFechamento');

  if (!l.fechamentoDisponivel) {
    el.innerHTML = '';
    el.style.gridTemplateColumns = '';
    $('#resumoFechamento').textContent = '';
    return;
  }

  el.style.gridTemplateColumns = `repeat(${l.grade.colunas}, minmax(30px, 44px))`;
  el.innerHTML = universoDe(l).map(
    (d) => `<div class="dezena ${estado.volanteFechamento.has(d) ? 'selecionada' : ''}" data-d="${d}">${fmt(d, l)}</div>`
  ).join('');

  el.querySelectorAll('.dezena').forEach((cel) => {
    cel.addEventListener('click', () => {
      const d = Number(cel.dataset.d);
      if (estado.volanteFechamento.has(d)) estado.volanteFechamento.delete(d);
      else if (estado.volanteFechamento.size >= l.fechamentoMaxDezenas) {
        toast(`Máximo de ${l.fechamentoMaxDezenas} dezenas no fechamento.`, true);
        return;
      } else estado.volanteFechamento.add(d);
      montarVolanteFechamento();
      montarOpcoesFechamento();
    });
  });

  $('#resumoFechamento').textContent =
    `${estado.volanteFechamento.size} de ${l.fechamentoMaxDezenas} dezenas`;
}

/* ------------------------------------------------------------------ */
/* Gerador                                                             */
/* ------------------------------------------------------------------ */

function montarOpcoesGerador() {
  const l = loteria();
  const sel = $('#dezenasPorJogo');
  const anterior = Number(sel.value);
  sel.innerHTML = '';
  for (let n = l.marcarMin; n <= l.marcarMax; n++) {
    const { combinacoes, custo } = custoAposta(l, n, precoDe(l));
    sel.insertAdjacentHTML('beforeend',
      `<option value="${n}">${n} dezenas — ${brl(custo)}${combinacoes > 1 ? ` (${combinacoes} apostas)` : ''}</option>`);
  }
  // Ao trocar de modalidade, volta para a aposta simples. Manter "15 dezenas"
  // ao sair da Lotofácil para a Mega-Sena significaria C(15,6) = 5.005 apostas
  // por bilhete — R$ 30 mil sem o usuário pedir.
  sel.value =
    !estado.trocouLoteria && anterior >= l.marcarMin && anterior <= l.marcarMax
      ? anterior
      : l.marcarMin;

  atualizarCustoPorJogo();
  aplicarSugestoesNosFiltros(false);
  estado.trocouLoteria = false;
}

function atualizarCustoPorJogo() {
  const l = loteria();
  const n = Number($('#dezenasPorJogo').value);
  const qtd = Number($('#qtdJogos').value) || 0;
  const { custo } = custoAposta(l, n, precoDe(l));
  $('#custoPorJogo').textContent =
    `${qtd} bilhete(s) = ${brl(custo * qtd)} no total`;
}
$('#dezenasPorJogo').addEventListener('change', () => {
  atualizarCustoPorJogo();
  aplicarSugestoesNosFiltros(false);
});
$('#qtdJogos').addEventListener('input', atualizarCustoPorJogo);

function lerFiltrosDaTela() {
  const l = loteria();
  const f = filtrosPadrao(l);
  f.dezenasPorJogo = Number($('#dezenasPorJogo').value);

  f.fixas = [...estado.volanteGerador].filter(([, v]) => v === 'fixa').map(([d]) => d);
  f.excluidas = [...estado.volanteGerador].filter(([, v]) => v === 'excluida').map(([d]) => d);

  for (const linha of $$('.linha-filtro')) {
    const nome = linha.dataset.filtro;
    const ligado = linha.querySelector('input[type=checkbox]').checked;
    if (!ligado) { f[nome] = null; continue; }
    const minEl = linha.querySelector('.min');
    const maxEl = linha.querySelector('.max');
    if (nome === 'maxSequencia') {
      f.maxSequencia = maxEl.value === '' ? null : Number(maxEl.value);
    } else {
      f[nome] = {
        min: minEl.value === '' ? null : Number(minEl.value),
        max: maxEl.value === '' ? null : Number(maxEl.value),
      };
    }
  }

  f.evitarPopulares = $('#evitarPopulares').checked;
  f.evitarJaSorteados = $('#evitarJaSorteados').checked;
  const sob = $('#sobreposicaoMax').value;
  f.sobreposicaoMax = sob === '' ? null : Number(sob);
  return f;
}

/**
 * As faixas do histórico (soma, pares, primos…) são medidas sobre as dezenas
 * SORTEADAS. Elas só descrevem um bilhete quando ele tem exatamente o mesmo
 * tamanho do sorteio — 15 na Lotofácil, 6 na Mega-Sena.
 *
 * Num bilhete de 18 dezenas da Lotofácil, ou nos 50 da Lotomania (que sorteia
 * 20), a soma é outra coisa completamente diferente e comparar as duas seria
 * um erro grosseiro. Nesses casos desligamos as faixas em vez de fingir.
 */
function filtrosEstatisticosSaoAplicaveis() {
  return Number($('#dezenasPorJogo').value) === loteria().sorteadas;
}

function aplicarSugestoesNosFiltros(avisar = true) {
  const l = loteria();
  const aviso = $('#avisoFiltros');
  const linhasFaixa = ['soma', 'pares', 'primos', 'moldura', 'repetidas', 'maxSequencia'];

  if (!filtrosEstatisticosSaoAplicaveis()) {
    for (const nome of linhasFaixa) {
      const cb = $(`.linha-filtro[data-filtro="${nome}"] input[type=checkbox]`);
      if (cb) { cb.checked = false; cb.disabled = true; }
    }
    aviso.innerHTML =
      `<b style="color:var(--alerta)">Faixas desligadas de propósito.</b>
       Elas descrevem as ${l.sorteadas} dezenas sorteadas, e o seu bilhete tem
       ${$('#dezenasPorJogo').value}. Comparar os dois seria comparar coisas diferentes.
       Volte para ${l.sorteadas} dezenas por bilhete para usá-las.`;
    if (avisar) toast(`As faixas só valem para bilhetes de ${l.sorteadas} dezenas.`, true);
    return;
  }

  for (const nome of linhasFaixa) {
    const cb = $(`.linha-filtro[data-filtro="${nome}"] input[type=checkbox]`);
    if (cb) cb.disabled = false;
  }
  aviso.innerHTML = '';

  if (!estado.analise || estado.analise.vazio) {
    if (avisar) toast('Baixe os resultados primeiro.', true);
    return;
  }
  const s = sugerirFiltros(estado.analise);
  const por = (nome, faixa) => {
    const linha = $(`.linha-filtro[data-filtro="${nome}"]`);
    if (!linha || !faixa) return;
    const min = linha.querySelector('.min');
    const max = linha.querySelector('.max');
    if (min) min.value = faixa.min;
    if (max) max.value = faixa.max;
  };
  por('soma', s.soma);
  por('pares', s.pares);
  por('primos', s.primos);
  por('moldura', s.moldura);
  if (s.repetidas) por('repetidas', s.repetidas);
  const seq = $('.linha-filtro[data-filtro="maxSequencia"] .max');
  if (seq) seq.value = s.maxSequencia;

  if (avisar) toast('Filtros ajustados para cobrir ~90% dos concursos históricos.');
}
$('#btnSugerirFiltros').addEventListener('click', () => aplicarSugestoesNosFiltros(true));

$('#limparVolante').addEventListener('click', () => {
  estado.volanteGerador.clear();
  montarVolanteGerador();
});

$('#btnGerar').addEventListener('click', async () => {
  const l = loteria();
  const qtd = Number($('#qtdJogos').value);
  if (!qtd || qtd < 1) return toast('Informe quantos bilhetes gerar.', true);

  let filtros;
  try { filtros = lerFiltrosDaTela(); }
  catch (e) { return toast(e.message, true); }

  const contexto = {
    ultimoSorteio: estado.historico.length
      ? estado.historico[estado.historico.length - 1].dezenas : null,
    combinacoesSorteadas: filtros.evitarJaSorteados && estado.historico.length
      ? combinacoesSorteadas(estado.historico) : null,
  };

  const btn = $('#btnGerar');
  btn.disabled = true; btn.textContent = 'Gerando…';
  await esperarPintura();

  try {
    const r = gerar(qtd, l, filtros, contexto);
    estado.jogosGerados = r.jogos;

    if (!r.jogos.length) {
      $('#caixaResultadoGerador').hidden = true;
      return toast('Nenhum bilhete passou nos filtros. Afrouxe as faixas.', true);
    }

    const custoTotal = r.jogos.length * custoAposta(l, filtros.dezenasPorJogo, precoDe(l)).custo;
    const recusasTop = Object.entries(r.recusas).sort((a, b) => b[1] - a[1]).slice(0, 3);

    $('#infoGeracao').innerHTML =
      `<b>${r.jogos.length} bilhete(s)</b> — custo ${brl(custoTotal)}. ` +
      `${r.tentativas.toLocaleString('pt-BR')} combinações testadas.` +
      (r.incompleto ? ' <span style="color:var(--alerta)">Não consegui gerar tudo com esses filtros.</span>' : '') +
      (recusasTop.length
        ? `<br><span class="nota">Mais recusados por: ${recusasTop.map(([m, q]) => `${m} (${q})`).join(', ')}.</span>`
        : '');

    $('#listaGerados').innerHTML = r.jogos.map((j, i) => `
      <div class="jogo">
        <span class="indice">${String(i + 1).padStart(2, '0')}</span>
        ${bolinhas(j)}
      </div>`).join('');

    $('#caixaResultadoGerador').hidden = false;
    $('#caixaResultadoGerador').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Gerar bilhetes';
  }
});

$('#btnSalvarGerados').addEventListener('click', async () => {
  if (!estado.jogosGerados.length) return;
  const concurso = $('#concursoAlvoGerador').value;
  const bilhetes = montarBilhetes(estado.loteriaId, estado.jogosGerados, {
    origem: 'gerador',
    concurso: concurso ? Number(concurso) : null,
    precoBase: precoDe(loteria()),
  });
  await salvarBilhetesEAtualizar(bilhetes);
  toast(`${bilhetes.length} bilhete(s) salvos.`);
});

$('#btnCopiarGerados').addEventListener('click', () => {
  const texto = estado.jogosGerados
    .map((j) => j.map((d) => fmt(d, loteria())).join(' ')).join('\n');
  navigator.clipboard.writeText(texto).then(
    () => toast('Copiado.'),
    () => toast('Não consegui copiar.', true)
  );
});

/* ------------------------------------------------------------------ */
/* Fechamento                                                          */
/* ------------------------------------------------------------------ */

function montarOpcoesFechamento() {
  const l = loteria();
  const n = estado.volanteFechamento.size;

  /* Quando o fechamento não se aplica, esta função retornava ANTES de
     reconstruir os selects — e eles ficavam exibindo os valores da
     modalidade anterior. Na Lotomania a tela mostrava "15 dezenas —
     R$ 3,50 cada" (preço e tamanho da Lotofácil) ao lado de um aviso
     dizendo que fechamento não se aplica ali. A tela se contradizendo de
     novo, e ainda por cima com número de outra loteria.
     Agora os controles somem: não há parâmetro a escolher se não há
     fechamento a montar. */
  const disponivel = l.fechamentoDisponivel;
  $('#parametrosFechamento').hidden = !disponivel;
  $('#acoesFechamento').hidden = !disponivel;
  $('#btnFechar').hidden = !disponivel;
  $('#notaFechamentoLento').hidden = !disponivel;
  $('#caixaResultadoFechamento').hidden = $('#caixaResultadoFechamento').hidden || !disponivel;

  const semVolante = $('#semFechamentoVolante');
  semVolante.hidden = disponivel;

  if (!disponivel) {
    semVolante.textContent =
      `A ${l.nome} não usa fechamento — não há volante a preencher aqui.`;
    $('#previaFechamento').innerHTML =
      `<b>Fechamento não se aplica à ${l.nome}.</b><br>
       Você marca ${l.marcarMin} dezenas de ${l.universo} — o número de cenários a cobrir
       é astronômico e nenhum conjunto de bilhetes viável garante nada.
       Use o <b>Gerador</b> com filtros para esta modalidade.`;
    $('#btnFechar').disabled = true;
    return;
  }
  $('#btnFechar').disabled = false;

  const selJogo = $('#fechPorJogo');
  const antesJogo = Number(selJogo.value);
  selJogo.innerHTML = '';
  for (let j = l.marcarMin; j <= Math.min(l.marcarMax, Math.max(n, l.marcarMin)); j++) {
    const { custo } = custoAposta(l, j, precoDe(l));
    selJogo.insertAdjacentHTML('beforeend', `<option value="${j}">${j} dezenas — ${brl(custo)} cada</option>`);
  }
  /* Comparar com `l.marcarMax` era errado: as opções param no MENOR entre
     `marcarMax` e o tamanho do volante. Com o volante menor que o valor
     anterior, o `value` atribuído não existia entre as opções, o navegador
     punha string vazia, e `Number('')` é ZERO — que passou por todas as
     guardas e chegou ao motor de fechamento. Comparar com o teto REAL das
     opções, e cair no mínimo quando não couber. */
  const tetoJogo = Math.min(l.marcarMax, Math.max(n, l.marcarMin));
  selJogo.value = antesJogo >= l.marcarMin && antesJogo <= tetoJogo ? antesJogo : l.marcarMin;

  const selCen = $('#fechCenario');
  const antesCen = Number(selCen.value);
  selCen.innerHTML = '';
  const maxT = Math.min(l.sorteadas, n || l.sorteadas);
  for (let t = maxT; t >= Math.max(1, maxT - 5); t--) {
    const p = n ? probabilidadeCenario(l.universo, l.sorteadas, n, t) : null;
    const chance = p ? ` — acontece 1 vez a cada ${umEmQuantos(p.acumulada)} concursos` : '';
    selCen.insertAdjacentHTML('beforeend',
      `<option value="${t}">${t} das ${l.sorteadas} sorteadas dentro do meu grupo${chance}</option>`);
  }
  // Só respeita a escolha anterior se ela foi feita de propósito — senão o
  // valor "gruda" enquanto o volante cresce e vira outra coisa sem avisar.
  /* Mesma armadilha do outro lado: as opções vão de `maxT` até
     `max(1, maxT - 5)`, então um valor anterior ABAIXO desse piso também
     some da lista e zera o select. */
  const pisoCen = Math.max(1, maxT - 5);
  selCen.value = estado.cenarioManual && antesCen >= pisoCen && antesCen <= maxT ? antesCen : maxT;

  atualizarGarantias();
}

function atualizarGarantias() {
  const l = loteria();
  const j = Number($('#fechPorJogo').value);
  const t = Number($('#fechCenario').value);
  const selG = $('#fechGarantia');
  const antes = Number(selG.value);
  const teto = Math.min(j, t);

  selG.innerHTML = '';
  for (let g = teto; g >= Math.max(1, teto - 4); g--) {
    const rotulo = l.faixas.includes(g) ? `${g} pontos 🏆` : `${g} pontos`;
    selG.insertAdjacentHTML('beforeend', `<option value="${g}">${rotulo}</option>`);
  }
  // Padrão sensato: a garantia mais alta que ainda cabe no bolso.
  // Pedir o teto (ex.: garantir 15 pontos na Lotofácil) exige jogar TODAS as
  // combinações — tecnicamente possível, financeiramente absurdo.
  const n = estado.volanteFechamento.size;
  let preferida = null;
  for (let g = teto - 1; g >= 1; g--) {
    if (!l.faixas.includes(g)) continue;
    if (minimoTeorico(n, j, t, g) <= 150) { preferida = g; break; }
  }
  if (preferida == null) {
    preferida = l.faixas.filter((f) => f < teto).sort((a, b) => b - a)[0] ?? teto;
  }
  // Mesma história do cenário: sem o flag, o valor antigo gruda enquanto o
  // volante cresce e o usuário acaba com uma garantia que ele nunca escolheu.
  const pisoG = Math.max(1, teto - 4);
  selG.value = estado.garantiaManual && antes >= pisoG && antes <= teto ? antes : preferida;

  atualizarPrevia();
}

function atualizarPrevia() {
  const l = loteria();
  const n = estado.volanteFechamento.size;
  const j = Number($('#fechPorJogo').value);
  const t = Number($('#fechCenario').value);
  const g = Number($('#fechGarantia').value);
  const el = $('#previaFechamento');

  if (n < j) {
    el.innerHTML = `Selecione pelo menos <b>${j}</b> dezenas no volante ao lado. Você marcou ${n}.`;
    $('#btnFechar').disabled = true;
    return;
  }
  $('#btnFechar').disabled = false;

  const cenarios = binomial(n, t);
  const min = minimoTeorico(n, j, t, g);
  const custoUnit = custoAposta(l, j, precoDe(l)).custo;

  const estimado = Number.isFinite(min) ? min * custoUnit : null;
  const p = probabilidadeCenario(l.universo, l.sorteadas, n, t);
  const umEm = umEmQuantos(p.acumulada);

  el.innerHTML = `
    Com <b>${n}</b> dezenas, bilhetes de <b>${j}</b>:<br>
    cenários a cobrir: <b>${cenarios.toLocaleString('pt-BR')}</b><br>
    mínimo teórico de bilhetes: <b>${Number.isFinite(min) ? min.toLocaleString('pt-BR') : '—'}</b>
    <span class="nota">(o algoritmo costuma ficar 1,5× a 3× acima disso)</span><br>
    custo estimado: <b class="destaque">${estimado != null ? `a partir de ${brl(estimado)}` : '—'}</b>
    <hr style="border:none;border-top:1px solid var(--borda);margin:.6rem 0">
    <b>E a chance de esse cenário acontecer?</b><br>
    ${t} ou mais das ${l.sorteadas} sorteadas caírem entre as suas ${n} dezenas:
    <b class="destaque">${(p.acumulada * 100).toFixed(2)}%</b>
    ${umEm ? `<span class="nota">— cerca de 1 concurso a cada ${umEm.toLocaleString('pt-BR')}</span>` : ''}
    <br><span class="nota">A garantia é certa. Este cenário é que não é —
    e é ele que separa o fechamento honesto da propaganda.</span>
    ${estimado != null && estimado > 500
      ? `<br><span style="color:var(--alerta)">Atenção: garantia alta custa caro.
         Baixar um ponto na garantia, ou assumir um cenário menos exigente,
         costuma derrubar o preço em dez vezes — e ainda aumenta a chance
         de o cenário acontecer.</span>`
      : ''}`;
}

$('#fechPorJogo').addEventListener('change', atualizarGarantias);
$('#fechCenario').addEventListener('change', () => {
  estado.cenarioManual = true;
  atualizarGarantias();
});
$('#fechGarantia').addEventListener('change', () => {
  estado.garantiaManual = true;
  atualizarPrevia();
});

$('#limparFechamento').addEventListener('click', () => {
  estado.volanteFechamento.clear();
  montarVolanteFechamento();
  montarOpcoesFechamento();
});

$('#aleatorioFechamento').addEventListener('click', () => {
  const l = loteria();
  const alvo = Math.min(l.marcarMin + 3, l.fechamentoMaxDezenas);
  const pool = universoDe(l);
  estado.volanteFechamento.clear();
  while (estado.volanteFechamento.size < alvo) {
    estado.volanteFechamento.add(pool[Math.floor(Math.random() * pool.length)]);
  }
  montarVolanteFechamento();
  montarOpcoesFechamento();
});

$('#btnFechar').addEventListener('click', async () => {
  const l = loteria();
  const dezenas = [...estado.volanteFechamento].sort((a, b) => a - b);
  const j = Number($('#fechPorJogo').value);
  const t = Number($('#fechCenario').value);
  const g = Number($('#fechGarantia').value);

  const btn = $('#btnFechar');
  btn.disabled = true; btn.textContent = 'Calculando e verificando…';
  await esperarPintura();

  try {
    const r = fechar(dezenas, { porJogo: j, acertosNoGrupo: t, garantia: g });
    estado.fechamentoAtual = r;

    const custoUnit = custoAposta(l, j, precoDe(l)).custo;
    const custoTotal = r.jogos.length * custoUnit;
    const probCenario = probabilidadeCenario(l.universo, l.sorteadas, dezenas.length, t);

    $('#veredito').innerHTML = r.garantiaAtendida
      ? `<div class="veredito-ok">
          <b>✓ Garantia verificada.</b><br>
          Testei os <b>${r.totalCenarios.toLocaleString('pt-BR')}</b> cenários possíveis, um por um.
          Em <b>todos</b> eles, ${r.jogos.length === 1 ? 'este bilhete' : `pelo menos um destes ${r.jogos.length} bilhetes`} faz
          <b>${r.garantiaReal} pontos ou mais</b> — desde que ${t} das ${l.sorteadas} dezenas
          sorteadas estejam entre as suas ${dezenas.length}.<br>
          <span class="nota">Custo: ${r.jogos.length} × ${brl(custoUnit)} = <b>${brl(custoTotal)}</b>.</span>
          <br><br><b>O que continua sendo sorte:</b> esse cenário acontecer.
          A chance de ${t} ou mais das ${l.sorteadas} sorteadas caírem entre as suas
          ${dezenas.length} dezenas é de <b>${(probCenario.acumulada * 100).toFixed(2)}%</b>${
            umEmQuantos(probCenario.acumulada)
              ? ` — mais ou menos 1 concurso a cada ${umEmQuantos(probCenario.acumulada).toLocaleString('pt-BR')}`
              : ''
          }. Nos outros, o fechamento não promete nada.
        </div>`
      : `<div class="veredito-erro">
          <b>Não alcancei a garantia pedida.</b>
          O melhor que este conjunto entrega no pior caso é ${r.garantiaReal} pontos, não ${g}.
          Tente mais dezenas por bilhete, um cenário menos exigente, ou rode de novo.
        </div>`;

    $('#distribuicaoFechamento').innerHTML = `
      <h3 style="font-size:.85rem;color:var(--texto-2);margin-top:.8rem">Melhor bilhete em cada cenário</h3>
      ${grafico(r.distribuicao.map((d) => ({ rotulo: `${d.acertos} pts`, valor: d.casos })),
        { formatar: (v, i) => `${i ? '' : ''}${((v / r.totalCenarios) * 100).toFixed(1)}%` })}`;

    $('#listaFechamento').innerHTML = r.jogos.map((jg, i) => `
      <div class="jogo"><span class="indice">${String(i + 1).padStart(3, '0')}</span>${bolinhas(jg)}</div>`).join('');

    $('#caixaResultadoFechamento').hidden = false;
    $('#caixaResultadoFechamento').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false; btn.textContent = 'Montar fechamento';
  }
});

$('#btnSalvarFechamento').addEventListener('click', async () => {
  if (!estado.fechamentoAtual) return;
  const concurso = $('#concursoAlvoFech').value;
  const p = estado.fechamentoAtual.parametros;
  const bilhetes = montarBilhetes(estado.loteriaId, estado.fechamentoAtual.jogos, {
    origem: 'fechamento',
    rotulo: `${p.n} dezenas · garante ${estado.fechamentoAtual.garantiaReal} se ${p.t} caírem`,
    concurso: concurso ? Number(concurso) : null,
    precoBase: precoDe(loteria()),
  });
  await salvarBilhetesEAtualizar(bilhetes);
  toast(`${bilhetes.length} bilhete(s) salvos.`);
});

$('#btnCopiarFechamento').addEventListener('click', () => {
  if (!estado.fechamentoAtual) return;
  const texto = estado.fechamentoAtual.jogos
    .map((j) => j.map((d) => fmt(d, loteria())).join(' ')).join('\n');
  navigator.clipboard.writeText(texto).then(
    () => toast('Copiado.'), () => toast('Não consegui copiar.', true));
});

/* ------------------------------------------------------------------ */
/* Bilhetes                                                            */
/* ------------------------------------------------------------------ */

/**
 * Salva bilhetes e já confere os que apontam para um concurso que a base
 * conhece — evita o usuário ver "—" na coluna de acertos e ter de clicar
 * em "Conferir todos" logo depois de salvar.
 */
async function salvarBilhetesEAtualizar(bilhetes) {
  await DB.salvarBilhetes(bilhetes);
  const conhecidos = new Set(estado.historico.map((c) => c.numero));
  if (bilhetes.some((b) => b.concurso != null && conhecidos.has(Number(b.concurso)))) {
    await conferirTodos(estado.loteriaId, estado.historico);
  }
  await renderBilhetes();
  await renderPainel();
  await renderEmAberto();
  await atualizarRetrospectiva();
  sincronizarNuvem();          // em segundo plano: não trava a tela
}

function lerDezenas(texto, l) {
  const nums = texto.split(/[^0-9]+/).filter(Boolean).map(Number);
  const unicos = [...new Set(nums)];
  if (unicos.some((d) => d < l.min || d > l.max)) {
    throw new Error(`Dezenas devem estar entre ${l.min} e ${l.max}.`);
  }
  if (unicos.length < l.marcarMin || unicos.length > l.marcarMax) {
    throw new Error(
      `A ${l.nome} aceita de ${l.marcarMin} a ${l.marcarMax} dezenas. Você informou ${unicos.length}.`
    );
  }
  return unicos.sort((a, b) => a - b);
}

$('#btnAddManual').addEventListener('click', async () => {
  const l = loteria();
  try {
    const dezenas = lerDezenas($('#entradaManual').value, l);
    const concurso = $('#concursoManual').value;
    const [bilhete] = montarBilhetes(estado.loteriaId, [dezenas], {
      origem: 'manual',
      concurso: concurso ? Number(concurso) : null,
      precoBase: precoDe(l),
    });
    await salvarBilhetesEAtualizar([bilhete]);
    $('#entradaManual').value = '';
    $('#erroManual').textContent = '';
    toast('Bilhete cadastrado.');
  } catch (e) {
    $('#erroManual').textContent = e.message;
  }
});

async function renderBilhetes() {
  const l = loteria();
  const todos = await DB.listarBilhetes(estado.loteriaId);
  const soPremiados = $('#soPremiados').checked;
  const filtroConc = $('#filtroConcurso').value;

  let lista = todos;
  if (soPremiados) lista = lista.filter((b) => b.premiado);
  if (filtroConc) lista = lista.filter((b) => Number(b.concurso) === Number(filtroConc));
  /* Ordenar id com subtração era resquício do id numérico: subtrair dois
     UUIDs dá NaN, o comparador devolve NaN para todo par, e o `sort` não
     reordena nada — a lista saía na ordem lexicográfica dos UUIDs, que é
     aleatória. O usuário cadastrava um bilhete, olhava o topo da tabela e
     não o encontrava. A intenção sempre foi "mais novo primeiro". */
  lista = [...lista].sort((a, b) =>
    (b.criadoEm ?? '').localeCompare(a.criadoEm ?? ''));

  const b = balanco(todos);
  $('#balancoBilhetes').innerHTML = todos.length
    ? `<div class="cards">
        <div class="card"><div class="rotulo">Bilhetes</div><div class="valor">${b.total}</div></div>
        <div class="card"><div class="rotulo">Apostado</div><div class="valor">${brl(b.gasto)}</div></div>
        <div class="card"><div class="rotulo">Recebido</div><div class="valor">${brl(b.retorno)}</div></div>
        <div class="card"><div class="rotulo">Saldo</div><div class="valor ${b.saldo >= 0 ? 'positivo' : 'negativo'}">${brl(b.saldo)}</div></div>
       </div>`
    : '';

  /* Bilhetes sem concurso não podem ser conferidos contra nada. Em vez de
     falharem em silêncio, ganham um painel que resolve o problema em um clique. */
  const semConcurso = todos.filter((x) => x.concurso == null);
  const prox = proximoConcurso();
  $('#painelPendentes').innerHTML = semConcurso.length
    ? `<div class="pendentes">
        <div>
          <b>${semConcurso.length} bilhete(s) sem concurso definido.</b>
          <span class="nota">Sem saber contra qual sorteio conferir, o sistema não
          consegue calcular acertos. Informe o concurso e eles são conferidos na hora.</span>
        </div>
        <div class="campo inline">
          <label>Concurso</label>
          <input type="number" id="concursoEmMassa" value="${prox ?? ''}" placeholder="ex.: ${prox ?? 3450}">
          <button class="btn primario" id="btnAplicarConcurso">Aplicar aos ${semConcurso.length}</button>
        </div>
      </div>`
    : '';

  if (semConcurso.length) {
    $('#btnAplicarConcurso').addEventListener('click', async () => {
      const n = Number($('#concursoEmMassa').value);
      if (!n) return toast('Informe o número do concurso.', true);
      const atualizados = semConcurso.map((x) => ({ ...x, concurso: n }));
      await DB.salvarBilhetes(atualizados);
      const r = await conferirTodos(estado.loteriaId, estado.historico);
      await renderBilhetes();
      await renderPainel();
      await atualizarRetrospectiva();
      toast(
        r.conferidos
          ? `${atualizados.length} bilhete(s) no concurso ${n} — conferidos, ${r.premiados} premiado(s).`
          : `${atualizados.length} bilhete(s) no concurso ${n}. Esse concurso ainda não saiu; a conferência acontece sozinha quando o resultado chegar.`
      );
    });
  }

  if (!lista.length) {
    $('#tabelaBilhetes').innerHTML =
      `<p class="vazio">${todos.length ? 'Nenhum bilhete com esse filtro.' : 'Nenhum bilhete ainda — gere alguns ou cadastre uma aposta feita.'}</p>`;
    return;
  }

  const porNumero = new Map(estado.historico.map((c) => [c.numero, new Set(c.dezenas)]));

  $('#tabelaBilhetes').innerHTML = `<div class="rolagem"><table>
    <thead><tr>
      <th>Concurso</th><th>Dezenas</th><th>Origem</th>
      <th>Acertos</th><th>Custo</th><th>Prêmio</th><th></th>
    </tr></thead>
    <tbody>
      ${lista.map((bi) => {
        const sorteadas = bi.concurso != null ? porNumero.get(Number(bi.concurso)) : null;
        const marcadas = sorteadas ?? new Set();
        return `<tr data-id="${bi.id}">
          <td><input type="number" class="concurso-input ${bi.concurso == null ? 'faltando' : ''}"
            value="${bi.concurso ?? ''}" placeholder="—" title="Contra qual concurso conferir este bilhete"></td>
          <td>${bolinhas(bi.dezenas, marcadas)}</td>
          <td><span class="nota">${bi.origem ?? ''}${bi.rotulo ? `<br>${bi.rotulo}` : ''}</span></td>
          <td>${bi.acertos != null ? `<b>${bi.acertos}</b>${bi.premiado ? ' 🏆' : ''}` : '<span class="nota">—</span>'}</td>
          <td>${brl(bi.custo ?? 0)}</td>
          <td><input type="number" step="0.01" class="premio-input" value="${bi.premio ?? 0}">
            ${seloDoPremio(bi)}</td>
          <td><button class="btn fantasma perigo apagar" style="padding:.25rem .55rem">✕</button></td>
        </tr>`;
      }).join('')}
    </tbody></table></div>`;

  /* O id é um UUID em TEXTO desde a migração para a sincronização entre
     aparelhos. Aqui havia `Number(...)`, sobra da época do id sequencial:
     `Number('7eb99ae3-…')` é NaN, o registro nunca era encontrado, e as três
     ações abaixo falhavam em silêncio absoluto — sem erro no console, sem
     aviso na tela, sem nada. Nunca converter este id. */
  $$('#tabelaBilhetes .apagar').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      await DB.apagarBilhete(id);
      await renderBilhetes();
      await renderPainel();
    });
  });

  $$('#tabelaBilhetes .concurso-input').forEach((inp) => {
    inp.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      const alvo = todos.find((x) => x.id === id);
      if (!alvo) return;
      const valor = e.target.value === '' ? null : Number(e.target.value);
      alvo.concurso = valor;
      // Mudou o concurso, os acertos antigos não valem mais.
      alvo.conferido = false;
      alvo.acertos = null;
      alvo.premiado = false;
      await DB.salvarBilhete(alvo);
      if (valor != null) await conferirTodos(estado.loteriaId, estado.historico);
      await renderBilhetes();
      await renderPainel();
    });
  });

  $$('#tabelaBilhetes .premio-input').forEach((inp) => {
    inp.addEventListener('change', async (e) => {
      const id = e.target.closest('tr').dataset.id;
      const alvo = todos.find((x) => x.id === id);
      if (!alvo) return;
      const digitado = Number(e.target.value) || 0;
      alvo.premio = digitado;
      /* Marcar como manual é o que impede a conferência seguinte de
         sobrescrever este número com o rateio da Caixa. Voltar o campo a
         zero desmarca: aí o usuário está dizendo "esquece o que eu pus",
         e a conferência pode preencher de novo. */
      alvo.premioFonte = digitado > 0 ? 'manual' : null;
      await DB.salvarBilhete(alvo);
      await renderBilhetes();
      await renderPainel();
    });
  });
}

$('#soPremiados').addEventListener('change', renderBilhetes);
$('#filtroConcurso').addEventListener('input', renderBilhetes);

$('#btnConferir').addEventListener('click', async () => {
  if (!estado.historico.length) return toast('Baixe os resultados primeiro.', true);

  const total = (await DB.listarBilhetes(estado.loteriaId)).length;
  if (!total) return toast('Você ainda não tem bilhetes cadastrados.', true);

  const r = await conferirTodos(estado.loteriaId, estado.historico);
  await renderBilhetes();
  await renderPainel();

  // Quando nada pôde ser conferido, dizer exatamente POR QUE — um toast com
  // "0 conferidos" parece o botão estar quebrado. E os dois motivos possíveis
  // pedem respostas diferentes: um o usuário resolve agora, o outro é só esperar.
  const plural = (n, um, muitos) => (n === 1 ? um : muitos);

  if (!r.conferidos) {
    if (r.semConcurso) {
      return toast(
        `${r.semConcurso} ${plural(r.semConcurso, 'bilhete está', 'bilhetes estão')} ` +
          `sem concurso definido, então não há contra o que conferir. ` +
          `Informe o concurso no painel acima da lista.`,
        true
      );
    }
    return toast(
      `Nada a conferir ainda: ${plural(r.aguardando, 'o bilhete aponta', 'os bilhetes apontam')} ` +
        `para ${plural(r.aguardando, 'um concurso que ainda não saiu', 'concursos que ainda não saíram')}.`
    );
  }

  const extras = [];
  if (r.aguardando) extras.push(`${r.aguardando} aguardando o sorteio`);
  if (r.semConcurso) extras.push(`${r.semConcurso} sem concurso definido`);

  toast(
    `${r.conferidos} ${plural(r.conferidos, 'bilhete conferido', 'bilhetes conferidos')}, ` +
      `${r.premiados} ${plural(r.premiados, 'premiado', 'premiados')}` +
      (extras.length ? ` · ${extras.join(', ')}.` : '.')
  );
});

$('#btnExportarCSV').addEventListener('click', async () => {
  const bilhetes = await DB.listarBilhetes(estado.loteriaId);
  if (!bilhetes.length) return toast('Nada para exportar.', true);
  baixar(`bilhetes-${estado.loteriaId}.csv`, exportarCSV(bilhetes), 'text/csv');
});

$('#btnLimparBilhetes').addEventListener('click', async () => {
  if (!confirm('Apagar TODOS os bilhetes de todas as loterias? Não dá para desfazer.')) return;
  await DB.apagarTodosBilhetes();
  await renderBilhetes();
  await renderPainel();
  toast('Bilhetes apagados.');
});

/* ------------------------------------------------------------------ */
/* Configurações                                                       */
/* ------------------------------------------------------------------ */

function renderConfig() {
  $('#precos').innerHTML = LISTA_LOTERIAS.map(
    (l) => `<div class="campo inline" style="margin-bottom:.5rem">
      <label style="min-width:110px">${l.nome}</label>
      <input type="number" step="0.01" data-preco="${l.id}" value="${precoDe(l)}">
      <span class="nota">aposta de ${l.marcarMin} dezenas</span>
    </div>`
  ).join('');

  Promise.all(LISTA_LOTERIAS.map(async (l) => {
    const h = await DB.lerHistorico(l.id);
    const nums = h?.concursos ? Object.keys(h.concursos) : [];
    return `<tr>
      <td><b>${l.nome}</b></td>
      <td>${nums.length.toLocaleString('pt-BR')} concursos</td>
      <td>${nums.length ? `até o ${Math.max(...nums.map(Number))}` : '—'}</td>
      <td class="nota">${h?.atualizadoEm ? new Date(h.atualizadoEm).toLocaleString('pt-BR') : 'nunca'}</td>
    </tr>`;
  })).then((linhas) => {
    $('#statusBases').innerHTML =
      `<div class="rolagem"><table><thead><tr><th>Loteria</th><th>Base</th><th>Último</th><th>Atualizada em</th></tr></thead><tbody>${linhas.join('')}</tbody></table></div>`;
  });

  renderStatusRateios();
}

/* ------------------------------------------------------------------ */
/* Prêmios pagos (rateio da Caixa, concurso a concurso)                */
/* ------------------------------------------------------------------ */

/* Fica fora de qualquer função para o botão "Parar" conseguir alcançar o
   laço que já está rodando. Uma variável dentro do handler seria recriada
   a cada clique e o Parar nunca chegaria em quem está no ar. */
let pararRateios = false;

async function renderStatusRateios() {
  const linhas = await Promise.all(LISTA_LOTERIAS.map(async (l) => {
    const c = await coberturaDeRateios(l.id);
    const pct = c.total ? (c.comRateio / c.total) * 100 : 0;
    const completo = c.total > 0 && c.faltando.length === 0;
    return `<tr>
      <td><b>${l.nome}</b></td>
      <td>${c.comRateio.toLocaleString('pt-BR')} de ${c.total.toLocaleString('pt-BR')}</td>
      <td>
        <span class="barra-trilho" style="display:inline-block;width:110px;vertical-align:middle">
          <span class="barra-valor-visual" style="display:block;height:100%;width:${pct.toFixed(1)}%;background:var(--loteria);border-radius:4px"></span>
        </span>
        ${completo ? '<span class="selo fixo">completo</span>' : `${pct.toFixed(0)}%`}
      </td>
    </tr>`;
  }));

  $('#statusRateios').innerHTML =
    `<div class="rolagem"><table><thead><tr>
       <th>Loteria</th><th>Concursos com prêmio</th><th>Cobertura</th>
     </tr></thead><tbody>${linhas.join('')}</tbody></table></div>`;

  /* Nada a baixar → botão desligado. Um botão que aceita o clique e não faz
     nada visível é a mesma classe de defeito do "Salvo" que este projeto já
     pagou caro: a tela aceitando uma ação que não existe. */
  const faltamAoTodo = (await Promise.all(
    LISTA_LOTERIAS.map(async (l) => (await coberturaDeRateios(l.id)).faltando.length)
  )).reduce((s, n) => s + n, 0);

  const btn = $('#btnBaixarRateios');
  if (btn && !btn.dataset.rodando) {
    btn.disabled = faltamAoTodo === 0;
    btn.textContent = faltamAoTodo === 0
      ? 'Tudo baixado'
      : `Baixar prêmios que faltam (${faltamAoTodo.toLocaleString('pt-BR')})`;
  }
}

$('#btnPararRateios').addEventListener('click', () => {
  pararRateios = true;
  $('#btnPararRateios').disabled = true;
  $('#progressoRateios').textContent = 'Parando depois do bloco atual…';
});

$('#btnBaixarRateios').addEventListener('click', async () => {
  const btn = $('#btnBaixarRateios');
  const parar = $('#btnPararRateios');
  const status = $('#progressoRateios');

  pararRateios = false;
  /* Marca que há um download no ar: sem isso, o `renderStatusRateios` que
     roda a cada lote reescreveria o rótulo do botão por cima do "Baixando…"
     e ainda poderia reabilitá-lo no meio da operação. */
  btn.dataset.rodando = '1';
  btn.disabled = true;
  btn.textContent = 'Baixando…';
  parar.hidden = false;
  parar.disabled = false;

  let totalBaixado = 0;
  let bloqueado = false;

  try {
    for (const l of LISTA_LOTERIAS) {
      /* Cada modalidade em quantos lotes forem precisos. O laço termina
         quando não sobrar nada, quando a Caixa fechar a porta, ou quando um
         lote não trouxer nada — sem essa última saída, uma Caixa fora do ar
         viraria laço infinito girando em falso. */
      for (;;) {
        if (pararRateios || bloqueado) break;

        const r = await baixarRateios(l.id, {
          onProgresso: (txt) => { status.textContent = txt; },
          pedidoDeParar: () => pararRateios,
        });

        totalBaixado += r.baixados;
        await renderStatusRateios();

        /* Bloqueio de IP não se resolve insistindo: cada pedido a mais
           renova a contagem do WAF e adia a liberação. Para tudo, inclusive
           as outras modalidades — a porta é a mesma para todas. */
        if (r.bloqueado) { bloqueado = true; break; }
        if (r.restantes === 0 || r.baixados === 0 || r.parou) break;

        status.textContent =
          `${l.nome}: faltam ${r.restantes.toLocaleString('pt-BR')} concursos. Continuando…`;
        await esperarPintura();
      }
      if (pararRateios || bloqueado) break;
    }

    /* A base em memória ficou velha: os bilhetes e a Retrospectiva precisam
       enxergar os prêmios que acabaram de entrar. */
    await trocarLoteria();
    if (estado.historico.length) await conferirTodos(estado.loteriaId, estado.historico);
    await renderBilhetes();
    await renderPainel();

    status.innerHTML = bloqueado
      ? `<span style="color:var(--alerta)">A Caixa parou de responder ao seu acesso.</span>
         Os <b>${totalBaixado.toLocaleString('pt-BR')}</b> concursos desta rodada estão
         guardados. Ela limita quantos pedidos um mesmo acesso pode fazer por vez, e o
         bloqueio é <b>temporário e curto</b> — na vez em que isso foi medido, saiu em
         cerca de 5 minutos. Espere um pouco e clique de novo para continuar de onde
         parou. Insistir agora só renova a contagem e adia a liberação.`
      : pararRateios
        ? `Parado. ${totalBaixado.toLocaleString('pt-BR')} concurso(s) baixados —
           clique de novo quando quiser continuar de onde parou.`
        : `Pronto: ${totalBaixado.toLocaleString('pt-BR')} concurso(s) com prêmio guardado.`;

    toast(
      bloqueado ? 'A Caixa bloqueou temporariamente — tente daqui a pouco.'
        : pararRateios ? 'Download interrompido.'
        : 'Prêmios atualizados.',
      bloqueado
    );
  } catch (e) {
    status.innerHTML = `<span style="color:var(--perigo)">Não deu certo:</span> ${semTags(e.message)}`;
    toast(e.message, true);
  } finally {
    delete btn.dataset.rodando;
    parar.hidden = true;
    pararRateios = false;
    /* Quem devolve rótulo e estado ao botão é o render — ele sabe quantos
       ainda faltam. Escrever um texto fixo aqui recriaria o botão que
       promete uma ação que já não existe. */
    await renderStatusRateios();
  }
});

$('#btnSalvarProxy').addEventListener('click', async () => {
  await definirProxy($('#fonteProxy').value.trim());
  $('#statusProxy').textContent = 'Endereço salvo.';
  toast('Fonte salva. Use "Testar conexão" para confirmar.');
});

$('#btnTestarProxy').addEventListener('click', async () => {
  const el = $('#statusProxy');
  const btn = $('#btnTestarProxy');
  btn.disabled = true; btn.textContent = 'Testando…';
  el.textContent = '';
  try {
    const c = await testarFonte(estado.loteriaId);
    el.innerHTML = `<span style="color:var(--acento)">Funcionando</span> (${c.via}).
      A ${loteria().nome} está no concurso <b>${c.numero}</b>${
        c.data ? `, de ${new Date(`${c.data}T12:00:00`).toLocaleDateString('pt-BR')}` : ''
      }.`;
  } catch (e) {
    el.innerHTML = `<span style="color:var(--perigo)">Não funcionou:</span> ${e.message}
      <br>A API da Caixa só aceita acessos com IP do Brasil. Se você usa VPN,
      desligue e tente de novo.`;
  } finally {
    btn.disabled = false; btn.textContent = 'Testar conexão';
  }
});

$('#btnSalvarPrecos').addEventListener('click', async () => {
  for (const inp of $$('[data-preco]')) {
    estado.precos[inp.dataset.preco] = Number(inp.value) || LOTERIAS[inp.dataset.preco].precoBase;
  }
  await DB.setConfig('precos', estado.precos);
  montarOpcoesGerador();
  montarOpcoesFechamento();
  await renderPainel();
  toast('Preços salvos.');
});

$('#btnSincronizar').addEventListener('click', async () => {
  await executarRotina({ forcar: true, silencioso: false });
});

$('#btnSincronizarTudo').addEventListener('click', async () => {
  const btn = $('#btnSincronizarTudo');
  btn.disabled = true; btn.textContent = 'Baixando…';
  for (const l of LISTA_LOTERIAS) {
    btn.textContent = `Baixando ${l.nome}…`;
    await sincronizarLoteria(l.id, true);
  }
  btn.disabled = false; btn.textContent = 'Baixar tudo de novo';
  toast('Bases atualizadas.');
  await trocarLoteria();
  renderConfig();
});

$('#arquivoImport').addEventListener('change', async (e) => {
  const arq = e.target.files[0];
  if (!arq) return;
  try {
    const texto = await arq.text();
    const r = await importarArquivo(estado.loteriaId, texto);
    $('#statusImport').textContent =
      `Importado: ${r.total} concursos na base, até o nº ${r.ultimo}.`;
    await trocarLoteria();
    renderConfig();
    toast('Import concluído.');
  } catch (err) {
    $('#statusImport').textContent = `Erro: ${err.message}`;
    toast(err.message, true);
  } finally {
    e.target.value = '';
  }
});

function baixar(nome, conteudo, tipo = 'application/json') {
  const blob = new Blob([conteudo], { type: `${tipo};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * O que PODE sair num backup.
 *
 * Antes daqui saía `todasConfigs()` inteiro — e dentro dele ia
 * `nuvem:sessao`, com o **refresh token** do Firebase. Esse token troca-se
 * por um token de acesso novo a qualquer momento, então o arquivo que a
 * própria tela recomenda baixar dava acesso completo à conta a quem o
 * abrisse: pasta de Downloads, pen drive, anexo de e-mail, sincronizador.
 *
 * E o pior: o restore nunca usou essa sessão para nada. Era vazamento sem
 * contrapartida.
 *
 * Lista de permissão, não de bloqueio: uma configuração nova que apareça
 * amanhã fica de fora até alguém decidir que ela pode sair.
 */
const CONFIGS_NO_BACKUP = ['precos', 'premios', 'avisoLido'];

$('#btnBackup').addEventListener('click', async () => {
  const bilhetes = await DB.listarBilhetes(null, true);   // com lápides, para não ressuscitar exclusões
  const todas = await DB.todasConfigs();
  const configs = {};
  for (const chave of CONFIGS_NO_BACKUP) {
    if (todas[chave] !== undefined) configs[chave] = todas[chave];
  }
  const dump = { versao: 2, criadoEm: new Date().toISOString(), bilhetes, configs };
  baixar(`backup-loterias-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump, null, 2));
  toast('Backup baixado.');
});

$('#arquivoBackup').addEventListener('change', async (e) => {
  const arq = e.target.files[0];
  if (!arq) return;
  try {
    const dump = JSON.parse(await arq.text());

    /* Qualquer JSON válido passava por aqui e saía com "Backup restaurado:
       0 bilhete(s)" — mensagem de sucesso para uma operação que não fez
       nada. Escolher o arquivo errado é o caminho natural, não a exceção. */
    if (!Array.isArray(dump.bilhetes)) {
      return toast('Este arquivo não é um backup do Loterias da Sorte.', true);
    }

    /* PRESERVAR O ID é o ponto todo.
       Antes o id era descartado (`({ id, ...resto })`) e o `_preparar` do
       db.js gerava um novo para cada registro. Restaurar um backup no
       aparelho que o gerou — o caso mais comum, "vou limpar o cache" —
       DOBRAVA a carteira: 120 bilhetes viravam 240, o investido dobrava, o
       balanço virava ficção, e as cópias ainda subiam para a nuvem e se
       espalhavam para o outro aparelho, de onde não há desfazer.
       Com o id preservado, restaurar é reconciliação: quem já existe é
       atualizado, quem sumiu volta. */
    const bilhetes = dump.bilhetes.filter((b) => b && b.id && Array.isArray(b.dezenas));
    const semId = dump.bilhetes.length - bilhetes.length;
    if (bilhetes.length) await DB.salvarBilhetes(bilhetes);

    /* O backup gravava `configs` inteiro mas o restore só lia `precos`:
       as estimativas de rateio que o usuário digitou uma a uma na
       Retrospectiva eram lidas do arquivo e jogadas fora, caladas. */
    if (dump.configs?.precos) {
      estado.precos = dump.configs.precos;
      await DB.setConfig('precos', estado.precos);
    }
    if (dump.configs?.premios) await DB.setConfig('premios', dump.configs.premios);

    toast(
      `Backup restaurado: ${bilhetes.length} bilhete(s).` +
      (semId ? ` ${semId} registro(s) sem identificação foram ignorados.` : '')
    );
    await trocarLoteria();
    renderConfig();
  } catch (err) {
    toast(`Backup inválido: ${err.message}`, true);
  } finally {
    e.target.value = '';
  }
});

$('#fecharAviso').addEventListener('click', async () => {
  $('.aviso-honesto').style.display = 'none';
  await DB.setConfig('avisoLido', true);
});

/* ------------------------------------------------------------------ */
/* PWA: atualização e instalação                                       */
/* ------------------------------------------------------------------ */

function mostrarFaixaAtualizacao(reg) {
  const el = $('#faixaAtualizacao');
  el.hidden = false;
  el.innerHTML = `
    <div class="faixa-atualizacao">
      <span>Tem uma versão nova do sistema disponível.</span>
      <span class="acoes">
        <button class="btn primario" id="btnAtualizarAgora">Atualizar</button>
        <button class="link" id="btnAtualizarDepois">depois</button>
      </span>
    </div>`;

  $('#btnAtualizarAgora').addEventListener('click', () => {
    $('#btnAtualizarAgora').textContent = 'Atualizando…';
    aplicarAtualizacao(reg);
  });
  $('#btnAtualizarDepois').addEventListener('click', () => { el.hidden = true; });
}

function prepararBotaoInstalar() {
  const caixa = $('#caixaInstalar');
  if (estaInstalado()) { caixa.hidden = true; return; }

  prepararInstalacao({
    aoPoderInstalar: (info) => {
      if (info.instalado) {
        caixa.hidden = true;
        toast('Instalado. Procure o trevo na tela do aparelho.');
        return;
      }
      caixa.hidden = false;
      if (info.ios) {
        $('#btnInstalar').hidden = true;
        $('#dicaInstalar').innerHTML =
          'No iPhone e iPad a instalação é manual: toque no botão de ' +
          '<b>Compartilhar</b> na barra do Safari e escolha ' +
          '<b>Adicionar à Tela de Início</b>.';
      }
    },
  });

  $('#btnInstalar').addEventListener('click', async () => {
    const r = await instalar();
    if (!r.ok && r.manual) {
      $('#dicaInstalar').innerHTML = r.ios
        ? 'No Safari: botão <b>Compartilhar</b> → <b>Adicionar à Tela de Início</b>.'
        : 'Seu navegador não oferece o instalador automático. Procure ' +
          '"Instalar aplicativo" no menu dele.';
    }
  });
}

/* ------------------------------------------------------------------ */
/* Nuvem                                                               */
/* ------------------------------------------------------------------ */

async function renderNuvem() {
  const configurada = await Nuvem.estaConfigurada();
  const sessao = await Nuvem.sessaoAtual();
  const ultima = await Nuvem.ultimaSincronizacao();
  const dentro = Boolean(sessao);

  /* ---- cabeçalho ---- */
  $('#btnAbrirLogin').hidden = dentro;
  $('#chipConta').hidden = !dentro;

  /* ---- janela de login ---- */
  $('#nuvemSemChaves').hidden = configurada;
  $('#loginNuvem').hidden = !configurada;

  /* ---- aba Configurações ---- */
  $('#nuvemDeslogado').hidden = dentro;
  $('#nuvemConectado').hidden = !dentro;
  if (!dentro) $('#trocaSenha').hidden = true;

  /* Quantos bilhetes existem só neste aparelho. Deslogado, é o número que
     responde "o que eu perco se limpar o navegador?" — e é o argumento
     honesto para criar conta, melhor que qualquer texto de propaganda. */
  const locais = (await DB.listarBilhetes(null, true)).filter((b) => !b.removido).length;
  const aviso = $('#avisoLocal');
  if (aviso) {
    aviso.innerHTML = locais
      ? `Você tem <b>${locais} bilhete(s)</b> guardado(s) só neste aparelho.
         Ao entrar, eles sobem para a sua conta — nada se perde.`
      : 'Sem conta o sistema funciona igual: gerar, conferir, tudo. A conta serve ' +
        'para os bilhetes acompanharem você no outro aparelho.';
  }

  if (!dentro) return;

  const email = sessao.email ?? 'sua conta';
  const inicial = email.trim().charAt(0) || '?';
  $('#emailConta').textContent = email;
  $('#avatarConta').textContent = inicial;
  $('#avatarTopo').textContent = inicial;
  $('#emailTopo').textContent = email;

  const quando = ultima
    ? `última sincronização: ${new Date(ultima).toLocaleString('pt-BR')}`
    : 'ainda não sincronizou neste aparelho';

  /* O selo dizia "sincronizado" sempre que EXISTISSE uma sincronização
     bem-sucedida em algum momento — inclusive semanas atrás. Como as duas
     que mais importam rodam em silêncio (ao salvar e ao abrir o app), uma
     falha persistente só aparecia no console. */
  const selo = $('#seloSync');
  const ponto = $('#pontoSync');
  const chip = $('#chipConta');
  if (estado.erroNuvem) {
    selo.textContent = 'com erro';
    selo.dataset.estado = 'pendente';
    ponto.dataset.estado = 'erro';
    chip.title = `Sincronização com erro: ${estado.erroNuvem}`;
    $('#ultimaSync').innerHTML =
      `<span style="color:var(--perigo)">A última tentativa falhou: ${estado.erroNuvem}</span>`;
  } else {
    selo.textContent = ultima ? 'sincronizado' : 'pendente';
    selo.dataset.estado = ultima ? 'ok' : 'pendente';
    ponto.dataset.estado = ultima ? 'ok' : 'pendente';
    chip.title = `${email} — ${quando}`;
    $('#ultimaSync').textContent = quando;
  }
}

/* ------------------------------------------------------------------ */
/* Janela de login                                                     */
/* ------------------------------------------------------------------ */

let focoAntesDoModal = null;

async function abrirLogin() {
  focoAntesDoModal = document.activeElement;
  /* Recontar ANTES de mostrar. O aviso "você tem N bilhetes só neste
     aparelho" é o argumento honesto para criar conta, e um número velho
     (ou o texto genérico) desperdiça exatamente o momento em que ele
     importa: o usuário acabou de salvar bilhetes e clicou em Entrar. */
  await renderNuvem();
  $('#modalLogin').hidden = false;
  document.body.style.overflow = 'hidden';
  limparRecado();
  ($('#nuvemEmail').value ? $('#nuvemSenha') : $('#nuvemEmail')).focus();
}

function fecharLogin() {
  $('#modalLogin').hidden = true;
  document.body.style.overflow = '';
  $('#nuvemSenha').value = '';
  $('#forcaSenha').hidden = true;
  limparRecado();
  focoAntesDoModal?.focus?.();
}

$('#btnAbrirLogin').addEventListener('click', abrirLogin);
$('#btnEntrarConfig').addEventListener('click', abrirLogin);
/* Clicar no chip com a conta aberta leva às Configurações, onde ficam
   sincronizar, trocar senha e sair. */
$('#chipConta').addEventListener('click', () => {
  $$('.aba').forEach((a) => a.classList.remove('ativa'));
  $$('.tela').forEach((t) => t.classList.remove('ativa'));
  $('.aba[data-alvo="config"]').classList.add('ativa');
  $('#config').classList.add('ativa');
  $('#nuvemConectado').scrollIntoView({ behavior: 'smooth', block: 'center' });
});
$('#btnFecharLogin').addEventListener('click', fecharLogin);
/* Clique no fundo escuro fecha; clique dentro da janela, não. */
$('#modalLogin').addEventListener('click', (ev) => {
  if (ev.target === $('#modalLogin')) fecharLogin();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#modalLogin').hidden) fecharLogin();
});

/** Sincroniza sem atrapalhar: falha de rede aqui não pode quebrar nada. */
async function sincronizarNuvem({ silencioso = true, completa = false } = {}) {
  if (!(await Nuvem.estaConfigurada())) return null;
  if (!(await Nuvem.sessaoAtual())) return null;

  const btn = $('#btnSincronizarNuvem');
  if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando…'; }
  try {
    const r = await Nuvem.sincronizar({ completa });
    if (r.aplicados) {
      await renderBilhetes();
      await renderPainel();
      await renderEmAberto();
      await atualizarRetrospectiva();
    }
    estado.erroNuvem = null;
    if (!silencioso) {
      toast(
        `Nuvem: ${r.enviados} enviado(s), ${r.aplicados} recebido(s) deste aparelho.`
      );
    }
    await renderNuvem();
    return r;
  } catch (e) {
    /* Guardar o erro mesmo no modo silencioso: silencioso quer dizer "não
       interrompe o que o usuário está fazendo", não "esconde para sempre". */
    estado.erroNuvem = semTags(e.message);
    if (!silencioso) toast(`Nuvem: ${e.message}`, true);
    else console.warn('[nuvem]', e.message);
    await renderNuvem();
    return null;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Sincronizar agora'; }
  }
}

/* ---- conta: entrar / criar ---- */

/** 'entrar' ou 'criar'. Uma tela só, dois modos — menos lugar para se perder. */
let modoConta = 'entrar';

const recado = (texto, tipo = 'erro') => {
  const el = $('#recadoLogin');
  el.className = `recado-login ${tipo}`;
  el.innerHTML = texto;
  el.hidden = false;
};
const limparRecado = () => { $('#recadoLogin').hidden = true; };

/**
 * Força da senha, medida pelo que de fato dificulta um ataque: tamanho
 * primeiro, variedade depois. Não é uma nota de prova — é um empurrão
 * visual, e por isso nunca impede de continuar.
 */
function forcaDaSenha(s) {
  if (!s) return { nivel: 0, rotulo: '' };
  let p = 0;
  if (s.length >= 8) p++;
  if (s.length >= 12) p++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) p++;
  if (/\d/.test(s) && /[^\w]/.test(s)) p++;
  const nivel = Math.max(1, Math.min(4, p));
  return { nivel, rotulo: ['', 'fraca', 'razoável', 'boa', 'ótima'][nivel] };
}

function aplicarModoConta() {
  const criando = modoConta === 'criar';
  $$('.aba-login').forEach((b) => {
    const ativa = b.dataset.modo === modoConta;
    b.classList.toggle('ativa', ativa);
    b.setAttribute('aria-selected', String(ativa));
  });
  $('#btnConta').textContent = criando ? 'Criar conta' : 'Entrar';
  $('#nuvemSenha').setAttribute('autocomplete', criando ? 'new-password' : 'current-password');
  $('#btnEsqueciSenha').hidden = criando;
  $('#btnTrocarModo').textContent = criando ? 'Já tenho conta' : 'Não tenho conta ainda';
  $('#forcaSenha').hidden = !criando || !$('#nuvemSenha').value;
  $('#dicaSenha').textContent = criando
    ? 'Mínimo de 8 caracteres. Anote num lugar seguro — a recuperação depende do seu e-mail.'
    : 'Use a mesma conta nos dois aparelhos — é ela que liga os bilhetes de um ao outro.';
}

const trocarModo = (m) => { modoConta = m; aplicarModoConta(); limparRecado(); };

$$('.aba-login').forEach((b) => b.addEventListener('click', () => trocarModo(b.dataset.modo)));
$('#btnTrocarModo').addEventListener('click', () =>
  trocarModo(modoConta === 'criar' ? 'entrar' : 'criar'));

/** Mostrar/esconder senha, reaproveitado pelos dois campos. */
function ligarOlho(idBotao, idCampo) {
  $(idBotao).addEventListener('click', () => {
    const campo = $(idCampo);
    const vendo = campo.type === 'text';
    campo.type = vendo ? 'password' : 'text';
    $(idBotao).textContent = vendo ? 'ver' : 'ocultar';
    $(idBotao).setAttribute('aria-label', vendo ? 'Mostrar a senha' : 'Ocultar a senha');
    campo.focus();
  });
}
ligarOlho('#verSenha', '#nuvemSenha');
ligarOlho('#verSenhaNova', '#senhaNova');

$('#nuvemSenha').addEventListener('input', (ev) => {
  if (modoConta !== 'criar') return;
  const f = forcaDaSenha(ev.target.value);
  const el = $('#forcaSenha');
  el.hidden = !ev.target.value;
  el.dataset.nivel = String(f.nivel);
  el.querySelector('.rotulo').textContent = f.rotulo;
});

/* Erro é sobre o que foi enviado, não sobre o que está sendo digitado.
   Sem isto, a tela se contradiz: a barra de força diz "ótima" enquanto o
   recado logo abaixo ainda acusa "precisa de pelo menos 8 caracteres",
   porque a mensagem é do envio anterior. Some ao primeiro toque. */
['#nuvemEmail', '#nuvemSenha'].forEach((sel) =>
  $(sel).addEventListener('input', () => {
    if (!$('#recadoLogin').hidden) limparRecado();
  }));

/* Caps Lock ligado é a causa silenciosa nº 1 de "minha senha não funciona". */
['keyup', 'keydown'].forEach((evt) =>
  $('#nuvemSenha').addEventListener(evt, (ev) => {
    const ligado = typeof ev.getModifierState === 'function' && ev.getModifierState('CapsLock');
    $('#avisoCaps').hidden = !ligado;
  }));
$('#nuvemSenha').addEventListener('blur', () => { $('#avisoCaps').hidden = true; });

async function ocupado(btn, rotulo, tarefa) {
  const antes = btn.textContent;
  btn.disabled = true; btn.setAttribute('aria-busy', 'true'); btn.textContent = rotulo;
  try { return await tarefa(); }
  finally { btn.disabled = false; btn.removeAttribute('aria-busy'); btn.textContent = antes; }
}

$('#formConta').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  limparRecado();
  const email = $('#nuvemEmail').value.trim();
  const senha = $('#nuvemSenha').value;

  if (!email.includes('@') || email.length < 5) return recado('Informe um e-mail válido.');
  if (!senha) return recado('Informe a senha.');
  /* O Firebase aceita 6; exigimos 8 na criação porque esta senha protege
     dados num banco aberto à internet, e o custo para o usuário é zero. */
  if (modoConta === 'criar' && senha.length < 8) {
    return recado('A senha precisa de pelo menos 8 caracteres.');
  }

  try {
    await ocupado($('#btnConta'), modoConta === 'criar' ? 'Criando…' : 'Entrando…', async () => {
      if (modoConta === 'criar') await Nuvem.criarConta(email, senha);
      else await Nuvem.entrarComSenha(email, senha);
    });
    /* Quantos bilhetes existiam SÓ aqui antes de entrar — para poder dizer
       ao usuário o que aconteceu com eles, em vez de sincronizar em
       silêncio e deixá-lo adivinhar. */
    const locaisAntes = (await DB.listarBilhetes(null, true)).filter((b) => !b.removido).length;

    fecharLogin();
    await renderNuvem();

    /* `completa: true` ignora o cursor e envia TUDO o que está no aparelho.
       É o que faz o trabalho feito antes do login subir junto — a promessa
       de "use sem conta, entre quando quiser, nada se perde". */
    const r = await sincronizarNuvem({ silencioso: true, completa: true });

    if (modoConta === 'criar') {
      toast(locaisAntes
        ? `Conta criada. ${locaisAntes} bilhete(s) deste aparelho foram para a sua conta.`
        : 'Conta criada e conectada.');
    } else {
      const veio = r?.aplicados ?? 0;
      toast(veio
        ? `Conectado. ${veio} bilhete(s) vieram da sua conta.`
        : (locaisAntes ? `Conectado. ${locaisAntes} bilhete(s) deste aparelho foram para a sua conta.` : 'Conectado.'));
    }
  } catch (e) {
    recado(e.message);
  }
});

$('#btnEsqueciSenha').addEventListener('click', async () => {
  const email = $('#nuvemEmail').value.trim();
  if (!email.includes('@')) return recado('Escreva seu e-mail no campo acima primeiro.');
  try {
    await ocupado($('#btnEsqueciSenha'), 'Enviando…', () => Nuvem.pedirRedefinicaoDeSenha(email));
    recado(`Enviado para <b>${email}</b>. Abra o e-mail e siga o link para escolher a senha nova.`, 'ok');
  } catch (e) {
    recado(e.message);
  }
});

$('#btnMudarSenha').addEventListener('click', () => {
  $('#trocaSenha').hidden = false;
  $('#senhaNova').focus();
});

$('#btnCancelarSenha').addEventListener('click', () => {
  $('#senhaNova').value = '';
  $('#trocaSenha').hidden = true;
});

$('#btnTrocarSenha').addEventListener('click', async () => {
  const nova = $('#senhaNova').value;
  if (nova.length < 8) return toast('A senha precisa de pelo menos 8 caracteres.', true);
  try {
    await ocupado($('#btnTrocarSenha'), 'Salvando…', () => Nuvem.trocarSenha(nova));
    $('#senhaNova').value = '';
    $('#trocaSenha').hidden = true;
    toast('Senha alterada.');
  } catch (e) {
    /* Antes isto escrevia em `#statusNuvem`, um parágrafo abaixo de todo o
       cartão — podia nascer fora da tela, e nada no arquivo o limpava
       depois: o erro ficava lá mesmo após uma troca bem-sucedida. */
    toast(e.message, true);
  }
});

$('#btnSincronizarNuvem').addEventListener('click', () =>
  sincronizarNuvem({ silencioso: false })
);

$('#btnSairNuvem').addEventListener('click', async () => {
  if (!confirm('Sair da conta neste aparelho? Os bilhetes continuam gravados aqui.')) return;
  await Nuvem.sair();
  await renderNuvem();
  toast('Desconectado. Os dados locais continuam intactos.');
});

/* ------------------------------------------------------------------ */
/* Rotina automática                                                   */
/* ------------------------------------------------------------------ */

/**
 * Sincroniza o que estiver velho, confere os bilhetes e monta o boletim —
 * sem o usuário pedir.
 *
 * Nunca bloqueia a abertura do sistema: se a internet estiver fora, seguimos
 * com o que já está gravado e dizemos isso discretamente, em vez de encher a
 * tela de erro por algo que o usuário não pode resolver agora.
 */
async function executarRotina({ forcar = false, silencioso = true } = {}) {
  const btn = $('#btnSincronizar');
  const status = $('#statusRotina');
  if (btn) { btn.disabled = true; btn.textContent = 'Verificando…'; }

  try {
    const saidas = await rodarRotinaCompleta({
      forcar,
      aoProgredir: (m) => { if (status) status.textContent = m; },
    });

    const desta = saidas.find((x) => x.loteria === estado.loteriaId);
    const novos = saidas.reduce((a, x) => a + x.concursosNovos.length, 0);
    const falhas = saidas.filter((x) => x.erroSync);

    // Recarrega o histórico e repinta tudo que depende dele.
    await trocarLoteria();
    renderConfig();

    const diag = saidas.find((x) => x.loteria === estado.loteriaId)?.diagnostico;
    if (!silencioso && diag && !diag.ok && diag.gravidade === 'grave') {
      toast(diag.motivo, true);
    }

    if (status) {
      status.textContent = falhas.length
        ? 'Sem conexão com o servidor de resultados — usando a base local.'
        : `Verificado ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}.`;
    }

    if (silencioso) return saidas;

    if (falhas.length === saidas.length) {
      toast('Não consegui buscar os resultados. Sua base local continua valendo.', true);
    } else if (novos) {
      toast(`${novos} concurso(s) novo(s). Seus bilhetes já foram conferidos.`);
    } else if (desta?.conferidos) {
      toast(`Tudo em dia — ${desta.conferidos} bilhete(s) conferidos, nenhum resultado novo.`);
    } else {
      toast('Tudo em dia. Nenhum resultado novo.');
    }
    return saidas;
  } catch (e) {
    console.error(e);
    if (!silencioso) toast(`Erro na verificação: ${e.message}`, true);
    return [];
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Verificar agora'; }
  }
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

async function iniciar() {
  estado.precos = (await DB.getConfig('precos', {})) ?? {};
  estado.premios = (await DB.getConfig('premios', {})) ?? {};
  $('#fonteProxy').value = await urlDoProxy();

  iniciarResultados({
    loteria,
    historico: () => estado.historico,
    toast,
  });

  iniciarRetrospectiva({
    loteria,
    loteriaId: () => estado.loteriaId,
    historico: () => estado.historico,
    rateios: () => estado.rateios,
    precoDe,
    premiosSalvos: () => estado.premios,
    salvarPremios: async (p) => {
      estado.premios = p;
      await DB.setConfig('premios', p);
    },
    toast,
    grafico,
    esperarPintura,
    baixar,
  });
  if (await DB.getConfig('avisoLido', false)) {
    $('.aviso-honesto').style.display = 'none';
  }

  montarSeletorLoteria();
  await trocarLoteria();
  renderConfig();
  await renderNuvem();
  prepararBotaoInstalar();
  registrarServiceWorker({ aoAtualizar: mostrarFaixaAtualizacao });

  const primeiraVez = !(await DB.lerHistorico(estado.loteriaId));
  if (primeiraVez) toast('Primeira execução — baixando os resultados…');

  // A rotina roda em segundo plano: a interface já está utilizável com a
  // base local enquanto os resultados novos chegam.
  const saidas = await executarRotina({ forcar: primeiraVez, silencioso: true });

  if (primeiraVez) {
    toast('Pronto. Base de resultados carregada.');
    return;
  }

  // Puxa o que o outro aparelho fez desde a última vez.
  await sincronizarNuvem();

  const novos = saidas.reduce((a, x) => a + x.concursosNovos.length, 0);
  const boletim = saidas.find((x) => x.loteria === estado.loteriaId)?.boletim;
  if (boletim) return;                       // o boletim na tela já dá a notícia
  if (novos) toast(`${novos} concurso(s) novo(s) desde a última vez.`);
}

iniciar().catch((e) => {
  console.error(e);
  toast(`Erro ao iniciar: ${e.message}`, true);
});
