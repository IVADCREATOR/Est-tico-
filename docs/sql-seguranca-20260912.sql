-- SORASAKI — revisão de segurança de 12/09/2026
-- Execute UMA vez no SQL Editor do Supabase. É idempotente (pode rodar de novo)
-- e não apaga dados. Rode DEPOIS de docs/sql-atualizacao-20260911.sql e de
-- docs/sql-analytics-captcha.sql.
--
-- O que este arquivo corrige ou reforça:
--  1. Avaliações: e-mail, IP e navegador de quem avaliou deixam de ser públicos.
--  2. Divulgações: visitantes anônimos deixam de ver o dono (UUID) e notas internas.
--  3. Perfil: usuário não consegue se promover a admin nem mudar status/e-mail
--     pelo navegador (reforço do gatilho de proteção, válido para qualquer instalação).
--  4. Novo cadastro (inclusive Google): nome de usuário sempre válido e único —
--     antes, e-mails como "joao.silva@gmail.com" quebravam o cadastro pelo Google.
--  5. Admin com verificação em duas etapas ativada precisa ter feito a
--     verificação na sessão (AAL2) para usar os poderes de admin.
--  6. Limite diário e status inicial forçado em feedback, bugs e relatos.
--  7. Funções de estatística e a tabela de cadastros: só o servidor acessa.

begin;

-- ===== 1. Avaliações: colunas públicas =====
-- A leitura pública (status = 'visible') continua, mas só destas colunas.
-- email, ip, user_agent e user_id ficam acessíveis apenas ao servidor.
revoke select on public.reviews from anon, authenticated;
grant select (id, group_id, rating, comment, status, created_at) on public.reviews to anon, authenticated;

-- ===== 2. Divulgações: colunas visíveis para visitantes anônimos =====
-- Usuários conectados continuam com acesso normal (as policies de RLS decidem
-- as linhas: aprovadas para todos, as próprias para o dono, tudo para admin).
revoke select on public.groups from anon;
grant select (id, name, description, category, platform, avatar_url, member_count, invite_url,
              featured_by_admin, admin_badge, created_at, tags, contact_url, highlight, view_count, status)
  on public.groups to anon;

-- ===== 3. Perfil: campos que só a equipe altera =====
alter table public.profiles add column if not exists email_confirmed boolean not null default false;

-- Sem "security definer" de propósito: current_user é o papel de quem fez a
-- alteração. Pelo site é 'authenticated'; em gatilhos do Supabase Auth ou no
-- servidor (service role) é outro papel, e a sincronização continua funcionando.
create or replace function public.protect_profile_admin_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    new.user_id := old.user_id;
    new.role := old.role;
    new.account_status := old.account_status;
    new.email := old.email;
    new.email_confirmed := old.email_confirmed;
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_protect_profile_admin_fields on public.profiles;
create trigger trg_protect_profile_admin_fields before update on public.profiles
  for each row execute function public.protect_profile_admin_fields();

-- ===== 4. Criação de perfil no cadastro (e-mail ou Google) =====
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  escolhido text := nullif(trim(new.raw_user_meta_data->>'username'), '');
  base text;
  candidato text;
  n integer := 0;
begin
  if escolhido is not null and escolhido ~ '^[A-Za-z0-9_]{3,24}$' then
    -- Nome escolhido no formulário de cadastro: se já existir, recusa
    -- (o site mostra "Esse nome de usuário já está em uso").
    if exists (select 1 from public.profiles where lower(username) = lower(escolhido)) then
      raise exception 'nome de usuário já está em uso' using errcode = 'unique_violation';
    end if;
    candidato := escolhido;
  else
    -- Google e outros provedores: gera um nome válido a partir do nome ou do e-mail.
    base := coalesce(
      nullif(new.raw_user_meta_data->>'preferred_username', ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      nullif(new.raw_user_meta_data->>'name', ''),
      'usuario');
    base := regexp_replace(base, '[^A-Za-z0-9_]+', '_', 'g');
    base := trim(both '_' from base);
    if char_length(base) < 3 then base := 'usuario'; end if;
    base := left(base, 20);
    candidato := base;
    while exists (select 1 from public.profiles where lower(username) = lower(candidato)) loop
      n := n + 1;
      if n > 500 then
        candidato := left(base, 15) || '_' || substr(md5(random()::text || clock_timestamp()::text), 1, 8);
        exit;
      end if;
      candidato := base || '_' || n::text;
    end loop;
  end if;

  insert into public.profiles (user_id, display_name, username, email, email_confirmed)
  values (
    new.id,
    left(coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), nullif(new.raw_user_meta_data->>'full_name', ''),
                  nullif(new.raw_user_meta_data->>'name', ''), candidato), 80),
    candidato,
    new.email,
    (new.email_confirmed_at is not null)
  )
  on conflict (user_id) do update set email = excluded.email;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== 5. Admin + verificação em duas etapas (MFA) =====
