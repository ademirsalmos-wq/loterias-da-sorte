# Loterias da Sorte

Sistema de gestão de apostas para Lotofácil, Mega-Sena e Lotomania.
HTML + CSS + JavaScript puro (sem framework, sem build), IndexedDB como banco.

---

## O que este sistema faz — e o que ele não faz

Isso precisa ficar claro antes de qualquer coisa, porque é o que separa este
sistema dos milhares de "geradores da sorte" que existem por aí.

### Não faz

**Não aumenta a probabilidade de um jogo ser sorteado.** Sorteios são eventos
independentes: a bola não lembra dos concursos anteriores. Uma dezena
"atrasada" há 12 concursos tem exatamente a mesma chance de sair que uma que
saiu ontem. Qualquer sistema que prometa o contrário está vendendo ilusão.

Na Mega-Sena, um jogo de 6 dezenas tem 1 chance em 50.063.860. Com filtro
estatístico, sem filtro, com dezenas quentes, com dezenas frias: 1 em
50.063.860. Sempre.

### Faz

1. **Fechamentos com garantia matemática verificada.**
   Esta é a única garantia real do sistema, e ela é um teorema.
   "Se T das dezenas sorteadas estiverem entre as N que você escolheu, pelo
   menos um destes bilhetes faz G pontos." O sistema monta o conjunto e depois
   **testa todos os cenários possíveis, um por um**, para provar. O número que
   aparece na tela é o verificado, nunca o prometido.

   Junto com a garantia, o sistema mostra **a probabilidade de o cenário
   acontecer** — a informação que quase nenhum sistema comercial exibe, e que é
   justamente a que decide se vale a pena.

2. **Fuga de padrões populares.**
   Não muda a chance de ganhar. Muda **quanto você leva se ganhar**, porque o
   prêmio é rateado entre os acertadores. Jogos formados só por datas de
   aniversário (1 a 31), sequências como 1-2-3-4-5-6, progressões aritméticas e
   linhas inteiras do volante são marcados por milhares de pessoas. Ganhar com
   um desses significa dividir.

3. **Filtros estatísticos descritivos.**
   Faixas de soma, pares/ímpares, primos, moldura e repetidas, calibradas para
   cobrir ~90% dos concursos já realizados. Servem para concentrar o volume em
   combinações com perfil parecido com o que costuma ser sorteado — não para
   prever nada.

4. **Varredura retrospectiva (backtest).**
   Passa os seus jogos por todos os concursos já realizados e conta como eles
   teriam se saído: em quais concursos premiariam, em que faixa, quanto teriam
   custado e voltado, qual a maior seca. É medição do passado — e serve para
   **calibrar expectativa** e **comparar estratégias** sob condições idênticas,
   nunca para prever.

   Inclui um comparativo contra jogos aleatórios de mesmo custo. Vale avisar:
   esse comparativo costuma contrariar o que se vende sobre fechamentos, e o
   sistema mostra o resultado como ele é (veja a seção abaixo).

5. **O ciclo semanal, automatizado.**
   Ao abrir, o sistema busca os resultados novos, confere os seus bilhetes e
   mostra um **boletim** com o que aconteceu — que fica na tela até você dizer
   que viu. O Painel também responde de relance "eu já joguei essa semana?",
   listando os bilhetes que estão valendo para os próximos sorteios.

   O único passo que continua sendo seu é o único que só você sabe: quanto o
   prêmio pagou de verdade.

6. **Contabilidade honesta.**
   Quanto você gastou, quanto voltou, saldo, ROI, histórico por concurso. Na
   prática, é a parte que mais economiza dinheiro.

---

## O que a varredura revelou sobre fechamentos

Vale registrar, porque é contraintuitivo e o sistema não esconde.

Rodando um fechamento de 18 dezenas contra milhares de concursos, e comparando
com bilhetes aleatórios de **mesma quantidade, mesmo tamanho e mesmo custo**:

| | fechamento (18 dezenas) | aleatório de mesmo custo |
|---|---|---|
| concursos que premiaram algo | ~52% | ~94% |
| faixas de 11 e 12 pontos | menos | bem mais |
| maior seca sem prêmio | maior | menor |

O motivo é simples: bilhetes tirados de um grupo pequeno de dezenas se parecem
muito entre si, então **erram juntos**. Bilhetes espalhados por todo o volante
cobrem mais terreno e batem as faixas pequenas com muito mais frequência.

Isso **não** significa que fechamento é ruim. Significa que ele é uma troca:
você abre mão de prêmios pequenos frequentes em troca de uma garantia — quando
as dezenas sorteadas caem dentro do seu grupo, você não faz um prêmio, faz
vários de uma vez.

Qual das duas estratégias serve depende do objetivo, e o sistema não decide isso
por você: ele mede as duas e mostra os números lado a lado.

---

## Instalação

Não tem build, não tem dependência, não tem `npm install`.

```bash
# na pasta do projeto
python -m http.server 8000
```

