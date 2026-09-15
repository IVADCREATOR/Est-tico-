-- SORASAKI — migração completa 2026-09
-- Execute UMA vez no SQL Editor do Supabase.
-- É idempotente: usa IF NOT EXISTS/DROP POLICY para poder ser aplicada
-- sobre a estrutura atual sem apagar os dados existentes.

begin;

-- ===== Perfis / segurança de conta =====
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists account_status text not null default 'active';
alter table public.profiles add column if not exists email_confirmed boolean not null default false;
alter table public.profiles drop constraint if exists profiles_username_format;
alter table public.profiles add constraint profiles_username_format
  check (username is null or username ~ '^[A-Za-z0-9_]{3,24}$');
alter table public.profiles drop constraint if exists profiles_account_status_check;
alter table public.profiles add constraint profiles_account_status_check
  check (account_status in ('active','suspended'));
create unique index if not exists uq_profiles_username on public.profiles(lower(username)) where username is not null;

update public.profiles p
set email_confirmed = (u.email_confirmed_at is not null), email = u.email
from auth.users u
where p.user_id = u.id and (p.email is null or p.email <> u.email);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id,display_name,username,email,email_confirmed)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name',new.raw_user_meta_data->>'username',split_part(new.email,'@',1)),
    coalesce(new.raw_user_meta_data->>'username',split_part(new.email,'@',1)),
    new.email, (new.email_confirmed_at is not null)
  )
  on conflict (user_id) do update set email=excluded.email;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

create or replace function public.handle_auth_user_update()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.profiles set email=new.email,email_confirmed=(new.email_confirmed_at is not null),updated_at=now() where user_id=new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated after update on auth.users
for each row execute function public.handle_auth_user_update();

create or replace function public.protect_profile_admin_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() = old.user_id and not public.is_admin() then
    new.role := old.role;
    new.account_status := old.account_status;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_protect_profile_admin_fields on public.profiles;
create trigger trg_protect_profile_admin_fields before update on public.profiles
for each row execute function public.protect_profile_admin_fields();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.profiles where user_id=auth.uid() and role='admin' and coalesce(account_status,'active')='active');
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Compatibilidade com instalações antigas que criaram tags como text[].
do $$
declare typ text;
begin
  select format_type(a.atttypid,a.atttypmod) into typ
  from pg_attribute a
  where a.attrelid='public.groups'::regclass and a.attname='tags' and not a.attisdropped;
  if typ='text[]' then
    alter table public.groups add column if not exists tags_text text;
    execute 'update public.groups set tags_text=array_to_string(tags,'','') where tags is not null';
    alter table public.groups drop column tags;
    alter table public.groups rename column tags_text to tags;
  end if;
exception when undefined_column then null;
end $$;

-- ===== Divulgações =====
alter table public.groups add column if not exists platform text;
alter table public.groups add column if not exists tags text;
alter table public.groups add column if not exists contact_url text;
alter table public.groups add column if not exists highlight text;
alter table public.groups add column if not exists view_count bigint not null default 0;
alter table public.groups add column if not exists avatar_source text not null default 'manual';
alter table public.groups add column if not exists avatar_status text not null default 'manual';
alter table public.groups add column if not exists avatar_checked_at timestamptz;
alter table public.groups add column if not exists avatar_hash text;
alter table public.groups add column if not exists avatar_path text;

alter table public.groups drop constraint if exists groups_category_check;
alter table public.groups add constraint groups_category_check
  check (category in ('vendas','comunidade','jogos','freefire','divulgacao','amizades','suporte','estudos','outros'));
alter table public.groups drop constraint if exists groups_platform_length;
alter table public.groups add constraint groups_platform_length check (platform is null or char_length(platform) between 2 and 80);
alter table public.groups drop constraint if exists groups_tags_length;
alter table public.groups add constraint groups_tags_length check (tags is null or char_length(tags) <= 300);
alter table public.groups drop constraint if exists groups_contact_url_length;
alter table public.groups add constraint groups_contact_url_length check (contact_url is null or char_length(contact_url) <= 1000);
alter table public.groups drop constraint if exists groups_highlight_length;
alter table public.groups add constraint groups_highlight_length check (highlight is null or char_length(highlight) <= 160);
alter table public.groups drop constraint if exists groups_avatar_source_check;
alter table public.groups add constraint groups_avatar_source_check check (avatar_source in ('auto','manual','fallback'));
alter table public.groups drop constraint if exists groups_avatar_status_check;
alter table public.groups add constraint groups_avatar_status_check check (avatar_status in ('pending','found','not_found','error','manual'));
alter table public.groups drop constraint if exists groups_platform_required_pending;
alter table public.groups add constraint groups_platform_required_pending check (status <> 'pending' or (platform is not null and char_length(trim(platform)) >= 2));
create index if not exists idx_groups_status_created on public.groups(status,created_at desc);
create index if not exists idx_groups_owner_created on public.groups(owner_id,created_at desc);
create unique index if not exists uq_groups_invite_active on public.groups(lower(invite_url)) where status <> 'removed';

