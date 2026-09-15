-- SORASAKI — atualização de 11/09/2026
-- Execute UMA vez no SQL Editor do Supabase (pode rodar de novo sem problema:
-- tudo aqui é idempotente e não apaga dados).
--
-- O que este arquivo garante no banco (e não só na tela):
--  1. Avaliações entram como "pendente" e a equipe aprova pelo painel.
--  2. O limite diário de divulgações e a opção "Novas divulgações" do painel
--     valem de verdade no servidor; contas suspensas não publicam.
--  3. O dono de uma divulgação não consegue alterar campos que só a equipe
--     controla (visualizações, dono, data de aprovação).
--  4. A equipe consegue marcar feedbacks e relatos de bug como resolvidos.
--  5. O status "e-mail confirmado" do perfil acompanha o Supabase Auth.

begin;

-- ===== 1. Avaliações com moderação =====
alter table public.reviews add column if not exists ip inet;
alter table public.reviews add column if not exists email text;
alter table public.reviews add column if not exists user_agent text;
alter table public.reviews drop constraint if exists reviews_status_check;
alter table public.reviews add constraint reviews_status_check check (status in ('pending','visible','hidden'));
alter table public.reviews alter column status set default 'pending';

drop policy if exists "users review" on public.reviews;
create policy "users review" on public.reviews
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and exists(select 1 from public.groups g where g.id = group_id and g.status = 'approved')
  );
create index if not exists idx_reviews_pending on public.reviews(status, created_at desc) where status = 'pending';

-- ===== 2. Regras de envio de divulgações =====
create or replace function public.enforce_group_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  total integer;
  max_allowed integer;
  enabled boolean;
begin
  if new.owner_id <> auth.uid() and not public.is_admin() then
    raise exception 'operação não autorizada';
  end if;
  if not public.is_admin() then
    if exists(select 1 from public.profiles where user_id = new.owner_id and account_status = 'suspended') then
      raise exception 'conta suspensa';
    end if;
    if new.status = 'pending' then
      select coalesce((value #>> '{}')::boolean, true) into enabled
        from public.site_settings where key = 'community_submissions_enabled';
      if enabled is false then
        raise exception 'novas divulgações estão temporariamente desativadas';
      end if;
      select coalesce((value #>> '{}')::integer, 5) into max_allowed
        from public.site_settings where key = 'max_group_submissions_per_24h';
      select count(*) into total from public.groups
        where owner_id = new.owner_id and status in ('pending','approved')
          and created_at > now() - interval '24 hours';
      if total >= coalesce(max_allowed, 5) then
        raise exception 'limite de divulgações atingido';
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_group_limits on public.groups;
create trigger trg_group_limits before insert on public.groups
  for each row execute function public.enforce_group_limits();

-- ===== 3. Campos controlados pela equipe =====
-- Sem "security definer" de propósito: assim current_user é o papel de quem
-- fez a alteração. Pelo site é 'authenticated'; dentro de funções do sistema
-- (como increment_group_view) é o dono da função, e o contador continua
-- funcionando normalmente.
create or replace function public.protect_group_owner_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_admin() then
    new.owner_id := old.owner_id;
    new.view_count := old.view_count;
    new.created_at := old.created_at;
    new.approved_at := null;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_group_owner_fields on public.groups;
create trigger trg_protect_group_owner_fields before update on public.groups
  for each row execute function public.protect_group_owner_fields();

-- ===== 4. Feedback e relatos de bug: a equipe pode atualizar o status =====
drop policy if exists "admins update feedback" on public.feedback;
create policy "admins update feedback" on public.feedback
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admins update bug reports" on public.bug_reports;
create policy "admins update bug reports" on public.bug_reports
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ===== 5. E-mail confirmado sincronizado com o Supabase Auth =====
alter table public.profiles add column if not exists email_confirmed boolean not null default false;
create or replace function public.handle_auth_user_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles
     set email = new.email, email_confirmed = (new.email_confirmed_at is not null), updated_at = now()
   where user_id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated after update on auth.users
  for each row execute function public.handle_auth_user_update();

update public.profiles p
   set email_confirmed = (u.email_confirmed_at is not null)
  from auth.users u
 where p.user_id = u.id and p.email_confirmed is distinct from (u.email_confirmed_at is not null);

commit;
