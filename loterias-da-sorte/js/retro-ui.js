/**
 * retro-ui.js — Aba Retrospectiva.
 *
 * Separado de app.js de propósito: a varredura tem regra própria e bastante
 * texto explicativo, e misturar tudo num arquivo só ia deixar app.js
 * intratável. Recebe as dependências de que precisa em vez de importá-las
 * do app (evita import circular).
 */

import { LOTERIAS, fmt, brl } from './config.js';
import { DB } from './db.js';
import { varrer, compararComAleatorio, lerJogosDeTexto } from './backtest.js';
import { custoAposta } from './tickets.js';

let ctx = null;      // { loteria(), historico(), precoDe(), toast(), grafico(), esperarPintura() }
let ultimoResultado = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ------------------------------------------------------------------ */
/* Tabela de prêmios                                                   */
/* ------------------------------------------------------------------ */

/** Prêmios efetivos: o oficial para as faixas fixas, o do usuário para o rateio. */
export function premiosDe(loteria, salvos = {}) {
  const base = loteria.premios ?? {};
  const doUsuario = salvos[loteria.id] ?? {};
  const out = {};
  for (const faixa of loteria.faixas) {
    const b = base[faixa] ?? { valor: 0, fixo: false };
    out[faixa] = b.fixo
      ? { ...b }                                   // fixo é lei, não se edita
      : { valor: Number(doUsuario[faixa] ?? b.valor) || 0, fixo: false };
  }
  return out;
}

