/**
 * O espaço de combinações filtradas.
 *
 * Aqui um erro não dá erro: dá um espaço com o tamanho errado, e toda a
 * estatística em cima dele sai errada com cara de certa. Por isso a
 * verificação central deste arquivo é uma FORÇA BRUTA independente —
 * enumerar tudo sem poda nenhuma e filtrar com `motivoRecusa`, que é o
 * mesmo oráculo que o Gerador usa. Se a poda cortar um ramo que continha
 * um jogo válido, as duas contagens divergem e o teste grita.
 *
 * E, como sempre neste projeto, os testes CLICAM. O bug mais caro daqui
 * sobreviveu a rodadas inteiras de teste porque os testes chamavam a
 * função e nunca o botão.
 */

import { abrirPagina, placar, chromium, irPara, trocarLoteria, esperarBase } from './ajuda.mjs';

export default async function rodar() {
  const t = placar('Espaço filtrado');
  const nav = await chromium.launch();
  const p = await abrirPagina(nav);
  await esperarBase(p, 'lotofacil', 50);

  /* ================================================================ */
  /* 1. Contagem: a poda não pode inventar nem perder combinação       */
  /* ================================================================ */

  const contagem = await p.evaluate(async () => {
    const E = await import('/js/espaco.js');
    const { LOTERIAS } = await import('/js/config.js');
    const { filtrosPadrao, motivoRecusa } = await import('/js/generator.js');
    const LF = LOTERIAS.lotofacil;
    const MS = LOTERIAS.megasena;

    const limpo = (l, extra) => ({
      ...filtrosPadrao(l),
      evitarPopulares: false,
      evitarJaSorteados: false,
      soma: null, pares: null, primos: null, moldura: null, repetidas: null,
      maxSequencia: null,
      ...extra,
    });

    /* Oráculo independente: gera TODAS as combinações do pool, sem poda
       alguma, e aplica o filtro do Gerador jogo a jogo. */
    function forcaBruta(loteria, filtros, contexto = {}) {
      const excl = new Set(filtros.excluidas ?? []);
      const fix = filtros.fixas ?? [];
      const pool = [];
      for (let d = loteria.min; d <= loteria.max; d++) if (!excl.has(d)) pool.push(d);
      const k = filtros.dezenasPorJogo;
      const aceitos = [];
      const cur = [];
      (function rec(i) {
        if (cur.length === k) {
          for (const d of fix) if (!cur.includes(d)) return;
          if (!motivoRecusa(cur.slice(), loteria, filtros, contexto)) aceitos.push(cur.slice());
          return;
        }
        if (i >= pool.length || pool.length - i < k - cur.length) return;
        cur.push(pool[i]); rec(i + 1); cur.pop();
        rec(i + 1);
      })(0);
      return aceitos.length;
    }

    const fora = (de, ate) => { const a = []; for (let d = de; d <= ate; d++) a.push(d); return a; };
    const ultimo = fora(1, 15);
    const ctx = { ultimoSorteio: ultimo };

    const casos = [
      ['soma + pares + consecutivas', limpo(LF, {
        excluidas: fora(19, 25), dezenasPorJogo: 15,
        soma: { min: 110, max: 150 }, pares: { min: 5, max: 8 }, maxSequencia: 6,
      })],
      ['moldura + primos', limpo(LF, {
        excluidas: fora(18, 25), dezenasPorJogo: 15,
        primos: { min: 5, max: 7 }, moldura: { min: 8, max: 13 },
      })],
      ['fixas + excluídas', limpo(LF, {
        fixas: [1, 2, 3], excluidas: fora(19, 25), dezenasPorJogo: 15,
        soma: { min: 110, max: 155 }, maxSequencia: 5,
      })],
      ['popularidade (conferida na folha)', limpo(LF, {
        excluidas: fora(18, 25), dezenasPorJogo: 15,
        evitarPopulares: true, limitePopularidade: 60,
      })],
      ['repetidas do último sorteio', limpo(LF, {
        excluidas: fora(18, 25), dezenasPorJogo: 15,
        repetidas: { min: 12, max: 14 },
      })],
    ];

    const comparados = casos.map(([nome, f]) => {
      const bruta = forcaBruta(LF, f, ctx);
      const podada = E.explorar(LF, f, { reservatorio: 200000, semente: 3, contexto: ctx });
      /* As máscaras guardadas têm que decodificar para jogos que o oráculo
         também aceitaria — contagem certa com conteúdo errado seria pior. */
      let mascarasValidas = true;
      for (let i = 0; i < podada.amostra.n && mascarasValidas; i++) {
        const dz = [];
        for (let b = 0; b < 32; b++) if (podada.amostra.lo[i] & (1 << b)) dz.push(podada.pool[b]);
        for (let b = 0; b < 32; b++) if (podada.amostra.hi[i] & (1 << b)) dz.push(podada.pool[b + 32]);
        if (dz.length !== f.dezenasPorJogo) mascarasValidas = false;
        else if (motivoRecusa(dz, LF, f, ctx)) mascarasValidas = false;
      }
      return { nome, bruta, podada: podada.total, mascarasValidas, exata: podada.exata };
    });

    const semFiltroLF = E.explorar(LF, limpo(LF, { dezenasPorJogo: 15 }), { reservatorio: 1 });
    const semFiltroMS = E.explorar(MS, limpo(MS, { dezenasPorJogo: 6 }), { reservatorio: 1000 });
    let usouMascaraAlta = false;
    for (let i = 0; i < semFiltroMS.amostra.n; i++) {
      if (semFiltroMS.amostra.hi[i] !== 0) { usouMascaraAlta = true; break; }
    }

    return {
      comparados,
      lf: semFiltroLF.total, lfEsperado: E.combinacoes(25, 15),
      ms: semFiltroMS.total, msEsperado: E.combinacoes(60, 6),
      usouMascaraAlta,
    };
  });

  t.confere('sem filtro, a Lotofácil conta C(25,15)',
    contagem.lf === contagem.lfEsperado,
    `${contagem.lf.toLocaleString('pt-BR')}`);
  t.confere('sem filtro, a Mega-Sena conta C(60,6)',
    contagem.ms === contagem.msEsperado,
    `${contagem.ms.toLocaleString('pt-BR')}`);
  t.confere('a máscara de 64 bits usa a metade alta (dezenas acima de 32)',
    contagem.usouMascaraAlta);

  for (const c of contagem.comparados) {
    t.confere(`poda == força bruta: ${c.nome}`,
      c.podada === c.bruta && c.bruta > 0,
      `${c.podada} vs ${c.bruta}`);
    t.confere(`  e as máscaras decodificam para jogos aprovados: ${c.nome}`,
      c.mascarasValidas);
  }

  /* ================================================================ */
  /* 2. A linha teórica — conferida contra a fórmula, não contra si    */
  /* ================================================================ */

  const teoria = await p.evaluate(async () => {
    const E = await import('/js/espaco.js');
    const { LOTERIAS } = await import('/js/config.js');
    const b15 = E.baselineTeorico(LOTERIAS.lotofacil, 15);
    const b18 = E.baselineTeorico(LOTERIAS.lotofacil, 18);
    const bMS = E.baselineTeorico(LOTERIAS.megasena, 6);
    return {
      soma: [...b15.p.values()].reduce((s, v) => s + v, 0),
      media15: b15.media,
      media18: b18.media,
      mediaMS: bMS.media,
      pSena: bMS.p.get(6),
      umEm: 1 / E.combinacoes(60, 6),
      p15: b15.p.get(15),
      umEm15: 1 / E.combinacoes(25, 15),
    };
  });

  t.confere('a distribuição hipergeométrica soma 1', Math.abs(teoria.soma - 1) < 1e-12,
    teoria.soma.toFixed(15));
  t.confere('média de acertos da Lotofácil = 9 exatos (15 × 15/25)',
    Math.abs(teoria.media15 - 9) < 1e-12, teoria.media15.toFixed(15));
  t.confere('bilhete de 18 dezenas: média 10,8 exatos (18 × 15/25)',
    Math.abs(teoria.media18 - 10.8) < 1e-12, teoria.media18.toFixed(15));
  t.confere('média da Mega-Sena = 0,6 exatos (6 × 6/60)',
    Math.abs(teoria.mediaMS - 0.6) < 1e-12, teoria.mediaMS.toFixed(15));
  t.confere('P(sena) = 1 em 50.063.860', Math.abs(teoria.pSena - teoria.umEm) < 1e-20);
  t.confere('P(15 acertos) = 1 em 3.268.760', Math.abs(teoria.p15 - teoria.umEm15) < 1e-18);

  /* ================================================================ */
  /* 3. O teorema em ação: cortar 95% do espaço não muda os acertos    */
  /* ================================================================ */

  const teorema = await p.evaluate(async () => {
    const E = await import('/js/espaco.js');
    const { LOTERIAS } = await import('/js/config.js');
    const { filtrosPadrao } = await import('/js/generator.js');
    const LF = LOTERIAS.lotofacil;

    /* Sorteios uniformes e determinísticos: é contra o acaso puro que a
       afirmação vale, e é ele que temos que reproduzir aqui. */
    let s = 20260831;
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
    const concursos = [];
    for (let c = 0; c < 700; c++) {
      const idx = [...Array(25).keys()];
      for (let i = 0; i < 15; i++) {
        const j = i + Math.floor(rnd() * (25 - i));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      concursos.push({ numero: c + 1, dezenas: idx.slice(0, 15).map((x) => x + 1).sort((a, b) => a - b) });
    }

    const apertado = {
      ...filtrosPadrao(LF), dezenasPorJogo: 15,
      evitarPopulares: false, evitarJaSorteados: false,
      soma: { min: 180, max: 210 }, pares: { min: 7, max: 8 },
      primos: null, moldura: null, repetidas: null, maxSequencia: 3,
    };
    const esp = E.explorar(LF, apertado, { reservatorio: 40000, semente: 11 });
    const med = E.medir(esp.amostra, concursos, LF, { tamanho: 15 });
    const ic = E.bootstrap(med.porConcurso, { rodadas: 300 });
    const v = E.veredito(med, ic, LF);

    /* Uniformidade do reservatório: cada dezena do espaço COMPLETO deve
       aparecer em 15/25 = 60% dos bilhetes amostrados. */
    const todo = E.explorar(LF, { ...filtrosPadrao(LF), dezenasPorJogo: 15,
      evitarPopulares: false, evitarJaSorteados: false,
      soma: null, pares: null, primos: null, moldura: null, repetidas: null, maxSequencia: null },
      { reservatorio: 30000, semente: 99 });
    let com1 = 0, somaDezenas = 0;
    for (let i = 0; i < todo.amostra.n; i++) {
      if (todo.amostra.lo[i] & 1) com1++;
      for (let b = 0; b < 25; b++) if (todo.amostra.lo[i] & (1 << b)) somaDezenas += b + 1;
    }

    return {
      total: esp.total, fracao: esp.fracao,
      mediaFiltrada: med.filtrado.mediaAcertos,
      mediaTeorica: med.teorico.mediaAcertos,
      dentroDoRuido: v.dentroDoRuido,
      icLo: ic.pctPremiado.lo, icHi: ic.pctPremiado.hi,
      reservatorioCheio: !todo.exata && todo.amostra.n === 30000,
      frac1: com1 / todo.amostra.n,
      somaMedia: somaDezenas / todo.amostra.n,
    };
  });

  t.confere('um filtro apertado corta a maior parte do espaço',
    teorema.fracao < 0.10, `sobraram ${(teorema.fracao * 100).toFixed(2)}% (${teorema.total.toLocaleString('pt-BR')})`);
  t.confere('e mesmo assim a média de acertos continua ~9',
    Math.abs(teorema.mediaFiltrada - 9) < 0.03,
    `filtrado ${teorema.mediaFiltrada.toFixed(4)} vs teórico ${teorema.mediaTeorica.toFixed(4)}`);
  t.confere('o veredito diz "dentro do ruído" contra sorteio uniforme',
    teorema.dentroDoRuido,
    `IC 95% [${(teorema.icLo * 100).toFixed(3)}, ${(teorema.icHi * 100).toFixed(3)}] pp`);
  t.confere('o reservatório enche e marca a medição como amostra',
    teorema.reservatorioCheio);
  t.confere('a amostra é uniforme: cada dezena em ~60% dos bilhetes',
    Math.abs(teorema.frac1 - 0.6) < 0.015, teorema.frac1.toFixed(4));
  t.confere('a amostra é uniforme: soma média ~195',
    Math.abs(teorema.somaMedia - 195) < 2, teorema.somaMedia.toFixed(2));

  /* ================================================================ */
  /* 4. Recusas honestas                                               */
  /* ================================================================ */

  const recusas = await p.evaluate(async () => {
    const E = await import('/js/espaco.js');
    const { LOTERIAS } = await import('/js/config.js');
    const { filtrosPadrao } = await import('/js/generator.js');
    const lm = E.viabilidade(LOTERIAS.lotomania, { dezenasPorJogo: 50 });
    const fixasDemais = E.viabilidade(LOTERIAS.lotofacil, {
      dezenasPorJogo: 15, fixas: [...Array(16).keys()].map((x) => x + 1),
    });
    /* Excluir dezenas demais não deixa jogo possível. */
    const poucas = E.viabilidade(LOTERIAS.lotofacil, {
      dezenasPorJogo: 15, excluidas: [...Array(15).keys()].map((x) => x + 11),
    });
    let erroDeExplorar = null;
    try { E.explorar(LOTERIAS.lotomania, filtrosPadrao(LOTERIAS.lotomania), {}); }
    catch (e) { erroDeExplorar = e.message; }
    return {
      lmViavel: lm.viavel, lmMotivo: lm.motivo,
      fixasViavel: fixasDemais.viavel, fixasMotivo: fixasDemais.motivo,
      poucasViavel: poucas.viavel,
      erroDeExplorar,
    };
  });

  t.confere('a Lotomania é recusada, e o motivo explica a ordem de grandeza',
    !recusas.lmViavel && /trilh/.test(recusas.lmMotivo ?? ''));
  t.confere('explorar() também recusa a Lotomania em vez de tentar',
    /trilh/.test(recusas.erroDeExplorar ?? ''));
  t.confere('fixar mais dezenas do que cabe no bilhete é recusado',
    !recusas.fixasViavel && /fixou/.test(recusas.fixasMotivo ?? ''));
  t.confere('excluir dezenas demais é recusado', !recusas.poucasViavel);

  /* ================================================================ */
  /* 5. A TELA — o teste clica no botão, não chama a função            */
  /* ================================================================ */

  await irPara(p, 'gerador');

  /* O tamanho do espaço tem que estar escrito ANTES de qualquer clique. */
  const notaAntes = await p.textContent('#notaEspaco');
  t.confere('a tela diz o tamanho do espaço antes de rodar',
    /3\.268\.760/.test(notaAntes ?? ''), (notaAntes ?? '').slice(0, 80));

  await p.click('#btnMedirFiltro');
  await p.waitForSelector('#corpoEspaco:not([hidden])', { timeout: 120000 });

  const tela = await p.evaluate(() => {
    const texto = (s) => document.querySelector(s)?.textContent ?? '';
    const linhas = [...document.querySelectorAll('#tabelaEspaco tbody tr')].map((tr) =>
      [...tr.children].map((td) => td.textContent.trim())
    );
    return {
      veredito: texto('#vereditoEspaco'),
      resumo: texto('#resumoEspaco'),
      conclusao: texto('#conclusaoEspaco'),
      linhas,
      botaoTexto: document.querySelector('#btnMedirFiltro')?.textContent ?? '',
      botaoTravado: document.querySelector('#btnMedirFiltro')?.disabled,
      cancelarEscondido: document.querySelector('#botoesEspaco')?.hidden,
      progresso: texto('#progressoEspaco'),
    };
  });

  const linhaMedia = tela.linhas.find((l) => /Média de acertos/.test(l[0]));
  const lidos = linhaMedia ? linhaMedia.slice(1).map((x) => Number(x.replace(',', '.'))) : [];

  t.confere('a tabela mostra a média de acertos das duas colunas',
    lidos.length === 2 && lidos.every((v) => Number.isFinite(v)),
    linhaMedia ? linhaMedia.join(' | ') : 'linha não encontrada');
  t.confere('a média teórica na tela é exatamente 9',
    Math.abs(lidos[1] - 9) < 1e-9, String(lidos[1]));
  t.confere('a média medida na tela bate com a teórica',
    Math.abs(lidos[0] - lidos[1]) < 0.05,
    `${lidos[0]} vs ${lidos[1]}`);

  const linhaComb = tela.linhas.find((l) => /^Combinações/.test(l[0]));
  t.confere('a tabela mostra o espaço filtrado e o espaço inteiro',
    !!linhaComb && /3\.268\.760/.test(linhaComb[2]),
    linhaComb ? linhaComb.join(' | ') : 'linha não encontrada');

  t.confere('o veredito aparece escrito, não só o número',
    /ruído/.test(tela.veredito), tela.veredito.slice(0, 90));
  t.confere('o rodapé diz sobre quantos concursos mediu',
    /concursos/.test(tela.resumo));
  t.confere('a conclusão repete que a média é igual por teorema',
    /teorema/.test(tela.conclusao));

  /* O botão não pode ficar preso em "Medindo…" — foi assim que quatro
     operações demoradas congelaram antes. */
  t.confere('o botão volta ao texto original quando termina',
    /Medir este filtro/.test(tela.botaoTexto) && !tela.botaoTravado,
    tela.botaoTexto.trim());
  t.confere('o botão Cancelar some quando termina', tela.cancelarEscondido === true);
  t.confere('o progresso é limpo no fim', tela.progresso.trim() === '');

  /* ================================================================ */
  /* 6. Lotomania na tela: recusa visível, não botão morto             */
  /* ================================================================ */

  await trocarLoteria(p, 'lotomania');
  await p.waitForFunction(
    () => document.querySelector('#btnMedirFiltro')?.disabled === true,
    null, { timeout: 15000 }
  ).catch(() => {});

  const lm = await p.evaluate(() => ({
    travado: document.querySelector('#btnMedirFiltro')?.disabled,
    nota: document.querySelector('#notaEspaco')?.textContent ?? '',
  }));
  t.confere('na Lotomania o botão fica desabilitado', lm.travado === true);
  t.confere('e a tela explica por quê, em vez de só travar',
    /combina/.test(lm.nota) && /trilh/.test(lm.nota), lm.nota.slice(0, 100));

  t.confere('nenhum erro de console durante tudo isso',
    p.erros.length === 0, p.erros.slice(0, 3).join(' | '));

  await nav.close();
  return t.resultado();
}
