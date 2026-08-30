/**
 * Conta, sincronização e backup — tudo o que pode perder dados.
 *
 * O Firebase é simulado (`firebase-falso.mjs`), mas fiel nos pontos em
 * que a API de verdade é traiçoeira: inteiro trafega como string, a
 * renovação de token mora noutro host e responde em snake_case, a
 * listagem pagina devolvendo menos do que se pediu, e as regras de
 * segurança são de fato aplicadas.
 */

import {
  abrirPagina, placar, chromium, irPara, semearBilhetes, contarBilhetes,
  fs, path, RAIZ,
} from './ajuda.mjs';
import { instalarFirebaseFalso } from './firebase-falso.mjs';

const JOGOS = [
  [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],
  [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16],
];

export default async function rodar() {
  const t = placar('Conta e dados');
  const nav = await chromium.launch();

  /* Um servidor só, compartilhado pelos dois "aparelhos". */
  const servidor = {};
  servidor.roteador = instalarFirebaseFalso(servidor);
  const ponte = async (url, init) => {
    const r = await servidor.roteador(url, init);
    return { status: r.status, corpo: await r.text() };
  };

  const pc = await abrirPagina(nav, { firebase: ponte, baixar: true });

  /* ---------------- sem conta, o sistema funciona ---------------- */

  await semearBilhetes(pc, 'lotofacil', JOGOS, { concurso: 10, origem: 'teste' });
  t.confere('salva bilhetes sem estar logado', (await contarBilhetes(pc)) === 2);
  t.confere('nada sobe para a nuvem sem conta', servidor.docs.size === 0,
    `${servidor.docs.size} documentos no servidor`);

  const topo = await pc.evaluate(() => ({
    entrar: !document.querySelector('#btnAbrirLogin').hidden,
    chip: !document.querySelector('#chipConta').hidden,
  }));
  t.confere('deslogado: o topo mostra "Entrar"', topo.entrar && !topo.chip);

  /* ---------------- janela de login ---------------- */

  await pc.click('#btnAbrirLogin');
  await pc.waitForTimeout(700);
  const aviso = await pc.$eval('#avisoLocal', (e) => e.innerText);
  t.confere('a janela diz quantos bilhetes estão só neste aparelho',
    /2 bilhete/.test(aviso), aviso.slice(0, 60));

  await pc.keyboard.press('Escape');
  await pc.waitForTimeout(400);
  t.confere('Esc fecha a janela',
    await pc.$eval('#modalLogin', (e) => e.hidden));

  /* ---------------- validações que não chegam ao servidor ---------- */

  const entrar = async (modo, email, senha) => {
    if (await pc.$eval('#modalLogin', (e) => e.hidden)) {
      await pc.click('#btnAbrirLogin');
      await pc.waitForTimeout(600);
    }
    await pc.click(`.aba-login[data-modo=${modo}]`);
    await pc.fill('#nuvemEmail', email);
    await pc.fill('#nuvemSenha', senha);
    await pc.click('#btnConta');
    await pc.waitForTimeout(2500);
    return pc.evaluate(() => {
      const r = document.querySelector('#recadoLogin');
      return {
        recado: r.hidden ? '' : r.innerText.replace(/\s+/g, ' ').trim(),
        logado: !document.querySelector('#chipConta').hidden,
      };
    });
  };

  let e = await entrar('criar', 'semarroba', 'senhaboa123');
  t.confere('e-mail inválido é barrado no navegador', /e-mail válido/i.test(e.recado));
  e = await entrar('criar', 'ademir@exemplo.com', 'abc');
  t.confere('senha curta é barrada antes de chamar o servidor',
    /8 caracteres/.test(e.recado) && servidor.usuarios.size === 0);

  /* ---------------- criar conta: o que era local sobe ---------------- */

  e = await entrar('criar', 'ademir@exemplo.com', 'senhaboa123');
  t.confere('criar conta conecta e fecha a janela', e.logado);
  t.confere('os bilhetes que estavam só no aparelho SUBIRAM',
    servidor.docs.size === 2, `${servidor.docs.size} no servidor`);

  /* ---------------- segundo aparelho, mesma conta ---------------- */

  const cel = await abrirPagina(nav, { firebase: ponte });
  await cel.click('#btnAbrirLogin');
  await cel.waitForTimeout(600);
  await cel.click('.aba-login[data-modo=entrar]');
  await cel.fill('#nuvemEmail', 'ademir@exemplo.com');
  await cel.fill('#nuvemSenha', 'senhaboa123');
  await cel.click('#btnConta');
  await cel.waitForTimeout(3500);
  t.confere('o segundo aparelho entra com a mesma senha, sem e-mail nenhum',
    !(await cel.evaluate(() => document.querySelector('#chipConta').hidden)) &&
    servidor.emails === 0,
    `${servidor.emails} e-mails enviados`);
  t.confere('os bilhetes chegaram no segundo aparelho',
    (await contarBilhetes(cel)) === 2, `${await contarBilhetes(cel)}`);

  /* ---------------- a exclusão viaja ---------------- */

  await cel.evaluate(async () => {
    const { DB } = await import('/js/db.js');
    const bs = await DB.listarBilhetes('lotofacil');
    await DB.apagarBilhete(bs[0].id);
  });
  await irPara(cel, 'config');
  await cel.click('#btnSincronizarNuvem');
  await cel.waitForTimeout(2500);
  await irPara(pc, 'config');
  await pc.click('#btnSincronizarNuvem');
  await pc.waitForTimeout(2500);
  t.confere('apagar num aparelho apaga no outro',
    (await contarBilhetes(pc)) === 1, `${await contarBilhetes(pc)} restante(s)`);

  /* ---------------- senha errada, conta repetida ---------------- */

  await pc.evaluate(() => { window.confirm = () => true; });
  await pc.click('#btnSairNuvem');
  await pc.waitForTimeout(1500);
  t.confere('sair não apaga os dados locais', (await contarBilhetes(pc)) === 1);

  e = await entrar('entrar', 'ademir@exemplo.com', 'errada999');
  t.confere('senha errada avisa, e não entra',
    /não conferem/i.test(e.recado) && !e.logado, e.recado.slice(0, 50));
  e = await entrar('criar', 'ademir@exemplo.com', 'outrasenha1');
  t.confere('e-mail já cadastrado avisa', /Já existe conta/i.test(e.recado));
  e = await entrar('entrar', 'ademir@exemplo.com', 'senhaboa123');
  t.confere('senha certa entra', e.logado);

  /* ---------------- trocar a senha não derruba a sessão ------------ */

  await irPara(pc, 'config');
  await pc.click('#btnMudarSenha');
  await pc.waitForTimeout(400);
  await pc.fill('#senhaNova', 'senhaNova98765');
  await pc.click('#btnTrocarSenha');
  await pc.waitForTimeout(2500);
  await pc.click('#btnSincronizarNuvem');
  await pc.waitForTimeout(2500);
  t.confere('trocar a senha mantém a sessão viva',
    servidor.usuarios.get('ademir@exemplo.com').senha === 'senhaNova98765' &&
    !(await pc.evaluate(() => document.querySelector('#chipConta').hidden)));

  /* ---------------- backup: não vaza credencial, não duplica -------- */

  const destino = path.join(RAIZ, 'testes', '.backup-temporario.json');
  const [download] = await Promise.all([
    pc.waitForEvent('download'),
    pc.click('#btnBackup'),
  ]);
  await download.saveAs(destino);
  const texto = fs.readFileSync(destino, 'utf8');
  const dump = JSON.parse(texto);

  const sessao = await pc.evaluate(async () =>
    (await (await import('/js/db.js')).DB.getConfig('nuvem:sessao')));
  t.confere('o backup NÃO leva o refresh token',
    Boolean(sessao?.refreshToken) && !texto.includes(sessao.refreshToken));
  t.confere('o backup NÃO leva a sessão inteira',
    !('nuvem:sessao' in (dump.configs ?? {})),
    `configs no arquivo: ${Object.keys(dump.configs ?? {}).join(', ') || '(nenhuma)'}`);
  t.confere('os bilhetes vão com id', dump.bilhetes.every((b) => typeof b.id === 'string'));
  t.confere('o backup inclui a lápide, para não ressuscitar exclusões',
    dump.bilhetes.some((b) => b.removido));

  const antes = await contarBilhetes(pc);
  await pc.setInputFiles('#arquivoBackup', destino);
  await pc.waitForTimeout(2500);
  t.confere('restaurar no MESMO aparelho não duplica nada',
    (await contarBilhetes(pc)) === antes, `${antes} → ${await contarBilhetes(pc)}`);

  const lixo = path.join(RAIZ, 'testes', '.nao-e-backup.json');
  fs.writeFileSync(lixo, '{"qualquer":"coisa"}');
  await pc.setInputFiles('#arquivoBackup', lixo);
  await pc.waitForTimeout(1500);
  t.confere('arquivo que não é backup é recusado, com aviso',
    /não é um backup/i.test(await pc.$eval('#toast', (el) => el.textContent)));

  /* recupera de banco zerado */
  await pc.evaluate(async () => {
    const req = indexedDB.open('loterias-da-sorte');
    await new Promise((ok) => {
      req.onsuccess = () => {
        const tx = req.result.transaction('bilhetes', 'readwrite');
        tx.objectStore('bilhetes').clear();
        tx.oncomplete = ok;
      };
    });
  });
  await pc.setInputFiles('#arquivoBackup', destino);
  await pc.waitForTimeout(2500);
  t.confere('restaurar recupera tudo depois de perder o banco',
    (await contarBilhetes(pc)) === antes, `${await contarBilhetes(pc)}`);

  for (const f of [destino, lixo]) fs.rmSync(f, { force: true });

  t.confere('nenhum erro de página',
    pc.erros.length === 0 && cel.erros.length === 0,
    [...pc.erros, ...cel.erros].join(' | '));
  await nav.close();
  return t.resultado();
}
