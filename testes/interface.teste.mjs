/**
 * A interface — clicando nos botões, não chamando as funções.
 *
 * Este arquivo existe por causa de um bug específico: apagar um bilhete
 * ficou quebrado por semanas porque o id virou UUID e o handler ainda
 * fazia `Number(dataset.id)`. A camada de dados passava em todos os
 * testes; o botão não fazia nada, em silêncio. Por isso aqui é sempre
 * `p.click`, e a verificação é sempre "o estado mudou de verdade?".
 */

import {
  abrirPagina, placar, chromium, irPara, trocarLoteria,
  semearBilhetes, contarBilhetes, abrirTabelaDeBilhetes,
} from './ajuda.mjs';

const QUINZE = [
  [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
  [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
  [3,4,5,6,7,8,9,10,11,12,13,14,15,16,17],
];

export default async function rodar() {
  const t = placar('Interface');
  const nav = await chromium.launch();
  const p = await abrirPagina(nav, { tela: { width: 1280, height: 900 } });

  /* ---------------- todas as abas abrem, em duas larguras ------------- */

  const abas = ['painel','resultados','estatisticas','gerador','fechamento',
                'retrospectiva','bilhetes','config'];
  for (const largura of [1280, 390]) {
    await p.setViewportSize({ width: largura, height: 900 });
    for (const a of abas) {
      await irPara(p, a);
      const est = await p.evaluate((id) => {
        const s = document.querySelector('#' + id);
        return {
          visivel: !s.hidden && s.offsetHeight > 40,
          rolaLado: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        };
      }, a);
      t.confere(`aba ${a} em ${largura}px`, est.visivel && !est.rolaLado,
        est.rolaLado ? 'a página rola de lado' : '');
    }
  }
  await p.setViewportSize({ width: 1280, height: 900 });

  /* ---------------- Meus bilhetes: apagar e editar pela tabela -------- */

  await semearBilhetes(p, 'lotofacil', QUINZE, { concurso: 10, origem: 'teste' });
  await abrirTabelaDeBilhetes(p);

  const idNaLinha = await p.$eval('#tabelaBilhetes tbody tr', (e) => e.dataset.id);
  t.confere('o id na linha é UUID em texto, não número',
    typeof idNaLinha === 'string' && Number.isNaN(Number(idNaLinha)),
    idNaLinha);

  const antes = await contarBilhetes(p);
  await p.click('#tabelaBilhetes tbody tr:first-child .apagar');
  await p.waitForTimeout(1200);
  t.confere('botão ✕ apaga de verdade', (await contarBilhetes(p)) === antes - 1,
    `${antes} → ${await contarBilhetes(p)}`);

  const lapide = await p.evaluate(async (id) => {
    const { DB } = await import('/js/db.js');
    const todos = await DB.listarBilhetes(null, true);
    const b = todos.find((x) => x.id === id);
    return { existe: Boolean(b), removido: b?.removido, temData: Boolean(b?.atualizadoEm) };
  }, idNaLinha);
  t.confere('apagar vira lápide com data nova (é o que viaja entre aparelhos)',
    lapide.existe && lapide.removido === true && lapide.temData);

  await p.fill('#tabelaBilhetes tbody tr:first-child .concurso-input', '99');
  await p.dispatchEvent('#tabelaBilhetes tbody tr:first-child .concurso-input', 'change');
  await p.waitForTimeout(1000);
  const conc = await p.evaluate(async () =>
    (await (await import('/js/db.js')).DB.listarBilhetes())[0].concurso);
  t.confere('editar o concurso pela tabela salva', conc === 99, String(conc));

  await p.fill('#tabelaBilhetes tbody tr:first-child .premio-input', '35');
  await p.dispatchEvent('#tabelaBilhetes tbody tr:first-child .premio-input', 'change');
  await p.waitForTimeout(1000);
  const premio = await p.evaluate(async () =>
    (await (await import('/js/db.js')).DB.listarBilhetes())[0].premio);
  t.confere('editar o prêmio pela tabela salva', premio === 35, String(premio));

  await p.click('#btnLimparBilhetes');
  await p.waitForTimeout(1200);
  t.confere('"Apagar todos" apaga todos', (await contarBilhetes(p)) === 0);

  /* ---------------- gerador e fechamento, pelos botões ---------------- */

  await irPara(p, 'gerador');
  await p.click('#btnGerar');
  await p.waitForTimeout(3500);
  const gerados = await p.$$eval('#listaGerados .jogo', (e) => e.length);
  t.confere('botão Gerar produz bilhetes na tela', gerados > 0, `${gerados}`);
  t.confere('o botão volta ao normal',
    (await p.$eval('#btnGerar', (e) => e.textContent.trim())) === 'Gerar bilhetes');

  await p.click('#btnSalvarGerados');
  await p.waitForTimeout(1500);
  t.confere('salvar em Meus bilhetes grava', (await contarBilhetes(p)) === gerados);

  await irPara(p, 'fechamento');
  /* O volante se REFAZ a cada clique, então guardar os elementos numa
     lista os deixa obsoletos no segundo clique. Selecionar pela posição a
     cada vez é o que funciona — e é o que o usuário faz. */
  for (let i = 1; i <= 18; i++) {
    await p.click(`#volanteFechamento .dezena:nth-child(${i})`);
    await p.waitForTimeout(60);
  }
  await p.waitForTimeout(400);
  await p.click('#btnFechar');
  await p.waitForTimeout(4000);
  const fech = await p.$$eval('#fechamento .lista-jogos .jogo', (e) => e.length);
  t.confere('botão Montar fechamento produz bilhetes', fech > 0, `${fech}`);

  /* ---------------- travamento com a aba escondida -------------------- */

  /* O `requestAnimationFrame` não dispara em aba de segundo plano nem com
     a tela do celular apagada. Uma promessa que dependesse só dele ficava
     pendente para sempre e o botão congelava em "Gerando…". */
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
    window.requestAnimationFrame = () => 0;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await irPara(p, 'gerador');
  await p.click('#btnGerar');
  await p.waitForTimeout(5000);
  const rotulo = await p.$eval('#btnGerar', (e) => e.textContent.trim());
  t.confere('gerador destrava mesmo com a aba escondida',
    rotulo === 'Gerar bilhetes', `botão ficou em "${rotulo}"`);

  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => document.querySelector('#cardsPainel')?.children.length > 0,
    null, { timeout: 45000 });

  /* ---------------- volante de resultados em telas estreitas ---------- */

  for (const [largura, lot] of [[320,'lotomania'],[390,'lotomania'],[390,'megasena'],[1280,'lotofacil']]) {
    await p.setViewportSize({ width: largura, height: 800 });
    await trocarLoteria(p, lot);
    await irPara(p, 'resultados');
    const v = await p.evaluate(() => {
      const cels = [...document.querySelectorAll('.cel-volante')];
      const cx = document.querySelector('.rolagem-volante')?.getBoundingClientRect();
      const fora = cx ? cels.filter((c) => {
        const b = c.getBoundingClientRect();
        return b.right > cx.right + 1 || b.left < cx.left - 1;
      }).length : -1;
      const r = cels[0]?.getBoundingClientRect();
      return {
        celulas: cels.length,
        fora,
        quadrada: r ? Math.abs(r.width - r.height) < 1.5 : false,
        rolaLado: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    t.confere(`volante ${lot} em ${largura}px: nada escondido, nada rolando de lado`,
      v.fora === 0 && !v.rolaLado && v.quadrada,
      `${v.celulas} células, ${v.fora} fora da vista`);
  }

  /* ---------------- fechamento não se aplica à Lotomania -------------- */

  await p.setViewportSize({ width: 1280, height: 900 });
  await trocarLoteria(p, 'lotofacil');
  await irPara(p, 'fechamento');
  const lf = await p.$eval('#fechPorJogo', (e) => e.selectedOptions[0]?.textContent ?? '');
  await trocarLoteria(p, 'lotomania');
  const lm = await p.evaluate(() => ({
    parametros: !document.querySelector('#parametrosFechamento').hidden,
    botao: !document.querySelector('#btnFechar').hidden,
    previa: document.querySelector('#previaFechamento').innerText,
  }));
  t.confere('Lotomania esconde os parâmetros de fechamento', !lm.parametros && !lm.botao);
  t.confere('Lotomania NÃO mostra o preço da modalidade anterior',
    !lm.previa.includes(lf.replace(/.*—\s*/, '')), lf);

  await trocarLoteria(p, 'megasena');
  const ms = await p.evaluate(() => ({
    parametros: !document.querySelector('#parametrosFechamento').hidden,
    porJogo: document.querySelector('#fechPorJogo').selectedOptions[0]?.textContent ?? '',
  }));
  t.confere('voltando à Mega-Sena, os parâmetros voltam com os valores dela',
    ms.parametros && /6 dezenas/.test(ms.porJogo), ms.porJogo);

  /* ---------------- concurso alvo acompanha a modalidade -------------- */

  await trocarLoteria(p, 'lotofacil');
  await irPara(p, 'gerador');
  const alvoA = await p.$eval('#concursoAlvoGerador', (e) => e.value);
  await trocarLoteria(p, 'megasena');
  const alvoB = await p.$eval('#concursoAlvoGerador', (e) => e.value);
  t.confere('concurso alvo muda ao trocar de modalidade',
    alvoA !== alvoB && alvoB !== '', `lotofácil ${alvoA} · mega-sena ${alvoB}`);

  t.confere('nenhum erro de página', p.erros.length === 0, p.erros.join(' | '));
  await nav.close();
  return t.resultado();
}