Abra `http://localhost:8000`.

> **Precisa de um servidor.** O sistema usa ES Modules (`<script type="module">`),
> que o navegador bloqueia em `file://`. Abrir o `index.html` com dois cliques
> não funciona — use o `http.server` acima, o Live Server do VS Code, ou publique.

### Publicar no Netlify

Arraste a pasta inteira para o Netlify Drop, ou conecte o repositório.
Não há comando de build; o diretório de publicação é a raiz.

---

## Estrutura

```
index.html          uma página, sete abas
css/style.css       folha única
js/
  config.js         definição das loterias e tabela de prêmios
                    (adicionar uma modalidade nova = uma entrada aqui)
  db.js             persistência — IndexedDB, com adaptador Supabase pronto
  api.js            importação dos resultados oficiais
  stats.js          motor estatístico
  generator.js      gerador com filtros + pontuação de popularidade
  wheel.js          fechamentos: cobertura, verificação e probabilidade
  backtest.js       varredura retrospectiva + comparativo com aleatório
  rotina.js         o ciclo semanal + o detector de base defasada
  tickets.js        custos, conferência e balanço
  app.js            interface
  retro-ui.js       a aba Retrospectiva (separada para não inchar o app.js)
netlify/edge-functions/
  loterias.js       ponte para a API oficial da Caixa (resolve o CORS)
supabase/
  schema.sql        só é necessário se você ligar a sincronização em nuvem
```

---

## De onde vêm os resultados

### A lição que custou caro

A primeira versão usava um espelho público em JSON que se anunciava como
"atualizado todos os dias com Cron Job via GitHub Actions". Era verdade um dia.

Quando fomos usar de verdade, ele estava parado no **concurso 3246** da
Lotofácil, enquanto a Caixa já ia no **3773** — mais de 500 concursos e quase
dois anos de atraso. Pior: **o sistema consumiu esse dado velho sem reclamar uma
única vez**. A falha grave não foi a fonte morrer; foi ninguém perceber.

Duas correções vieram daí.

### 1. A fonte principal passou a ser a Caixa

A API oficial (`servicebus2.caixa.gov.br/portaldeloterias/api/…`) não envia o
cabeçalho `Access-Control-Allow-Origin`, então o navegador bloqueia a resposta
antes do JavaScript ler qualquer coisa. Não é limitação do nosso código, é
política do servidor deles — a única saída é buscar o dado do lado do servidor.

É o que faz `netlify/edge-functions/loterias.js`.

**Por que Edge Function e não Function comum:** no plano free do Netlify, as
Functions comuns consomem do bolo de 300 créditos/mês que também paga banda e
deploys — e quando esse bolo acaba, **o site sai do ar**. Edge Functions têm
1.000.000 de invocações/mês em pool separado. O uso real aqui é da ordem de
100/mês.

Como publicar:

1. Suba a pasta inteira para o GitHub (o `netlify.toml` e a pasta
   `netlify/edge-functions/` precisam ir junto).
2. No Netlify, conecte o repositório. Não há comando de build; o diretório de
   publicação é a raiz.
3. Publicado, teste em **Configurações → De onde vêm os resultados →
   Testar conexão**. Ele diz em que concurso a Caixa está agora.

Rodando local com `python -m http.server`, o caminho `/api/loterias` não existe
— a Edge Function só roda no Netlify (ou com `netlify dev`). Nesse caso, aponte
o campo para o seu site publicado:
`https://seusite.netlify.app/api/loterias`.

Rotas da função:

```
/api/loterias/lotofacil                 → último concurso
/api/loterias/lotofacil/3773            → um concurso específico
/api/loterias/lotofacil/lote?de=&ate=   → um intervalo (máx. 60 por chamada)
```

Ela só aceita modalidades de uma lista branca — sem isso, seria um proxy aberto
e qualquer um poderia usar o seu domínio para buscar na Caixa.

### 2. O sistema passou a desconfiar da própria base

Toda leitura da base agora passa por `diagnosticarBase()`. Se o último concurso
for velho demais para a cadência da modalidade, aparece um aviso no Painel
dizendo para **não confiar nas conferências** até resolver.

E dado sem data não recebe atestado de saúde: se a base veio de uma fonte que
não informa a data dos concursos (o espelho JSON é assim), o sistema diz que
não consegue verificar, em vez de assumir que está tudo bem. Foi exatamente
essa suposição que deixou 20 meses passarem.

### Reserva e plano B

Se o proxy não responder, o sistema cai no espelho JSON e avisa. E
**Configurações → Import manual** aceita qualquer arquivo que tenha, em cada
linha, o número do concurso seguido das dezenas — que é o formato dos arquivos
de resultado que circulam por aí, incluindo CSV exportado de planilha. Datas no
formato `dd/mm/aaaa` no meio da linha são reconhecidas e aproveitadas.

---

## Banco de dados

O padrão é **IndexedDB**: roda no navegador, funciona offline, custo zero,
nenhuma configuração. Os dados nunca saem da máquina.