function renderPremios() {
  const l = ctx.loteria();
  const p = premiosDe(l, ctx.premiosSalvos());

  $('#retroPremios').innerHTML = [...l.faixas]
    .sort((a, b) => b - a)
    .map((f) => {
      const item = p[f];
      return `<div class="linha-premio">
        <span class="rotulo-faixa">${f} ponto${f === 1 ? '' : 's'}</span>
        <span><span class="selo ${item.fixo ? 'fixo' : 'rateio'}">${item.fixo ? 'fixo' : 'rateio'}</span></span>
        <input type="number" step="0.01" min="0" data-premio="${f}"
          value="${item.valor}" ${item.fixo ? 'disabled title="Valor garantido por regulamento"' : 'placeholder="0"'}>
      </div>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/* Seleção da fonte dos jogos                                          */
/* ------------------------------------------------------------------ */

async function lotesDisponiveis() {
  const bilhetes = await DB.listarBilhetes(ctx.loteriaId());
  const mapa = new Map();
  for (const b of bilhetes) {
    const chave = b.grupo ?? 'sem-grupo';
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        grupo: chave,
        rotulo: b.rotulo || b.origem || 'sem rótulo',
        origem: b.origem,
        criadoEm: b.criadoEm,
        jogos: [],
      });
    }
    mapa.get(chave).jogos.push(b.dezenas);
  }
  return [...mapa.values()].sort((a, b) =>
    String(b.criadoEm ?? '').localeCompare(String(a.criadoEm ?? ''))
  );
}

async function atualizarFonte() {
  const fonte = $('#retroFonte').value;
  $('#campoRetroLote').hidden = fonte !== 'lote';
  $('#campoRetroTexto').hidden = fonte !== 'texto';

  if (fonte === 'lote') {
    const lotes = await lotesDisponiveis();
    $('#retroLote').innerHTML = lotes.length
      ? lotes
          .map((lo) => {
            const quando = lo.criadoEm
              ? new Date(lo.criadoEm).toLocaleDateString('pt-BR')
              : '';
            return `<option value="${lo.grupo}">${lo.jogos.length} jogo(s) — ${lo.rotulo}${quando ? ` · ${quando}` : ''}</option>`;
          })
          .join('')
      : '<option value="">nenhum lote salvo</option>';
  }

  await atualizarResumoFonte();
}

async function obterJogos() {
  const l = ctx.loteria();
  const fonte = $('#retroFonte').value;

  if (fonte === 'texto') {
    const { jogos, erros } = lerJogosDeTexto($('#retroTexto').value, l);
    $('#retroErrosTexto').innerHTML = erros.length
      ? `<span style="color:var(--alerta)">${erros.join('<br>')}</span>`
      : '';
    return jogos;
  }

  $('#retroErrosTexto').innerHTML = '';

  if (fonte === 'lote') {
    const alvo = $('#retroLote').value;
    const lotes = await lotesDisponiveis();
    return lotes.find((lo) => lo.grupo === alvo)?.jogos ?? [];
  }

  const bilhetes = await DB.listarBilhetes(ctx.loteriaId());
  return bilhetes.map((b) => b.dezenas);
}

async function atualizarResumoFonte() {
  const l = ctx.loteria();
  const jogos = await obterJogos();
  const historico = ctx.historico();
  const el = $('#retroResumoFonte');

  if (!jogos.length) {
    el.innerHTML =
      'Nenhum jogo selecionado. Salve bilhetes na aba Gerador ou Fechamento, ' +
      'ou cole os jogos no campo acima.';
    $('#btnVarrer').disabled = true;
    return;
  }
  if (!historico.length) {
    el.innerHTML = 'A base de resultados está vazia — atualize no Painel primeiro.';
    $('#btnVarrer').disabled = true;
    return;
  }

  $('#btnVarrer').disabled = false;
  const custo = jogos.reduce(
    (a, j) => a + custoAposta(l, j.length, ctx.precoDe(l)).custo,
    0
  );
  const janela = Number($('#retroPeriodo').value) || historico.length;
  const n = Math.min(janela, historico.length);

  el.innerHTML =
    `<b>${jogos.length}</b> jogo(s) contra <b>${n.toLocaleString('pt-BR')}</b> concursos.<br>
     Custo por concurso: <b class="destaque">${brl(custo)}</b> ·
     se você tivesse jogado em todos eles: <b>${brl(custo * n)}</b>.`;
}

/* ------------------------------------------------------------------ */
/* Renderização do resultado                                           */
/* ------------------------------------------------------------------ */

function renderResumo(r, l) {
  const s = r.resumo;
  const cards = [
    { rotulo: 'Concursos varridos', valor: s.concursos.toLocaleString('pt-BR'),
      rodape: `do ${s.primeiro} ao ${s.ultimo}` },
    { rotulo: 'Premiaram algo', valor: `${s.pctPremiados.toFixed(1)}%`,
      rodape: !s.umACada
        ? 'nunca premiou'
        : s.umACada <= 1
          ? 'quase todo concurso'
          : `1 a cada ${s.umACada} concursos` },
    { rotulo: 'Melhor acerto', valor: `${s.melhorDeTodos} pts`,
      rodape: `média do melhor: ${s.mediaMelhor.toFixed(2)}` },
    { rotulo: 'Maior seca', valor: `${s.maiorSeca}`,
      rodape: s.piorSeca ? `concursos ${s.piorSeca.de}–${s.piorSeca.ate}` : 'sem seca' },
  ];
  $('#retroCards').innerHTML = cards
    .map(
      (c) => `<div class="card">
        <div class="rotulo">${c.rotulo}</div>
        <div class="valor">${c.valor}</div>
        <div class="rodape">${c.rodape}</div>
      </div>`
    )
    .join('');
}

function renderDistribuicao(r) {
  $('#retroDistribuicao').innerHTML = ctx.grafico(
    r.resumo.distribuicaoMelhor.map((d) => ({
      rotulo: `${d.acertos} pts`,
      valor: d.concursos,
    })),
    { formatar: (v, i) => `${((v / r.resumo.concursos) * 100).toFixed(1)}%` }
  );
}

function renderFaixas(r, l) {
  const s = r.resumo;
  $('#retroFaixas').innerHTML = `<div class="rolagem"><table>
    <thead><tr>
      <th>Faixa</th><th>Concursos</th><th>%</th><th>Bilhetes</th><th>Prêmio</th>
    </tr></thead>
    <tbody>${s.porFaixa
      .map((f) => {
        const p = f.premio;
        const valor = p?.fixo
          ? `${brl(p.valor)} <span class="selo fixo">fixo</span>`
          : p?.valor
            ? `${brl(p.valor)} <span class="selo rateio">estimado</span>`
            : '<span class="nota">não informado</span>';
        return `<tr>
          <td><b>${f.acertos} pts</b></td>
          <td>${f.concursos.toLocaleString('pt-BR')}</td>
          <td>${f.pctConcursos.toFixed(2)}%</td>
          <td>${f.bilhetesPremiados.toLocaleString('pt-BR')}</td>
          <td>${valor}</td>
        </tr>`;
      })
      .join('')}
    </tbody></table></div>
    <p class="nota" style="margin-top:.6rem">"Concursos" é em quantos deles pelo menos
    um bilhete bateu a faixa. "Bilhetes" soma quantos bilhetes bateram no total —
    num fechamento, vários pegam a mesma faixa no mesmo concurso.</p>`;
}

function renderMelhores(r, l, jogos) {
  $('#retroMelhores').innerHTML = `<div class="rolagem"><table>
    <thead><tr>
      <th>Concurso</th><th>Dezenas sorteadas</th>
      <th>Melhor</th><th>Premiados</th><th>Retorno</th>
    </tr></thead>
    <tbody>${r.melhores
      .map((m) => {
        // Dezenas que o bilhete campeão daquele concurso realmente pegou.
        const campeao = new Set(jogos[m.melhorIdx] ?? []);
        return `<tr>
        <td><b>${m.numero}</b></td>
        <td><div class="dezenas-concurso">${m.dezenas
          .map(
            (d) =>
              `<span class="bolinha ${campeao.has(d) ? 'acerto' : ''}">${fmt(d, l)}</span>`
          )
          .join('')}</div></td>
        <td><b>${m.melhor}</b> pts</td>
        <td>${m.premiados}</td>
        <td>${m.retorno.total ? brl(m.retorno.total) : '<span class="nota">—</span>'}</td>
      </tr>`;
      })
      .join('')}
    </tbody></table></div>`;
}

function renderFinanceiro(r, l) {
  const f = r.financeiro;
  const faltam = f.faltamValores;

  $('#retroFinanceiro').innerHTML = `
    <div class="cards">
      <div class="card"><div class="rotulo">Custo total</div>
        <div class="valor">${brl(f.custoTotal)}</div>
        <div class="rodape">${brl(f.custoPorConcurso)} × ${r.resumo.concursos} concursos</div></div>
      <div class="card"><div class="rotulo">Retorno garantido</div>
        <div class="valor">${brl(f.retornoFixo)}</div>
        <div class="rodape">só faixas de valor fixo</div></div>
      <div class="card"><div class="rotulo">Retorno estimado</div>
        <div class="valor">${brl(f.retornoEstimado)}</div>
        <div class="rodape">faixas de rateio, com os valores que você informou</div></div>
      <div class="card"><div class="rotulo">Saldo</div>
        <div class="valor ${f.saldo >= 0 ? 'positivo' : 'negativo'}">${brl(f.saldo)}</div>
        <div class="rodape">${f.roi.toFixed(1)}% sobre o investido</div></div>
    </div>

    ${faltam.length
      ? `<p class="nota" style="color:var(--alerta)">
          As faixas de ${faltam.join(', ')} pontos estão sem valor informado, então o
          retorno acima <b>ignora</b> o que elas teriam pago. Preencha uma estimativa
          na caixa "Valores de prêmio" para completar a conta.</p>`
      : ''}

    <div class="conclusao">
      <b>Como ler este saldo.</b> Ele responde "e se eu tivesse jogado exatamente
      estes jogos em todos esses concursos?". A resposta quase sempre é negativa, e
      não é defeito da estratégia: a Caixa devolve em prêmios menos do que arrecada,
      por desenho. Um saldo positivo aqui normalmente vem de um único acerto grande
      que você mesmo estimou — troque a estimativa e o saldo vira outro. As faixas
      fixas são a única parte deste número em que dá para confiar de olhos fechados.
    </div>`;
}

function renderComparacao(r, base, l) {
  if (!base) {
    $('#caixaRetroComparacao').hidden = true;
    return;
  }
  $('#caixaRetroComparacao').hidden = false;

  const meu = r.resumo;
  const venceuFreq = meu.pctPremiados >= base.pctPremiados;

  const linhasFaixa = meu.porFaixa
    .map((f) => {
      const ale = base.porFaixa.find((x) => x.acertos === f.acertos)?.concursos ?? 0;
      const dif = f.concursos - ale;
      const cor = dif > 0 ? 'var(--acento)' : dif < 0 ? 'var(--perigo)' : 'var(--texto-3)';
      return `<tr>
        <td><b>${f.acertos} pts</b></td>
        <td>${f.concursos.toLocaleString('pt-BR')}</td>
        <td>${ale.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}</td>
        <td style="color:${cor}">${dif > 0 ? '+' : ''}${dif.toFixed(1)}</td>
      </tr>`;
    })
    .join('');

  $('#retroComparacao').innerHTML = `
    <p class="nota">Mesma quantidade de bilhetes, mesmo tamanho, mesmo custo, mesmos
      concursos — só que sorteados na hora. Média de ${base.rodadas} rodadas, para
      uma amostra azarada não distorcer a leitura.</p>

    <div class="comparacao">
      <div class="lado ${venceuFreq ? 'vencedor' : ''}">
        <h3>Os seus jogos</h3>
        <div class="numerao">${meu.pctPremiados.toFixed(1)}%</div>
        <div class="detalhe">dos concursos premiaram algo</div>
        <div class="detalhe" style="margin-top:.4rem">melhor acerto médio:
          <b>${meu.mediaMelhor.toFixed(2)}</b> · maior seca: <b>${meu.maiorSeca}</b></div>
      </div>
      <div class="lado ${venceuFreq ? '' : 'vencedor'}">
        <h3>Jogos aleatórios de mesmo custo</h3>
        <div class="numerao">${base.pctPremiados.toFixed(1)}%</div>
        <div class="detalhe">dos concursos premiaram algo</div>
        <div class="detalhe" style="margin-top:.4rem">melhor acerto médio:
          <b>${base.mediaMelhor.toFixed(2)}</b> · maior seca: <b>${base.maiorSeca.toFixed(1)}</b></div>
      </div>
    </div>

    <div class="rolagem"><table>
      <thead><tr><th>Faixa</th><th>Seus jogos</th><th>Aleatório</th><th>Diferença</th></tr></thead>
      <tbody>${linhasFaixa}</tbody>
    </table></div>

    <div class="conclusao">${textoConclusao(meu, base, l)}</div>`;
}

/**
 * A leitura honesta do comparativo. Este texto existe porque o resultado
 * costuma contrariar o que se vende sobre fechamentos, e o usuário merece
 * entender o porquê em vez de só ver um número vermelho.
 */
function textoConclusao(meu, base, l) {
  const dif = meu.pctPremiados - base.pctPremiados;

  if (dif < -3) {
    return `<b>Os seus jogos premiaram menos vezes que jogos aleatórios de mesmo custo.</b>
      Isso não é um defeito do sistema, e sim o preço da concentração: jogos tirados de
      um grupo pequeno de dezenas se parecem muito entre si, então erram juntos.
      Bilhetes espalhados por todo o volante cobrem mais terreno e batem as faixas
      pequenas com mais frequência.<br><br>
      O que a concentração compra em troca é a <b>garantia</b> — quando as dezenas
      sorteadas caem dentro do seu grupo, você não faz um prêmio, faz vários de uma vez.
      É uma troca real: menos prêmios pequenos, mais concentração quando acerta.
      Qual dos dois vale mais depende do que você quer. Se o objetivo é recuperar o
      custo com frequência, espalhe. Se é maximizar o resultado no dia em que o grupo
      der certo, feche.`;
  }
  if (dif > 3) {
    return `<b>Os seus jogos premiaram mais vezes que jogos aleatórios de mesmo custo</b>
      (${dif.toFixed(1)} pontos percentuais a mais) nesta janela de concursos.
      Vale a ressalva: isso mede o passado. Como os sorteios são independentes, a
      diferença não se projeta para a frente sozinha — rode de novo com outro período
      e veja se ela se sustenta ou se some. Se sumir, era ruído.`;
  }
  return `<b>Empate técnico.</b> Os seus jogos e os aleatórios premiaram com frequência
    praticamente igual (${meu.pctPremiados.toFixed(1)}% contra ${base.pctPremiados.toFixed(1)}%).
    É exatamente o esperado quando os dois conjuntos têm o mesmo tamanho e o mesmo grau
    de espalhamento: nesse caso os filtros não mudam o resultado, mudam só quais
    combinações você levou. Onde eles ainda pesam é no rateio — jogo menos batido,
    prêmio menos dividido —, e isso a varredura não consegue medir.`;
}

/* ------------------------------------------------------------------ */
/* Execução                                                            */
/* ------------------------------------------------------------------ */

async function executarVarredura() {
  const l = ctx.loteria();
  const jogos = await obterJogos();
  if (!jogos.length) return ctx.toast('Nenhum jogo válido para varrer.', true);

  const historico = ctx.historico();
  if (!historico.length) return ctx.toast('Baixe os resultados primeiro.', true);

  const janela = Number($('#retroPeriodo').value);
  const concursos = janela > 0 ? historico.slice(-janela) : historico;

  const premios = premiosDe(l, ctx.premiosSalvos());
  const custoPorConcurso = jogos.reduce(
    (a, j) => a + custoAposta(l, j.length, ctx.precoDe(l)).custo,
    0
  );

  const btn = $('#btnVarrer');
  btn.disabled = true;
  btn.textContent = 'Varrendo…';
  await ctx.esperarPintura();

  try {
    const r = varrer(jogos, concursos, l, { premios, custoPorConcurso, topN: 25 });

    let base = null;
    if ($('#retroComparar').checked) {
      btn.textContent = 'Comparando com aleatórios…';
      await ctx.esperarPintura();
      base = compararComAleatorio(jogos, concursos, l, {
        premios,
        custoPorConcurso,
        rodadas: 5,
      });
    }

    ultimoResultado = { r, l };
    renderResumo(r, l);
    renderDistribuicao(r);
    renderFaixas(r, l);
    renderComparacao(r, base, l);
    renderMelhores(r, l, jogos);
    renderFinanceiro(r, l);

    $('#retroResultado').hidden = false;
    $('#retroCards').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    ctx.toast(`${concursos.length.toLocaleString('pt-BR')} concursos varridos.`);
  } catch (e) {
    console.error(e);
    ctx.toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Varrer o histórico';
  }
}

function exportarCSV() {
  if (!ultimoResultado) return;
  const { r, l } = ultimoResultado;
  const linhas = ['concurso;dezenas;melhor_acerto;bilhetes_premiados;retorno'];
  for (const x of r.linhas) {
    linhas.push(
      [
        x.numero,
        x.dezenas.map((d) => fmt(d, l)).join(' '),
        x.melhor,
        x.premiados,
        String(x.retorno.total.toFixed(2)).replace('.', ','),
      ].join(';')
    );
  }
  ctx.baixar(`retrospectiva-${l.id}.csv`, linhas.join('\n'), 'text/csv');
}

/* ------------------------------------------------------------------ */
/* Ligação com o app                                                   */
/* ------------------------------------------------------------------ */

export function iniciarRetrospectiva(contexto) {
  ctx = contexto;

  $('#retroFonte').addEventListener('change', atualizarFonte);
  $('#retroLote').addEventListener('change', atualizarResumoFonte);
  $('#retroPeriodo').addEventListener('change', atualizarResumoFonte);
  $('#retroTexto').addEventListener('input', atualizarResumoFonte);
  $('#btnVarrer').addEventListener('click', executarVarredura);
  $('#btnExportarRetro').addEventListener('click', exportarCSV);

  $('#btnSalvarPremios').addEventListener('click', async () => {
    const l = ctx.loteria();
    const salvos = { ...ctx.premiosSalvos() };
    salvos[l.id] = {};
    for (const inp of $$('[data-premio]')) {
      if (inp.disabled) continue;                 // faixa fixa, não se edita
      salvos[l.id][inp.dataset.premio] = Number(inp.value) || 0;
    }
    await ctx.salvarPremios(salvos);
    ctx.toast('Valores salvos.');
  });
}

/**
 * Chamado pelo app sempre que a loteria muda ou os bilhetes mudam.
 *
 * `trocouLoteria` volta a fonte para "todos" e limpa o campo colado. Sem
 * isso, jogos de 15 dezenas colados para a Lotofácil continuavam válidos ao
 * mudar para a Mega-Sena (que aceita de 6 a 20) e viravam, em silêncio,
 * apostas de C(15,6) = 5.005 combinações — R$ 30 mil cada.
 */
export async function atualizarRetrospectiva(trocouLoteria = false) {
  if (!ctx) return;
  ultimoResultado = null;
  $('#retroResultado').hidden = true;
  $('#caixaRetroComparacao').hidden = true;

  if (trocouLoteria) {
    $('#retroFonte').value = 'todos';
    $('#retroTexto').value = '';
    $('#retroErrosTexto').innerHTML = '';
  }

  renderPremios();
  await atualizarFonte();
}
