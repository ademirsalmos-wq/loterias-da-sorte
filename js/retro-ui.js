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

/**
 * Lê os jogos de uma das fontes. Parametrizado porque agora existem DUAS:
 * a estratégia principal e a que ela enfrenta.
 */
async function obterJogos({ fonte, idTexto, idErros, idLote } = {}) {
  const l = ctx.loteria();
  fonte = fonte ?? $('#retroFonte').value;
  idTexto = idTexto ?? '#retroTexto';
  idErros = idErros ?? '#retroErrosTexto';
  idLote = idLote ?? '#retroLote';

  if (fonte === 'texto') {
    const { jogos, erros } = lerJogosDeTexto($(idTexto).value, l);
    $(idErros).innerHTML = erros.length
      ? `<span style="color:var(--alerta)">${erros.join('<br>')}</span>`
      : '';
    return jogos;
  }

  $(idErros).innerHTML = '';

  if (fonte === 'lote') {
    const alvo = $(idLote).value;
    const lotes = await lotesDisponiveis();
    return lotes.find((lo) => lo.grupo === alvo)?.jogos ?? [];
  }

  const bilhetes = await DB.listarBilhetes(ctx.loteriaId());
  return bilhetes.map((b) => b.dezenas);
}

/** Os jogos do lado B, ou [] quando não há duelo. */
async function obterJogosB() {
  const contra = $('#retroContra').value;
  if (contra === 'nada') return [];
  return obterJogos({
    fonte: contra,
    idTexto: '#retroTextoB',
    idErros: '#retroErrosTextoB',
    idLote: '#retroLoteB',
  });
}

/** Preenche a lista de lotes do lado B e mostra o campo certo. */
/** Nome curto da fonte, para as colunas da tabela do duelo. */
function rotuloDaFonte(fonte, idLote) {
  if (fonte === 'todos') return 'Todos os meus bilhetes';
  if (fonte === 'texto') return 'Jogos colados';
  if (fonte === 'lote') {
    const sel = $(idLote);
    const t = sel?.selectedOptions?.[0]?.textContent ?? '';
    return t.split(' · ')[0] || 'Lote';
  }
  return 'Estratégia';
}