Três stores: `historico` (um registro por loteria, com todos os concursos num
blob só — muito mais rápido que 3.500 registros soltos), `bilhetes` e `config`.

### Ligar o Supabase (opcional)

O limite do plano free é de **2 projetos ativos por organização**, não por
conta. Se os seus dois já estão ocupados, crie uma **nova organização free** —
não custa nada e libera o terceiro projeto.

1. Rode `supabase/schema.sql` no SQL Editor do projeto.
2. Preencha `SUPABASE_CONFIG` em `js/db.js`.
3. Troque a última linha do arquivo:
   ```js
   export const DB = SupabaseAdapter;
   ```

O histórico de concursos continua em IndexedDB mesmo com o Supabase ligado: são
dados públicos, pesados e idênticos para todo mundo — não faz sentido ocupar
banco (e cota de transferência) com eles.

---

## Sobre o algoritmo de fechamento

O problema é um *covering design*: dado um conjunto de N dezenas, encontrar o
menor conjunto de bilhetes de J dezenas tal que **todo** subconjunto de T
dezenas compartilhe pelo menos G elementos com algum bilhete.

Encontrar o mínimo absoluto é NP-difícil. O sistema usa um guloso randomizado
com bitmasks (cada dezena vira um bit; a interseção vira um `AND` e um
popcount), poda os bilhetes redundantes e roda várias tentativas ficando com a
menor. Costuma chegar a 1,5×–3× do limite inferior teórico — na prática,
equivalente ao que se vende por aí.

O que ele **não** faz é confiar no próprio resultado: depois de montar, ele
percorre todos os C(N,T) cenários e mede a garantia real. Se o algoritmo não
alcançou o que você pediu, a tela diz isso em vez de fingir que alcançou.

Exemplo verificado: 18 dezenas na Lotofácil, bilhetes de 15, garantindo 14
pontos se as 15 sorteadas caírem no grupo → **33 bilhetes**, R$ 115,50.
Probabilidade de o cenário acontecer: **0,02%** (1 concurso a cada ~4.000).

Esse último número é o que ninguém mostra.

---

## O ciclo semanal

O sistema tinha a matemática certa e o dia a dia errado. O ciclo real de quem
aposta é:

```
gerar → salvar com o concurso → jogar → sai o resultado →
sincronizar → conferir → registrar o prêmio
```

Três desses passos dependiam de o usuário lembrar de clicar em algo. Um sistema
que exige disciplina para funcionar é um sistema que se abandona em três
semanas. Hoje:

- **Sincroniza sozinho** quando a base está com mais de 6 horas. O espelho é
  atualizado uma vez por dia, então isso pega qualquer resultado novo bem antes
  de você sentir falta, sem baixar meio megabyte a cada aba aberta.
- **Confere sozinho** e guarda um boletim persistente do que aconteceu.
- **Nunca trava a abertura.** Sem internet, o sistema abre normalmente com a
  base local e avisa discretamente — em vez de encher a tela de erro por algo
  que você não pode resolver naquele momento.
- **O boletim só fala do que te interessa**: concurso em que você não tinha
  bilhete não vira notícia. E se você passar uma semana fora, os boletins se
  acumulam em vez de o mais novo apagar o anterior.

---

## Prêmios

Só a Lotofácil tem faixas de valor fixo, garantidas por regulamento e
conferidas no portal da Caixa:

| acertos | prêmio |
|---|---|
| 11 pontos | R$ 7,00 |
| 12 pontos | R$ 14,00 |
| 13 pontos | R$ 35,00 |

As faixas de 14 e 15 pontos da Lotofácil, e **todas** as faixas da Mega-Sena e
da Lotomania, são rateio: mudam a cada concurso conforme a arrecadação e o
número de ganhadores. Não existe valor certo para elas.

Por isso a varredura separa o retorno em duas linhas — **garantido** (faixas
fixas, número confiável) e **estimado** (faixas de rateio, com o valor que você
mesmo informou). Se você não informar nada, o retorno das faixas variáveis fica
de fora e o sistema avisa, em vez de inventar um número.

---

## Preços

Lotofácil R$ 3,50 · Mega-Sena R$ 6,00 · Lotomania R$ 3,00
(valores após o reajuste de julho/2025)

A Caixa reajusta de tempos em tempos — ajuste em **Configurações → Preço das
apostas** para o balanço continuar correto.

Marcar mais dezenas que o mínimo custa combinatoriamente: 18 dezenas na
Lotofácil equivalem a C(18,15) = 816 apostas = R$ 2.856. O sistema calcula e
mostra isso antes de você se comprometer.

---

## Aviso final

Loteria é entretenimento com valor esperado negativo — a Caixa devolve em
prêmios menos do que arrecada, por definição. Este sistema serve para você
apostar de forma organizada e consciente, não para ganhar dinheiro de forma
sistemática. Se as apostas estiverem passando do que você pode perder sem
prejuízo, o problema não se resolve com software.
