-- Runtime state (threads/traces/chats/scheduled_jobs/workspaces) remains in JSONL at
-- .runtime-data/orgs/<orgId>/... in this v1 cutover.

create extension if not exists pgcrypto;

create table if not exists public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  config jsonb not null default '{}'::jsonb,
  config_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.org_memberships (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists public.orchestrator_channels (
  org_id uuid not null references public.orgs(id) on delete cascade,
  orchestrator_id text not null,
  provider text not null default 'kapso_whatsapp',
  phone_number_id text,
  owner_number text not null,
  active boolean not null default true,
  kapso_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, orchestrator_id),
  unique (phone_number_id),
  constraint orchestrator_id_format_ck check (
    orchestrator_id = 'orchestrator'
    or orchestrator_id ~ '^orchestrator:[A-Za-z0-9._-]+$'
  )
);

create table if not exists public.channel_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  orchestrator_id text not null,
  channel text not null check (channel in ('ui','cli','whatsapp')),
  contact text not null,
  direction text not null check (direction in ('inbound','outbound')),
  status text not null check (status in ('received','sent','delivered','read','failed')),
  message_id text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  event_ts timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint channel_events_orchestrator_format_ck check (
    orchestrator_id = 'orchestrator'
    or orchestrator_id ~ '^orchestrator:[A-Za-z0-9._-]+$'
  )
);

create unique index if not exists ux_channel_events_message_id
  on public.channel_events(message_id)
  where message_id is not null;

create index if not exists ix_channel_events_org_event_ts
  on public.channel_events(org_id, event_ts desc);

create table if not exists public.communication_intents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  orchestrator_id text not null,
  from_number text not null,
  expected_owner_number text not null,
  reason text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint communication_intents_orchestrator_format_ck check (
    orchestrator_id = 'orchestrator'
    or orchestrator_id ~ '^orchestrator:[A-Za-z0-9._-]+$'
  )
);

create index if not exists ix_communication_intents_org_created_at
  on public.communication_intents(org_id, created_at desc);

create table if not exists public.org_credentials (
  org_id uuid not null references public.orgs(id) on delete cascade,
  orchestrator_id text,
  provider text not null,
  field_name text not null,
  ciphertext text not null,
  iv text not null,
  tag text not null,
  key_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_credentials_orchestrator_format_ck check (
    orchestrator_id is null
    or orchestrator_id = 'orchestrator'
    or orchestrator_id ~ '^orchestrator:[A-Za-z0-9._-]+$'
  )
);

create unique index if not exists ux_org_credentials_org_scope
  on public.org_credentials(org_id, provider, field_name)
  where orchestrator_id is null;

create unique index if not exists ux_org_credentials_orchestrator_scope
  on public.org_credentials(org_id, orchestrator_id, provider, field_name)
  where orchestrator_id is not null;

create table if not exists public.env_secrets (
  scope text not null check (scope in ('platform','org','orchestrator')),
  org_id uuid references public.orgs(id) on delete cascade,
  orchestrator_id text,
  env_key text not null,
  ciphertext text not null,
  iv text not null,
  tag text not null,
  key_version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint env_secrets_orchestrator_format_ck check (
    orchestrator_id is null
    or orchestrator_id = 'orchestrator'
    or orchestrator_id ~ '^orchestrator:[A-Za-z0-9._-]+$'
  ),
  constraint env_secrets_scope_ck check (
    (scope = 'platform' and org_id is null and orchestrator_id is null)
    or (scope = 'org' and org_id is not null and orchestrator_id is null)
    or (scope = 'orchestrator' and org_id is not null and orchestrator_id is not null)
  )
);

create unique index if not exists ux_env_secrets_platform
  on public.env_secrets(scope, env_key)
  where scope = 'platform';

create unique index if not exists ux_env_secrets_org
  on public.env_secrets(scope, org_id, env_key)
  where scope = 'org';

create unique index if not exists ux_env_secrets_orchestrator
  on public.env_secrets(scope, org_id, orchestrator_id, env_key)
  where scope = 'orchestrator';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_orgs_updated_at on public.orgs;
create trigger trg_orgs_updated_at
before update on public.orgs
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_orchestrator_channels_updated_at on public.orchestrator_channels;
create trigger trg_orchestrator_channels_updated_at
before update on public.orchestrator_channels
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_org_credentials_updated_at on public.org_credentials;
create trigger trg_org_credentials_updated_at
before update on public.org_credentials
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_env_secrets_updated_at on public.env_secrets;
create trigger trg_env_secrets_updated_at
before update on public.env_secrets
for each row execute procedure public.set_updated_at();