async function atualizarContra() {
  const contra = $('#retroContra').value;
  $('#campoRetroLoteB').hidden = contra !== 'lote';
  $('#campoRetroTextoB').hidden = contra !== 'texto';

  if (contra === 'lote') {
    const lotes = await lotesDisponiveis();
    $('#retroLoteB').innerHTML = lotes.length
      ? lotes.map((lo) => {
          const quando = lo.criadoEm ? new Date(lo.criadoEm).toLocaleDateString('pt-BR') : '';
          return `<option value="${lo.grupo}">${lo.jogos.length} jogo(s) — ${lo.rotulo}${quando ? ` · ${quando}` : ''}</option>`;
        }).join('')
      : '<option value="">nenhum lote salvo</option>';
  }
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
      <th>Seu melhor acerto</th><th>Premiados</th><th>Retorno</th>
    </tr></thead>
    <tbody>${r.melhores
      .map((m) => {
        // Dezenas que o bilhete campeão daquele concurso realmente pegou.
        const campeao = new Set(jogos[m.melhorIdx] ?? []);
        return `<tr>
        <td><b>${m.numero}</b></td>
        <td><div class="dezenas-concurso">${m.dezenas
          .map((d) => {
            const pegou = campeao.has(d);
            /* O `title` existe porque a diferença é só de cor, e cor é
               justamente o que falha em tela pequena, no sol e para quem
               não distingue verde. */
            return `<span class="bolinha ${pegou ? 'acerto' : 'escapou'}"
              title="${fmt(d, l)} — ${pegou ? 'seu melhor bilhete acertou' : 'escapou'}"
              >${fmt(d, l)}</span>`;
          })
          .join('')}</div></td>
        <td><b>${m.melhor}</b> de ${l.sorteadas}</td>
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
      <div class="card"><div class="rotulo">Retorno apurado</div>
        <div class="valor">${brl(f.retornoApurado)}</div>
        <div class="rodape">o que a Caixa pagou de fato nesses concursos</div></div>
      <div class="card"><div class="rotulo">Retorno estimado</div>
        <div class="valor">${brl(f.retornoEstimado)}</div>
        <div class="rodape">onde faltou o rateio, com os valores que você informou</div></div>
      <div class="card"><div class="rotulo">Saldo</div>
        <div class="valor ${f.saldo >= 0 ? 'positivo' : 'negativo'}">${brl(f.saldo)}</div>
        <div class="rodape">${f.roi.toFixed(1)}% sobre o investido</div></div>
    </div>

    ${f.concursosSemRateio
      ? `<p class="nota">
          ${f.concursosSemRateio} dos ${r.resumo.concursos} concursos deste intervalo ainda
          não têm o rateio da Caixa baixado — neles a conta usou a sua estimativa.
          Em <b>Configurações → Prêmios pagos</b> dá para baixar o que falta.</p>`
      : ''}

    ${f.faixasAcumuladas
      ? `<p class="nota" style="color:var(--alerta)">
          Em ${f.faixasAcumuladas} ocasião(ões) estes jogos bateram uma faixa que
          <b>acumulou</b> naquele concurso — ninguém levou. O prêmio real teria sido o
          acumulado, que a Caixa não publica por bilhete, então essas ocasiões entraram
          como zero. Ou seja: o retorno acima é um <b>piso</b>, e justamente nos
          concursos em que o prêmio teria sido o maior.</p>`
      : ''}

    ${faltam.length
      ? `<p class="nota" style="color:var(--alerta)">
          Estes jogos bateram ${f.ocorrenciasSemValor}× as faixas de ${faltam.join(', ')}
          pontos em concursos <b>sem valor nenhum</b> — nem rateio baixado, nem estimativa.
          Essas ocasiões entraram como zero. Baixe os prêmios pagos ou preencha uma
          estimativa na caixa "Valores de prêmio".</p>`
      : ''}

    <div class="conclusao">
      <b>Como ler este saldo.</b> Ele responde "e se eu tivesse jogado exatamente
      estes jogos em todos esses concursos?". A resposta quase sempre é negativa, e
      não é defeito da estratégia: a Caixa devolve em prêmios menos do que arrecada,
      por desenho. Com o rateio baixado, a parte <b>apurada</b> deste número é o que a
      Caixa realmente pagou em cada concurso — não é mais palpite. O que continua sendo
      palpite é a parte estimada, e é lá que um saldo positivo costuma nascer: troque a
      estimativa e ele vira outro. Concursos em que a faixa acumulou também puxam este
      número para baixo, porque o acumulado não entra.
    </div>`;
}

/**
 * Duas estratégias reais, lado a lado, sobre os mesmos concursos.
 *
 * O cuidado central é o custo: um fechamento de 33 bilhetes e um lote de 10
 * jogos não custam o mesmo, então comparar "quantas vezes premiou" entre
 * eles favorece automaticamente quem gasta mais. Por isso toda linha
 * sensível a volume aparece TAMBÉM por R$ 100 gastos — é a única forma de a
 * comparação responder à pergunta que o usuário realmente tem, que é onde
 * vale mais a pena pôr o próximo real.
 */
function renderDuelo(a, bB, l, rotulos) {
  if (!bB) { $('#caixaRetroDuelo').hidden = true; return; }
  $('#caixaRetroDuelo').hidden = false;

  const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const por100 = (valor, custo) => (custo > 0 ? (valor / custo) * 100 : 0);

  const linha = (rotulo, va, vb, fmt = (x) => x, maiorEhMelhor = true, nota = '') => {
    const na = typeof va === 'number' ? va : NaN;
    const nb = typeof vb === 'number' ? vb : NaN;
    let ca = '', cb = '';
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
      const aGanha = maiorEhMelhor ? na > nb : na < nb;
      ca = aGanha ? 'color:var(--acento);font-weight:700' : '';
      cb = aGanha ? '' : 'color:var(--acento);font-weight:700';
    }
    return `<tr>
      <td>${rotulo}${nota ? `<br><span class="nota">${nota}</span>` : ''}</td>
      <td style="${ca}">${fmt(va)}</td>
      <td style="${cb}">${fmt(vb)}</td>
    </tr>`;
  };

  const ra = a.r.resumo, rb = bB.r.resumo;
  const fa = a.r.financeiro, fb = bB.r.financeiro;
  const num = (x) => (typeof x === 'number' ? x.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : x);
  const pct = (x) => `${x.toFixed(1)}%`;

  const incompleto = fa.faltamValores.length || fb.faltamValores.length;

  $('#retroDuelo').innerHTML = `
    <p class="nota">Os mesmos <b>${ra.concursos.toLocaleString('pt-BR')}</b> concursos,
      as duas estratégias. Verde marca quem se saiu melhor em cada linha.</p>

    <div class="rolagem">
    <table class="tabela duelo">
      <thead><tr>
        <th>&nbsp;</th>
        <th>${rotulos.a}</th>
        <th>${rotulos.b}</th>
      </tr></thead>
      <tbody>
        ${linha('Bilhetes por concurso', ra.bilhetes, rb.bilhetes, num, false,
                'menos bilhetes para o mesmo resultado é melhor')}
        ${linha('Custo por concurso', fa.custoPorConcurso, fb.custoPorConcurso, brl, false)}
        ${linha('Custo no período', fa.custoTotal, fb.custoTotal, brl, false)}
        <tr class="separador"><td colspan="3"></td></tr>
        ${linha('Concursos que premiaram algo', ra.pctPremiados, rb.pctPremiados, pct)}
        ${linha('Melhor acerto médio', ra.mediaMelhor, rb.mediaMelhor, (x) => x.toFixed(2))}
        ${linha('Melhor acerto de todos', ra.melhorDeTodos, rb.melhorDeTodos, num)}
        ${linha('Maior seca', ra.maiorSeca, rb.maiorSeca, num, false,
                'concursos seguidos sem prêmio nenhum')}
        <tr class="separador"><td colspan="3"></td></tr>
        ${linha('Retorno apurado', fa.retornoApurado, fb.retornoApurado, brl)}
        ${linha('Retorno por R$ 100 gastos',
                por100(fa.retornoApurado, fa.custoTotal),
                por100(fb.retornoApurado, fb.custoTotal),
                (x) => brl(x), true,
                'só o que a Caixa pagou de fato — é a linha que compara de igual para igual')}
        ${linha('Saldo sobre o investido', fa.roi, fb.roi, pct)}
      </tbody>
    </table>
    </div>

    ${incompleto ? `<p class="nota" style="color:var(--alerta)">
      Faixas de rateio sem valor informado ficaram de fora do retorno das duas.
      Preencha em "Valores de prêmio" para a comparação financeira ficar completa.</p>` : ''}

    <p class="nota">Isto mede o passado, não prevê o futuro. Uma estratégia que
      teria rendido mais nos últimos anos não tem, por isso, chance maior no
      próximo concurso — sorteios são independentes. O que a tabela responde é
      outra coisa, e útil: <b>com o dinheiro que você já gastou, qual dos dois
      jeitos teria devolvido mais.</b></p>`;
}

function renderComparacao(r, base, l) {
  if (!base) {
    /* Só esconde a SUA caixa. O duelo entre estratégias é independente
       desta comparação com aleatórios — esconder os dois aqui fazia
       desmarcar "comparar com aleatórios" apagar o duelo junto. */
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
  /* O rateio real de cada concurso. Onde ele existe, é ele que vale; a
     tabela de estimativas acima só cobre o que ainda não foi baixado. */
  const rateios = ctx.rateios?.() ?? {};
  const custoPorConcurso = jogos.reduce(
    (a, j) => a + custoAposta(l, j.length, ctx.precoDe(l)).custo,
    0
  );

  const btn = $('#btnVarrer');
  btn.disabled = true;
  btn.textContent = 'Varrendo…';
  await ctx.esperarPintura();

  try {
    const r = varrer(jogos, concursos, l, { premios, rateios, custoPorConcurso, topN: 25 });

    let base = null;
    if ($('#retroComparar').checked) {
      btn.textContent = 'Comparando com aleatórios…';
      await ctx.esperarPintura();
      base = compararComAleatorio(jogos, concursos, l, {
        premios,
        rateios,
        custoPorConcurso,
        rodadas: 5,
      });
    }

    /* Lado B: a outra estratégia, sobre EXATAMENTE os mesmos concursos.
       Rodar em períodos diferentes seria comparar coisa nenhuma. */
    let duelo = null;
    const jogosB = await obterJogosB();
    if (jogosB.length) {
      btn.textContent = 'Varrendo a outra estratégia…';
      await ctx.esperarPintura();
      const custoB = jogosB.reduce(
        (acc, j) => acc + custoAposta(l, j.length, ctx.precoDe(l)).custo, 0
      );
      duelo = {
        r: varrer(jogosB, concursos, l, { premios, rateios, custoPorConcurso: custoB, topN: 5 }),
      };
    }

    ultimoResultado = { r, l };
    renderResumo(r, l);
    renderDistribuicao(r);
    renderFaixas(r, l);
    renderDuelo({ r }, duelo, l, {
      a: rotuloDaFonte($('#retroFonte').value, '#retroLote'),
      b: rotuloDaFonte($('#retroContra').value, '#retroLoteB'),
    });
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
  $('#retroContra').addEventListener('change', atualizarContra);
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
  $('#caixaRetroDuelo').hidden = true;

  if (trocouLoteria) {
    $('#retroFonte').value = 'todos';
    $('#retroTexto').value = '';
    $('#retroErrosTexto').innerHTML = '';
  }

  renderPremios();
  await atualizarFonte();
}
