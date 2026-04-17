-- Cutover env_secrets to org/user scoped plain values for runtime overrides.
-- Replaces the previous scope/ciphertext model introduced in 20260403.

create extension if not exists pgcrypto;

drop trigger if exists trg_env_secrets_updated_at on public.env_secrets;
drop index if exists public.ux_env_secrets_platform;
drop index if exists public.ux_env_secrets_org;
drop index if exists public.ux_env_secrets_orchestrator;
drop table if exists public.env_secrets;

create table if not exists public.env_secrets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  env_key text not null,
  env_value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_env_secrets_org_user_env_key
  on public.env_secrets(org_id, user_id, env_key)
  where user_id is not null;

create unique index if not exists ux_env_secrets_org_env_key_user_null
  on public.env_secrets(org_id, env_key)
  where user_id is null;

create index if not exists ix_env_secrets_org_updated_at
  on public.env_secrets(org_id, updated_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_env_secrets_updated_at
before update on public.env_secrets
for each row execute procedure public.set_updated_at();
