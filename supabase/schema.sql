-- ===================================================================
-- Loterias da Sorte — schema opcional para sincronização em nuvem.
--
-- Só é necessário se você trocar o adaptador em js/db.js para
-- SupabaseAdapter. Por padrão o sistema roda 100% em IndexedDB e este
-- arquivo pode ser ignorado.
--
-- Lembrete: o limite do plano free é de 2 projetos ATIVOS por
-- ORGANIZAÇÃO. Se os seus dois já estão ocupados, crie uma nova
-- organização free — é gratuito e libera o terceiro projeto.
-- ===================================================================

create table if not exists public.bilhetes (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,

  loteria     text not null check (loteria in ('lotofacil','megasena','lotomania')),
  dezenas     smallint[] not null,
  concurso    integer,

  origem      text default 'manual',   -- 'gerador' | 'fechamento' | 'manual'
  grupo       text,                    -- agrupa os bilhetes de um mesmo lote
  rotulo      text,

  custo       numeric(10,2) not null default 0,
  conferido   boolean not null default false,
  acertos     smallint,
  premiado    boolean not null default false,
  premio      numeric(12,2) not null default 0,

  criado_em   timestamptz not null default now()
);

create index if not exists bilhetes_user_loteria_idx
  on public.bilhetes (user_id, loteria);

create index if not exists bilhetes_concurso_idx
  on public.bilhetes (user_id, loteria, concurso);

-- -------------------------------------------------------------------
-- Row Level Security: cada pessoa enxerga e mexe só nos próprios
-- bilhetes. Sem isto, a chave anônima do front-end daria acesso à
-- tabela inteira — inclusive para escrita.
-- -------------------------------------------------------------------

alter table public.bilhetes enable row level security;

drop policy if exists "bilhetes proprios: ler"     on public.bilhetes;
drop policy if exists "bilhetes proprios: inserir" on public.bilhetes;
drop policy if exists "bilhetes proprios: alterar" on public.bilhetes;
drop policy if exists "bilhetes proprios: apagar"  on public.bilhetes;

create policy "bilhetes proprios: ler"
  on public.bilhetes for select
  using (auth.uid() = user_id);

create policy "bilhetes proprios: inserir"
  on public.bilhetes for insert
  with check (auth.uid() = user_id);

create policy "bilhetes proprios: alterar"
  on public.bilhetes for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "bilhetes proprios: apagar"
  on public.bilhetes for delete
  using (auth.uid() = user_id);

-- -------------------------------------------------------------------
-- O histórico de concursos NÃO tem tabela aqui de propósito: são dados
-- públicos, pesados (milhares de linhas por modalidade) e idênticos
-- para todos os usuários. Guardá-los no Supabase só consumiria cota de
-- banco e de transferência sem benefício nenhum — eles continuam em
-- IndexedDB, no navegador, mesmo com a nuvem ligada.
-- -------------------------------------------------------------------
