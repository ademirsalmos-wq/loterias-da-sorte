#!/usr/bin/env node
/**
 * rodar.mjs — sobe o servidor, roda todos os testes, mostra o placar.
 *
 *     node testes/rodar.mjs              roda tudo
 *     node testes/rodar.mjs matematica   roda só um arquivo
 *
 * Sai com código 1 se qualquer verificação falhar, para servir de portão
 * antes de publicar.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PORTA, RAIZ } from './ajuda.mjs';
import * as ajuda from './ajuda.mjs';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * Servidor estático mínimo. Existe porque ES Modules não carregam por
 * `file://` — o app inteiro depende disso, em teste e em produção.
 */
function subirServidor() {
  const s = http.createServer((req, res) => {
    const limpo = decodeURIComponent(req.url.split('?')[0]);
    const alvo = path.join(RAIZ, limpo === '/' ? 'index.html' : limpo);
    /* Nunca servir fora da raiz do projeto, nem em teste. */
    if (!alvo.startsWith(RAIZ)) { res.writeHead(403).end(); return; }
    fs.readFile(alvo, (err, dados) => {
      if (err) { res.writeHead(404).end('não achei'); return; }
      res.writeHead(200, {
        'content-type': TIPOS[path.extname(alvo)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(dados);
    });
  });
  return new Promise((ok) => s.listen(PORTA, () => ok(s)));
}

const ARQUIVOS = fs.readdirSync(AQUI)
  .filter((f) => f.endsWith('.teste.mjs'))
  .sort();

const filtro = process.argv[2];
const aRodar = filtro
  ? ARQUIVOS.filter((f) => f.includes(filtro))
  : ARQUIVOS;

if (!aRodar.length) {
  console.error(`Nenhum teste combina com "${filtro}". Existem: ${ARQUIVOS.join(', ')}`);
  process.exit(1);
}

const servidor = await subirServidor();
console.log(`servidor em http://localhost:${PORTA}\n`);

const t0 = Date.now();
const resultados = [];

for (const arq of aRodar) {
  console.log(`\n▸ ${arq}`);
  try {
    /* `pathToFileURL` e não o caminho cru: no Windows, `path.join` devolve
       algo como C:\...\testes\espaco.teste.mjs, e o carregador de ES Modules
       do Node recusa isso com "Only URLs with a scheme in: file, data, and
       node are supported. Received protocol 'c:'" — ele lê o C: como se
       fosse um protocolo. No Linux e no macOS o caminho cru passa, que é
       por que este defeito atravessou a suíte inteira sem aparecer: ela
       nunca tinha rodado no Windows, justamente a máquina onde o Ademir
       desenvolve. Teste que não roda na máquina de quem programa é teste
       que não existe. */
    const mod = await import(pathToFileURL(path.join(AQUI, arq)).href);
    resultados.push(await mod.default());
  } catch (e) {
    const linha = e.message.split('\n')[0];
    console.log(`  ✗ o arquivo estourou: ${linha}`);
    /* Preserva o que já tinha passado antes do estouro. */
    const parcial = ajuda.ultimoPlacar?.resultado();
    resultados.push(parcial
      ? { ...parcial, falhas: [...parcial.falhas, `estourou: ${linha}`] }
      : { nome: arq, ok: 0, falhas: [`estourou: ${linha}`] });
  }
}

servidor.close();

/* ---------------------------- placar ---------------------------- */

const totalOk = resultados.reduce((a, r) => a + r.ok, 0);
const todasFalhas = resultados.flatMap((r) => r.falhas.map((f) => `${r.nome}: ${f}`));

console.log('\n' + '─'.repeat(64));
for (const r of resultados) {
  const marca = r.falhas.length ? '✗' : '·';
  console.log(`${marca} ${r.nome.padEnd(20)} ${r.ok} passaram` +
              (r.falhas.length ? `, ${r.falhas.length} FALHARAM` : ''));
}
console.log('─'.repeat(64));
console.log(`${totalOk} verificações passaram, ${todasFalhas.length} falharam ` +
            `em ${((Date.now() - t0) / 1000).toFixed(0)}s`);

if (todasFalhas.length) {
  console.log('\nFalhas:');
  for (const f of todasFalhas) console.log(`  ✗ ${f}`);
  process.exit(1);
}