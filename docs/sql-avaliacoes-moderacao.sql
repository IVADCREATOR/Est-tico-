-- Isolado e idempotente: só mexe na tabela public.reviews que já existe.
-- Não toca em nenhuma outra tabela, função ou policy do projeto.
-- Pode colar tudo de uma vez no SQL Editor do Supabase.

alter table public.reviews add column if not exists ip inet;
alter table public.reviews add column if not exists email text;
alter table public.reviews add column if not exists user_agent text;

alter table public.reviews drop constraint if exists reviews_status_check;
alter table public.reviews add constraint reviews_status_check check (status in ('pending','visible','hidden'));
alter table public.reviews alter column status set default 'pending';

-- Qualquer avaliação nova entra como 'pending' — mesmo que alguém tente
-- inserir direto pelo navegador sem passar pela função /api/submit-review.
drop policy if exists "users review" on public.reviews;
create policy "users review" on public.reviews
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and exists(select 1 from public.groups g where g.id = group_id and g.status = 'approved')
  );

create index if not exists idx_reviews_pending on public.reviews(status, created_at desc) where status = 'pending';
