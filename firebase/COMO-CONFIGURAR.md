# Ligando o Firebase — passo a passo

São cinco passos, uma vez só. Depois disso o celular entra com e-mail e
senha, sem depender de e-mail nenhum.

Se algo der errado no meio, a própria tela do app diz o que fazer — as
mensagens de erro do Firebase foram traduzidas e apontam a tela exata do
console.

---

## 1. Criar o projeto

[console.firebase.google.com](https://console.firebase.google.com) →
**Adicionar projeto**.

- Dê um nome (ex.: `loterias-da-sorte`).
- **Google Analytics: pode desligar.** Não usamos, e desligar evita ter
  que criar uma conta do Analytics junto.

Diferente do Supabase, aqui **não há limite documentado de projetos** no
plano gratuito, e **projeto não é pausado por inatividade**. Foram esses
os dois motivos da mudança.

## 2. Ligar o login por e-mail e senha

**Authentication** → **Vamos começar** → em *Provedores de login* escolha
**E-mail/senha** → ative a primeira chave → **Salvar**.

> Deixe **"Link de e-mail (login sem senha)"** desligado. Não usamos, e
> ligar só aumenta a superfície de coisa que pode falhar.

Não existe aqui o "Confirm email" que atrapalhou no Supabase: com
e-mail/senha o cadastro já entra direto. Se um dia você quiser exigir
verificação de e-mail — o que faz sentido se o sistema virar produto —
isso passa a ser um passo extra a implementar, não uma chave a desligar.

## 3. Criar o banco

**Firestore Database** → **Criar banco de dados**.

- Modo: **Nativo** (é o padrão; o outro, Datastore, não serve).
- Local: escolha algo próximo, como `southamerica-east1` (São Paulo).
  A escolha é definitiva e não muda o endereço que o app usa.
- Quando perguntar as regras iniciais, pode escolher **modo bloqueado** —
  o passo 4 substitui tudo mesmo.

**Este passo é fácil de achar que já está feito e não estar.** Se o banco
nunca foi criado, a API do Firestore responde **403**, e não 404 — o mesmo
código que ela usa quando as regras recusam. Ou seja: "banco inexistente" e
"regras bloqueando" são indistinguíveis de fora, e é comum concluir a
segunda quando o caso é a primeira.

O jeito de saber é olhar a tela: se ela mostra o botão **Criar banco de
dados**, o banco não existe. Se mostra as abas **Dados · Regras · Índices**,
existe.

## 4. Publicar as regras de segurança

**Firestore Database** → aba **Regras** → apague o que estiver lá → cole
o conteúdo de **`firebase/firestore.rules`** → **Publicar**.

**Este passo não é opcional.** A chave que vai no código é pública por
desenho; são estas regras que impedem outra pessoa de ler seus bilhetes.

Confira na aba **Playground**, como está descrito no fim do arquivo de
regras: uma leitura no seu próprio `uid` deve passar, e no `uid` de
outra pessoa deve ser negada.

## 5. Copiar as duas chaves para o código

**⚙ (engrenagem ao lado de "Visão geral do projeto")** → **Configurações
do projeto** → aba **Geral** → role até **Seus aplicativos**.

Se ainda não houver um app da Web, clique no ícone **`</>`**, dê um
apelido e registre. **Ignore todo o código que a tela sugerir** e o
convite para instalar o SDK — este sistema fala com o Firebase por REST
puro, sem dependência nenhuma.

Do bloco de configuração que aparece, copie dois valores para
**`js/configuracao.js`**:

```js
export const FIREBASE = {
  apiKey: 'AIzaSy...',          // apiKey
  projectId: 'loterias-da-sorte', // projectId
};
```

Publique, abra o app em **Configurações → Sua conta**, e use **Criar
conta**. No celular, **Entrar** com o mesmo e-mail e a mesma senha.

---

## Sobre a chave ficar visível no repositório

Ela pode. A `apiKey` da Web do Firebase não é uma senha: ela identifica o
projeto, não autoriza nada sozinha. Quem decide o que pode ser lido e
escrito são as regras do passo 4, que exigem um usuário autenticado e só
devolvem os dados dele. É o mesmo desenho da chave anônima do Supabase.

O que **nunca** pode ir para o repositório é uma credencial de servidor:
o JSON de conta de serviço (aquele com `private_key`) ou um token do
Admin SDK. Esses passam por cima das regras.

**Endurecimento opcional**, se você quiser: no
[console do Google Cloud](https://console.cloud.google.com/apis/credentials),
a chave pode ser restrita a rodar só a partir do seu domínio
(`loterias-da-sorte.netlify.app`) e só nas APIs Identity Toolkit e
Firestore. Não é necessário para a segurança dos dados — é só para evitar
que alguém use a sua cota.

---

## Cotas do plano gratuito (Spark)

| | limite |
|---|---|
| Armazenamento | 1 GiB |
| Leituras | 50 mil por dia |
| Escritas | 20 mil por dia |
| Contas ativas | 50 mil por mês |

Para dimensionar: cada sincronização lê um documento por bilhete. Com
500 bilhetes e dez sincronizações por dia, dá 5 mil leituras — um décimo
do limite. Não há risco realista de estourar num uso pessoal.

---

## E o Supabase antigo?

Os bilhetes que estavam lá **não vêm sozinhos**. Se houver algo que você
queira preservar, o caminho mais simples é, ainda com a versão antiga no
ar: **Configurações → Seus dados → Baixar backup**, e depois **Restaurar
backup** já na versão nova, antes de sincronizar pela primeira vez.

O arquivo `supabase/schema.sql` continua no repositório apenas como
registro histórico. Pode apagar a tabela `loterias_bilhetes` do projeto
emprestado quando tiver certeza de que não precisa mais dela.
