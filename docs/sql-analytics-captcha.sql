-- Tabela de contexto de cadastro (IP/geo/entrada) — idempotente, seguro para rodar de novo.
-- O ID do Google Analytics e a site key do Turnstile ficam direto no config.js
-- (são identificadores públicos por natureza, não precisam de banco).
create table if not exists public.signup_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  ip text,
  country text,
  region text,
  city text,
  entry_page text,
  referrer text,
  created_at timestamptz not null default now()
);

create index if not exists signup_events_created_at_idx on public.signup_events (created_at desc);

-- RLS ligado e SEM nenhuma policy: isso bloqueia completamente o acesso via
-- chave anon/authenticated (front-end). Só a service role (usada nas
-- funções /api/track-signup.js e /api/admin-signups.js) enxerga esses dados,
-- porque a service role sempre ignora RLS.
alter table public.signup_events enable row level security;

comment on table public.signup_events is
  'Contexto de cadastro (IP, geo aproximada, página de entrada). Dado sensível — acesso só via service role, nunca pelo cliente.';

