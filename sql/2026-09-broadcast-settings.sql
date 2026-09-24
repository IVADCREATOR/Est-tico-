-- Autodisparo configurável pelo site (aba separada de "Grupos e comandos").
-- Rode isto uma vez no SQL Editor do Supabase, no mesmo projeto onde já
-- existem bot_instances / bot_group_commands / bot_groups etc.
--
-- Uma linha por instância. "version" sobe a cada vez que o dono salva pelo
-- site; "applied_version" é atualizado pelo worker quando o bot confirma que
-- já aplicou aquela versão (mesmo padrão de bot_group_commands).

create table if not exists public.bot_broadcast_settings (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.bot_instances(id) on delete cascade,
  enabled boolean not null default false,
  message text not null default '',
  interval_minutes integer not null default 60 check (interval_minutes between 5 and 1440),
  mode text not null default 'todos' check (mode in ('todos', 'selecionados')),
  image_url text,
  group_refs text[] not null default '{}',
  version integer not null default 1,
  applied_version integer not null default 0,
  applied_at timestamptz,
  total_sent integer not null default 0,
  total_cycles integer not null default 0,
  last_dispatch_at timestamptz,
  updated_by uuid,
  updated_by_type text default 'user',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (instance_id)
);

create index if not exists bot_broadcast_settings_instance_idx on public.bot_broadcast_settings (instance_id);

alter table public.bot_broadcast_settings enable row level security;
-- Sem policies de propósito: só o backend (service role, em api/v1/bots.js e
-- api/v1/worker.js) acessa esta tabela. O service role sempre ignora RLS, e
-- assim nem "anon" nem "authenticated" conseguem ler/escrever direto do
-- navegador — igual ao resto da plataforma de bots.

-- Atenção: o código novo grava eventos com kind: 'broadcast' em bot_events
-- (ver evento() em api/v1/bots.js e api/v1/worker.js). Se bot_events.kind
-- tiver uma constraint CHECK fechada (só aceita 'admin','connection',
-- 'instance','payment','worker'...), rode manualmente algo como:
--   alter table public.bot_events drop constraint <nome_da_constraint>;
--   alter table public.bot_events add constraint <nome_da_constraint>
--     check (kind in ('instance','connection','payment','admin','worker','broadcast'));
-- Troque <nome_da_constraint> pelo nome real (veja em Database → Tables →
-- bot_events → Constraints no painel do Supabase). Se kind já for texto
-- livre (sem CHECK), não precisa fazer nada.
