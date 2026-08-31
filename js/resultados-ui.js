/**
 * resultados-ui.js — A aba Resultados.
 *
 * O histórico já estava no sistema, mas só como matéria-prima da
 * estatística: números numa tabela. Esta aba existe para outra coisa —
 * VER o sorteio como ele aparece no volante.
 *
 * A diferença não é enfeite. "03 04 07 09 11 13 14 15 17 18 20 21 22 24 25"
 * é uma lista; a mesma coisa marcada na grade 5×5 mostra na hora que o
 * sorteio pegou a coluna da direita inteira e deixou um buraco no miolo.
 * Isso o olho vê e a lista esconde.
 *
 * Por isso a grade traz as contagens por linha e por coluna nas margens: é
 * a resposta precisa para "como as dezenas se distribuíram no bilhete".
 *
 * E as dezenas repetidas do concurso anterior ganham uma borda. Repetição é
 * a única relação real entre dois concursos vizinhos que dá para observar
 * — vale mostrar, desde que sem sugerir que ela prevê o próximo.
 */

import { LOTERIAS, universoDe, fmt } from './config.js';
import { caracterizar, posicaoNaGrade, ehMoldura } from './stats.js';

let ctx = null;
let atual = null;          // número do concurso em exibição
let paginaLista = 0;
let buscaLista = '';

const POR_PAGINA = 60;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ------------------------------------------------------------------ */
/* Acesso ao histórico                                                 */
/* ------------------------------------------------------------------ */

function historico() {
  return ctx.historico();
}

