-- ===================================================================
-- Loterias da Sorte — schema para a sincronização entre aparelhos.
--
-- Rode isto uma vez no SQL Editor do seu projeto Supabase.
-- Depois é só preencher URL e chave anônima em Configurações no app.
--
-- NÃO PRECISA DE UM PROJETO NOVO. O limite do plano free é de 500 MB de
-- banco, não de tabelas — e estes bilhetes ocupam alguns kilobytes. Dá para
-- rodar isto dentro de um projeto que você já usa para outra coisa.
--
-- Por isso a tabela se chama `loterias_bilhetes`, com prefixo: para conviver
-- sem colidir com as tabelas da aplicação que já mora ali.
--
-- O QUE NÃO ESTÁ AQUI, DE PROPÓSITO: o histórico de concursos. São ~10 mil
-- registros públicos, iguais para todos os usuários, que cada aparelho
-- busca da Caixa em segundos. Guardá-los aqui só gastaria cota de banco e
-- de transferência sem benefício nenhum.
-- ===================================================================

create table if not exists public.loterias_bilhetes (
  -- UUID gerado no aparelho, não sequencial: com dois aparelhos, dois
  -- contadores independentes gerariam o mesmo id e um sobrescreveria o
  -- outro em silêncio.
  id            uuid primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,

  loteria       text not null check (loteria in ('lotofacil','megasena','lotomania')),
  dezenas       smallint[] not null,
  concurso      integer,

  origem        text,           -- 'gerador' | 'fechamento' | 'manual'
  grupo         text,           -- agrupa os bilhetes de um mesmo lote
  rotulo        text,

  custo         numeric(10,2) not null default 0,
  conferido     boolean not null default false,
  acertos       smallint,
  premiado      boolean not null default false,
  premio        numeric(12,2) not null default 0,

  -- Apagar é marcar, não sumir: sem esta lápide, o aparelho que não viu a
  -- exclusão devolveria o bilhete na sincronização seguinte.
  removido      boolean not null default false,

  criado_em     timestamptz,
  -- É por esta data que o conflito entre aparelhos se resolve: vence a
  -- alteração mais recente, em qualquer direção.
  atualizado_em timestamptz not null default now()
);

create index if not exists loterias_bilhetes_user_idx
  on public.loterias_bilhetes (user_id, loteria);

-- A sincronização pergunta "o que mudou depois de X?" a cada rodada.
create index if not exists loterias_bilhetes_atualizado_idx
  on public.loterias_bilhetes (user_id, atualizado_em desc);

-- -------------------------------------------------------------------
-- Segurança
--
-- A chave anônima fica visível no navegador — é o desenho do Supabase, e
-- só é seguro por causa do RLS. Sem as políticas abaixo, essa chave daria
-- a qualquer pessoa acesso de leitura E ESCRITA à tabela inteira.
-- -------------------------------------------------------------------

alter table public.loterias_bilhetes enable row level security;

drop policy if exists "bilhetes proprios: ler"     on public.loterias_bilhetes;
drop policy if exists "bilhetes proprios: inserir" on public.loterias_bilhetes;
drop policy if exists "bilhetes proprios: alterar" on public.loterias_bilhetes;
drop policy if exists "bilhetes proprios: apagar"  on public.loterias_bilhetes;

create policy "bilhetes proprios: ler"
  on public.loterias_bilhetes for select
  using (auth.uid() = user_id);

create policy "bilhetes proprios: inserir"
  on public.loterias_bilhetes for insert
  with check (auth.uid() = user_id);

create policy "bilhetes proprios: alterar"
  on public.loterias_bilhetes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "bilhetes proprios: apagar"
  on public.loterias_bilhetes for delete
  using (auth.uid() = user_id);

-- -------------------------------------------------------------------
-- Conferência rápida depois de rodar (deve devolver 4 linhas):
--
--   select policyname from pg_policies where tablename = 'loterias_bilhetes';
--
-- E o RLS precisa estar ligado:
--
--   select relrowsecurity from pg_class where relname = 'loterias_bilhetes';
--   -- esperado: t
-- -------------------------------------------------------------------
