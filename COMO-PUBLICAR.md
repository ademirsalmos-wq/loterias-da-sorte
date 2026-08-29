# Como publicar esta versão

Um deploy só. Suba **tudo de uma vez** — o Netlify cobra por publicação, não
por arquivo, então mandar os 25 arquivos juntos custa o mesmo que mandar um.

## 1. Subir no GitHub

No seu repositório, clique **Add file → Upload files** e arraste a pasta
inteira que veio no zip. O GitHub aceita pastas arrastadas e mantém a
estrutura sozinho.

Confira depois do upload que a árvore ficou assim — **os arquivos `.js`
precisam estar dentro de `js/`, não na raiz**:

```
index.html
manifest.webmanifest
sw.js
netlify.toml
COMO-PUBLICAR.md
README.md
css/style.css
icones/           (4 imagens — pasta NOVA)
js/               (13 arquivos)
supabase/schema.sql
```

Depois desça a página, escreva algo como `PWA, sincronização e aba
Resultados` no campo pequeno de cima e clique **Commit changes**.

> O campo grande embaixo é a *descrição* do commit. Não é para colar código
> nele — é só texto livre, e pode ficar vazio.

O Netlify percebe o commit e publica sozinho em 1–2 minutos.

## 2. Ligar a sincronização (uma vez só, no PC)

Você já rodou o `supabase/schema.sql` e pegou a URL e a chave anônima.
Agora, no app publicado:

1. Aba **Configurações → Sincronizar entre aparelhos**
2. Cole a **URL do projeto** e a **chave anônima (anon public)**
3. Digite seu e-mail e clique em **Enviar link**
4. Abra o e-mail **no mesmo aparelho** e clique no link — ele volta para o
   app já conectado

No celular, repita os passos 1–4 com a mesma URL, a mesma chave e o mesmo
e-mail. A partir daí os bilhetes andam juntos nos dois.

## 3. Instalar no celular

Abra o site no Chrome do Android e aceite o convite **Instalar** que aparece
na faixa embaixo (ou menu ⋮ → *Instalar aplicativo*).

No iPhone é manual: Safari → botão de compartilhar → **Adicionar à Tela de
Início**. O iOS não mostra convite automático; é limitação da Apple, não do
app.

## 4. Conferir que deu certo

Na aba **Painel**, o boletim deve dizer que a base está em dia e mostrar o
número do último concurso de cada modalidade. Se disser que faltam
concursos, clique em **Atualizar agora** — ele preenche os buracos sozinho.

Na aba **Resultados**, abra a Lotomania no celular: as 10 colunas do volante
precisam caber na tela, sem empurrar a página para o lado.
