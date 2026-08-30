# Testes

```bash
npm install --no-save playwright   # uma vez
npx playwright install chromium    # uma vez

node testes/rodar.mjs              # tudo
node testes/rodar.mjs interface    # só um arquivo
```

O runner sobe um servidor estático próprio na porta 8123, abre um Chromium
sem janela, roda tudo e sai com código 1 se algo falhar. Não precisa de
internet, não toca no Firebase de verdade e não usa a API da Caixa.

---

## Por que estes testes existem assim

**Eles clicam.** Foi a lição mais cara deste projeto. Apagar um bilhete
ficou quebrado por semanas: os ids migraram de número para UUID e três
handlers continuaram fazendo `Number(dataset.id)`. Como `Number('7eb9…')`
é `NaN`, a busca não achava nada e a função retornava — sem erro no
console, sem aviso na tela. A camada de dados passava em todos os testes,
porque **os testes chamavam as funções, nunca os botões**. Aqui, sempre que
existe botão, o teste clica no botão e depois pergunta se o estado mudou.

**Eles conferem a matemática por fora.** Um erro de conta não dá erro: dá
número errado com cara de certo. Então o fechamento é verificado por força
bruta em todos os cenários possíveis, a conferência é refeita à mão contra
um resultado real da Caixa, e a contabilidade da Retrospectiva é
recalculada do zero a partir dos bilhetes e do histórico.

**O histórico é sintético e determinístico.** Um gerador com semente fixa
produz sempre os mesmos sorteios, então uma falha é sempre reproduzível e
o repositório não carrega um dump de milhares de concursos. Onde o teste
precisa de um resultado *real* — conferência, valores de prêmio — ele traz
o concurso escrito à mão, conferido contra a API oficial.

**O Firebase é simulado, mas fiel onde a API é traiçoeira.**
`firebase-falso.mjs` reproduz de propósito as três coisas que já causaram
bug silencioso: inteiro que trafega como *string*, renovação de token que
mora em outro host e responde em `snake_case`, e listagem que pagina
devolvendo menos do que se pediu. Também aplica as regras de segurança, e
recusa acesso a dados de outro `uid`.

---

## Os arquivos

| arquivo | o que cobre |
|---|---|
| `matematica.teste.mjs` | garantia dos fechamentos por força bruta, conferência em todas as faixas (inclusive o zero da Lotomania), contabilidade recalculada por fora, validade dos bilhetes gerados |
| `interface.teste.mjs` | as 8 abas em duas larguras, apagar e editar pela tabela, gerador e fechamento pelos botões, travamento com a aba escondida, volante em telas estreitas, troca de modalidade |
| `conta.teste.mjs` | usar sem conta, entrar, dois aparelhos na mesma conta, exclusão que viaja, senha errada, troca de senha, backup que não vaza credencial e restore que não duplica |

`ajuda.mjs` tem o encanamento: servidor, fixtures, atalhos de navegação.
`rodar.mjs` é o runner.

---

## Ao mexer no código

Rode antes de publicar. Cada deploy custa crédito do Netlify, e a suíte
inteira leva menos de dois minutos — sai muito mais barato descobrir aqui.

Se você **corrigir um bug**, escreva a verificação que teria pego. Quase
toda linha destes arquivos nasceu de um defeito real que passou por
alguma revisão antes.

Uma armadilha do próprio teste, para não repetir: elementos que se
refazem a cada clique (o volante do fechamento, as linhas da tabela)
ficam obsoletos se você guardar o handle. Selecione pela posição a cada
vez — `#volanteFechamento .dezena:nth-child(3)` — em vez de guardar a
lista.
