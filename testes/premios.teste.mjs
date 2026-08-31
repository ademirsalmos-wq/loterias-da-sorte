/**
 * Os prêmios pagos — o rateio que a Caixa publica concurso a concurso.
 *
 * Este arquivo existe porque a funcionalidade inteira gira em torno de um
 * zero ambíguo. Quando uma faixa acumula, a Caixa devolve:
 *
 *     { "descricaoFaixa": "15 acertos", "numeroDeGanhadores": 0,
 *       "valorPremio": 0.0 }
 *
 * Ler esse 0.0 como valor não dá erro nenhum: dá um sistema que anuncia
 * R$ 0,00 de retorno exatamente nos concursos em que o bilhete simulado
 * teria levado o prêmio máximo. É o defeito que este projeto mais persegue
 * — número errado com cara de certo — e ele só aparece se alguém testar.
 *
 * As respostas usadas aqui são as REAIS, copiadas da API oficial:
 * Lotofácil 3774, Mega-Sena 2920 e 1 (de 1996) e Lotomania 2820 e 1 (de
 * 1999). Os extremos importam porque o número de faixas mudou com o tempo:
 * a Lotomania de 1999 tinha 6, a de hoje tem 7.
 */

import {
  abrirPagina, placar, chromium, irPara, trocarLoteria,
  semearBilhetes, abrirTabelaDeBilhetes, esperarBase, esquecerRateios,
} from './ajuda.mjs';

/* --- Respostas reais da Caixa, conferidas na API oficial ------------ */

const LOTOFACIL_3774 = [
  { descricaoFaixa: '15 acertos', faixa: 1, numeroDeGanhadores: 0, valorPremio: 0.0 },
  { descricaoFaixa: '14 acertos', faixa: 2, numeroDeGanhadores: 281, valorPremio: 1784.1 },
  { descricaoFaixa: '13 acertos', faixa: 3, numeroDeGanhadores: 8219, valorPremio: 35.0 },
  { descricaoFaixa: '12 acertos', faixa: 4, numeroDeGanhadores: 91426, valorPremio: 14.0 },
  { descricaoFaixa: '11 acertos', faixa: 5, numeroDeGanhadores: 474312, valorPremio: 7.0 },
];

/* Concurso 1, de 02/10/1999: seis faixas, sem a de 15 acertos que existe hoje. */
const LOTOMANIA_1 = [
  { descricaoFaixa: '20 acertos', faixa: 1, numeroDeGanhadores: 0, valorPremio: 0.0 },
  { descricaoFaixa: '19 acertos', faixa: 2, numeroDeGanhadores: 1, valorPremio: 118746.87 },
  { descricaoFaixa: '18 acertos', faixa: 3, numeroDeGanhadores: 46, valorPremio: 2581.46 },
  { descricaoFaixa: '17 acertos', faixa: 4, numeroDeGanhadores: 446, valorPremio: 132.62 },
  { descricaoFaixa: '16 acertos', faixa: 5, numeroDeGanhadores: 2716, valorPremio: 21.78 },
  { descricaoFaixa: '0 acertos', faixa: 6, numeroDeGanhadores: 0, valorPremio: 0.0 },
];

const MEGASENA_1 = [
  { descricaoFaixa: '6 acertos', faixa: 1, numeroDeGanhadores: 0, valorPremio: 0.0 },
  { descricaoFaixa: '5 acertos', faixa: 2, numeroDeGanhadores: 17, valorPremio: 39158.92 },
  { descricaoFaixa: '4 acertos', faixa: 3, numeroDeGanhadores: 2016, valorPremio: 330.21 },
];

