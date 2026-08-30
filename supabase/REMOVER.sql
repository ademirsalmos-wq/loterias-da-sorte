-- ===================================================================
-- Loterias da Sorte — desfazendo o que o schema.sql criou no Supabase.
--
-- O sistema migrou para o Firebase (ver firebase/COMO-CONFIGURAR.md).
-- Este arquivo remove a tabela que morava emprestada num projeto de
-- outra aplicação.
--
-- ORDEM SUGERIDA: rode o passo 1 quando quiser, mas só rode o passo 2
-- depois que o Firebase estiver funcionando ponta a ponta — conta criada
-- num aparelho, o outro entrando, bilhete viajando. A tabela vazia não
-- atrapalha nem consome cota; ter o caminho antigo de pé enquanto o novo
-- não foi provado é barato e evita pressa.
-- ===================================================================

-- -------------------------------------------------------------------
-- 1) ANTES DE QUALQUER COISA: tem dado ali dentro?
--
-- `drop` não tem desfazer. Cinco segundos aqui valem mais do que
-- qualquer certeza de memória.
-- -------------------------------------------------------------------
select count(*)                                   as total,
       count(*) filter (where not removido)       as ativos,
       min(criado_em)                             as mais_antigo,
       max(atualizado_em)                         as ultima_alteracao
from public.loterias_bilhetes;

-- Se voltar mais que zero e você quiser preservar, exporte antes:
--
--   select * from public.loterias_bilhetes where not removido;
--
-- e use o botão de download do resultado, no SQL Editor.


-- -------------------------------------------------------------------
-- 2) REMOVER
--
-- Os dois índices e as quatro políticas de RLS pertencem à tabela e vão
-- junto, automaticamente. Não é preciso apagar um a um.
--
-- Sem `cascade` de propósito: se alguma outra coisa passar a depender
-- desta tabela, o Postgres recusa e avisa, em vez de derrubar junto sem
-- perguntar.
-- -------------------------------------------------------------------
drop table public.loterias_bilhetes;


-- -------------------------------------------------------------------
-- 3) CONFERIR — as três devem voltar vazias
-- -------------------------------------------------------------------
select tablename  from pg_tables   where tablename = 'loterias_bilhetes';
select policyname from pg_policies where tablename = 'loterias_bilhetes';
select indexname  from pg_indexes  where tablename = 'loterias_bilhetes';


-- ===================================================================
-- O QUE ESTE SCRIPT NÃO REMOVE, E POR QUÊ
--
-- A tabela referenciava `auth.users`, mas a dependência era só num
-- sentido: apagar os bilhetes não mexe nos usuários. Se durante os
-- testes nasceu uma conta, ela continua em Authentication → Users.
--
-- Apague-a por lá SOMENTE se aquele e-mail existia só para este app. Se
-- for o mesmo e-mail que você usa na outra aplicação hospedada no mesmo
-- projeto, é a mesma conta — e apagá-la derruba o outro sistema.
-- ===================================================================