function acharIndice(numero) {
  const h = historico();
  // O histórico é contíguo na esmagadora maioria dos casos; a busca binária
  // evita varrer 3.700 itens a cada seta do teclado.
  let lo = 0;
  let hi = h.length - 1;
  while (lo <= hi) {
    const meio = (lo + hi) >> 1;
    if (h[meio].numero === numero) return meio;
    if (h[meio].numero < numero) lo = meio + 1;
    else hi = meio - 1;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* O volante                                                           */
/* ------------------------------------------------------------------ */

/**
 * Desenha a grade da modalidade com as dezenas sorteadas marcadas, e as
 * somas de cada linha e de cada coluna nas margens.
 */
function volanteDoSorteio(sorteio, anterior, l) {
  const marcadas = new Set(sorteio.dezenas);
  const repetidas = anterior ? new Set(anterior.dezenas.filter((d) => marcadas.has(d))) : new Set();

  const linhas = new Array(l.grade.linhas).fill(0);
  const colunas = new Array(l.grade.colunas).fill(0);
  for (const d of sorteio.dezenas) {
    const p = posicaoNaGrade(d, l);
    linhas[p.linha]++;
    colunas[p.coluna]++;
  }

  const celulas = universoDe(l).map((d) => {
    const dentro = marcadas.has(d);
    const rep = repetidas.has(d);
    return `<div class="cel-volante ${dentro ? 'marcada' : ''} ${rep ? 'repetida' : ''}"
      title="${fmt(d, l)}${dentro ? ' — sorteada' : ''}${rep ? ', repetiu do concurso anterior' : ''}">
      ${fmt(d, l)}</div>`;
  });

  /* A grade tem uma coluna e uma linha extras para os totais. */
  const html = [];
  for (let ln = 0; ln < l.grade.linhas; ln++) {
    for (let cl = 0; cl < l.grade.colunas; cl++) {
      html.push(celulas[ln * l.grade.colunas + cl]);
    }
    html.push(`<div class="total-margem" title="dezenas nesta linha">${linhas[ln]}</div>`);
  }
  for (let cl = 0; cl < l.grade.colunas; cl++) {
    html.push(`<div class="total-margem" title="dezenas nesta coluna">${colunas[cl]}</div>`);
  }
  html.push('<div class="total-margem canto"></div>');

  /* Teto por célula: grades estreitas (Lotofácil, 5 colunas) ficariam
     perdidas num painel largo, então ganham células maiores. O mínimo é 0 de
     propósito — assim as 10 colunas da Lotomania encolhem para caber no
     celular em vez de esconderem metade atrás de uma rolagem lateral. */
  const teto = l.grade.colunas <= 6 ? 62 : 46;

  return `
    <div class="rolagem-volante">
      <div class="volante-sorteio"
           style="grid-template-columns: repeat(${l.grade.colunas}, minmax(0, ${teto}px)) auto">
        ${html.join('')}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Painel de características                                           */
/* ------------------------------------------------------------------ */

function caracteristicas(sorteio, anterior, l) {
  const k = caracterizar(sorteio.dezenas, l, anterior?.dezenas ?? null);

  const itens = [
    ['Soma', k.soma],
    ['Pares / ímpares', `${k.pares} / ${k.impares}`],
    ['Primos', k.primos],
    ['Moldura / miolo', `${k.moldura} / ${k.miolo}`],
    ['Maior sequência', `${k.maiorSequencia} seguida${k.maiorSequencia === 1 ? '' : 's'}`],
    ['Menor e maior', `${fmt(k.menor, l)} – ${fmt(k.maior, l)}`],
  ];

  if (k.repetidas !== null) {
    itens.push(['Repetidas do anterior', `${k.repetidas} de ${l.sorteadas}`]);
  }
  if (k.linhasVazias || k.colunasVazias) {
    itens.push([
      'Vazias',
      `${k.linhasVazias} linha(s), ${k.colunasVazias} coluna(s)`,
    ]);
  }

  return `<div class="caracteristicas">${itens
    .map(([rot, val]) => `<div><span class="rot">${rot}</span><b>${val}</b></div>`)
    .join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* Render principal                                                    */
/* ------------------------------------------------------------------ */

export function mostrarConcurso(numero) {
  const l = ctx.loteria();
  const h = historico();
  if (!h.length) return;

  const i = acharIndice(numero);
  if (i < 0) {
    ctx.toast(`O concurso ${numero} não está na base.`, true);
    return;
  }

  atual = numero;
  const sorteio = h[i];
  const anterior = i > 0 ? h[i - 1] : null;
  const proximo = i < h.length - 1 ? h[i + 1] : null;

  const data = sorteio.data
    ? new Date(`${sorteio.data}T12:00:00`).toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
      })
    : null;

  $('#resultadoAtual').innerHTML = `
    <div class="cabecalho-resultado">
      <div>
        <div class="numero-concurso">Concurso ${sorteio.numero}</div>
        ${data ? `<div class="data-concurso">${data}</div>` : ''}
      </div>
      <div class="navegacao">
        <button class="btn" id="btnPrimeiro" ${i === 0 ? 'disabled' : ''} title="primeiro">⏮</button>
        <button class="btn" id="btnAnterior" ${!anterior ? 'disabled' : ''} title="anterior (seta ←)">←</button>
        <input type="number" id="irParaConcurso" value="${sorteio.numero}"
               min="${h[0].numero}" max="${h[h.length-1].numero}">
        <button class="btn" id="btnProximo" ${!proximo ? 'disabled' : ''} title="próximo (seta →)">→</button>
        <button class="btn" id="btnUltimo" ${i === h.length-1 ? 'disabled' : ''} title="último">⏭</button>
      </div>
    </div>

    <div class="dezenas-linha">
      ${sorteio.dezenas.map((d) => `<span class="bolinha sorteada">${fmt(d, l)}</span>`).join('')}
    </div>

    ${volanteDoSorteio(sorteio, anterior, l)}

    <p class="nota legenda-volante">
      Os números nas bordas são quantas dezenas caíram em cada linha e em cada coluna.
      ${anterior
        ? 'As marcadas com borda amarela <span class="marca-exemplo"></span> se repetiram do concurso anterior.'
        : ''}
    </p>

    ${caracteristicas(sorteio, anterior, l)}
  `;

  $('#btnAnterior').addEventListener('click', () => anterior && mostrarConcurso(anterior.numero));
  $('#btnProximo').addEventListener('click', () => proximo && mostrarConcurso(proximo.numero));
  $('#btnPrimeiro').addEventListener('click', () => mostrarConcurso(h[0].numero));
  $('#btnUltimo').addEventListener('click', () => mostrarConcurso(h[h.length - 1].numero));
  $('#irParaConcurso').addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (n) mostrarConcurso(n);
  });

  marcarNaLista();
}