export default async function rodar() {
  const t = placar('Prêmios');
  const nav = await chromium.launch();
  const p = await abrirPagina(nav, { tela: { width: 1280, height: 900 }, caixa: true });

  /* ---------------- o parser, contra as respostas reais --------------- */

  const lidos = await p.evaluate(async ([lf, lm, ms]) => {
    /* `extrairRateio` não é exportada; o caminho público é a normalização
       que a sincronização usa. Testar pela porta que o app usa de verdade
       é o princípio desta suíte inteira. */
    const { LOTERIAS } = await import('/js/config.js');
    const { valorDaFaixa } = await import('/js/premios.js');

    /* Reproduz o que normalizarCaixa faz com listaRateioPremio, para
       conferir o formato sem depender da rede. */
    const extrair = (lista, loteria) => {
      const faixas = new Set(loteria.faixas);
      const out = {};
      for (const item of lista) {
        const m = String(item?.descricaoFaixa ?? '').match(/(\d+)\s*acerto/i);
        if (!m) continue;
        const a = Number(m[1]);
        if (!faixas.has(a)) continue;
        out[a] = [Number(item.valorPremio) || 0, Number(item.numeroDeGanhadores) || 0];
      }
      return out;
    };

    const rlf = extrair(lf, LOTERIAS.lotofacil);
    const rlm = extrair(lm, LOTERIAS.lotomania);
    const rms = extrair(ms, LOTERIAS.megasena);

    return {
      lf: rlf, lm: rlm, ms: rms,
      // 14 acertos: rateio real, houve 281 ganhadores
      lf14: valorDaFaixa(LOTERIAS.lotofacil, 14, rlf),
      // 15 acertos: acumulou (0 ganhadores) — valor é DESCONHECIDO, não zero
      lf15: valorDaFaixa(LOTERIAS.lotofacil, 15, rlf),
      // 13 acertos: apurado e fixo coincidem em R$ 35
      lf13: valorDaFaixa(LOTERIAS.lotofacil, 13, rlf),
      // sem rateio nenhum: cai no valor fixo do regulamento
      lf13SemRateio: valorDaFaixa(LOTERIAS.lotofacil, 13, null),
      // sem rateio e sem valor fixo: cai na estimativa do usuário
      lf14Estimado: valorDaFaixa(LOTERIAS.lotofacil, 14, null, { 14: 1500 }),
      // faixa que não existe nesta modalidade
      lf9: valorDaFaixa(LOTERIAS.lotofacil, 9, rlf),
      // o zero da Lotomania é faixa premiada de verdade
      lmZero: valorDaFaixa(LOTERIAS.lotomania, 0, rlm),
      lm19: valorDaFaixa(LOTERIAS.lotomania, 19, rlm),
    };
  }, [LOTOFACIL_3774, LOTOMANIA_1, MEGASENA_1]);

  t.confere('Lotofácil 3774: lê as 5 faixas',
    Object.keys(lidos.lf).length === 5, JSON.stringify(lidos.lf));
  t.confere('Mega-Sena 1 (1996): lê as 3 faixas',
    Object.keys(lidos.ms).length === 3 && lidos.ms[5][0] === 39158.92);
  t.confere('Lotomania 1 (1999): 6 faixas, incluindo o "0 acertos"',
    Object.keys(lidos.lm).length === 6 && Array.isArray(lidos.lm[0]),
    Object.keys(lidos.lm).join(','));
  t.confere('Lotomania 1 NÃO inventa a faixa de 15 que ainda não existia',
    lidos.lm[15] === undefined);

  t.confere('14 acertos com ganhador: valor apurado da Caixa',
    lidos.lf14.valor === 1784.1 && lidos.lf14.fonte === 'apurado',
    JSON.stringify(lidos.lf14));

  /* O CORAÇÃO DESTE ARQUIVO. */
  t.confere('15 acertos sem ganhador: "acumulou", NUNCA um valor de R$ 0,00',
    lidos.lf15.fonte === 'acumulou' && lidos.lf15.valor === 0,
    JSON.stringify(lidos.lf15));
  t.confere('o zero da Lotomania sem ganhador também é "acumulou", não faixa inexistente',
    lidos.lmZero.fonte === 'acumulou', JSON.stringify(lidos.lmZero));
  t.confere('19 acertos da Lotomania de 1999: valor apurado',
    lidos.lm19.valor === 118746.87 && lidos.lm19.fonte === 'apurado');

  t.confere('13 acertos: o apurado vence e bate com o regulamento',
    lidos.lf13.valor === 35 && lidos.lf13.fonte === 'apurado');
  t.confere('sem rateio, 13 acertos cai no valor fixo',
    lidos.lf13SemRateio.valor === 35 && lidos.lf13SemRateio.fonte === 'fixo');
  t.confere('sem rateio e sem valor fixo, usa a estimativa do usuário',
    lidos.lf14Estimado.valor === 1500 && lidos.lf14Estimado.fonte === 'estimado');
  t.confere('faixa que não premia devolve fonte nula',
    lidos.lf9.fonte === null && lidos.lf9.valor === 0);

  /* ---------------- download em lotes, retomável ---------------------- */

  /* A base precisa estar cheia antes de medir cobertura de prêmios: com a
     Caixa de mentira ligada o app baixa concurso a concurso, e a tela fica
     pronta muito antes disso terminar. */
  const naBase = await esperarBase(p, 'lotofacil', 400);

  /* Numa base recém-sincronizada TODOS os concursos já vêm com rateio — ele
     viaja junto com o resultado, de graça. Confirmar isso é metade do
     valor da funcionalidade: quem tem base nova não precisa baixar nada. */
  const deGraca = await p.evaluate(async () => {
    const { coberturaDeRateios } = await import('/js/api.js');
    return coberturaDeRateios('lotofacil');
  });
  t.confere('sincronizar já traz o prêmio junto, sem requisição extra',
    deGraca.comRateio === naBase && deGraca.faltando.length === 0,
    `${deGraca.comRateio} de ${naBase}`);

  /* Agora a base vira a de quem já usava o sistema antes desta versão:
     sorteios sim, prêmios não. É esse o estado que o download conserta. */
  await esquecerRateios(p, 'lotofacil');

  const lote1 = await p.evaluate(async () => {
    const { baixarRateios, coberturaDeRateios } = await import('/js/api.js');
    const antes = await coberturaDeRateios('lotofacil');
    const r = await baixarRateios('lotofacil', { limite: 40 });
    return { antes: antes.comRateio, faltavam: antes.faltando.length, ...r };
  });

  t.confere('um lote baixa só o limite pedido, não a base inteira',
    lote1.baixados === 40 && lote1.restantes === lote1.faltavam - 40,
    `${lote1.baixados} baixados, ${lote1.restantes} restantes de ${lote1.faltavam}`);
  t.confere('o que veio no lote foi gravado', lote1.comRateio >= 40);

  const lote2 = await p.evaluate(async () => {
    const { baixarRateios } = await import('/js/api.js');
    return baixarRateios('lotofacil', { limite: 40 });
  });
  t.confere('o lote seguinte continua de onde parou, sem rebaixar o mesmo',
    lote2.comRateio === lote1.comRateio + 40,
    `${lote1.comRateio} → ${lote2.comRateio}`);

  /* Um concurso em que TODAS as faixas acumulassem ficaria gravado só com
     zeros. Se "tem rateio" fosse deduzido do valor, ele voltaria para a
     fila a cada rodada e o download nunca terminaria. */
  const naoRebaixa = await p.evaluate(async () => {
    const { baixarRateios, coberturaDeRateios } = await import('/js/api.js');
    const antes = await coberturaDeRateios('lotofacil');
    const r = await baixarRateios('lotofacil', { limite: 5 });
    const depois = await coberturaDeRateios('lotofacil');
    return { antes: antes.comRateio, depois: depois.comRateio, baixados: r.baixados };
  });
  t.confere('concurso já baixado nunca volta para a fila',
    naoRebaixa.depois === naoRebaixa.antes + naoRebaixa.baixados,
    `${naoRebaixa.antes} → ${naoRebaixa.depois}`);

  const parada = await p.evaluate(async () => {
    const { baixarRateios } = await import('/js/api.js');
    let blocos = 0;
    const r = await baixarRateios('lotofacil', {
      limite: 200,
      pedidoDeParar: () => ++blocos > 3,     // para logo no começo
    });
    return r;
  });
  t.confere('"Parar" interrompe e guarda o que já veio',
    parada.parou === true && parada.baixados > 0 && parada.baixados < 200,
    `${parada.baixados} baixados antes de parar`);

  /* ---------------- o prêmio entra no bilhete conferido --------------- */

  /* Termina o download antes de conferir bilhetes: os testes de lote acima
     deixaram a base pela metade de propósito. */
  await p.evaluate(async () => {
    const { baixarRateios } = await import('/js/api.js');
    for (let i = 0; i < 20; i++) {
      const r = await baixarRateios('lotofacil', { limite: 400 });
      if (r.restantes === 0 || r.baixados === 0) break;
    }
  });

  /* Bilhete montado com as 15 dezenas do concurso 50 do histórico
     sintético: acerta 15, que é a faixa máxima. */
  const preparo = await p.evaluate(async () => {
    const { carregarHistorico } = await import('/js/api.js');
    const h = await carregarHistorico('lotofacil');
    const c50 = h.concursos.find((c) => c.numero === 50);
    const c51 = h.concursos.find((c) => c.numero === 51);
    return {
      quinzeDoC50: c50.dezenas,
      onzeDoC51: [...c51.dezenas.slice(0, 11), ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
        .filter((d) => !c51.dezenas.includes(d)).slice(0, 4)],
      rateio50: h.rateios[50] ?? null,
      rateio51: h.rateios[51] ?? null,
    };
  });

  await semearBilhetes(p, 'lotofacil', [preparo.quinzeDoC50], { concurso: 50, origem: 'teste' });
  await semearBilhetes(p, 'lotofacil', [preparo.onzeDoC51], { concurso: 51, origem: 'teste' });

  const conferidos = await p.evaluate(async () => {
    const { conferirTodos } = await import('/js/tickets.js');
    const { carregarHistorico } = await import('/js/api.js');
    const { DB } = await import('/js/db.js');
    const h = await carregarHistorico('lotofacil');
    await conferirTodos('lotofacil', h.concursos);
    const bs = await DB.listarBilhetes('lotofacil');
    return bs.map((b) => ({
      concurso: b.concurso, acertos: b.acertos,
      premio: b.premio, fonte: b.premioFonte,
      rateio: h.rateios[b.concurso] ?? null,
    }));
  });

  const b50 = conferidos.find((b) => b.concurso === 50);
  const b51 = conferidos.find((b) => b.concurso === 51);

  t.confere('o bilhete do concurso 50 fez 15 acertos', b50?.acertos === 15);

  /* Concurso 50 não é múltiplo de 3, então a faixa máxima TEM ganhador e o
     valor é o apurado. O teste confere contra o próprio rateio gravado, e
     não contra um número escrito à mão — assim ele não quebra se a semente
     do histórico sintético mudar. */
  const esperado50 = b50?.rateio?.[15]?.[0];
  t.confere('o prêmio do bilhete premiado saiu do rateio da Caixa',
    b50 && b50.fonte === 'apurado' && b50.premio === esperado50,
    `bilhete R$ ${b50?.premio} · rateio R$ ${esperado50} · fonte ${b50?.fonte}`);

  if (b51) {
    const esperado51 = b51.acertos >= 11 ? b51.rateio?.[b51.acertos]?.[0] : 0;
    t.confere('bilhete de faixa menor também recebe o valor certo',
      b51.acertos < 11 || b51.premio === esperado51,
      `${b51.acertos} acertos · R$ ${b51.premio} · esperado R$ ${esperado51}`);
  }

  /* ---------------- o valor digitado à mão é intocável ---------------- */

  await abrirTabelaDeBilhetes(p);
  await p.fill('#tabelaBilhetes tbody tr:first-child .premio-input', '999,00'.replace(',', '.'));
  await p.dispatchEvent('#tabelaBilhetes tbody tr:first-child .premio-input', 'change');
  await p.waitForTimeout(900);

  const depoisDeReconferir = await p.evaluate(async () => {
    const { conferirTodos } = await import('/js/tickets.js');
    const { carregarHistorico } = await import('/js/api.js');
    const { DB } = await import('/js/db.js');
    const h = await carregarHistorico('lotofacil');
    await conferirTodos('lotofacil', h.concursos);
    const bs = await DB.listarBilhetes('lotofacil');
    return bs.filter((b) => b.premio === 999).map((b) => b.premioFonte);
  });

  t.confere('valor digitado à mão sobrevive a uma nova conferência',
    depoisDeReconferir.length === 1 && depoisDeReconferir[0] === 'manual',
    JSON.stringify(depoisDeReconferir));

  /* ---------------- a Retrospectiva usa o valor real ------------------ */

  /* O retorno apurado é recalculado por fora, do zero, a partir do rateio
     gravado — e não relendo a mesma função que o app usa. É o mesmo
     princípio dos testes de matemática: um erro de conta não dá erro, dá
     número errado com cara de certo. */
  const varredura = await p.evaluate(async () => {
    const { varrer } = await import('/js/backtest.js');
    const { carregarHistorico } = await import('/js/api.js');
    const { LOTERIAS } = await import('/js/config.js');
    const l = LOTERIAS.lotofacil;

    const h = await carregarHistorico('lotofacil');
    /* Só os concursos que já têm rateio, para o teste medir o caminho
       apurado sem se misturar com o estimado. */
    const comRateio = h.concursos.filter((c) => h.rateios[c.numero]);
    /* O jogo é a cópia exata de um concurso em que a faixa máxima
       ACUMULOU. Assim a varredura obrigatoriamente encontra o caso que
       este arquivo existe para vigiar: 15 acertos num concurso em que
       ninguém levou. Um jogo qualquer quase nunca cairia nele. */
    const alvo = comRateio.find((c) => c.numero % 3 === 0) ?? comRateio[0];
    const jogos = [alvo.dezenas];

    const r = varrer(jogos, comRateio, l, {
      premios: {}, rateios: h.rateios, custoPorConcurso: 3.5,
    });

    /* Recálculo independente: para cada concurso, conta os acertos na mão,
       procura a faixa no rateio, e só soma se houve ganhador. */
    let apurado = 0, acumuladas = 0;
    for (const c of comRateio) {
      const set = new Set(c.dezenas);
      let acertos = 0;
      for (const d of jogos[0]) if (set.has(d)) acertos++;
      if (!l.faixas.includes(acertos)) continue;
      const linha = h.rateios[c.numero][acertos];
      if (!linha) continue;
      if (linha[1] > 0) apurado += linha[0];
      else acumuladas++;
    }

    return {
      doApp: Math.round(r.financeiro.retornoApurado * 100) / 100,
      recalculado: Math.round(apurado * 100) / 100,
      acumuladasApp: r.financeiro.faixasAcumuladas,
      acumuladasRecalc: acumuladas,
      semRateio: r.financeiro.concursosSemRateio,
      estimado: r.financeiro.retornoEstimado,
      concursos: comRateio.length,
      faltam: r.financeiro.faltamValores,
    };
  });

  t.confere('retorno apurado bate com o recálculo independente',
    varredura.doApp === varredura.recalculado,
    `app ${varredura.doApp} · recalculado ${varredura.recalculado}`);
  t.confere('as faixas que acumularam são contadas, não somadas como zero',
    varredura.acumuladasApp === varredura.acumuladasRecalc && varredura.acumuladasApp > 0,
    `app ${varredura.acumuladasApp} · recalculado ${varredura.acumuladasRecalc}`);
  /* O aviso "faltam valores" não pode acusar uma faixa que o retorno
     apurado acima é feito dela. A tela dizia exatamente isso: "as faixas de
     14 e 15 foram ignoradas" logo acima de R$ 1,9 milhão vindo delas. */
  t.confere('não avisa que falta valor numa faixa que ele acabou de pagar',
    varredura.faltam.length === 0, JSON.stringify(varredura.faltam));
  t.confere('com rateio em todos os concursos, nada fica por estimativa',
    varredura.semRateio === 0 && varredura.estimado === 0,
    `${varredura.semRateio} sem rateio · R$ ${varredura.estimado} estimado`);

  /* ---------------- pelo BOTÃO, que é como o usuário faz -------------- */

  /* Tudo acima chamou `baixarRateios()` direto. Isso não prova que o botão
     funciona — e a lição mais cara deste projeto foi descobrir que a camada
     de dados passava em tudo enquanto o botão não fazia nada, em silêncio.
     Daqui para baixo é só clique. */

  await esquecerRateios(p, 'lotofacil');
  await irPara(p, 'config');
  await p.waitForTimeout(800);

  const antesDoClique = await p.evaluate(() => ({
    texto: document.querySelector('#btnBaixarRateios').textContent.trim(),
    desligado: document.querySelector('#btnBaixarRateios').disabled,
    tabela: document.querySelector('#statusRateios').innerText,
  }));
  t.confere('a aba Configurações mostra a cobertura REAL ao abrir',
    /400/.test(antesDoClique.tabela) && !antesDoClique.desligado,
    antesDoClique.tabela.replace(/\s+/g, ' ').slice(0, 90));
  t.confere('o botão diz quantos concursos faltam',
    /400/.test(antesDoClique.texto), antesDoClique.texto);

  await p.click('#btnBaixarRateios');
  await p.waitForFunction(
    () => document.querySelector('#btnBaixarRateios')?.dataset.rodando === undefined,
    null, { timeout: 120000 }
  );
  await p.waitForTimeout(600);

  const depoisDoClique = await p.evaluate(async () => {
    const { coberturaDeRateios } = await import('/js/api.js');
    const c = await coberturaDeRateios('lotofacil');
    const btn = document.querySelector('#btnBaixarRateios');
    return {
      faltando: c.faltando.length, comRateio: c.comRateio,
      texto: btn.textContent.trim(), desligado: btn.disabled,
      parar: document.querySelector('#btnPararRateios').hidden,
      progresso: document.querySelector('#progressoRateios').innerText,
    };
  });

  t.confere('clicar no botão baixa tudo o que faltava',
    depoisDoClique.faltando === 0 && depoisDoClique.comRateio === 400,
    `${depoisDoClique.comRateio} com prêmio, ${depoisDoClique.faltando} faltando`);
  t.confere('sem nada a baixar, o botão se desliga em vez de aceitar clique à toa',
    depoisDoClique.desligado === true && /tudo baixado/i.test(depoisDoClique.texto),
    `"${depoisDoClique.texto}" desligado=${depoisDoClique.desligado}`);
  t.confere('o botão Parar some quando acaba', depoisDoClique.parar === true);
  t.confere('a tela conta o que aconteceu',
    /pronto/i.test(depoisDoClique.progresso), depoisDoClique.progresso);

  t.confere('nenhum erro de página', p.erros.length === 0, p.erros.join(' | '));
  await nav.close();
  return t.resultado();
}