create or replace function public.enforce_group_limits()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  total integer;
begin
  if new.owner_id <> auth.uid() and not public.is_admin() then
    raise exception 'operação não autorizada';
  end if;
  if new.status='pending' and not public.is_admin() then
    select count(*) into total from public.groups
    where owner_id=new.owner_id and status in ('pending','approved')
      and created_at > now() - interval '24 hours';
    if total >= 5 then
      raise exception 'limite diário de divulgações atingido';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_group_limits on public.groups;
create trigger trg_group_limits before insert on public.groups
for each row execute function public.enforce_group_limits();

-- ===== Grupos oficiais =====
alter table public.official_groups add column if not exists image_url text;
alter table public.official_groups add column if not exists highlight_phrase text;
alter table public.official_groups add column if not exists image_source text not null default 'manual';
alter table public.official_groups add column if not exists image_status text not null default 'manual';
alter table public.official_groups add column if not exists image_checked_at timestamptz;
alter table public.official_groups add column if not exists image_hash text;
update public.official_groups set image_url=coalesce(image_url,avatar_url), highlight_phrase=coalesce(highlight_phrase,highlight) where image_url is null or highlight_phrase is null;
alter table public.official_groups drop constraint if exists official_groups_image_source_check;
alter table public.official_groups add constraint official_groups_image_source_check check (image_source in ('auto','manual','fallback'));
alter table public.official_groups drop constraint if exists official_groups_image_status_check;
alter table public.official_groups add constraint official_groups_image_status_check check (image_status in ('found','not_found','error','manual','pending'));
-- Compatibilidade: a interface usa avatar_url/highlight/invite_url quando já existem.
alter table public.official_groups drop constraint if exists official_groups_category_check;
alter table public.official_groups add constraint official_groups_category_check
  check(category in('vendas','comunidade','jogos','freefire','divulgacao','amizades','suporte','estudos','outros'));
create index if not exists idx_official_groups_active_order on public.official_groups(active,display_order,created_at);

-- Campos de cupom nos pedidos existentes.
alter table public.orders add column if not exists coupon_id bigint;
alter table public.orders add column if not exists discount_amount numeric(10,2) not null default 0;
-- ===== Cupons =====
create table if not exists public.coupons (
  id bigint generated by default as identity primary key,
  code text not null unique,
  discount_type text not null check (discount_type in ('percent','fixed')),
  discount_value numeric(10,2) not null check (discount_value > 0),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  max_uses integer,
  max_uses_per_user integer not null default 1,
  uses_count integer not null default 0,
  product_id bigint,
  plan_id bigint,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(code) between 3 and 40),
  check (code = upper(code)),
  check (max_uses is null or max_uses > 0),
  check (max_uses_per_user > 0),
  check (expires_at is null or expires_at > starts_at),
  check ((discount_type='percent' and discount_value <= 100) or discount_type='fixed')
);
alter table public.coupons add column if not exists plan_id bigint;
create index if not exists idx_coupons_active_dates on public.coupons(active,starts_at,expires_at);

create table if not exists public.coupon_redemptions (
  id bigint generated by default as identity primary key,
  coupon_id bigint not null references public.coupons(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  order_id bigint references public.orders(id) on delete set null,
  discount_amount numeric(10,2) not null check (discount_amount >= 0),
  created_at timestamptz not null default now(),
  unique(coupon_id,user_id,order_id)
);
create index if not exists idx_coupon_redemptions_user on public.coupon_redemptions(user_id,created_at desc);

-- ===== Produtos e preços =====
create table if not exists public.products (
  id bigint generated by default as identity primary key,
  name text not null,
  slug text not null unique,
  description text,
  price numeric(10,2) not null default 0 check (price >= 0),
  previous_price numeric(10,2) check (previous_price is null or previous_price >= 0),
  promo_price numeric(10,2) check (promo_price is null or promo_price >= 0),
  category text check (category is null or char_length(category) <= 60),
  image_url text check (image_url is null or char_length(image_url) <= 1000),
  active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(name) between 2 and 120),
  check (char_length(slug) between 2 and 120),
  check (description is null or char_length(description) <= 1000)
);
create index if not exists idx_products_active_order on public.products(active,display_order,created_at);
alter table public.products add column if not exists category text;
alter table public.products add column if not exists image_url text;
alter table public.products alter column promo_price drop not null;

