/**
 * A matemática — a parte em que um erro não dá erro, dá número errado
 * com cara de certo.
 *
 * Tudo aqui é verificado POR FORA: o teste refaz a conta com um método
 * independente e compara. Um fechamento é conferido por força bruta em
 * todos os cenários; a conferência é refeita à mão; a contabilidade é
 * recalculada do zero a partir dos bilhetes e do histórico.
 */

import { abrirPagina, placar, chromium } from './ajuda.mjs';

export default async function rodar() {
  const t = placar('Matemática');
  const nav = await chromium.launch();
  const p = await abrirPagina(nav);

  /* ---------------- fechamento: garantia por força bruta -------------- */

  const fech = await p.evaluate(async () => {
    const W = await import('/js/wheel.js');

    /* Verificação independente: para TODO cenário possível de t acertos
       dentro do grupo, qual o melhor bilhete? A garantia real é o pior
       caso. Não usa nada do que o próprio motor calculou. */
    const combinar = (arr, k) => {
      const res = [], cur = [];
      (function rec(i) {
        if (cur.length === k) { res.push(cur.slice()); return; }
        for (let j = i; j < arr.length; j++) { cur.push(arr[j]); rec(j + 1); cur.pop(); }
      })(0);
      return res;
    };
    const garantiaReal = (jogos, grupo, t) => {
      let pior = Infinity;
      for (const cen of combinar(grupo, t)) {
        const s = new Set(cen);
        let melhor = 0;
        for (const b of jogos) {
          let c = 0; for (const d of b) if (s.has(d)) c++;
          if (c > melhor) melhor = c;
        }
        if (melhor < pior) pior = melhor;
      }
      return pior;
    };

    const grupo = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const casos = [
      { n: 16, j: 15, t: 15, g: 14 },
      { n: 17, j: 15, t: 15, g: 13 },
      { n: 18, j: 15, t: 15, g: 14 },
      { n: 17, j: 15, t: 14, g: 13 },
      { n: 20, j: 15, t: 15, g: 13 },
    ];
    return casos.map((k) => {
      const gr = grupo(k.n);
      const r = W.fechar(gr, { porJogo: k.j, acertosNoGrupo: k.t, garantia: k.g });
      return {
        caso: `${k.n} dezenas, ${k.j}/bilhete, cenário ${k.t}, garantia ${k.g}`,
        bilhetes: r.jogos.length,
        vazios: r.jogos.filter((x) => !x.length).length,
        appDiz: r.garantiaReal,
        forcaBruta: garantiaReal(r.jogos, gr, k.t),
        pedido: k.g,
      };
    });
  });

  for (const f of fech) {
    t.confere(
      `fechamento (${f.caso})`,
      f.appDiz === f.forcaBruta && f.forcaBruta >= f.pedido && f.vazios === 0,
      `${f.bilhetes} bilhetes · app diz ${f.appDiz} · força bruta ${f.forcaBruta}`
    );
  }

  /* --- fechamento nunca pode devolver bilhete vazio dizendo que garante --- */

  const invalidos = await p.evaluate(async () => {
    const W = await import('/js/wheel.js');
    /* Zero é o valor perigoso: `Number('')` é 0, não NaN, então um select
       que perdeu a opção escolhida entregava 0 e passava por todas as
       guardas. O motor devolvia `[[]]` com garantiaAtendida: true. */
    const casos = [
      { n: 16, j: 0, t: 15, g: 0 },
      { n: 16, j: 15, t: 0, g: 0 },
      { n: 16, j: 15, t: 15, g: 0 },
      { n: 0, j: 15, t: 15, g: 14 },
    ];
    return casos.map((k) => Boolean(W.validarPedido(k)));
  });
  t.confere('parâmetros zerados são recusados antes de virar bilhete vazio',
    invalidos.every(Boolean), `${invalidos.filter(Boolean).length}/4 recusados`);

  /* ---------------- conferência, inclusive o zero da Lotomania -------- */

  const conf = await p.evaluate(async () => {
    const { conferirBilhete, montarBilhetes } = await import('/js/tickets.js');
    const { LOTERIAS } = await import('/js/config.js');

    /* Resultado REAL da Lotofácil 3774, conferido na API oficial da Caixa
       em 30/08/2026. Escrito à mão de propósito: aqui a fixture sintética
       não serve, porque o que se testa é o acerto contra a realidade. */
    const S = [1, 3, 4, 5, 6, 7, 9, 12, 14, 15, 16, 18, 19, 23, 24];
    const fora = [2, 8, 10, 11, 13, 17, 20, 21, 22, 25];

    const caso = (dezenas) => {
      const [b] = montarBilhetes('lotofacil', [dezenas], { concurso: 3774 });
      const r = conferirBilhete(b, S);
      return { acertos: r.acertos, premiado: r.premiado, esperado: dezenas.filter((d) => S.includes(d)).length };
    };

    const faixas = [15, 14, 13, 12, 11, 10, 5].map((quero) => {
      const dez = [...S.slice(0, quero), ...fora.slice(0, 15 - quero)];
      return { quero, ...caso(dez) };
    });

    /* Lotomania: ZERO acerto também premia. É a armadilha da modalidade. */
    const SL = [0, 13, 15, 21, 25, 38, 40, 47, 55, 56, 57, 58, 62, 68, 70, 75, 84, 86, 90, 99];
    const zero = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16, 17, 18, 19, 20, 22, 23];
    const [bz] = montarBilhetes('lotomania', [zero], { concurso: 2969 });
    const rz = conferirBilhete(bz, SL);

    return { faixas, zeroAcertos: rz.acertos, zeroPremiado: rz.premiado,
             faixasLotomania: LOTERIAS.lotomania.faixas };
  });

  t.confere('conferência bate em todas as faixas',
    conf.faixas.every((f) => f.acertos === f.esperado),
    conf.faixas.map((f) => `${f.acertos}`).join(', '));
  t.confere('Lotofácil: 11 pontos premia, 10 não',
    conf.faixas.find((f) => f.acertos === 11)?.premiado === true &&
    conf.faixas.find((f) => f.acertos === 10)?.premiado === false);
  t.confere('Lotomania: ZERO acerto é faixa premiada',
    conf.zeroAcertos === 0 && conf.zeroPremiado === true,
    `faixas: ${conf.faixasLotomania}`);

  /* ---------------- contabilidade recalculada do zero ---------------- */

  const contas = await p.evaluate(async () => {
    const { DB } = await import('/js/db.js');
    const { montarBilhetes } = await import('/js/tickets.js');
    const { varrer } = await import('/js/backtest.js');
    const { carregarHistorico } = await import('/js/api.js');
    const { LOTERIAS } = await import('/js/config.js');
    const { custoAposta } = await import('/js/tickets.js');

    const l = LOTERIAS.lotofacil;
    const jogos = [
      [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
      [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
      [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17],
    ];
    await DB.salvarBilhetes(montarBilhetes('lotofacil', jogos, { concurso: 1 }));

    const h = await carregarHistorico('lotofacil');
    const custoPorConcurso = jogos.reduce(
      (a, j) => a + custoAposta(l, j.length, 3.5).custo, 0);
    const r = varrer(jogos, h.concursos, l, { premios: l.premios, custoPorConcurso });

    /* Refazendo a conta por fora, sem tocar em nada do backtest. */
    const FIXO = { 11: 7, 12: 14, 13: 35 };   // conferido no portal da Caixa
    let retorno = 0, premiaram = 0, somaMelhor = 0;
    for (const c of h.concursos) {
      const s = new Set(c.dezenas);
      let melhor = 0;
      for (const j of jogos) {
        let a = 0; for (const d of j) if (s.has(d)) a++;
        retorno += FIXO[a] ?? 0;
        if (a > melhor) melhor = a;
      }
      if (melhor >= 11) premiaram++;
      somaMelhor += melhor;
    }
    const n = h.concursos.length;
    return {
      app: {
        retorno: r.financeiro.retornoFixo,
        custo: r.financeiro.custoTotal,
        pct: r.resumo.pctPremiados,
        media: r.resumo.mediaMelhor,
      },
      meu: {
        retorno,
        custo: custoPorConcurso * n,
        pct: (premiaram / n) * 100,
        media: somaMelhor / n,
      },
    };
  });

  const perto = (a, b) => Math.abs(a - b) < 0.001;
  t.confere('retorno garantido bate com o cálculo independente',
    perto(contas.app.retorno, contas.meu.retorno),
    `app ${contas.app.retorno} · recalculado ${contas.meu.retorno}`);
  t.confere('custo total bate', perto(contas.app.custo, contas.meu.custo));
  t.confere('"premiaram algo" bate', perto(contas.app.pct, contas.meu.pct),
    `${contas.app.pct.toFixed(2)}%`);
  t.confere('média do melhor acerto bate', perto(contas.app.media, contas.meu.media));

  /* ---------------- gerador: bilhetes sempre válidos ---------------- */

  const ger = await p.evaluate(async () => {
    const { gerar } = await import('/js/generator.js');
    const { LOTERIAS } = await import('/js/config.js');
    return ['lotofacil', 'megasena', 'lotomania'].map((id) => {
      const l = LOTERIAS[id];
      const r = gerar(40, l, { dezenasPorJogo: l.sorteadas }, {});
      const vistos = new Set();
      const problemas = [];
      for (const j of r.jogos) {
        if (j.length !== l.sorteadas) problemas.push('tamanho');
        if (new Set(j).size !== j.length) problemas.push('dezena repetida no bilhete');
        if (j.some((d) => d < l.min || d > l.max)) problemas.push('fora da faixa');
        const k = j.slice().sort((a, b) => a - b).join(',');
        if (vistos.has(k)) problemas.push('bilhete duplicado no lote');
        vistos.add(k);
      }
      return { id, n: r.jogos.length, problemas: [...new Set(problemas)] };
    });
  });
  for (const g of ger) {
    t.confere(`gerador ${g.id}: ${g.n} bilhetes válidos e distintos`,
      g.problemas.length === 0, g.problemas.join(', '));
  }

  t.confere('nenhum erro de página', p.erros.length === 0, p.erros.join(' | '));
  await nav.close();
  return t.resultado();
}
