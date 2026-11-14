-- 감당할수있겠나! · Supabase 스키마
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 한 번 실행하세요.
-- 앱의 '연결' 탭에서도 같은 SQL을 복사할 수 있습니다.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────
-- 1) 개인 계획 (사용자당 1행)
--    수입·지출·큰 지출·시나리오·설정을 통째로 jsonb 로 보관합니다.
--    앱이 계획 전체를 한 덩어리로 다루므로 컬럼 분해보다 단순하고,
--    나중에 항목별 조회가 필요해지면 items/bigs 테이블로 쪼개면 됩니다.
-- ─────────────────────────────────────────────
create table if not exists public.plans (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 2) 버전 스냅샷
-- ─────────────────────────────────────────────
create table if not exists public.snapshots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default '',
  memo       text not null default '',
  plan       jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists snapshots_user_idx on public.snapshots(user_id, created_at desc);

-- ─────────────────────────────────────────────
-- 3) 공용 마스터: 기관 (은행 / 카드사 / 캐피탈)
-- ─────────────────────────────────────────────
create table if not exists public.orgs (
  id         text primary key,
  kind       text not null default 'bank',
  name       text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────
-- 4) 공용 마스터: 할부·대출 상품
-- ─────────────────────────────────────────────
create table if not exists public.products (
  id          text primary key,
  org_id      text references public.orgs(id) on delete cascade,
  type        text not null default 'installment',   -- card | installment | loan
  name        text not null,
  apr         numeric not null default 0,            -- 연 이자율 %
  free_months integer not null default 0,            -- 무이자 개월
  max_months  integer not null default 12,
  fee_rate    numeric not null default 0,            -- 취급수수료 %
  note        text not null default '',
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);
create index if not exists products_org_idx on public.products(org_id);

-- ─────────────────────────────────────────────
-- RLS (Row Level Security)
-- ─────────────────────────────────────────────
alter table public.plans     enable row level security;
alter table public.snapshots enable row level security;
alter table public.orgs      enable row level security;
alter table public.products  enable row level security;

-- 개인 데이터: 본인 행만 읽고 쓸 수 있음
drop policy if exists plans_own on public.plans;
create policy plans_own on public.plans
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists snapshots_own on public.snapshots;
create policy snapshots_own on public.snapshots
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 공용 마스터: 누구나 읽기, 로그인한 사용자만 등록·수정
drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs
  for select to anon, authenticated using (true);

drop policy if exists orgs_write on public.orgs;
create policy orgs_write on public.orgs
  for all to authenticated using (true) with check (true);

drop policy if exists products_read on public.products;
create policy products_read on public.products
  for select to anon, authenticated using (true);

drop policy if exists products_write on public.products;
create policy products_write on public.products
  for all to authenticated using (true) with check (true);

-- ─────────────────────────────────────────────
-- 참고: 지금은 로그인한 사용자면 누구나 공용 마스터를 수정할 수 있습니다.
-- 위키처럼 열어두는 구조입니다. 나중에 관리자만 수정하게 바꾸려면
-- 아래처럼 역할 테이블을 두고 write 정책의 조건을 교체하세요.
--
-- create table public.admins (user_id uuid primary key references auth.users(id));
-- alter table public.admins enable row level security;
--
-- drop policy if exists products_write on public.products;
-- create policy products_write on public.products
--   for all to authenticated
--   using (exists (select 1 from public.admins a where a.user_id = auth.uid()))
--   with check (exists (select 1 from public.admins a where a.user_id = auth.uid()));
--
-- 또는 변경 이력을 남기고 싶다면 products_history 테이블에 트리거로 적재하세요.
