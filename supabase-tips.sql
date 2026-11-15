-- 감당할수있겠나! 사용자 꿀팁 (supabase-schema.sql 실행 후 이어서 실행)

create table if not exists public.tips (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  nick       text not null default '',
  topic      text not null default 'etc',
  keywords   text not null default '',
  title      text not null,
  body       text not null,
  up_count   integer not null default 0,
  down_count integer not null default 0,
  hidden     boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tips_rank on public.tips (hidden, up_count desc, created_at desc);

create table if not exists public.tip_votes (
  tip_id     uuid not null references public.tips(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  vote       smallint not null check (vote in (-1, 1)),
  reason     text not null default '',
  created_at timestamptz not null default now(),
  primary key (tip_id, user_id)
);

-- 관리자 명단. 여기에 넣은 사용자만 신고 사유를 보고 팁을 가릴 수 있습니다.
--   insert into public.tip_admins(user_id) values ('<내 user id>');
create table if not exists public.tip_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

create or replace function public.is_tip_admin()
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from public.tip_admins where user_id = auth.uid());
$$;

-- 투표 수를 tips 행에 적어 둡니다. 목록을 볼 때 투표 내역을 읽지 않아도 되고,
-- 비추천 사유가 밖으로 새지 않습니다.
create or replace function public.tip_recount()
returns trigger language plpgsql security definer
set search_path = public as $$
declare t uuid; u integer; d integer;
begin
  t := coalesce(new.tip_id, old.tip_id);
  select count(*) filter (where vote > 0), count(*) filter (where vote < 0)
    into u, d from public.tip_votes where tip_id = t;
  update public.tips
     set up_count = coalesce(u, 0),
         down_count = coalesce(d, 0),
         -- 비추천이 5개 넘고 추천의 두 배가 넘으면 관리자가 볼 때까지 자동으로 가립니다
         hidden = hidden or (coalesce(d, 0) >= 5 and coalesce(d, 0) > coalesce(u, 0) * 2)
   where id = t;
  return null;
end; $$;

drop trigger if exists tip_votes_recount on public.tip_votes;
create trigger tip_votes_recount
  after insert or update or delete on public.tip_votes
  for each row execute function public.tip_recount();

alter table public.tips       enable row level security;
alter table public.tip_votes  enable row level security;
alter table public.tip_admins enable row level security;

-- 가려지지 않은 팁은 누구나 읽습니다
drop policy if exists tips_read on public.tips;
create policy tips_read on public.tips for select to anon, authenticated
  using (hidden = false or auth.uid() = user_id or public.is_tip_admin());

drop policy if exists tips_insert on public.tips;
create policy tips_insert on public.tips for insert to authenticated
  with check (auth.uid() = user_id);

-- 글쓴이는 자기 글만 고치고 지웁니다. hidden 은 손대지 못합니다.
drop policy if exists tips_update_own on public.tips;
create policy tips_update_own on public.tips for update to authenticated
  using (auth.uid() = user_id and hidden = false)
  with check (auth.uid() = user_id and hidden = false);

drop policy if exists tips_delete_own on public.tips;
create policy tips_delete_own on public.tips for delete to authenticated
  using (auth.uid() = user_id);

-- 관리자는 가리고 되살립니다
drop policy if exists tips_admin on public.tips;
create policy tips_admin on public.tips for update to authenticated
  using (public.is_tip_admin()) with check (public.is_tip_admin());

-- 투표는 본인 것만 보고 넣고 지웁니다. 사유는 관리자만 모아 봅니다.
drop policy if exists votes_own on public.tip_votes;
create policy votes_own on public.tip_votes for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists votes_admin_read on public.tip_votes;
create policy votes_admin_read on public.tip_votes for select to authenticated
  using (public.is_tip_admin());

drop policy if exists admins_self on public.tip_admins;
create policy admins_self on public.tip_admins for select to authenticated
  using (auth.uid() = user_id);