-- Se o admin tem um fator de autenticação verificado, a sessão precisa estar
-- em AAL2 (código do app autenticador confirmado) para valer como admin.
-- Admins sem MFA continuam funcionando (para ninguém ficar trancado para fora);
-- o painel recomenda ativar.
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
      select 1 from public.profiles
       where user_id = auth.uid() and role = 'admin' and coalesce(account_status, 'active') = 'active'
    )
    and (
      coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
    );
$$;
revoke all on function public.is_admin() from public;
-- anon também executa: várias policies públicas chamam is_admin(), e sem
-- sessão ela sempre retorna false (auth.uid() é nulo).
grant execute on function public.is_admin() to anon, authenticated;

-- ===== 6. Limites e status inicial em envios de usuários =====
create or replace function public.enforce_user_submission()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  total integer;
begin
  if public.is_admin() then return new; end if;
  if tg_table_name = 'feedback' then
    new.status := 'new';
    select count(*) into total from public.feedback where user_id = new.user_id and created_at > now() - interval '24 hours';
  elsif tg_table_name = 'bug_reports' then
    new.status := 'open';
    select count(*) into total from public.bug_reports where user_id = new.user_id and created_at > now() - interval '24 hours';
  elsif tg_table_name = 'reports' then
    new.status := 'open';
    total := 0; -- o limite de relatos já existe em trg_report_limit
  end if;
  if total >= 20 then
    raise exception 'limite de envios atingido';
  end if;
  return new;
end $$;
drop trigger if exists trg_feedback_submission on public.feedback;
create trigger trg_feedback_submission before insert on public.feedback
  for each row execute function public.enforce_user_submission();
drop trigger if exists trg_bug_submission on public.bug_reports;
create trigger trg_bug_submission before insert on public.bug_reports
  for each row execute function public.enforce_user_submission();
drop trigger if exists trg_report_submission on public.reports;
create trigger trg_report_submission before insert on public.reports
  for each row execute function public.enforce_user_submission();

-- ===== 7. Menor privilégio: acesso só pelo servidor =====
-- As estatísticas do site são lidas/gravadas pelas funções /api (service role).
revoke execute on function public.record_site_visit(text, text) from anon, authenticated;
revoke execute on function public.get_site_analytics() from anon, authenticated;
-- No Supabase, funções do schema public ganham EXECUTE para anon/authenticated
-- por padrão — "revoke ... from public" não tira isso. Sem esta linha, qualquer
-- visitante chamava /rest/v1/rpc/consume_coupon e esgotava cupons.
revoke execute on function public.consume_coupon(bigint, uuid, bigint, numeric) from anon, authenticated;
grant execute on function public.consume_coupon(bigint, uuid, bigint, numeric) to service_role;

-- Contexto de cadastro (IP/localização): RLS sem policy + sem privilégios.
do $$
begin
  if to_regclass('public.signup_events') is not null then
    execute 'alter table public.signup_events enable row level security';
    execute 'revoke all on public.signup_events from anon, authenticated';
  end if;
end $$;

commit;

-- Conferência rápida (opcional): deve retornar "false" nas duas primeiras linhas.
-- select has_column_privilege('anon', 'public.reviews', 'email', 'select')   as anon_ve_email_da_avaliacao,
--        has_column_privilege('anon', 'public.groups', 'owner_id', 'select') as anon_ve_dono_do_grupo,
--        has_column_privilege('anon', 'public.reviews', 'rating', 'select')  as anon_ve_nota;