/* ------------------------------------------------------------------ */
/* Lista de todos os concursos                                         */
/* ------------------------------------------------------------------ */

function filtrados() {
  const h = historico();
  if (!buscaLista) return h;
  return h.filter((c) => String(c.numero).includes(buscaLista));
}

function renderLista() {
  const l = ctx.loteria();
  const todos = filtrados();
  // Do mais recente para o mais antigo: é o que se quer ver primeiro.
  const ordenados = [...todos].reverse();

  const paginas = Math.max(1, Math.ceil(ordenados.length / POR_PAGINA));
  paginaLista = Math.min(paginaLista, paginas - 1);
  const fatia = ordenados.slice(paginaLista * POR_PAGINA, (paginaLista + 1) * POR_PAGINA);

  $('#listaConcursos').innerHTML = fatia.length
    ? `<div class="rolagem"><table>
        <thead><tr><th>Concurso</th><th>Data</th><th>Dezenas</th></tr></thead>
        <tbody>${fatia.map((c) => `
          <tr data-n="${c.numero}" class="linha-concurso ${c.numero === atual ? 'ativa' : ''}">
            <td><b>${c.numero}</b></td>
            <td class="nota">${c.data
              ? new Date(`${c.data}T12:00:00`).toLocaleDateString('pt-BR')
              : '—'}</td>
            <td><div class="dezenas-concurso">${c.dezenas
              .map((d) => `<span class="bolinha">${fmt(d, l)}</span>`).join('')}</div></td>
          </tr>`).join('')}
        </tbody></table></div>`
    : '<p class="vazio">Nenhum concurso com esse número.</p>';

  $('#paginacao').innerHTML = paginas > 1
    ? `<button class="btn fantasma" id="pagAnterior" ${paginaLista === 0 ? 'disabled' : ''}>← anteriores</button>
       <span class="nota">página ${paginaLista + 1} de ${paginas} · ${ordenados.length.toLocaleString('pt-BR')} concursos</span>
       <button class="btn fantasma" id="pagProxima" ${paginaLista >= paginas - 1 ? 'disabled' : ''}>próximos →</button>`
    : `<span class="nota">${ordenados.length.toLocaleString('pt-BR')} concurso(s)</span>`;

  $$('#listaConcursos .linha-concurso').forEach((tr) => {
    tr.addEventListener('click', () => mostrarConcurso(Number(tr.dataset.n)));
  });
  $('#pagAnterior')?.addEventListener('click', () => { paginaLista--; renderLista(); });
  $('#pagProxima')?.addEventListener('click', () => { paginaLista++; renderLista(); });
}

/** Realça na lista o concurso aberto, se ele estiver na página atual. */
function marcarNaLista() {
  $$('#listaConcursos .linha-concurso').forEach((tr) => {
    tr.classList.toggle('ativa', Number(tr.dataset.n) === atual);
  });
}

/* ------------------------------------------------------------------ */
/* Ligação com o app                                                   */
/* ------------------------------------------------------------------ */

export function iniciarResultados(contexto) {
  ctx = contexto;

  $('#buscaConcurso').addEventListener('input', (e) => {
    buscaLista = e.target.value.trim();
    paginaLista = 0;
    renderLista();
  });

  /* Setas do teclado só quando a aba está à vista e o foco não está num
     campo — senão atrapalhariam quem digita um número. */
  document.addEventListener('keydown', (e) => {
    if (!$('#resultados')?.classList.contains('ativa')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

    if (e.key === 'ArrowLeft') { $('#btnAnterior')?.click(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { $('#btnProximo')?.click(); e.preventDefault(); }
  });
}

/** Chamado quando a loteria muda ou o histórico é atualizado. */
export function atualizarResultados() {
  if (!ctx) return;
  const h = historico();

  if (!h.length) {
    $('#resultadoAtual').innerHTML =
      '<p class="vazio">A base está vazia. Atualize os resultados no Painel.</p>';
    $('#listaConcursos').innerHTML = '';
    $('#paginacao').innerHTML = '';
    return;
  }

  buscaLista = '';
  const campo = $('#buscaConcurso');
  if (campo) campo.value = '';
  paginaLista = 0;

  renderLista();
  mostrarConcurso(h[h.length - 1].numero);   // abre no mais recente
}
