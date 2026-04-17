-- Enforce strict 1 user <-> 1 orchestrator mapping per org.
-- This migration adds user_id to orchestrator_channels and binds it to org_memberships.

alter table public.orchestrator_channels
  add column if not exists user_id uuid;

-- Backfill existing rows using the preferred membership per org:
-- owner > admin > member, then oldest membership.
with ranked_memberships as (
  select
    m.org_id,
    m.user_id,
    row_number() over (
      partition by m.org_id
      order by
        case m.role
          when 'owner' then 0
          when 'admin' then 1
          else 2
        end,
        m.created_at asc
    ) as rn
  from public.org_memberships m
),
preferred_membership as (
  select org_id, user_id
  from ranked_memberships
  where rn = 1
)
update public.orchestrator_channels ch
set user_id = pm.user_id
from preferred_membership pm
where ch.org_id = pm.org_id
  and ch.user_id is null;

do $$
begin
  if exists (select 1 from public.orchestrator_channels where user_id is null) then
    raise exception 'Cannot set NOT NULL on orchestrator_channels.user_id: rows without org membership still exist.';
  end if;
end $$;

alter table public.orchestrator_channels
  alter column user_id set not null;

-- user must belong to the same org
alter table public.orchestrator_channels
  drop constraint if exists orchestrator_channels_org_user_membership_fk;

alter table public.orchestrator_channels
  add constraint orchestrator_channels_org_user_membership_fk
  foreign key (org_id, user_id)
  references public.org_memberships(org_id, user_id)
  on delete restrict;

-- strict 1:1 inside each org
drop index if exists public.ux_orchestrator_channels_org_user;
create unique index if not exists ux_orchestrator_channels_org_user
  on public.orchestrator_channels(org_id, user_id);

create index if not exists ix_orchestrator_channels_user_id
  on public.orchestrator_channels(user_id);