-- ===== Notícias =====
create table if not exists public.news (
  id bigint generated by default as identity primary key,
  title text not null,
  summary text,
  content text not null,
  category text not null default 'novidade',
  image_url text,
  status text not null default 'draft' check (status in ('draft','published')),
  publish_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(title) between 2 and 160),
  check (summary is null or char_length(summary) <= 400),
  check (char_length(content) between 2 and 12000),
  check (image_url is null or char_length(image_url) <= 1000)
);
create index if not exists idx_news_publication on public.news(status,publish_at desc);

-- ===== Avisos =====
create table if not exists public.site_notices (
  id bigint generated by default as identity primary key,
  title text not null,
  message text not null,
  notice_type text not null default 'info' check (notice_type in ('info','success','warning','danger')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  highlighted boolean not null default false,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(title) between 2 and 120),
  check (char_length(message) between 2 and 1000),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists idx_notices_active_dates on public.site_notices(active,starts_at,ends_at);

-- ===== Configurações gerais =====
create table if not exists public.site_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  description text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into public.site_settings(key,value,description) values
 ('max_group_submissions_per_24h','5'::jsonb,'Máximo de novas divulgações por conta em 24 horas.'),
 ('maintenance_mode','false'::jsonb,'Ativa o modo de manutenção público.'),
 ('community_submissions_enabled','true'::jsonb,'Permite novas divulgações de usuários.'),
 ('maintenance_title',to_jsonb('🔧 Estamos em manutenção'::text),'Título da tela de manutenção.'),
 ('maintenance_message',to_jsonb('O site está passando por algumas melhorias no momento. Nossa equipe está trabalhando para deixar tudo funcionando corretamente.'::text),'Mensagem da tela de manutenção.'),
 ('maintenance_image_url',to_jsonb(''::text),'Imagem da tela de manutenção.'),
 ('maintenance_return_at','null'::jsonb,'Previsão opcional de retorno.'),
 ('maintenance_show_immediately','true'::jsonb,'Compatibilidade legada.'),
('maintenance_start_at','null'::jsonb,'Data opcional para iniciar a manutenção automaticamente.')
on conflict(key) do nothing;

-- ===== Histórico administrativo =====
create table if not exists public.admin_activity (
  id bigint generated by default as identity primary key,
  admin_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_activity alter column admin_id drop not null;
create index if not exists idx_admin_activity_created on public.admin_activity(created_at desc);
create index if not exists idx_admin_activity_entity on public.admin_activity(entity,created_at desc);

-- ===== Trigger de atualização =====
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists trg_coupons_updated on public.coupons;
create trigger trg_coupons_updated before update on public.coupons for each row execute function public.touch_updated_at();
drop trigger if exists trg_products_updated on public.products;
create trigger trg_products_updated before update on public.products for each row execute function public.touch_updated_at();
drop trigger if exists trg_news_updated on public.news;
create trigger trg_news_updated before update on public.news for each row execute function public.touch_updated_at();
drop trigger if exists trg_notices_updated on public.site_notices;
create trigger trg_notices_updated before update on public.site_notices for each row execute function public.touch_updated_at();
drop trigger if exists trg_settings_updated on public.site_settings;
create trigger trg_settings_updated before update on public.site_settings for each row execute function public.touch_updated_at();

-- ===== Auditoria automática de ações administrativas =====
create or replace function public.audit_admin_change()
returns trigger language plpgsql security definer set search_path=public as $$
declare
  who uuid := auth.uid();
  rid text;
begin
  if who is null or not public.is_admin() then return coalesce(new,old); end if;
  rid := coalesce((to_jsonb(new)->>'id'),(to_jsonb(old)->>'id'));
  insert into public.admin_activity(admin_id,action,entity,entity_id,details)
  values (
    who,
    tg_op,
    tg_table_name,
    rid,
    jsonb_build_object('record_id',rid)
  );
  return coalesce(new,old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['groups','official_groups','coupons','products','news','site_notices','site_settings','promotion_plans','reviews','reports'] loop
    execute format('drop trigger if exists trg_audit_%I on public.%I',t,t);
    execute format('create trigger trg_audit_%I after insert or update or delete on public.%I for each row execute function public.audit_admin_change()',t,t);
  end loop;
end $$;

-- ===== RPC segura para o próprio painel registrar eventos extras =====
create or replace function public.log_admin_activity(p_action text,p_entity text,p_entity_id text default null,p_details jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'operação não autorizada'; end if;
  insert into public.admin_activity(admin_id,action,entity,entity_id,details)
  values(auth.uid(),left(p_action,80),left(p_entity,80),p_entity_id,p_details);
end $$;
revoke all on function public.log_admin_activity(text,text,text,jsonb) from public;
grant execute on function public.log_admin_activity(text,text,text,jsonb) to authenticated;


create or replace function public.consume_coupon(p_coupon_id bigint,p_user_id uuid,p_order_id bigint,p_discount numeric)
returns boolean language plpgsql security definer set search_path=public as $$
declare c public.coupons; used_by_user integer;
begin
  select * into c from public.coupons where id=p_coupon_id for update;
  if c.id is null or not c.active or c.starts_at>now() or (c.expires_at is not null and c.expires_at<=now()) then return false; end if;
  if c.max_uses is not null and c.uses_count>=c.max_uses then return false; end if;
  select count(*) into used_by_user from public.coupon_redemptions where coupon_id=c.id and user_id=p_user_id;
  if used_by_user>=c.max_uses_per_user then return false; end if;
  insert into public.coupon_redemptions(coupon_id,user_id,order_id,discount_amount)
  values(c.id,p_user_id,p_order_id,greatest(0,p_discount));
  update public.coupons set uses_count=uses_count+1 where id=c.id;
  return true;
exception when unique_violation then return false;
end $$;
revoke all on function public.consume_coupon(bigint,uuid,bigint,numeric) from public;
grant execute on function public.consume_coupon(bigint,uuid,bigint,numeric) to service_role;


create or replace function public.enforce_report_limit()
returns trigger language plpgsql security definer set search_path=public as $$
declare total integer;
begin
 select count(*) into total from public.reports where reporter_id=new.reporter_id and created_at>now()-interval '24 hours';
 if total>=10 then raise exception 'limite de relatos atingido'; end if;
 return new;
end $$;
drop trigger if exists trg_report_limit on public.reports;
create trigger trg_report_limit before insert on public.reports for each row execute function public.enforce_report_limit();

-- ===== Storage para imagens públicas =====
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('group-images','group-images',true,5242880,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public=true,file_size_limit=5242880,allowed_mime_types=excluded.allowed_mime_types;
-- ===== RLS =====
alter table public.coupons enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.products enable row level security;
alter table public.news enable row level security;
alter table public.site_notices enable row level security;
alter table public.site_settings enable row level security;
alter table public.admin_activity enable row level security;

drop policy if exists "public active products read" on public.products;
create policy "public active products read" on public.products for select to anon,authenticated using (active=true or public.is_admin());
drop policy if exists "admins manage products" on public.products;
create policy "admins manage products" on public.products for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "public published news read" on public.news;
create policy "public published news read" on public.news for select to anon,authenticated using ((status='published' and publish_at<=now()) or public.is_admin());
drop policy if exists "admins manage news" on public.news;
create policy "admins manage news" on public.news for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "public active notices read" on public.site_notices;
create policy "public active notices read" on public.site_notices for select to anon,authenticated using ((active=true and starts_at<=now() and (ends_at is null or ends_at>now())) or public.is_admin());
drop policy if exists "admins manage notices" on public.site_notices;
create policy "admins manage notices" on public.site_notices for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "admins manage coupons" on public.coupons;
create policy "admins manage coupons" on public.coupons for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "admins manage coupon redemptions" on public.coupon_redemptions;
create policy "admins manage coupon redemptions" on public.coupon_redemptions for all to authenticated using(public.is_admin()) with check(public.is_admin());
drop policy if exists "users own coupon redemptions" on public.coupon_redemptions;
create policy "users own coupon redemptions" on public.coupon_redemptions for select to authenticated using(auth.uid()=user_id);

drop policy if exists "admins read activity" on public.admin_activity;
create policy "admins read activity" on public.admin_activity for select to authenticated using(public.is_admin());
drop policy if exists "admins insert activity" on public.admin_activity;
create policy "admins insert activity" on public.admin_activity for insert to authenticated with check(public.is_admin() and auth.uid()=admin_id);

drop policy if exists "admins manage settings" on public.site_settings;
create policy "admins manage settings" on public.site_settings for all to authenticated using(public.is_admin()) with check(public.is_admin());

drop policy if exists "group images upload" on storage.objects;
create policy "group images upload" on storage.objects for insert to authenticated
with check(bucket_id='group-images' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
drop policy if exists "group images update" on storage.objects;
create policy "group images update" on storage.objects for update to authenticated
using(bucket_id='group-images' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()))
with check(bucket_id='group-images' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));
drop policy if exists "group images delete" on storage.objects;
create policy "group images delete" on storage.objects for delete to authenticated
using(bucket_id='group-images' and ((storage.foldername(name))[1]=auth.uid()::text or public.is_admin()));


-- Melhor segurança para grupos: apenas o dono pode enviar/editar os próprios campos,
-- enquanto o ADM mantém controle total via policy separada.
drop policy if exists "users submit pending groups" on public.groups;
create policy "users submit pending groups" on public.groups for insert to authenticated
with check(auth.uid()=owner_id and status='pending' and featured_by_admin=false and admin_badge is null);

drop policy if exists "users own groups update" on public.groups;
create policy "users own groups update" on public.groups for update to authenticated
using(auth.uid()=owner_id)
with check(auth.uid()=owner_id and status='pending' and featured_by_admin=false and admin_badge is null);

-- ===== Limite de spam de relatos/feedback já existente =====
create unique index if not exists uq_reports_group_reporter on public.reports(group_id,reporter_id);

commit;

-- ===== Estatísticas de visitantes do site =====
create table if not exists public.site_visits (
 visitor_id text not null, visit_day date not null default current_date, path text not null,
 page_views integer not null default 1 check(page_views>0), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 primary key(visitor_id,visit_day,path)
);
create index if not exists idx_site_visits_day on public.site_visits(visit_day desc);
create index if not exists idx_site_visits_path_day on public.site_visits(path,visit_day desc);
create or replace function public.record_site_visit(p_visitor_id text,p_path text) returns void language plpgsql security definer set search_path=public as $$ begin
 if p_visitor_id is null or p_visitor_id !~ '^[A-Za-z0-9_-]{20,120}$' then raise exception 'visitor inválido'; end if;
 if p_path is null or left(p_path,1) <> '/' or char_length(p_path)>180 then raise exception 'rota inválida'; end if;
 if p_path ~* '^/api(?:/|$)' or p_path ~* '^/controle-8f4c2e91(?:/|$)' then raise exception 'rota não rastreável'; end if;
 insert into public.site_visits(visitor_id,visit_day,path,page_views,updated_at) values(p_visitor_id,current_date,p_path,1,now()) on conflict(visitor_id,visit_day,path) do update set page_views=site_visits.page_views+1,updated_at=now(); end $$;
revoke all on function public.record_site_visit(text,text) from public; grant execute on function public.record_site_visit(text,text) to anon,authenticated;
alter table public.site_visits enable row level security; drop policy if exists "admins read site visits" on public.site_visits; create policy "admins read site visits" on public.site_visits for select to authenticated using(public.is_admin());
revoke all on public.site_visits from anon,authenticated; grant select on public.site_visits to service_role;
create or replace function public.get_site_analytics() returns jsonb language sql security definer set search_path=public as $$
with daily as (select visit_day,count(distinct visitor_id)::integer visitors,sum(page_views)::bigint page_views from public.site_visits where visit_day>=current_date-29 group by visit_day), pages as (select path,sum(page_views)::bigint page_views from public.site_visits group by path order by page_views desc limit 10), days as (select generate_series(current_date-29,current_date,interval '1 day')::date as day)
select jsonb_build_object('ok',true,'website',jsonb_build_object('unique_visitors_total',(select count(distinct visitor_id)::bigint from public.site_visits),'unique_visitors_today',(select count(distinct visitor_id)::bigint from public.site_visits where visit_day=current_date),'page_views_total',(select coalesce(sum(page_views),0)::bigint from public.site_visits),'page_views_today',(select coalesce(sum(page_views),0)::bigint from public.site_visits where visit_day=current_date),'daily',coalesce((select jsonb_agg(jsonb_build_object('day',days.day,'visitors',coalesce(daily.visitors,0),'page_views',coalesce(daily.page_views,0)) order by days.day) from days left join daily on daily.visit_day=days.day),'[]'::jsonb),'top_pages',coalesce((select jsonb_agg(jsonb_build_object('path',pages.path,'page_views',pages.page_views) order by pages.page_views desc) from pages),'[]'::jsonb)));
$$;
revoke all on function public.get_site_analytics() from public; grant execute on function public.get_site_analytics() to anon,authenticated;
update public.site_settings set value='false'::jsonb where key='maintenance_mode' and lower(trim(value #>> '{}')) in ('false','0','off','no');
