import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { storage } from "./storage.js";
import { SUPABASE_URL, SUPABASE_KEY, HOSTED, SERVICE } from "./config.js";
import { AboutPage, GuideIndex, GuidePage, LegalPage } from "./Pages.jsx";
import { GUIDES } from "./content.js";
import { tipsFor, EFFORT } from "./savetips.js";
import {
  listTips, myVotes, addTip, editTip, removeTip, vote, isAdmin, listReports, setHidden,
  canRead, canWrite, cleanTip, tipProblem, findDuplicate, TIP_LIMITS, TIPS_SQL,
} from "./tipsapi.js";

/* ------------------------------------------------------------------
   감당할수있겠나! — 큰 지출을 감당할 수 있는지 미리 굴려보는 가계 현금흐름 예측 시스템
   개인 데이터 / 공용 상품 카탈로그 / 버전 스냅샷
------------------------------------------------------------------- */

const K_PLAN = "cashflow:plan";
const K_SNAPS = "cashflow:snapshots";
const K_CATALOG = "market:catalog";
const K_CONN = "app:supabase";

/* ------------------------------------------------------------------
   Supabase 연동 (REST 직접 호출)
   - publishable key(또는 예전 anon key)는 공개용이라 브라우저에 저장해도 됩니다.
   - 실제 접근 제어는 서버의 RLS 정책이 담당합니다.
------------------------------------------------------------------- */
const SCHEMA_SQL = `-- 감당할수있겠나! · Supabase 스키마
-- SQL Editor에 붙여넣고 실행하세요.

create extension if not exists "pgcrypto";

-- 1) 개인 계획 (사용자당 1행)
create table if not exists public.plans (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2) 버전 스냅샷
create table if not exists public.snapshots (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default '',
  memo       text not null default '',
  plan       jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists snapshots_user_idx on public.snapshots(user_id, created_at desc);

-- 3) 공용 마스터: 기관
create table if not exists public.orgs (
  id         text primary key,
  kind       text not null default 'bank',
  name       text not null,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- 4) 공용 마스터: 상품
create table if not exists public.products (
  id          text primary key,
  org_id      text references public.orgs(id) on delete cascade,
  type        text not null default 'installment',
  name        text not null,
  apr         numeric not null default 0,
  free_months integer not null default 0,
  max_months  integer not null default 12,
  fee_rate    numeric not null default 0,
  note        text not null default '',
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

-- RLS
alter table public.plans     enable row level security;
alter table public.snapshots enable row level security;
alter table public.orgs      enable row level security;
alter table public.products  enable row level security;

-- 개인 데이터: 본인 행만
drop policy if exists plans_own on public.plans;
create policy plans_own on public.plans
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists snapshots_own on public.snapshots;
create policy snapshots_own on public.snapshots
  for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 공용 마스터: 누구나 읽기, 로그인한 사용자만 쓰기
drop policy if exists orgs_read on public.orgs;
create policy orgs_read on public.orgs for select to anon, authenticated using (true);
drop policy if exists orgs_write on public.orgs;
create policy orgs_write on public.orgs for all to authenticated using (true) with check (true);

drop policy if exists products_read on public.products;
create policy products_read on public.products for select to anon, authenticated using (true);
drop policy if exists products_write on public.products;
create policy products_write on public.products for all to authenticated using (true) with check (true);

-- 본인 계정 삭제. auth.users 에서 지워지면 plans·snapshots 도 함께 사라집니다.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요합니다';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
`;

const trimUrl = (u) => String(u || "").trim().replace(/\/+$/, "");

/* 새 publishable key(sb_publishable_...)는 JWT가 아니라서
   Authorization: Bearer 로 보내면 거부됩니다. apikey 헤더만 씁니다.
   예전 anon key는 JWT라 두 헤더 모두 받습니다. */
const isNewKey = (k) => /^sb_/.test(String(k || ""));

async function sbFetch(conn, path, opts = {}) {
  if (!conn || !conn.url || !conn.key) throw new Error("Supabase 주소와 API 키를 먼저 저장하세요.");
  const headers = {
    apikey: conn.key,
    ...(opts.body ? { "Content-Type": "application/json" } : {}),
    ...(opts.headers || {}),
  };
  const bearer = conn.token || (isNewKey(conn.key) ? null : conn.key);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(`${trimUrl(conn.url)}${path}`, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) {
    const m = (data && (data.message || data.error_description || data.msg || data.error)) || `HTTP ${res.status}`;
    throw new Error(String(m));
  }
  return data;
}

const sbSignUp = (conn, email, password) =>
  sbFetch(conn, "/auth/v1/signup", { method: "POST", body: JSON.stringify({ email, password }) });

/* 비밀번호 재설정 메일 보내기 */
const sbRecover = (conn, email) =>
  sbFetch(conn, "/auth/v1/recover", {
    method: "POST",
    body: JSON.stringify({ email, redirect_to: `${SERVICE.url}/` }),
  });

/* 로그인한 사용자의 비밀번호 바꾸기 */
const sbUpdatePassword = (conn, password) =>
  sbFetch(conn, "/auth/v1/user", { method: "PUT", body: JSON.stringify({ password }) });

/* 서버에 올라간 내 데이터만 지우기 (계정은 유지) */
async function remoteWipeData(conn) {
  const uid = conn.user.id;
  await sbFetch(conn, `/rest/v1/snapshots?user_id=eq.${uid}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
  await sbFetch(conn, `/rest/v1/plans?user_id=eq.${uid}`, {
    method: "DELETE", headers: { Prefer: "return=minimal" },
  });
}

/* 계정까지 지우기. 스키마의 delete_my_account() 를 호출합니다.
   auth.users 에서 지워지면 plans·snapshots 도 on delete cascade 로 함께 사라집니다. */
const remoteDeleteAccount = (conn) =>
  sbFetch(conn, "/rest/v1/rpc/delete_my_account", {
    method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({}),
  });

const sbSignIn = (conn, email, password) =>
  sbFetch(conn, "/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password }) });

const sbRefresh = (conn) =>
  sbFetch({ ...conn, token: null }, "/auth/v1/token?grant_type=refresh_token", {
    method: "POST", body: JSON.stringify({ refresh_token: conn.refresh }),
  });

function catalogFromRows(orgs, products) {
  return {
    orgs: (orgs || []).map((o) => ({ id: o.id, kind: o.kind, name: o.name })),
    products: (products || []).map((p) => ({
      id: p.id, orgId: p.org_id, type: p.type, name: p.name,
      apr: Number(p.apr), freeMonths: Number(p.free_months),
      maxMonths: Number(p.max_months), feeRate: Number(p.fee_rate), note: p.note || "",
    })),
    updatedAt: null,
  };
}

async function remoteLoad(conn) {
  const uid = conn.user.id;
  const [plans, snapRows, orgRows, prodRows] = await Promise.all([
    sbFetch(conn, `/rest/v1/plans?user_id=eq.${uid}&select=data`),
    sbFetch(conn, `/rest/v1/snapshots?user_id=eq.${uid}&select=id,name,memo,plan,created_at&order=created_at.desc`),
    sbFetch(conn, `/rest/v1/orgs?select=*&order=name.asc`),
    sbFetch(conn, `/rest/v1/products?select=*&order=name.asc`),
  ]);
  return {
    plan: plans && plans[0] ? plans[0].data : null,
    snaps: (snapRows || []).map((r) => ({ id: r.id, name: r.name, memo: r.memo, at: r.created_at, plan: r.plan })),
    catalog: catalogFromRows(orgRows, prodRows),
  };
}

const remoteSavePlan = (conn, plan) =>
  sbFetch(conn, "/rest/v1/plans?on_conflict=user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ user_id: conn.user.id, data: plan, updated_at: new Date().toISOString() }),
  });

async function remoteSyncSnaps(conn, prev, next) {
  const uid = conn.user.id;
  const nextIds = new Set(next.map((s) => s.id));
  const removed = (prev || []).filter((s) => !nextIds.has(s.id)).map((s) => s.id);
  const prevIds = new Set((prev || []).map((s) => s.id));
  const added = next.filter((s) => !prevIds.has(s.id));
  if (removed.length) {
    await sbFetch(conn, `/rest/v1/snapshots?id=in.(${removed.join(",")})`, {
      method: "DELETE", headers: { Prefer: "return=minimal" },
    });
  }
  if (added.length) {
    await sbFetch(conn, "/rest/v1/snapshots", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(added.map((s) => ({ user_id: uid, name: s.name, memo: s.memo, plan: s.plan }))),
    });
  }
}

async function remoteSaveCatalog(conn, prev, next) {
  const uid = conn.user.id;
  const gone = (a, b) => (a || []).filter((x) => !(b || []).some((y) => y.id === x.id)).map((x) => x.id);
  const goneProducts = gone(prev && prev.products, next.products);
  const goneOrgs = gone(prev && prev.orgs, next.orgs);
  if (goneProducts.length) {
    await sbFetch(conn, `/rest/v1/products?id=in.(${goneProducts.join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  if (goneOrgs.length) {
    await sbFetch(conn, `/rest/v1/orgs?id=in.(${goneOrgs.join(",")})`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  if (next.orgs.length) {
    await sbFetch(conn, "/rest/v1/orgs?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(next.orgs.map((o) => ({ id: o.id, kind: o.kind, name: o.name, updated_by: uid, updated_at: new Date().toISOString() }))),
    });
  }
  if (next.products.length) {
    await sbFetch(conn, "/rest/v1/products?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(next.products.map((p) => ({
        id: p.id, org_id: p.orgId || null, type: p.type, name: p.name,
        apr: num(p.apr), free_months: num(p.freeMonths), max_months: num(p.maxMonths),
        fee_rate: num(p.feeRate), note: p.note || "", updated_by: uid, updated_at: new Date().toISOString(),
      }))),
    });
  }
}

/* ---------------- 날짜 유틸 ---------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const nowYM = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
const parseYM = (s) => {
  const [y, m] = String(s).split("-").map(Number);
  return { y, m };
};
const addM = (s, n) => {
  const { y, m } = parseYM(s);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
};
const diffM = (a, b) => {
  const A = parseYM(a), B = parseYM(b);
  return (B.y * 12 + B.m) - (A.y * 12 + A.m);
};
const labelYM = (s) => {
  const { y, m } = parseYM(s);
  return `${String(y).slice(2)}.${pad2(m)}`;
};
const longYM = (s) => {
  const { y, m } = parseYM(s);
  return `${y}년 ${m}월`;
};

/* ---------------- 숫자 유틸 ---------------- */
const uid = () => Math.random().toString(36).slice(2, 9);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function won(n) {
  const v = Math.round(num(n));
  return `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("ko-KR")}원`;
}
function compact(n) {
  const v = Math.round(num(n));
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 100000000) return `${sign}${(a / 100000000).toFixed(a % 100000000 === 0 ? 0 : 1)}억`;
  if (a >= 10000) return `${sign}${Math.round(a / 10000).toLocaleString("ko-KR")}만`;
  return `${sign}${a.toLocaleString("ko-KR")}`;
}
function money(n, unit) {
  return unit === "man" ? compact(n) + "원" : won(n);
}

/* ------------------------------------------------------------------
   입력한 금액을 읽기 쉬운 말로 풀어 씁니다. 120000000 → 1억 2,000만원
   지금은 원화만 지원합니다. 나중에 사용자별 통화 설정이 붙으면
   readable(n, code) 의 code 분기만 늘리면 됩니다.
------------------------------------------------------------------- */
const KR_UNITS = [
  [1000000000000, "조"],
  [100000000, "억"],
  [10000, "만"],
];

function korean(n) {
  const v = Math.round(num(n));
  if (v === 0) return "0원";
  let rest = Math.abs(v);
  const parts = [];
  for (const [u, label] of KR_UNITS) {
    const q = Math.floor(rest / u);
    if (q > 0) {
      parts.push(q.toLocaleString("ko-KR") + label);
      rest -= q * u;
    }
  }
  if (rest > 0) parts.push(rest.toLocaleString("ko-KR"));
  return (v < 0 ? "마이너스 " : "") + parts.join(" ") + "원";
}

const DEFAULT_CURRENCY = "KRW";

function readable(n, code = DEFAULT_CURRENCY) {
  if (code === "KRW") return korean(n);
  return won(n);
}

/* ---------------- 기본값 ---------------- */
const FREQ = [
  { v: "monthly", label: "매월", step: 1 },
  { v: "bimonthly", label: "2개월마다", step: 2 },
  { v: "quarterly", label: "분기", step: 3 },
  { v: "semiannual", label: "반기", step: 6 },
  { v: "yearly", label: "매년", step: 12 },
];
const freqStep = (v) => (FREQ.find((f) => f.v === v) || FREQ[0]).step;

const CATEGORIES = ["급여", "사업·부업", "금융소득", "고정비", "변동비", "교육·육아", "보험", "저축·투자", "기타"];

/* ---------------- 큰 지출 구성 항목 ---------------- */
/* 비용을 한 덩어리로 넣는 대신 항목별로 쌓습니다.
   kind:"amount" 는 금액을 직접, kind:"pct" 는 기준 항목(base) 대비 %로 계산합니다.
   세율·수수료율은 조건마다 달라 기본값을 넣지 않았습니다 — 직접 확인해 입력하세요. */
const BIG_TEMPLATES = [
  {
    id: "house",
    label: "주택 구입",
    hint: "매매가에 세금·수수료·이사비까지 더해 실제로 나가는 돈을 봅니다.",
    lines: [
      { name: "매매가", kind: "amount", base: true },
      { name: "취득세", kind: "pct", note: "가격·면적·주택 수에 따라 다릅니다" },
      { name: "중개수수료", kind: "pct", note: "상한요율은 거래금액 구간별로 다릅니다" },
      { name: "법무사·등기 비용", kind: "amount" },
      { name: "이사비", kind: "amount" },
      { name: "인테리어·수리", kind: "amount" },
    ],
  },
  {
    id: "car",
    label: "자동차 구입",
    hint: "차량 가격에 등록 비용과 초기 지출을 더합니다.",
    lines: [
      { name: "차량 가격", kind: "amount", base: true },
      { name: "취득세", kind: "pct", note: "차종에 따라 다릅니다" },
      { name: "등록 부대비용", kind: "amount", note: "공채, 번호판, 대행료 등" },
      { name: "보험료(1년)", kind: "amount" },
      { name: "탁송료", kind: "amount" },
      { name: "용품·블랙박스", kind: "amount" },
    ],
  },
  {
    id: "rent",
    label: "전세·월세 계약",
    hint: "보증금과 계약에 드는 비용을 함께 봅니다.",
    lines: [
      { name: "보증금", kind: "amount", base: true },
      { name: "중개수수료", kind: "pct" },
      { name: "이사비", kind: "amount" },
      { name: "입주 청소·수리", kind: "amount" },
    ],
  },
];

const newLine = (o = {}) => ({
  id: uid(), name: "", kind: "amount", amount: 0, pct: 0, note: "", base: false, ...o,
});

const makeLines = (tplId) => {
  const t = BIG_TEMPLATES.find((x) => x.id === tplId);
  return t ? t.lines.map((l) => newLine(l)) : [];
};

const baseAmount = (lines) => {
  const b = (lines || []).find((l) => l.base);
  return b ? num(b.amount) : 0;
};

function lineValue(l, base) {
  return l.kind === "pct" ? base * (num(l.pct) / 100) : num(l.amount);
}

function linesTotal(lines) {
  if (!lines || !lines.length) return 0;
  const base = baseAmount(lines);
  return lines.reduce((a, l) => a + lineValue(l, base), 0);
}

const REPAY = [
  { v: "annuity", label: "원리금균등" },
  { v: "equalPrincipal", label: "원금균등" },
  { v: "bullet", label: "만기일시(이자만)" },
];

const SC_COLORS = ["#0F5F6B", "#8A5A16", "#6B2D5C", "#33506B", "#3F6B2F", "#8C3A2E"];

function emptyPlan() {
  return {
    settings: {
      startMonth: nowYM(),
      horizon: 6,
      opening: 0,
      floor: 0,
      unit: "man",
    },
    items: [],
    bigs: [],
    savings: [],
    scenarios: [{ id: "base", name: "기본", color: SC_COLORS[0], note: "", off: {}, ov: {}, inFactor: 100, outFactor: 100 }],
    shown: ["base"],
  };
}

function samplePlan() {
  const start = nowYM();
  const carId = uid();
  const plan = {
    settings: { startMonth: start, horizon: 6, opening: 12000000, floor: 5000000, unit: "man" },
    items: [
      { id: uid(), kind: "recurring", flow: "in", name: "급여(실수령)", amount: 3800000, cat: "급여", freq: "monthly", startMonth: start, endMonth: "", growth: 3 },
      { id: uid(), kind: "recurring", flow: "out", name: "주거비·관리비", amount: 900000, cat: "고정비", freq: "monthly", startMonth: start, endMonth: "", growth: 2 },
      { id: uid(), kind: "recurring", flow: "out", name: "생활비", amount: 1200000, cat: "변동비", freq: "monthly", startMonth: start, endMonth: "", growth: 2.5 },
      { id: uid(), kind: "recurring", flow: "out", name: "보험료", amount: 250000, cat: "보험", freq: "monthly", startMonth: start, endMonth: "", growth: 0 },
      { id: uid(), kind: "recurring", flow: "out", name: "아이 교육·돌봄", amount: 450000, cat: "교육·육아", freq: "monthly", startMonth: start, endMonth: "", growth: 5 },
      { id: uid(), kind: "recurring", flow: "out", name: "명절·경조사", amount: 900000, cat: "기타", freq: "semiannual", startMonth: addM(start, 2), endMonth: "", growth: 0 },
      { id: uid(), kind: "oneoff", flow: "in", name: "성과급", amount: 3000000, cat: "급여", month: addM(start, 5) },
    ],
    bigs: [
      {
        id: carId, name: "자동차 구입", amount: 32000000, month: addM(start, 2),
        method: "installment", productId: "", down: 5000000, months: 36, apr: 5.9,
        feeRate: 0, repayment: "annuity", defer: 1,
      },
    ],
    scenarios: [
      { id: "base", name: "36개월 할부", color: SC_COLORS[0], note: "기준안", off: {}, ov: {}, inFactor: 100, outFactor: 100 },
      { id: uid(), name: "일시불", color: SC_COLORS[1], note: "이자 없이 한 번에", off: {}, ov: { [carId]: { method: "lump" } }, inFactor: 100, outFactor: 100 },
      { id: uid(), name: "3개월 미루기", color: SC_COLORS[2], note: "구입 시점을 3개월 뒤로", off: {}, ov: { [carId]: { month: addM(start, 5) } }, inFactor: 100, outFactor: 100 },
    ],
    shown: [],
  };
  plan.shown = plan.scenarios.map((s) => s.id);
  return plan;
}

function seedCatalog() {
  const orgs = [
    { id: "o1", kind: "bank", name: "시중은행 (예시)" },
    { id: "o2", kind: "card", name: "카드사 (예시)" },
    { id: "o3", kind: "capital", name: "캐피탈 (예시)" },
  ];
  return {
    orgs,
    products: [
      { id: "p1", orgId: "o2", type: "card", name: "무이자 할부 (예시 템플릿)", apr: 0, freeMonths: 6, maxMonths: 6, feeRate: 0, note: "실제 무이자 개월 수는 카드사 공지를 확인해서 수정하세요." },
      { id: "p2", orgId: "o2", type: "installment", name: "일반 카드할부 (예시 템플릿)", apr: 0, freeMonths: 0, maxMonths: 12, feeRate: 0, note: "수수료율은 카드사·기간마다 다릅니다. 직접 입력하세요." },
      { id: "p3", orgId: "o3", type: "installment", name: "자동차 할부 (예시 템플릿)", apr: 0, freeMonths: 0, maxMonths: 60, feeRate: 0, note: "견적서의 실제 금리를 입력하세요." },
      { id: "p4", orgId: "o1", type: "loan", name: "신용대출 (예시 템플릿)", apr: 0, freeMonths: 0, maxMonths: 60, feeRate: 0, note: "본인 승인 금리를 입력하세요." },
      { id: "p5", orgId: "o1", type: "loan", name: "마이너스통장 (예시 템플릿)", apr: 0, freeMonths: 0, maxMonths: 12, feeRate: 0, note: "이자만 내는 구조라면 상환 방식을 '만기일시'로 두세요." },
    ],
    updatedAt: null,
  };
}

/* ------------------------------------------------------------------
   저축 (적금·예금)
   적금 단리: 매달 넣은 돈이 남은 개월 수만큼 이자를 받습니다.
     이자 = 월납입액 × (연이율/12) × n(n+1)/2
   예금 단리: 원금 × 연이율 × (개월/12)
   예금 월복리: 원금 × ((1 + 연이율/12)^n − 1)
   이자소득세 15.4% (소득세 14% + 지방소득세 1.4%) 를 떼고 받습니다.
------------------------------------------------------------------- */
const TAX_RATE = 15.4;

const SAVE_KINDS = [
  { v: "regular", label: "적금", hint: "매달 일정액을 넣고 만기에 찾습니다" },
  { v: "deposit", label: "예금", hint: "목돈을 한 번에 맡기고 만기에 찾습니다" },
];

function savingSchedule(sv) {
  const n = Math.max(1, Math.round(num(sv.months)));
  const r = num(sv.apr) / 100 / 12;
  const amt = num(sv.amount);
  const events = [];
  let principal = 0;
  let interest = 0;

  if (sv.kind === "deposit") {
    principal = amt;
    if (amt > 0) events.push({ month: sv.startMonth, amount: amt, flow: "out", tag: "예치" });
    interest = sv.compound === "monthly"
      ? amt * (Math.pow(1 + r, n) - 1)
      : amt * (num(sv.apr) / 100) * (n / 12);
  } else {
    principal = amt * n;
    for (let i = 0; i < n; i++) {
      if (amt > 0) events.push({ month: addM(sv.startMonth, i), amount: amt, flow: "out", tag: "납입" });
    }
    interest = amt * r * (n * (n + 1) / 2);
  }

  const tax = interest * (num(sv.taxRate) / 100);
  const net = interest - tax;
  const maturity = addM(sv.startMonth, n);
  const payout = principal + net;
  if (payout > 0) events.push({ month: maturity, amount: payout, flow: "in", tag: "만기 수령" });

  return { events, principal, interest, tax, net, payout, maturity, n };
}

/* ---------------- 계산 엔진 ---------------- */
function bigSchedule(be) {
  const price = num(be.amount);
  const events = [];
  let interest = 0;

  if (be.method === "lump") {
    if (price > 0) events.push({ month: be.month, amount: price, tag: "일시불" });
    return { events, interest: 0, financed: 0, monthly: 0, lastMonth: be.month, n: 0 };
  }

  const down = Math.min(Math.max(0, num(be.down)), price);
  if (down > 0) events.push({ month: be.month, amount: down, tag: "선납금" });

  const financed = Math.max(0, price - down);
  const n = Math.max(1, Math.round(num(be.months) || 1));
  const r = num(be.apr) / 100 / 12;
  const fee = financed * (num(be.feeRate) / 100);
  if (fee > 0) events.push({ month: be.month, amount: fee, tag: "취급수수료" });

  const first = addM(be.month, Math.max(0, Math.round(num(be.defer))));
  let monthly = 0;

  if (be.repayment === "equalPrincipal") {
    let rem = financed;
    for (let i = 0; i < n; i++) {
      const p = financed / n;
      const int = rem * r;
      interest += int;
      if (i === 0) monthly = p + int;
      events.push({ month: addM(first, i), amount: p + int, tag: "상환" });
      rem -= p;
    }
  } else if (be.repayment === "bullet") {
    for (let i = 0; i < n; i++) {
      const int = financed * r;
      interest += int;
      const amt = i === n - 1 ? int + financed : int;
      if (i === 0) monthly = amt;
      events.push({ month: addM(first, i), amount: amt, tag: i === n - 1 ? "만기상환" : "이자" });
    }
  } else {
    const pmt = r === 0 ? financed / n : (financed * r) / (1 - Math.pow(1 + r, -n));
    monthly = pmt;
    let rem = financed;
    for (let i = 0; i < n; i++) {
      const int = rem * r;
      interest += int;
      rem -= pmt - int;
      events.push({ month: addM(first, i), amount: pmt, tag: "상환" });
    }
  }
  return { events, interest, financed, monthly, lastMonth: addM(first, n - 1), n };
}

function applyOv(obj, sc) {
  const o = sc.ov && sc.ov[obj.id];
  return o ? { ...obj, ...o } : obj;
}

function compute(plan, sc) {
  const { startMonth, horizon, opening, floor } = plan.settings;
  const H = Math.max(1, Math.round(num(horizon)));
  const months = Array.from({ length: H }, (_, i) => addM(startMonth, i));
  const rows = months.map((m) => ({ month: m, inflow: 0, outflow: 0, notes: [] }));
  const at = (m) => {
    const i = diffM(startMonth, m);
    return i >= 0 && i < H ? rows[i] : null;
  };

  const inF = num(sc.inFactor || 100) / 100;
  const outF = num(sc.outFactor || 100) / 100;

  /* 일반 수입·지출 */
  for (const raw of plan.items) {
    if (sc.off && sc.off[raw.id]) continue;
    const it = applyOv(raw, sc);
    const amt0 = num(it.amount);
    if (amt0 === 0) continue;

    if (it.kind === "oneoff") {
      const r = at(it.month);
      if (!r) continue;
      const v = amt0 * (it.flow === "in" ? inF : outF);
      if (it.flow === "in") r.inflow += v; else r.outflow += v;
      r.notes.push({ name: it.name, amount: v, flow: it.flow });
      continue;
    }

    const step = freqStep(it.freq);
    for (let i = 0; i < H; i++) {
      const m = months[i];
      const d = diffM(it.startMonth || startMonth, m);
      if (d < 0 || d % step !== 0) continue;
      if (it.endMonth && diffM(it.endMonth, m) > 0) continue;
      const years = Math.floor(d / 12);
      const grown = amt0 * Math.pow(1 + num(it.growth) / 100, years);
      const v = grown * (it.flow === "in" ? inF : outF);
      if (it.flow === "in") rows[i].inflow += v; else rows[i].outflow += v;
      rows[i].notes.push({ name: it.name, amount: v, flow: it.flow });
    }
  }

  /* 큰 지출 */
  let interest = 0;
  let tail = 0;
  const bigMonths = new Set();
  const bigDetail = [];
  for (const raw of plan.bigs) {
    if (sc.off && sc.off[raw.id]) continue;
    const be = applyOv(raw, sc);
    const s = bigSchedule(be);
    interest += s.interest;
    bigDetail.push({ be, s });
    for (const ev of s.events) {
      const r = at(ev.month);
      if (!r) { tail += ev.amount; continue; }
      r.outflow += ev.amount;
      r.notes.push({ name: `${be.name} · ${ev.tag}`, amount: ev.amount, flow: "out", big: true });
      bigMonths.add(ev.month);
    }
  }

  /* 저축 */
  let saveOut = 0, saveIn = 0, saveInterest = 0;
  const saveMonths = new Set();
  for (const raw of (plan.savings || [])) {
    if (sc.off && sc.off[raw.id]) continue;
    const sv = applyOv(raw, sc);
    const sch = savingSchedule(sv);
    saveInterest += sch.net;
    for (const ev of sch.events) {
      const row = at(ev.month);
      if (!row) continue;
      if (ev.flow === "in") { row.inflow += ev.amount; saveIn += ev.amount; }
      else { row.outflow += ev.amount; saveOut += ev.amount; }
      row.notes.push({ name: `${sv.name || "저축"} · ${ev.tag}`, amount: ev.amount, flow: ev.flow, saving: true });
      saveMonths.add(ev.month);
    }
  }

  /* 잔고 굴리기 */
  let bal = num(opening);
  let min = Infinity, minMonth = null, breach = null, negative = null;
  let totalIn = 0, totalOut = 0;
  for (const r of rows) {
    r.net = r.inflow - r.outflow;
    bal += r.net;
    r.balance = bal;
    totalIn += r.inflow;
    totalOut += r.outflow;
    if (bal < min) { min = bal; minMonth = r.month; }
    if (breach === null && bal < num(floor)) breach = r.month;
    if (negative === null && bal < 0) negative = r.month;
  }

  return {
    months, rows, bigMonths, bigDetail, saveMonths,
    metrics: {
      end: bal, min, minMonth, breach, negative,
      totalIn, totalOut, interest, tail,
      avgNet: rows.length ? (totalIn - totalOut) / rows.length : 0,
      /* 저축으로 묶인 돈을 빼기 전, 매달 실제로 남는 돈 */
      avgFree: rows.length ? (totalIn - saveIn - (totalOut - saveOut)) / rows.length : 0,
      saveOut, saveIn, saveInterest,
    },
  };
}

/* ------------------------------------------------------------------
   주택 취득 관련 참고 요율
   공식 사이트(위택스·국토교통부·지자체)는 자동 조회가 막혀 있어
   널리 쓰이는 값을 참고값으로 넣어 두었습니다. 조건마다 달라지므로
   실제 계약 전에는 반드시 확인하고 직접 고쳐 쓰세요.
------------------------------------------------------------------- */
const HOME_COUNTS = [
  { v: "1", label: "1주택" },
  { v: "2", label: "2주택" },
  { v: "3", label: "3주택 이상" },
  { v: "corp", label: "법인" },
];

/* 6~9억 구간은 (가액(억) × 2/3 − 3) % */
function acqTaxRate({ price, homes, adjusted }) {
  const eok = num(price) / 100000000;
  const tier = eok <= 6 ? 1 : eok <= 9 ? Math.max(1, (eok * 2) / 3 - 3) : 3;
  if (homes === "corp") return 12;
  if (homes === "3") return adjusted ? 12 : 8;
  if (homes === "2") return adjusted ? 8 : tier;
  return tier;
}

function homeTaxRates({ price, homes, adjusted, over85 }) {
  const acq = acqTaxRate({ price, homes, adjusted });
  const edu = acq <= 3 ? acq * 0.1 : 0.4;
  let farm = 0;
  if (over85) farm = acq <= 3 ? 0.2 : acq <= 8 ? 0.6 : 1.0;
  return {
    acq: Math.round(acq * 1000) / 1000,
    edu: Math.round(edu * 1000) / 1000,
    farm,
  };
}

/* 주택 매매 중개보수 상한요율 (한도액이 있는 구간 포함) */
function brokerFee(price) {
  const p = num(price);
  if (p < 50000000) return { pct: 0.6, cap: 250000 };
  if (p < 200000000) return { pct: 0.5, cap: 800000 };
  if (p < 900000000) return { pct: 0.4, cap: 0 };
  if (p < 1200000000) return { pct: 0.5, cap: 0 };
  if (p < 1500000000) return { pct: 0.6, cap: 0 };
  return { pct: 0.7, cap: 0 };
}

/* ------------------------------------------------------------------
   감당 가능 판정
------------------------------------------------------------------- */
/* 상환이 끝나는 시점까지 보도록 기간을 늘립니다.
   그러지 않으면 "지출을 미루면 괜찮다"처럼 문제가 예측 기간 밖으로
   밀려난 것을 통과로 잘못 읽습니다. */
function extendHorizon(plan) {
  let need = num(plan.settings.horizon);
  for (const b of plan.bigs) {
    const sch = bigSchedule(b);
    const last = sch.lastMonth || b.month;
    need = Math.max(need, diffM(plan.settings.startMonth, last) + 13);
  }
  for (const sv of (plan.savings || [])) {
    const sch = savingSchedule(sv);
    need = Math.max(need, diffM(plan.settings.startMonth, sch.maturity) + 1);
  }
  if (need <= num(plan.settings.horizon)) return plan;
  return { ...plan, settings: { ...plan.settings, horizon: Math.min(need, 600) } };
}

function verdictOf(plan, sc) {
  const r = compute(plan, sc);
  const m = r.metrics;
  const floor = num(plan.settings.floor);
  return {
    ok: !m.breach && !m.negative,
    broke: !!m.negative,
    breach: m.breach,
    min: m.min,
    minMonth: m.minMonth,
    short: Math.max(0, floor - m.min),
    res: r,
  };
}

/* 계획을 조금씩 바꿔 가며 통과하는 지점을 찾습니다 */
function prescribe(plan, sc) {
  const ev = extendHorizon(plan);
  const base = verdictOf(ev, sc);
  if (base.ok) return { ok: true, base, fixes: [] };

  const fixes = [];
  const clone = () => JSON.parse(JSON.stringify(ev));
  const bigs = ev.bigs.filter((b) => !(sc.off && sc.off[b.id]));

  /* 1) 매달 얼마를 더 남겨야 하나 */
  const H = Math.max(1, Math.round(num(ev.settings.horizon)));
  if (base.short > 0) {
    fixes.push({
      kind: "trim",
      label: "매달 덜 쓰기",
      detail: `지금 계획대로면 ${base.minMonth ? longYM(base.minMonth) : ""}에 안전선보다 ${won(base.short)} 모자랍니다.`,
      action: `그때까지 매달 약 ${won(Math.ceil(base.short / Math.max(1, diffM(ev.settings.startMonth, base.minMonth) || H)))}씩 덜 쓰면 넘길 수 있습니다.`,
    });
  }

  /* 2) 큰 지출을 미루면 */
  for (const b of bigs) {
    let found = null;
    for (let d = 1; d <= 36; d++) {
      const p2 = clone();
      const t = p2.bigs.find((x) => x.id === b.id);
      t.month = addM(b.month, d);
      if (verdictOf(extendHorizon(p2), sc).ok) { found = d; break; }
    }
    if (found) {
      fixes.push({
        kind: "delay",
        label: `${b.name || "큰 지출"} 미루기`,
        detail: `${found}개월 미뤄 ${longYM(addM(b.month, found))}에 하면`,
        action: "예측 기간 내내 안전선을 지킵니다.",
        apply: (p) => { const t = p.bigs.find((x) => x.id === b.id); if (t) t.month = addM(b.month, found); },
      });
    }
  }

  /* 3) 상환 기간을 늘리면 */
  for (const b of bigs) {
    if (b.method === "lump") continue;
    let found = null;
    for (const n of [24, 36, 48, 60, 72, 84, 120, 180, 240, 360]) {
      if (n <= num(b.months)) continue;
      const p2 = clone();
      const t = p2.bigs.find((x) => x.id === b.id);
      t.months = n;
      if (verdictOf(extendHorizon(p2), sc).ok) { found = n; break; }
    }
    if (found) {
      const s0 = bigSchedule(b);
      const s1 = bigSchedule({ ...b, months: found });
      fixes.push({
        kind: "stretch",
        label: `${b.name || "큰 지출"} 기간 늘리기`,
        detail: `${num(b.months)}개월 → ${found}개월로 늘리면 월 ${won(s0.monthly)} → ${won(s1.monthly)}`,
        action: `대신 이자가 ${won(s1.interest - s0.interest)} 더 듭니다.`,
        apply: (p) => { const t = p.bigs.find((x) => x.id === b.id); if (t) t.months = found; },
      });
    }
  }

  /* 4) 규모를 줄이면 */
  for (const b of bigs) {
    let found = null;
    for (const pct of [95, 90, 85, 80, 75, 70, 60, 50]) {
      const p2 = clone();
      const t = p2.bigs.find((x) => x.id === b.id);
      t.amount = Math.round(num(b.amount) * pct / 100);
      if (t.lines) t.lines = null;
      if (verdictOf(extendHorizon(p2), sc).ok) { found = pct; break; }
    }
    if (found) {
      fixes.push({
        kind: "shrink",
        label: `${b.name || "큰 지출"} 예산 줄이기`,
        detail: `${won(b.amount)} → ${won(Math.round(num(b.amount) * found / 100))} (${100 - found}% 줄임)`,
        action: "이 선까지는 지금 수입으로 감당됩니다.",
      });
    }
  }

  return { ok: false, base, fixes };
}

/* ------------------------------------------------------------------
   입력 점검
   빠진 항목이 있으면 예측은 대개 실제보다 낙관적으로 나옵니다.
   무엇이 비어 있는지, 왜 필요한지, 어디로 가면 되는지 알려줍니다.
------------------------------------------------------------------- */
const hasWord = (items, re, flow) =>
  items.some((i) => (!flow || i.flow === flow) && re.test(String(i.name || "")));

function checkGaps(plan, res) {
  const items = plan.items || [];
  const outs = items.filter((i) => i.flow === "out");
  const recurOut = outs.filter((i) => i.kind !== "oneoff");
  const g = [];
  const add = (level, tab, title, why, label) => g.push({ level, tab, title, why, label: label || title });

  if (!items.some((i) => i.flow === "in")) {
    add("must", "items", "수입이 없습니다", "들어오는 돈이 없으면 잔고는 줄기만 합니다. 실수령 기준으로 넣으세요.", "수입");
  }
  if (!recurOut.length) {
    add("must", "items", "매달 나가는 돈이 없습니다", "지출을 넣지 않으면 쓰지 않고 사는 것으로 계산됩니다.", "지출");
  } else {
    if (!hasWord(outs, /주거|월세|전세|관리비|임대|주택/)) {
      add("must", "items", "주거비가 안 보입니다", "대개 지출에서 가장 큰 몫입니다. 월세·관리비·주택담보대출 상환을 넣으세요.", "주거비");
    }
    if (!hasWord(outs, /식비|생활|장보|먹|마트/)) {
      add("must", "items", "식비·생활비가 안 보입니다", "가장 자주 빠지고 가장 크게 어긋나는 항목입니다.", "식비·생활비");
    }
    if (!hasWord(outs, /통신|휴대|핸드폰|인터넷/)) {
      add("should", "items", "통신비가 안 보입니다", "줄이기 가장 쉬운 고정비이기도 합니다.");
    }
    if (!hasWord(outs, /보험/)) {
      add("should", "items", "보험료가 안 보입니다", "없다면 넘어가도 됩니다. 연납이면 주기를 매년으로 두세요.");
    }
    if (!hasWord(outs, /교통|차량|주유|기름|대중교통/)) {
      add("nice", "items", "교통비·차량유지비가 안 보입니다", "주유, 대중교통, 보험 외 차량 유지비를 말합니다.");
    }
  }

  const irregular = outs.some((i) => i.kind === "oneoff" || ["quarterly", "semiannual", "yearly"].includes(i.freq));
  if (recurOut.length && !irregular) {
    add("must", "items", "달력에 없는 지출이 하나도 없습니다",
      "경조사·명절·자동차세·보험 연납처럼 매달 나가지 않는 돈입니다. 이게 빠지면 특정 달에만 갑자기 모자랍니다.", "불규칙 지출");
  }

  const grown = recurOut.filter((i) => num(i.growth) > 0).length;
  if (recurOut.length >= 3 && grown === 0) {
    add("should", "items", "물가 상승이 반영되지 않았습니다",
      "모든 항목의 연 증가율이 0입니다. 몇 년을 보는 계획이라면 지출은 해마다 오릅니다.");
  }

  if (num(plan.settings.opening) <= 0) {
    add("must", "dash", "시작 잔고가 0입니다", "지금 쓸 수 있는 현금을 넣어야 어디서 출발하는지 알 수 있습니다.", "시작 잔고");
  }

  const monthlyOut = recurOut.reduce((a, i) => a + num(i.amount) / freqStep(i.freq), 0);
  const floor = num(plan.settings.floor);
  if (floor <= 0) {
    add("must", "dash", "안전선이 0입니다", "잔고가 바닥나기 직전까지 '여유 있음'으로 나옵니다. 생활비 3~6개월치로 잡으세요.", "안전선");
  } else if (monthlyOut > 0 && floor < monthlyOut * 3) {
    add("should", "dash", "안전선이 낮습니다",
      `생활비 ${(floor / monthlyOut).toFixed(1)}개월치입니다. 수입이 끊기면 버티기 빠듯합니다.`);
  }

  if (!(plan.bigs || []).length) {
    add("should", "bigs", "계획 중인 큰 지출이 없습니다", "이 도구는 그 지출을 감당할 수 있는지 재는 쪽에 쓸모가 있습니다.");
  }

  const free = res.metrics.avgFree;
  if (free > 300000 && !(plan.savings || []).length) {
    add("nice", "save", "남는 돈이 묶여 있지 않습니다",
      `매달 ${won(free)}이 통장에 그냥 쌓입니다. 쓸 일이 정해지지 않았다면 적금으로 옮기는 편이 낫습니다.`);
  }

  /* 상환이 예측 기간 밖에서 끝나면 지금 화면은 절반만 보여주는 셈입니다 */
  if (res.metrics.tail > 0) {
    add("should", "dash", "예측 기간이 상환보다 짧습니다",
      `기간 뒤에도 ${won(res.metrics.tail)}을 더 갚아야 합니다. 기간을 늘려야 끝까지 보입니다.`);
  }

  return g;
}

/* ---------------- 작은 UI 조각 ---------------- */
function Field({ label, hint, children, wide }) {
  return (
    <label className={`fld${wide ? " wide" : ""}`}>
      <span className="fld-l">
        {label}
        {hint ? <em className="fld-h">{hint}</em> : null}
      </span>
      {children}
    </label>
  );
}

function NumIn({ value, onChange, suffix, step = 1, min, comma }) {
  if (comma) {
    const shown =
      value === "" || value === null || value === undefined || Number.isNaN(Number(value))
        ? ""
        : Number(value).toLocaleString("ko-KR");
    /* 금액은 오른쪽 정렬이라 칸 왼쪽이 빕니다.
       거기에 읽기 쉬운 한글 표기를 넣어 줄 하나를 아낍니다. */
    return (
      <span className="numwrap boxed">
        <em className="krin">{readable(value)}</em>
        <input
          className="mono"
          type="text"
          inputMode="numeric"
          value={shown}
          onChange={(e) => {
            const neg = e.target.value.trim().startsWith("-");
            const digits = e.target.value.replace(/[^0-9]/g, "");
            if (digits === "") { onChange(0); return; }
            onChange(Number(digits) * (neg ? -1 : 1));
          }}
        />
      </span>
    );
  }
  return (
    <span className="numwrap">
      <input
        className="in mono"
        type="number"
        step={step}
        min={min}
        value={value === "" || value === null || value === undefined ? "" : value}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      />
      {suffix ? <em>{suffix}</em> : null}
    </span>
  );
}

/* 받침이 있으면 "을", 없으면 "를" */
function objPart(word) {
  const ch = String(word || "").trim().slice(-1);
  const c = ch.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 === 0 ? "를" : "을";
  return "을";
}

/* 지우기 전에 무엇을 지우는지 이름을 보여주고 한 번 묻습니다. */
function Confirm({ open, name, kind, note, onConfirm, onCancel, confirmLabel = "삭제" }) {
  if (!open) return null;
  const shown = String(name || "").trim();
  return (
    <Modal title={`${kind} 삭제`} onClose={onCancel}
      footer={<>
        <button className="btn" onClick={onCancel}>취소</button>
        <button className="btn danger" onClick={onConfirm}>{confirmLabel}</button>
      </>}>
      <p className="confirm-msg">
        {shown ? <b>&lsquo;{shown}&rsquo;</b> : <span className="mut">이름 없는</span>} {kind}{objPart(kind)} 삭제하시겠습니까?
      </p>
      <p className="mut sm">{note || "되돌릴 수 없습니다."}</p>
    </Modal>
  );
}

function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-label={title}>
        <div className="modal-h">
          <h3>{title}</h3>
          <button className="icon" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="modal-b">{children}</div>
        {footer ? <div className="modal-f">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- 시그니처: 잔고 스트립 ---------------- */
function LevelStrip({ result, floor, unit }) {
  const [hover, setHover] = useState(null);
  const rows = result.rows;
  const vals = rows.map((r) => r.balance);
  const hi = Math.max(...vals, num(floor), 0);
  const lo = Math.min(...vals, 0);
  const span = hi - lo || 1;
  const zero = ((hi - 0) / span) * 100;
  const floorPct = ((hi - num(floor)) / span) * 100;

  const active = hover !== null ? rows[hover] : rows[rows.length - 1];

  return (
    <div className="strip-card">
      <div className="strip-head">
        <span className="eyebrow">월말 잔고 추이</span>
        <span className="strip-read mono">
          {longYM(active.month)} · <b>{money(active.balance, unit)}</b>
          {active.balance < 0 ? <i className="tag bad">마이너스</i>
            : active.balance < num(floor) ? <i className="tag warn">안전선 아래</i>
            : <i className="tag ok">여유</i>}
        </span>
      </div>
      <div className="strip" onMouseLeave={() => setHover(null)}>
        <div className="strip-line zero" style={{ top: `${zero}%` }} />
        {num(floor) > 0 && <div className="strip-line floor" style={{ top: `${floorPct}%` }} />}
        {rows.map((r, i) => {
          const top = ((hi - Math.max(r.balance, 0)) / span) * 100;
          const bottom = 100 - ((hi - Math.min(r.balance, 0)) / span) * 100;
          const state = r.balance < 0 ? "bad" : r.balance < num(floor) ? "warn" : "ok";
          return (
            <div
              key={r.month}
              className={`cell ${state}${hover === i ? " on" : ""}`}
              onMouseEnter={() => setHover(i)}
              title={`${longYM(r.month)} · ${won(r.balance)}`}
            >
              <span className="bar" style={{ top: `${Math.min(top, zero)}%`, bottom: `${Math.min(bottom, 100 - zero)}%` }} />
              {result.bigMonths.has(r.month) && <span className="pip" />}
            </div>
          );
        })}
      </div>
      {rows.length <= 12 && (
        <div className="strip-axis mono">
          {rows.map((r, i) => (
            <span key={r.month} className={hover === i ? "on" : ""}>{labelYM(r.month)}</span>
          ))}
        </div>
      )}
      <div className="strip-foot mono">
        <span>{labelYM(rows[0].month)}</span>
        <span className="legend">
          <i className="sw ok" />여유 <i className="sw warn" />안전선 아래 <i className="sw bad" />마이너스 <i className="sw pipm" />큰 지출
        </span>
        <span>{labelYM(rows[rows.length - 1].month)}</span>
      </div>
    </div>
  );
}

/* ---------------- 메인 ---------------- */
/* ------------------------------------------------------------------
   아주 작은 라우터
   계산기는 /, 읽을거리와 약관은 각자의 주소를 가집니다.
   Netlify 의 _redirects 가 모든 경로를 index.html 로 보내 줍니다.
------------------------------------------------------------------- */
const TITLES = {
  "/": `${SERVICE.name} — ${SERVICE.tagline}`,
  "/about": `소개 · ${SERVICE.name}`,
  "/guide": `가이드 · ${SERVICE.name}`,
  "/privacy": `개인정보처리방침 · ${SERVICE.name}`,
  "/terms": `이용약관 · ${SERVICE.name}`,
};

function useRoute() {
  const [path, setPath] = useState(() => window.location.pathname || "/");

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPop);

    /* 같은 사이트 안의 링크는 새로고침 없이 이동합니다 */
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!href || !href.startsWith("/") || a.target === "_blank") return;
      e.preventDefault();
      if (href !== window.location.pathname) window.history.pushState({}, "", href);
      setPath(href);
      window.scrollTo(0, 0);
    };
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, []);

  useEffect(() => {
    const guide = path.startsWith("/guide/") ? GUIDES.find((g) => g.slug === path.slice(7)) : null;
    const title = guide ? `${guide.title} · ${SERVICE.name}` : (TITLES[path] || SERVICE.name);
    document.title = title;
    const desc = guide ? guide.summary : SERVICE.tagline;
    let tag = document.querySelector('meta[name="description"]');
    if (!tag) {
      tag = document.createElement("meta");
      tag.setAttribute("name", "description");
      document.head.appendChild(tag);
    }
    tag.setAttribute("content", desc);
  }, [path]);

  const go = (to) => (e) => {
    if (e) e.preventDefault();
    window.history.pushState({}, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  };

  return [path, go];
}

export default function App() {
  const [path, go] = useRoute();
  const home = go("/");

  if (path === "/about") return <AboutPage onHome={home} />;
  if (path === "/guide") return <GuideIndex onHome={home} />;
  if (path.startsWith("/guide/")) return <GuidePage slug={path.slice(7)} onHome={home} />;
  if (path === "/privacy") return <LegalPage which="privacy" onHome={home} />;
  if (path === "/terms") return <LegalPage which="terms" onHome={home} />;
  return <Cashflow />;
}

function Cashflow() {
  const [plan, setPlan] = useState(emptyPlan);
  const [catalog, setCatalog] = useState(seedCatalog);
  const [snaps, setSnaps] = useState([]);
  const [conn, setConn] = useState({
    url: HOSTED ? SUPABASE_URL : "",
    key: HOSTED ? SUPABASE_KEY : "",
    token: "", refresh: "", user: null,
  });
  const [tab, setTab] = useState("dash");
  const [wizard, setWizard] = useState(false);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("");
  const loaded = useRef(false);
  const connRef = useRef(conn);
  const snapsRef = useRef([]);
  const catalogRef = useRef(null);

  useEffect(() => { connRef.current = conn; }, [conn]);
  useEffect(() => { snapsRef.current = snaps; }, [snaps]);
  useEffect(() => { catalogRef.current = catalog; }, [catalog]);

  const online = !!(conn.url && conn.key && conn.token && conn.user);

  /* 로컬 불러오기 */
  const loadLocal = useCallback(async () => {
    try {
      const r = await storage.get(K_PLAN);
      if (r && r.value) setPlan(migrate(JSON.parse(r.value)));
    } catch (e) { /* 저장된 계획 없음 — 빈 상태로 시작 */ }
    try {
      const r = await storage.get(K_SNAPS);
      if (r && r.value) setSnaps(JSON.parse(r.value));
    } catch (e) { /* 스냅샷 없음 */ }
    try {
      const r = await storage.get(K_CATALOG, true);
      if (r && r.value) setCatalog(JSON.parse(r.value));
      else await storage.set(K_CATALOG, JSON.stringify(seedCatalog()), true);
    } catch (e) {
      try { await storage.set(K_CATALOG, JSON.stringify(seedCatalog()), true); } catch (e2) { /* 공용 저장소 사용 불가 */ }
    }
  }, []);

  /* 서버에서 불러오기 */
  const pullRemote = useCallback(async (c) => {
    const use = c || connRef.current;
    const d = await remoteLoad(use);
    if (d.plan) setPlan(migrate(d.plan));
    setSnaps(d.snaps);
    if (d.catalog.orgs.length || d.catalog.products.length) setCatalog(d.catalog);
    setStatus("서버에서 불러옴");
    return d;
  }, []);

  useEffect(() => {
    (async () => {
      let saved = null;
      try {
        const r = await storage.get(K_CONN);
        if (r && r.value) saved = JSON.parse(r.value);
      } catch (e) { /* 연결 설정 없음 */ }

      /* 서비스로 운영 중이면 주소·키는 항상 빌드 값을 씁니다.
         예전에 저장된 값이 남아 있어도 토큰만 이어받습니다. */
      if (HOSTED && saved) saved = { ...saved, url: SUPABASE_URL, key: SUPABASE_KEY };

      if (saved && saved.url && saved.key) {
        setConn(saved);
        connRef.current = saved;
        if (saved.token && saved.user) {
          try {
            await pullRemote(saved);
            loaded.current = true;
            setReady(true);
            return;
          } catch (e) {
            try {
              const t = await sbRefresh(saved);
              const next = { ...saved, token: t.access_token, refresh: t.refresh_token, user: t.user };
              setConn(next);
              connRef.current = next;
              await storage.set(K_CONN, JSON.stringify(next));
              await pullRemote(next);
              loaded.current = true;
              setReady(true);
              return;
            } catch (e2) {
              setStatus("서버 연결이 만료되어 로컬 데이터를 사용합니다");
            }
          }
        }
      }
      await loadLocal();
      loaded.current = true;
      setReady(true);
    })();
  }, [loadLocal, pullRemote]);

  const persistConn = useCallback(async (next) => {
    setConn(next);
    connRef.current = next;
    try { await storage.set(K_CONN, JSON.stringify(next)); }
    catch (e) { /* 연결 설정 저장 실패는 무시 */ }
  }, []);

  function migrate(p) {
    const base = emptyPlan();
    const merged = { ...base, ...p, settings: { ...base.settings, ...(p.settings || {}) } };
    if (!Array.isArray(merged.savings)) merged.savings = [];
    if (!merged.scenarios || !merged.scenarios.length) merged.scenarios = base.scenarios;
    merged.scenarios = merged.scenarios.map((s) => ({ off: {}, ov: {}, inFactor: 100, outFactor: 100, ...s }));
    if (!merged.shown || !merged.shown.length) merged.shown = [merged.scenarios[0].id];
    merged.shown = merged.shown.filter((id) => merged.scenarios.some((s) => s.id === id));
    if (!merged.shown.length) merged.shown = [merged.scenarios[0].id];
    return merged;
  }

  /* 자동 저장 */
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(async () => {
      const c = connRef.current;
      const isOnline = !!(c.url && c.key && c.token && c.user);
      try { await storage.set(K_PLAN, JSON.stringify(plan)); } catch (e) { /* 로컬 저장 실패 */ }
      if (isOnline) {
        try {
          await remoteSavePlan(c, plan);
          setStatus("서버 저장 " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
        } catch (e) {
          setStatus("서버 저장 실패 — 로컬에만 보관됨");
        }
      } else {
        setStatus("이 브라우저에 저장 " + new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }));
      }
    }, 700);
    return () => clearTimeout(t);
  }, [plan]);

  const saveSnaps = useCallback(async (next) => {
    const prev = snapsRef.current;
    setSnaps(next);
    try { await storage.set(K_SNAPS, JSON.stringify(next)); } catch (e) { /* 로컬 저장 실패 */ }
    const c = connRef.current;
    if (c.url && c.key && c.token && c.user) {
      try {
        await remoteSyncSnaps(c, prev, next);
        const d = await remoteLoad(c);
        setSnaps(d.snaps);
      } catch (e) { setStatus("스냅샷 서버 동기화 실패"); }
    }
  }, []);

  const saveCatalog = useCallback(async (next) => {
    const prev = catalogRef.current;
    const withTime = { ...next, updatedAt: new Date().toISOString() };
    setCatalog(withTime);
    try { await storage.set(K_CATALOG, JSON.stringify(withTime), true); } catch (e) { /* 로컬 저장 실패 */ }
    const c = connRef.current;
    if (c.url && c.key && c.token && c.user) {
      try { await remoteSaveCatalog(c, prev, withTime); }
      catch (e) { setStatus("공용 카탈로그 서버 저장 실패 — " + e.message); }
    }
  }, []);

  /* 계산 */
  const results = useMemo(() => {
    const map = {};
    for (const sc of plan.scenarios) map[sc.id] = compute(plan, sc);
    return map;
  }, [plan]);

  const primary = plan.scenarios.find((s) => s.id === plan.shown[0]) || plan.scenarios[0];
  const primaryRes = results[primary.id];
  const unit = plan.settings.unit;

  const chartData = useMemo(() => {
    const months = primaryRes.months;
    return months.map((m, i) => {
      const row = { month: m, label: labelYM(m) };
      for (const id of plan.shown) {
        const r = results[id];
        if (r && r.rows[i]) row[id] = Math.round(r.rows[i].balance);
      }
      return row;
    });
  }, [plan.shown, results, primaryRes]);

  const up = (fn) => setPlan((p) => { const c = JSON.parse(JSON.stringify(p)); fn(c); return c; });

  if (!ready) {
    return (
      <div className="app">
        <Style />
        <div className="boot mono">불러오는 중…</div>
      </div>
    );
  }

  const empty = plan.items.length === 0 && plan.bigs.length === 0;

  return (
    <div className="app">
      <Style />
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>감당할수있겠나!</h1>
            <p className="tagline">큰 지출을 감당할 수 있는지 미리 굴려보는 가계 현금흐름 예측 시스템</p>
          </div>
        </div>
        <div className="topright">
          <button className="wizbtn" onClick={() => setWizard(true)}
            title="버는 돈·쓰는 돈·큰 지출을 차례로 넣고 감당 가능한지 판정합니다">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M4 20 14.5 9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
              <path d="M13 8.5 15.5 11" stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none" />
              <path d="M18 3v4M16 5h4M6.5 4v2.5M5.2 5.2h2.6M19 14v2.5M17.7 15.2h2.6"
                stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
            </svg>
            <span className="wizlabel">설정 마법사</span>
            <span className="wizlabel-sm">마법사</span>
          </button>
          <a className="guidebtn" href="/guide" title="올바른 가계경제를 만드는 순서와 기준">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
              <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5z"
                stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
              <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5z"
                stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
            </svg>
            <span className="wizlabel">가계경제 가이드</span>
            <span className="wizlabel-sm">가이드</span>
          </a>
          <div className="topmeta">
            <span className={online ? "conn on" : "conn"} onClick={() => setTab("conn")} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter") setTab("conn"); }}>
              <i className="dot" style={{ background: online ? "#1F6B4E" : "#9AA9AE" }} />
              {online ? conn.user.email : HOSTED ? "로그인하면 어디서든" : "이 브라우저에만 저장 중"}
            </span>
            <span className="mono stat-line">{status}</span>
          </div>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {[
          ["dash", "대시보드"],
          ["items", "수입·지출"],
          ["bigs", "큰 지출"],
          ["save", "저축"],
          ["tips", "아껴보기"],
          ["scen", "시나리오"],
          ["cat", "상품 카탈로그"],
          ["snap", "스냅샷"],
          ["conn", "계정"],
        ].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "tb on" : "tb"} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      <main>
        {tab === "dash" && (
          empty ? (
            <div className="empty">
              <p className="eyebrow">시작하기</p>
              <h2>그 지출, 하고 나서도 생활이 돌아갈까요?</h2>
              <p>
                버는 돈과 쓰는 돈, 그리고 계획 중인 큰 지출을 차례로 넣으면
                앞으로 몇 년치 잔고가 어떻게 움직이는지, 감당할 수 있는지 판정해 드립니다.
              </p>
              <div className="row">
                <button className="btn primary" onClick={() => setWizard(true)}>차근차근 시작하기</button>
                <button className="btn" onClick={() => setPlan(samplePlan())}>예시로 채우기</button>
                <button className="btn" onClick={() => setTab("items")}>직접 입력하기</button>
              </div>
            </div>
          ) : (
            <Dashboard
              plan={plan} results={results} primary={primary} chartData={chartData}
              unit={unit} up={up} setTab={setTab}
            />
          )
        )}
        {tab === "items" && <ItemsTab plan={plan} up={up} unit={unit} />}
        {tab === "bigs" && <BigsTab plan={plan} up={up} unit={unit} catalog={catalog} results={results} primary={primary} />}
        {tab === "save" && <SavingsTab plan={plan} up={up} unit={unit} results={results} primary={primary} />}
        {tab === "tips" && <SaveTab plan={plan} conn={conn} unit={unit} setTab={setTab} />}
        {tab === "scen" && <ScenTab plan={plan} up={up} unit={unit} results={results} />}
        {tab === "cat" && <CatalogTab catalog={catalog} saveCatalog={saveCatalog} />}
        {tab === "snap" && <SnapTab plan={plan} setPlan={setPlan} snaps={snaps} saveSnaps={saveSnaps} results={results} primary={primary} unit={unit} />}
        {tab === "conn" && (
          <ConnTab
            conn={conn} persistConn={persistConn} online={online}
            plan={plan} snaps={snaps} catalog={catalog} setPlan={setPlan}
            pullRemote={pullRemote} setStatus={setStatus} setSnaps={setSnaps}
          />
        )}
      </main>

      {wizard && <Wizard plan={plan} setPlan={setPlan} onClose={() => setWizard(false)} />}

      <footer className="foot">
        <a href="/about" className="ilink">소개</a>
        <span className="fdot">·</span>
        <a href="/guide" className="ilink">가이드</a>
        <span className="fdot">·</span>
        <a href="/privacy" className="ilink">개인정보처리방침</a>
        <span className="fdot">·</span>
        <a href="/terms" className="ilink">이용약관</a>
        <span className="fdot">·</span>
        {online ? "내 계정에 저장됩니다" : "지금은 이 브라우저에만 저장됩니다"}
      </footer>
    </div>
  );
}

/* ---------------- 설정 마법사 ---------------- */
const LIVING = [
  { name: "주거비·관리비", cat: "고정비" },
  { name: "식비·생활용품", cat: "변동비" },
  { name: "통신비", cat: "고정비" },
  { name: "교통비·차량유지", cat: "변동비" },
  { name: "보험료", cat: "보험" },
  { name: "교육·육아", cat: "교육·육아" },
  { name: "용돈·여가", cat: "변동비" },
];

function Wizard({ plan, setPlan, onClose }) {
  const [step, setStep] = useState(0);
  const [delLiving, setDelLiving] = useState(null);
  const [d, setD] = useState(() => ({
    startMonth: plan.settings.startMonth || nowYM(),
    horizon: 60,
    opening: num(plan.settings.opening),
    floor: num(plan.settings.floor),
    income: 0,
    incomeGrowth: 3,
    bonus: 0,
    bonusMonth: addM(plan.settings.startMonth || nowYM(), 6),
    living: LIVING.map((l) => ({ ...l, amount: 0 })),
    extraLiving: [],
    wantBig: true,
    bigName: "",
    bigKind: "house",
    bigMonth: addM(plan.settings.startMonth || nowYM(), 12),
    price: 0,
    homes: "1",
    adjusted: false,
    over85: false,
    extras: 0,
    cash: 0,
    loanMonths: 360,
    loanApr: 0,
    loanRepay: "annuity",
  }));

  const set = (patch) => setD({ ...d, ...patch });

  const livingTotal =
    d.living.reduce((a, l) => a + num(l.amount), 0) +
    d.extraLiving.reduce((a, l) => a + num(l.amount), 0);
  const monthlyNet = num(d.income) - livingTotal;

  /* 큰 지출 총액: 가격 + 세금·수수료 + 기타 */
  const rates = homeTaxRates({ price: d.price, homes: d.homes, adjusted: d.adjusted, over85: d.over85 });
  const broker = brokerFee(d.price);
  const taxAmt = num(d.price) * (rates.acq + rates.edu + rates.farm) / 100;
  const brokerAmt = broker.cap
    ? Math.min(num(d.price) * broker.pct / 100, broker.cap)
    : num(d.price) * broker.pct / 100;
  const bigTotal = d.bigKind === "house"
    ? num(d.price) + taxAmt + brokerAmt + num(d.extras)
    : num(d.price) + num(d.extras);
  const loanAmt = Math.max(0, bigTotal - num(d.cash));

  /* 입력한 내용으로 임시 계획을 만들어 판정 */
  const draft = useMemo(() => {
    const items = [];
    if (num(d.income) > 0) {
      items.push({ id: uid(), kind: "recurring", flow: "in", name: "급여(실수령)", amount: num(d.income),
        cat: "급여", freq: "monthly", startMonth: d.startMonth, endMonth: "", growth: num(d.incomeGrowth) });
    }
    if (num(d.bonus) > 0) {
      items.push({ id: uid(), kind: "oneoff", flow: "in", name: "성과급·상여", amount: num(d.bonus), cat: "급여", month: d.bonusMonth });
    }
    for (const l of [...d.living, ...d.extraLiving]) {
      if (num(l.amount) > 0) {
        items.push({ id: uid(), kind: "recurring", flow: "out", name: l.name || "지출", amount: num(l.amount),
          cat: l.cat || "변동비", freq: "monthly", startMonth: d.startMonth, endMonth: "", growth: 2 });
      }
    }
    const bigs = [];
    if (d.wantBig && bigTotal > 0) {
      bigs.push({
        id: "wiz-big", name: d.bigName || (d.bigKind === "house" ? "주택 구입" : d.bigKind === "car" ? "자동차 구입" : "큰 지출"),
        amount: bigTotal, month: d.bigMonth,
        method: loanAmt > 0 ? "loan" : "lump",
        productId: "", down: num(d.cash), months: Math.max(1, num(d.loanMonths)),
        apr: num(d.loanApr), feeRate: 0, repayment: d.loanRepay, defer: 1,
      });
    }
    return {
      settings: { startMonth: d.startMonth, horizon: num(d.horizon), opening: num(d.opening), floor: num(d.floor), unit: plan.settings.unit },
      items, bigs, savings: [],
      scenarios: [{ id: "base", name: "기본", color: SC_COLORS[0], note: "", off: {}, ov: {}, inFactor: 100, outFactor: 100 }],
      shown: ["base"],
    };
  }, [d, bigTotal, loanAmt, plan.settings.unit]);

  const advice = useMemo(() => {
    if (!draft.items.length) return null;
    return prescribe(draft, draft.scenarios[0]);
  }, [draft]);

  const apply = () => {
    setPlan({ ...draft, scenarios: draft.scenarios, shown: ["base"] });
    onClose();
  };

  const STEPS = ["지금 사정", "매달 나가는 돈", "큰 지출", "자금 조달", "감당 가능한가"];
  const canNext = step < STEPS.length - 1;
  const skipFunding = !d.wantBig;

  const go = (n) => {
    if (n === 3 && skipFunding) n = step < 3 ? 4 : 2;
    setStep(Math.max(0, Math.min(STEPS.length - 1, n)));
  };

  return (
    <Modal title="처음 설정" wide onClose={onClose}
      footer={<>
        {step > 0 && <button className="btn" onClick={() => go(step - 1)}>이전</button>}
        <span style={{ flex: 1 }} />
        {canNext
          ? <button className="btn primary" onClick={() => go(step + 1)}>다음</button>
          : <button className="btn primary" onClick={apply}>이대로 시작하기</button>}
      </>}>
      <ol className="wsteps">
        {STEPS.map((t, i) => (
          <li key={t} className={i === step ? "on" : i < step ? "done" : ""}>
            <b>{i + 1}</b>{t}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <p className="note">지금 가진 돈과 버는 돈부터 적습니다. 대략이어도 괜찮아요. 나중에 언제든 고칠 수 있습니다.</p>
          <div className="grid">
            <Field label="지금 쓸 수 있는 현금" hint="예금·적금 등 바로 꺼낼 수 있는 돈">
              <NumIn value={d.opening} step={1000000} onChange={(v) => set({ opening: num(v) })} suffix="원" comma />
            </Field>
            <Field label="매달 들어오는 돈" hint="실수령 기준">
              <NumIn value={d.income} step={100000} onChange={(v) => set({ income: num(v) })} suffix="원" comma />
            </Field>
            <Field label="연봉 인상률" hint="모르면 그대로 두세요">
              <NumIn value={d.incomeGrowth} step={0.5} onChange={(v) => set({ incomeGrowth: num(v) })} suffix="%" />
            </Field>
            <Field label="상여·성과급" hint="없으면 0">
              <NumIn value={d.bonus} step={1000000} onChange={(v) => set({ bonus: num(v) })} suffix="원" comma />
            </Field>
            <Field label="최소 유지 잔고" hint="이 아래로 떨어지면 위험 신호">
              <NumIn value={d.floor} step={1000000} onChange={(v) => set({ floor: num(v) })} suffix="원" comma />
            </Field>
            <Field label="얼마나 앞을 볼까요">
              <select className="in" value={d.horizon} onChange={(e) => set({ horizon: Number(e.target.value) })}>
                {[12, 24, 36, 60, 120, 240, 360].map((h) => <option key={h} value={h}>{h}개월</option>)}
              </select>
            </Field>
          </div>
          <div className="wtip">
            최소 유지 잔고는 <b>생활비 3~6개월치</b>를 많이 씁니다. 갑자기 수입이 끊겨도 버틸 수 있는 선이에요.
          </div>
        </>
      )}

      {step === 1 && (
        <>
          <p className="note">
            매달 반복해서 나가는 돈입니다. 0으로 두면 계산에서 빠집니다.
            <b> 식비와 생활비는 기억으로 적으면 대개 실제보다 적게 나옵니다.</b>{" "}
            카드 결제 내역을 한 달치 훑어보고 넣으면 뒤의 판정이 훨씬 정확해집니다.
          </p>
          <div className="lines">
            {d.living.map((l, i) => (
              <div key={l.name} className="wrow">
                <span className="wlabel">{l.name}</span>
                <NumIn value={l.amount} step={50000} suffix="원" comma
                  onChange={(v) => { const n = [...d.living]; n[i] = { ...l, amount: num(v) }; set({ living: n }); }} />
              </div>
            ))}
            {d.extraLiving.map((l, i) => (
              <div key={i} className="wrow">
                <input className="in" value={l.name} placeholder="항목 이름"
                  onChange={(e) => { const n = [...d.extraLiving]; n[i] = { ...l, name: e.target.value }; set({ extraLiving: n }); }} />
                <NumIn value={l.amount} step={50000} suffix="원" comma
                  onChange={(v) => { const n = [...d.extraLiving]; n[i] = { ...l, amount: num(v) }; set({ extraLiving: n }); }} />
                <button className="link del" onClick={() => {
                  if (!String(l.name || "").trim() && !num(l.amount)) {
                    set({ extraLiving: d.extraLiving.filter((_, j) => j !== i) });
                  } else setDelLiving(i);
                }}>삭제</button>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
            <button className="btn sm" onClick={() => set({ extraLiving: [...d.extraLiving, { name: "", cat: "기타", amount: 0 }] })}>항목 추가</button>
            <span className="ltotal mono">매달 <b>{won(livingTotal)}</b></span>
          </div>
          <div className={`wtip ${monthlyNet < 0 ? "bad" : ""}`}>
            {num(d.income) > 0
              ? monthlyNet >= 0
                ? <>매달 <b>{won(monthlyNet)}</b>이 남습니다. 큰 지출은 결국 여기서 나갑니다.</>
                : <>매달 <b>{won(-monthlyNet)}</b>씩 모자랍니다. 큰 지출 전에 이것부터 봐야 합니다.</>
              : <>앞 단계에서 수입을 넣으면 매달 얼마가 남는지 보여드립니다.</>}
          </div>
        </>
      )}

      {step === 2 && (
        <>
          <p className="note">감당할 수 있을지 재보려는 그 지출입니다. 없으면 건너뛰어도 됩니다.</p>
          <div className="row" style={{ marginBottom: 12 }}>
            <label className="chk"><input type="checkbox" checked={d.wantBig} onChange={(e) => set({ wantBig: e.target.checked })} /> 계획 중인 큰 지출이 있습니다</label>
          </div>
          {d.wantBig && (
            <>
              <div className="grid">
                <Field label="무엇인가요">
                  <select className="in" value={d.bigKind} onChange={(e) => set({ bigKind: e.target.value })}>
                    <option value="house">주택 구입</option>
                    <option value="car">자동차 구입</option>
                    <option value="etc">그 밖의 큰 지출</option>
                  </select>
                </Field>
                <Field label="이름" hint="비워두면 자동">
                  <input className="in" value={d.bigName} placeholder={d.bigKind === "house" ? "주택 구입" : d.bigKind === "car" ? "자동차 구입" : "큰 지출"}
                    onChange={(e) => set({ bigName: e.target.value })} />
                </Field>
                <Field label="언제">
                  <input className="in mono" type="month" value={d.bigMonth} onChange={(e) => set({ bigMonth: e.target.value })} />
                </Field>
                <Field label={d.bigKind === "house" ? "매매가" : d.bigKind === "car" ? "차량 가격" : "금액"}>
                  <NumIn value={d.price} step={1000000} onChange={(v) => set({ price: num(v) })} suffix="원" comma />
                </Field>
                {d.bigKind === "house" && (
                  <>
                    <Field label="보유 주택 수" hint="취득 후 기준">
                      <select className="in" value={d.homes} onChange={(e) => set({ homes: e.target.value })}>
                        {HOME_COUNTS.map((h) => <option key={h.v} value={h.v}>{h.label}</option>)}
                      </select>
                    </Field>
                    <Field label="조정대상지역">
                      <select className="in" value={d.adjusted ? "y" : "n"} onChange={(e) => set({ adjusted: e.target.value === "y" })}>
                        <option value="n">아니오</option><option value="y">예</option>
                      </select>
                    </Field>
                    <Field label="전용 85㎡ 초과" hint="농어촌특별세 대상">
                      <select className="in" value={d.over85 ? "y" : "n"} onChange={(e) => set({ over85: e.target.value === "y" })}>
                        <option value="n">아니오</option><option value="y">예</option>
                      </select>
                    </Field>
                  </>
                )}
                <Field label="그 밖의 비용" hint={d.bigKind === "house" ? "이사비, 수리비 등" : "보험료, 용품 등"}>
                  <NumIn value={d.extras} step={500000} onChange={(v) => set({ extras: num(v) })} suffix="원" comma />
                </Field>
              </div>

              {d.bigKind === "house" && num(d.price) > 0 && (
                <div className="calcbox">
                  <span className="eyebrow">가격 말고도 나가는 돈</span>
                  <ul className="mono">
                    <li><span>취득세 {rates.acq}%</span><b>{won(num(d.price) * rates.acq / 100)}</b></li>
                    <li><span>지방교육세 {rates.edu}%</span><b>{won(num(d.price) * rates.edu / 100)}</b></li>
                    {rates.farm > 0 && <li><span>농어촌특별세 {rates.farm}%</span><b>{won(num(d.price) * rates.farm / 100)}</b></li>}
                    <li><span>중개보수 {broker.pct}%{broker.cap ? ` (한도 ${won(broker.cap)})` : ""}</span><b>{won(brokerAmt)}</b></li>
                    <li><span>그 밖의 비용</span><b>{won(d.extras)}</b></li>
                    <li><span><b>총 필요 금액</b></span><b>{won(bigTotal)}</b></li>
                  </ul>
                  <p className="mut sm" style={{ marginTop: 8 }}>
                    세율은 널리 쓰이는 참고값입니다. 주택 수·면적·지역·감면에 따라 달라지니 계약 전에 위택스나 관할 지자체에서 확인하세요.
                    시작한 뒤 큰 지출 탭에서 항목별로 고칠 수 있습니다.
                  </p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {step === 3 && d.wantBig && (
        <>
          <p className="note">필요한 {won(bigTotal)} 중 얼마를 지금 내고, 얼마를 빌릴지 정합니다.</p>
          <div className="grid">
            <Field label="자기자금" hint={`지금 현금 ${readable(d.opening)} 중에서`}>
              <NumIn value={d.cash} step={1000000} onChange={(v) => set({ cash: num(v) })} suffix="원" comma />
            </Field>
            <Field label="빌릴 금액" hint="자동 계산">
              <span className="numwrap boxed readonly">
                <em className="krin">{readable(loanAmt)}</em>
                <span className="mono roval">{won(loanAmt)}</span>
              </span>
            </Field>
            {loanAmt > 0 && (
              <>
                <Field label="상환 기간">
                  <NumIn value={d.loanMonths} min={1} onChange={(v) => set({ loanMonths: Math.max(1, num(v)) })} suffix="개월" />
                </Field>
                <Field label="연 이자율" hint="승인 금리를 넣으세요">
                  <NumIn value={d.loanApr} step={0.1} onChange={(v) => set({ loanApr: num(v) })} suffix="%" />
                </Field>
                <Field label="상환 방식">
                  <select className="in" value={d.loanRepay} onChange={(e) => set({ loanRepay: e.target.value })}>
                    {REPAY.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
                  </select>
                </Field>
              </>
            )}
          </div>
          {loanAmt > 0 && (() => {
            const sch = bigSchedule({ amount: bigTotal, month: d.bigMonth, method: "loan", down: num(d.cash),
              months: Math.max(1, num(d.loanMonths)), apr: num(d.loanApr), feeRate: 0, repayment: d.loanRepay, defer: 1 });
            const ratio = num(d.income) > 0 ? (sch.monthly / num(d.income)) * 100 : 0;
            return (
              <div className="calcbox">
                <span className="eyebrow">갚아야 할 돈</span>
                <ul className="mono">
                  <li><span>첫 회 상환액</span><b>{won(sch.monthly)}</b></li>
                  <li><span>총 이자</span><b className={sch.interest > 0 ? "neg" : ""}>{won(sch.interest)}</b></li>
                  <li><span>상환 종료</span><b>{labelYM(sch.lastMonth)}</b></li>
                  {num(d.income) > 0 && <li><span>월 수입 대비</span><b className={ratio > 40 ? "neg" : ratio > 30 ? "warnT" : ""}>{ratio.toFixed(0)}%</b></li>}
                </ul>
                {num(d.income) > 0 && (
                  <p className="mut sm" style={{ marginTop: 8 }}>
                    상환액이 수입의 30%를 넘으면 생활이 빠듯해지고, 40%를 넘으면 예상치 못한 일에 대응하기 어려워집니다.
                    다음 단계에서 실제로 버틸 수 있는지 보여드립니다.
                  </p>
                )}
              </div>
            );
          })()}
        </>
      )}

      {step === 4 && (
        <WizardVerdict draft={draft} advice={advice} unit={plan.settings.unit} />
      )}

      <Confirm open={delLiving !== null}
        name={delLiving !== null && d.extraLiving[delLiving] && d.extraLiving[delLiving].name}
        kind="지출 항목"
        onCancel={() => setDelLiving(null)}
        onConfirm={() => {
          set({ extraLiving: d.extraLiving.filter((_, j) => j !== delLiving) });
          setDelLiving(null);
        }} />
    </Modal>
  );
}

function WizardVerdict({ draft, advice, unit }) {
  if (!advice) {
    return <div className="wtip">수입과 지출을 넣으면 여기에서 감당 가능한지 판정해 드립니다.</div>;
  }
  const { base, fixes, ok } = advice;
  const m = base.res.metrics;

  return (
    <>
      <div className={`wverdict ${ok ? "ok" : base.broke ? "bad" : "warn"}`}>
        <strong>
          {ok ? "감당할 수 있습니다." : base.broke ? "지금 계획으로는 감당하기 어렵습니다." : "빠듯합니다. 조정이 필요합니다."}
        </strong>
        <span>
          {ok
            ? `상환이 끝날 때까지 안전선을 지키고, 가장 낮을 때 잔고가 ${money(m.min, unit)}입니다.`
            : base.broke
            ? `${longYM(m.negative)}에 잔고가 바닥납니다.`
            : `${longYM(base.breach)}에 안전선 아래로 내려가고, 가장 낮을 때 ${money(m.min, unit)}까지 떨어집니다.`}
        </span>
      </div>

      <div className="stats" style={{ marginTop: 12 }}>
        <Stat k="기간 말 잔고" v={money(m.end, unit)} tone={m.end < 0 ? "bad" : "ok"} />
        <Stat k="최저 잔고" v={money(m.min, unit)} sub={m.minMonth ? longYM(m.minMonth) : ""} tone={m.min < 0 ? "bad" : m.min < num(draft.settings.floor) ? "warn" : "ok"} />
        <Stat k="월평균 순현금흐름" v={money(m.avgNet, unit)} tone={m.avgNet < 0 ? "warn" : "ok"} />
        <Stat k="총 이자" v={money(m.interest, unit)} tone={m.interest > 0 ? "warn" : "ok"} />
      </div>

      {!ok && (
        <>
          <h4 className="sub-h">이렇게 하면 됩니다</h4>
          {fixes.length === 0 ? (
            <div className="wtip bad">
              지출 시점을 미루거나 기간을 늘리는 것만으로는 해결되지 않습니다.
              수입을 늘리거나 지출 규모를 크게 줄여야 합니다.
            </div>
          ) : (
            <div className="fixes">
              {fixes.map((f, i) => (
                <div key={i} className="fix">
                  <span className="eyebrow">{f.label}</span>
                  <p>{f.detail}</p>
                  <p className="mut">{f.action}</p>
                </div>
              ))}
            </div>
          )}
          <p className="mut sm" style={{ marginTop: 10 }}>
            지금 이대로 시작해도 됩니다. 시나리오 탭에서 여러 안을 나란히 비교할 수 있습니다.
          </p>
        </>
      )}

      {ok && (
        <div className="wtip" style={{ marginTop: 12 }}>
          시작한 뒤에는 <b>시나리오</b> 탭에서 다른 안과 비교해 보세요.
          지출을 앞당기거나 기간을 줄이면 얼마나 빠듯해지는지 바로 보입니다.
        </div>
      )}
    </>
  );
}

/* ---------------- 연결 탭 ---------------- */
function ConnTab({ conn, persistConn, online, plan, snaps, catalog, pullRemote, setStatus, setSnaps, setPlan }) {
  const [url, setUrl] = useState(conn.url || "");
  const [key, setKey] = useState(conn.key || "");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [mode, setMode] = useState("signin");   // signin | signup | reset
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [showSql, setShowSql] = useState(false);
  const [danger, setDanger] = useState("");     // wipe | delete

  const run = async (label, fn) => {
    setBusy(label); setErr(""); setMsg("");
    try { await fn(); } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  };

  const live = () => (HOSTED
    ? { ...conn, url: SUPABASE_URL, key: SUPABASE_KEY }
    : { ...conn, url: trimUrl(url), key: key.trim() });

  const saveEndpoint = () => run("endpoint", async () => {
    if (!trimUrl(url) || !key.trim()) throw new Error("주소와 API 키를 모두 입력하세요.");
    if (/^sb_secret_/.test(key.trim())) throw new Error("secret key 는 쓰면 안 됩니다. publishable key 를 넣으세요.");
    await persistConn({ ...conn, url: trimUrl(url), key: key.trim() });
    setMsg("주소를 저장했습니다. 이제 로그인하세요.");
  });

  const doSignUp = () => run("signup", async () => {
    if (pw.length < 8) throw new Error("비밀번호는 8자 이상으로 정해주세요.");
    if (pw !== pw2) throw new Error("비밀번호가 서로 다릅니다.");
    const c = live();
    const r = await sbSignUp(c, email.trim(), pw);
    if (r && r.access_token) {
      const next = { ...c, token: r.access_token, refresh: r.refresh_token, user: r.user };
      await persistConn(next);
      await pullRemote(next);
      setMsg("가입했습니다. 이제 어느 기기에서든 같은 내용을 볼 수 있습니다.");
    } else {
      setMsg("가입 확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요.");
      setMode("signin");
    }
    setPw(""); setPw2("");
  });

  const doSignIn = () => run("signin", async () => {
    const c = live();
    const r = await sbSignIn(c, email.trim(), pw);
    const next = { ...c, token: r.access_token, refresh: r.refresh_token, user: r.user };
    await persistConn(next);
    const d = await pullRemote(next);
    setMsg(d.plan ? "저장해 둔 내용을 불러왔습니다." : "서버에 저장된 내용이 없어 지금 화면의 내용을 올릴 수 있습니다.");
    setPw("");
  });

  const doReset = () => run("reset", async () => {
    if (!email.trim()) throw new Error("이메일을 입력하세요.");
    await sbRecover(live(), email.trim());
    setMsg("비밀번호 재설정 메일을 보냈습니다. 받은 편지함을 확인하세요.");
    setMode("signin");
  });

  const doChangePw = () => run("chpw", async () => {
    if (pw.length < 8) throw new Error("비밀번호는 8자 이상으로 정해주세요.");
    if (pw !== pw2) throw new Error("비밀번호가 서로 다릅니다.");
    await sbUpdatePassword(conn, pw);
    setMsg("비밀번호를 바꿨습니다.");
    setPw(""); setPw2("");
  });

  const doSignOut = () => run("signout", async () => {
    await persistConn({ ...conn, token: "", refresh: "", user: null });
    setMsg("로그아웃했습니다. 서버에 저장된 내용은 그대로 남아 있습니다.");
  });

  const pushAll = () => run("push", async () => {
    await remoteSavePlan(conn, plan);
    await remoteSyncSnaps(conn, [], snaps);
    await remoteSaveCatalog(conn, { orgs: [], products: [] }, catalog);
    const d = await pullRemote(conn);
    setSnaps(d.snaps);
    setMsg("지금 화면의 내용을 서버에 올렸습니다.");
  });

  const pull = () => run("pull", async () => {
    await pullRemote(conn);
    setMsg("서버에 저장된 내용을 불러왔습니다.");
  });

  const doWipe = () => run("wipe", async () => {
    await remoteWipeData(conn);
    setSnaps([]);
    setDanger("");
    setMsg("서버에 저장된 계획과 스냅샷을 지웠습니다. 이 브라우저의 내용은 그대로입니다.");
  });

  const doDeleteAccount = () => run("delacct", async () => {
    await remoteDeleteAccount(conn);
    await persistConn({ ...conn, token: "", refresh: "", user: null });
    setSnaps([]);
    setDanger("");
    setMsg("계정과 서버의 모든 기록을 지웠습니다.");
  });

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(`${SCHEMA_SQL}\n${TIPS_SQL}`);
      setMsg("SQL 을 복사했습니다. Supabase 의 SQL Editor 에 붙여넣고 실행하세요.");
    } catch (e) {
      setShowSql(true);
      setMsg("복사가 막혀 있어 아래에 펼쳤습니다. 직접 복사하세요.");
    }
  };

  /* ───── 로그인한 상태 ───── */
  if (online) {
    return (
      <>
        <section className="card">
          <div className="card-h">
            <div>
              <span className="eyebrow en">ACCOUNT</span>
              <h2>내 계정</h2>
            </div>
            <span className="scentag" style={{ borderColor: "#1F6B4E", color: "#1F6B4E" }}>
              <i className="dot" style={{ background: "#1F6B4E" }} />{conn.user.email}
            </span>
          </div>
          <p className="note">
            입력한 내용은 저장할 때마다 이 계정으로 올라갑니다. 다른 기기에서 같은 계정으로 로그인하면 이어서 볼 수 있습니다.
          </p>
          <div className="row">
            <button className="btn" onClick={pull} disabled={!!busy}>{busy === "pull" ? "불러오는 중…" : "서버에서 불러오기"}</button>
            <button className="btn" onClick={pushAll} disabled={!!busy}>{busy === "push" ? "올리는 중…" : "지금 화면 내용 올리기"}</button>
            <button className="btn" onClick={doSignOut} disabled={!!busy}>로그아웃</button>
          </div>

          <h4 className="sub-h">비밀번호 바꾸기</h4>
          <div className="grid">
            <Field label="새 비밀번호" hint="8자 이상">
              <input className="in" type="password" value={pw} autoComplete="new-password"
                onChange={(e) => setPw(e.target.value)} />
            </Field>
            <Field label="한 번 더">
              <input className="in" type="password" value={pw2} autoComplete="new-password"
                onChange={(e) => setPw2(e.target.value)} />
            </Field>
          </div>
          <div className="row"><button className="btn" onClick={doChangePw} disabled={!!busy}>비밀번호 바꾸기</button></div>

          {err && <p className="msg err">{err}</p>}
          {msg && <p className="msg ok">{msg}</p>}
        </section>

        <section className="card">
          <div className="card-h"><div><span className="eyebrow en">DATA</span><h2>내 데이터</h2></div></div>
          <div className="tablewrap">
            <table className="tbl">
              <thead><tr><th>내용</th><th>어디에 있나</th><th>누가 볼 수 있나</th></tr></thead>
              <tbody>
                <tr><td>수입·지출·큰 지출·시나리오</td><td className="mono">plans</td><td>나만</td></tr>
                <tr><td>버전 스냅샷</td><td className="mono">snapshots</td><td>나만</td></tr>
                <tr><td>기관·할부·대출 상품</td><td className="mono">orgs, products</td><td>모든 사용자 공유</td></tr>
              </tbody>
            </table>
          </div>
          <p className="note" style={{ marginTop: 12 }}>
            개인 데이터는 데이터베이스의 행 수준 보안(RLS)으로 계정별로 분리됩니다.
            다른 사용자는 물론 로그인하지 않은 사람도 읽을 수 없습니다.
            상품 카탈로그만 함께 쓰는 공용 정보이니, 거기에는 개인 정보를 넣지 마세요.
          </p>

          <h4 className="sub-h">지우기</h4>
          {!danger ? (
            <div className="row">
              <button className="btn" onClick={() => setDanger("wipe")}>서버에 저장된 내용 지우기</button>
              <button className="btn danger" onClick={() => setDanger("delete")}>계정 삭제</button>
            </div>
          ) : danger === "wipe" ? (
            <div className="confirm">
              <p><b>서버에 저장된 계획과 스냅샷을 모두 지웁니다.</b> 계정은 남고, 이 브라우저에 있는 내용도 그대로입니다. 되돌릴 수 없습니다.</p>
              <div className="row">
                <button className="btn" onClick={() => setDanger("")}>취소</button>
                <button className="btn danger" onClick={doWipe} disabled={!!busy}>{busy === "wipe" ? "지우는 중…" : "지웁니다"}</button>
              </div>
            </div>
          ) : (
            <div className="confirm">
              <p><b>계정과 서버의 모든 기록을 지웁니다.</b> 계획, 스냅샷, 로그인 정보가 함께 사라지고 같은 이메일로 다시 가입해야 합니다. 되돌릴 수 없습니다.</p>
              <p className="mut sm">이 브라우저에 남은 내용은 지워지지 않습니다. 그것까지 없애려면 스냅샷 탭에서 내보내기를 한 뒤 브라우저 데이터를 삭제하세요.</p>
              <div className="row">
                <button className="btn" onClick={() => setDanger("")}>취소</button>
                <button className="btn danger" onClick={doDeleteAccount} disabled={!!busy}>{busy === "delacct" ? "지우는 중…" : "계정을 삭제합니다"}</button>
              </div>
            </div>
          )}
        </section>
      </>
    );
  }

  /* ───── 로그인 전 ───── */
  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">ACCOUNT</span>
            <h2>{mode === "signup" ? "회원가입" : mode === "reset" ? "비밀번호 찾기" : "로그인"}</h2>
          </div>
        </div>

        <p className="note">
          지금은 입력한 내용이 이 브라우저에만 저장됩니다. 가입하면 계정에 저장되어
          폰과 PC 어디서든 이어서 볼 수 있고, 브라우저 기록을 지워도 남습니다.
        </p>

        {HOSTED ? null : (
          <>
            <div className="wtip bad">
              이 빌드에는 서버 주소가 들어 있지 않습니다. 직접 Supabase 를 연결해 쓰는 방식입니다.
            </div>
            <h4 className="sub-h">1단계 · 테이블 만들기</h4>
            <p className="note">Supabase 프로젝트의 SQL Editor 에서 아래 스키마를 한 번 실행하세요.</p>
            <div className="row">
              <button className="btn sm" onClick={copySql}>스키마 SQL 복사</button>
              <button className="btn sm" onClick={() => setShowSql(!showSql)}>{showSql ? "접기" : "SQL 보기"}</button>
            </div>
            {showSql && <pre className="sqlbox mono">{`${SCHEMA_SQL}\n${TIPS_SQL}`}</pre>}

            <h4 className="sub-h">2단계 · 주소와 키</h4>
            <p className="note">
              Settings → API Keys 에서 확인합니다. publishable key 는 공개용이라 브라우저에 두어도 되며,
              실제 접근 제어는 RLS 가 맡습니다. <b>secret key 는 절대 넣지 마세요.</b>
            </p>
            <div className="grid">
              <Field label="Project URL" wide hint="https://xxxxx.supabase.co">
                <input className="in mono" value={url} placeholder="https://....supabase.co"
                  onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label="Publishable key" wide hint="sb_publishable_... 또는 예전 anon key">
                <input className="in mono" value={key} placeholder="sb_publishable_..." type="password"
                  onChange={(e) => setKey(e.target.value)} />
              </Field>
            </div>
            <div className="row"><button className="btn" onClick={saveEndpoint} disabled={!!busy}>주소 저장</button></div>
            <h4 className="sub-h">3단계 · 계정</h4>
          </>
        )}

        <div className="grid">
          <Field label="이메일">
            <input className="in" type="email" value={email} autoComplete="email"
              onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {mode !== "reset" && (
            <Field label="비밀번호" hint={mode === "signup" ? "8자 이상" : undefined}>
              <input className="in" type="password" value={pw}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                onChange={(e) => setPw(e.target.value)} />
            </Field>
          )}
          {mode === "signup" && (
            <Field label="비밀번호 한 번 더">
              <input className="in" type="password" value={pw2} autoComplete="new-password"
                onChange={(e) => setPw2(e.target.value)} />
            </Field>
          )}
        </div>

        <div className="row" style={{ marginTop: 4 }}>
          {mode === "signup" && <button className="btn primary" onClick={doSignUp} disabled={!!busy}>{busy === "signup" ? "가입 중…" : "가입하기"}</button>}
          {mode === "signin" && <button className="btn primary" onClick={doSignIn} disabled={!!busy}>{busy === "signin" ? "확인 중…" : "로그인"}</button>}
          {mode === "reset" && <button className="btn primary" onClick={doReset} disabled={!!busy}>{busy === "reset" ? "보내는 중…" : "재설정 메일 받기"}</button>}
        </div>

        <div className="row authswitch">
          {mode !== "signup" && <button className="link" onClick={() => { setMode("signup"); setErr(""); setMsg(""); }}>처음이신가요? 가입하기</button>}
          {mode !== "signin" && <button className="link" onClick={() => { setMode("signin"); setErr(""); setMsg(""); }}>이미 계정이 있습니다</button>}
          {mode !== "reset" && <button className="link" onClick={() => { setMode("reset"); setErr(""); setMsg(""); }}>비밀번호를 잊었습니다</button>}
        </div>

        {err && <p className="msg err">{err}</p>}
        {msg && <p className="msg ok">{msg}</p>}

        <p className="mut sm" style={{ marginTop: 14 }}>
          가입하면 <a href="/terms" className="ilink">이용약관</a>과{" "}
          <a href="/privacy" className="ilink">개인정보처리방침</a>에 동의하는 것으로 봅니다.
          저장되는 것은 이메일과 직접 입력한 금액뿐이며, 계좌·카드 번호는 받지 않습니다.
        </p>
      </section>
    </>
  );
}

/* ---------------- 대시보드 ---------------- */
function Dashboard({ plan, results, primary, chartData, unit, up, setTab }) {
  const res = results[primary.id];
  const m = res.metrics;
  const floor = num(plan.settings.floor);
  const [openRow, setOpenRow] = useState(null);
  const gaps = useMemo(() => checkGaps(plan, res), [plan, res]);
  const mustGaps = gaps.filter((x) => x.level === "must");

  const verdict = m.negative
    ? { t: "bad", h: `${longYM(m.negative)}에 잔고가 바닥납니다`, s: "지출 시점을 미루거나 상환 기간을 늘려서 다시 보세요." }
    : m.breach
    ? { t: "warn", h: `${longYM(m.breach)}에 안전선 아래로 내려갑니다`, s: `최저 ${money(m.min, unit)}까지 떨어집니다.` }
    : { t: "ok", h: "예측 기간 내내 안전선을 지킵니다", s: `최저 잔고는 ${longYM(m.minMonth)}의 ${money(m.min, unit)}입니다.` };

  return (
    <>
      <section className="settings">
        <Field label="시작 월">
          <input className="in mono" type="month" value={plan.settings.startMonth}
            onChange={(e) => up((p) => { p.settings.startMonth = e.target.value; })} />
        </Field>
        <Field label="예측 기간">
          <select className="in" value={plan.settings.horizon}
            onChange={(e) => up((p) => { p.settings.horizon = Number(e.target.value); })}>
            {[6, 12, 24, 36, 60, 120].map((h) => <option key={h} value={h}>{h}개월</option>)}
          </select>
        </Field>
        <Field label="시작 잔고">
          <NumIn value={plan.settings.opening} step={100000} onChange={(v) => up((p) => { p.settings.opening = num(v); })} suffix="원" comma />
        </Field>
        <Field label="안전선(최소 유지 잔고)" hint="이 아래로 내려가면 경고">
          <NumIn value={plan.settings.floor} step={100000} onChange={(v) => up((p) => { p.settings.floor = num(v); })} suffix="원" comma />
        </Field>
        <Field label="금액 표기">
          <select className="in" value={unit} onChange={(e) => up((p) => { p.settings.unit = e.target.value; })}>
            <option value="man">만원 단위</option>
            <option value="won">원 단위</option>
          </select>
        </Field>
      </section>

      <GapPanel gaps={gaps} setTab={setTab} />

      {(() => {
        /* 비상금(안전선)은 생활비 몇 달치로 잡는 게 보통입니다.
           실제 지출에서 계산해 바로 적용할 수 있게 합니다. */
        const monthlyOut = plan.items
          .filter((i) => i.flow === "out" && i.kind !== "oneoff")
          .reduce((a, i) => a + num(i.amount) / freqStep(i.freq), 0);
        if (monthlyOut <= 0) return null;
        const floorNow = num(plan.settings.floor);
        const m3 = Math.round(monthlyOut * 3 / 100000) * 100000;
        const m6 = Math.round(monthlyOut * 6 / 100000) * 100000;
        const months = floorNow / monthlyOut;
        const low = floorNow < monthlyOut * 3;
        return (
          <div className={`floorhint${low ? " low" : ""}`}>
            <div className="fh-text">
              <b>비상금은 생활비 3~6개월치</b>를 많이 씁니다.
              지금 지출로 보면 <span className="mono">{money(m3, unit)} ~ {money(m6, unit)}</span>입니다.
              {floorNow > 0
                ? <> 현재 안전선 {money(floorNow, unit)}은 약 <b>{months.toFixed(1)}개월치</b>입니다.
                    {low && " 수입이 끊기면 버티기 빠듯합니다."}</>
                : <> 지금은 안전선이 0이라 잔고가 바닥나기 직전까지 \u2018여유 있음\u2019으로 나옵니다.</>}
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => up((p) => { p.settings.floor = m3; })}>3개월치</button>
              <button className="btn sm" onClick={() => up((p) => { p.settings.floor = m6; })}>6개월치</button>
            </div>
          </div>
        );
      })()}

      <div className={`verdict ${mustGaps.length ? "stale" : verdict.t}`}>
        <strong>{verdict.h}</strong>
        <span>{verdict.s}</span>
        {mustGaps.length > 0 && (
          <span className="v-warn">
            다만 {mustGaps.slice(0, 3).map((x) => x.label).join(", ")}
            {mustGaps.length > 3 ? ` 외 ${mustGaps.length - 3}가지` : ""}가 아직 비어 있습니다.
            <b> 이 판정은 그만큼 낙관적입니다.</b> 위에서 채운 뒤 다시 보세요.
          </span>
        )}
      </div>

      <LevelStrip result={res} floor={floor} unit={unit} />

      <section className="stats">
        <Stat k="기간 말 잔고" v={money(m.end, unit)} tone={m.end < 0 ? "bad" : m.end < floor ? "warn" : "ok"} />
        <Stat k="최저 잔고" v={money(m.min, unit)} sub={m.minMonth ? longYM(m.minMonth) : ""} tone={m.min < 0 ? "bad" : m.min < floor ? "warn" : "ok"} />
        <Stat k="월평균 순현금흐름" v={money(m.avgNet, unit)} tone={m.avgNet < 0 ? "warn" : "ok"} />
        <Stat k="총 이자·수수료" v={money(m.interest, unit)} tone={m.interest > 0 ? "warn" : "ok"} />
        <Stat k="기간 이후 남은 상환" v={money(m.tail, unit)} sub={m.tail > 0 ? "예측 기간 밖" : "없음"} />
      </section>

      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">BALANCE PROJECTION</span>
            <h2>시나리오별 잔고 추이</h2>
          </div>
          <button className="btn sm" onClick={() => setTab("scen")}>시나리오 편집</button>
        </div>
        <div className="chips">
          {plan.scenarios.map((s) => {
            const on = plan.shown.includes(s.id);
            return (
              <button key={s.id} className={on ? "chip on" : "chip"}
                style={on ? { borderColor: s.color, color: s.color } : undefined}
                onClick={() => up((p) => {
                  const i = p.shown.indexOf(s.id);
                  if (i >= 0) { if (p.shown.length > 1) p.shown.splice(i, 1); }
                  else p.shown.push(s.id);
                })}>
                <i className="dot" style={{ background: s.color }} />{s.name}
              </button>
            );
          })}
        </div>
        <div className="chart">
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid stroke="#DCE3E2" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7B83", fontFamily: "'IBM Plex Mono','IBM Plex Sans KR',monospace" }}
                interval={Math.max(0, Math.floor(chartData.length / 12) - 1)} tickLine={false} axisLine={{ stroke: "#C9D3D1" }} />
              <YAxis tickFormatter={(v) => compact(v)} width={54}
                tick={{ fontSize: 11, fill: "#6B7B83", fontFamily: "'IBM Plex Mono','IBM Plex Sans KR',monospace" }} tickLine={false} axisLine={false} />
              <Tooltip
                contentStyle={{ border: "1px solid #C9D3D1", borderRadius: 3, fontSize: 12, fontFamily: "IBM Plex Sans KR, sans-serif" }}
                labelFormatter={(l, pl) => (pl && pl[0] ? longYM(pl[0].payload.month) : l)}
                formatter={(v, nm) => [won(v), plan.scenarios.find((s) => s.id === nm)?.name || nm]} />
              {floor > 0 && <ReferenceLine y={floor} stroke="#B8860B" strokeDasharray="5 4"
                label={{ value: "안전선", position: "insideTopRight", fontSize: 10, fill: "#8A6508" }} />}
              <ReferenceLine y={0} stroke="#8C1D18" strokeWidth={1} />
              {plan.shown.map((id) => {
                const s = plan.scenarios.find((x) => x.id === id);
                if (!s) return null;
                return <Line key={id} type="monotone" dataKey={id} name={id} stroke={s.color}
                  strokeWidth={id === primary.id ? 2.4 : 1.6} dot={false} activeDot={{ r: 3 }} />;
              })}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">MONTHLY LEDGER</span>
            <h2>월별 상세</h2>
          </div>
          <span className="scentag" style={{ borderColor: primary.color, color: primary.color }}>
            <i className="dot" style={{ background: primary.color }} />{primary.name}
          </span>
        </div>
        <div className="tablewrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>월</th><th className="r">수입</th><th className="r">지출</th><th className="r">순증감</th><th className="r">월말 잔고</th><th />
              </tr>
            </thead>
            <tbody>
              {res.rows.map((r, i) => {
                const state = r.balance < 0 ? "bad" : r.balance < floor ? "warn" : "";
                return (
                  <React.Fragment key={r.month}>
                    <tr className={state} onClick={() => setOpenRow(openRow === i ? null : i)}>
                      <td className="mono">{labelYM(r.month)}</td>
                      <td className="r mono pos">{compact(r.inflow)}</td>
                      <td className="r mono neg">{compact(r.outflow)}</td>
                      <td className={`r mono ${r.net < 0 ? "neg" : "pos"}`}>{compact(r.net)}</td>
                      <td className="r mono b">{compact(r.balance)}</td>
                      <td className="r mono chev">{openRow === i ? "−" : "+"}</td>
                    </tr>
                    {openRow === i && (
                      <tr className="detail">
                        <td colSpan={6}>
                          <ul>
                            {r.notes.length === 0 && <li className="mut">이 달에는 항목이 없습니다.</li>}
                            {r.notes.map((n, j) => (
                              <li key={j}>
                                <span className={n.big ? "big" : ""}>{n.name}</span>
                                <b className={n.flow === "in" ? "pos" : "neg"}>{n.flow === "in" ? "+" : "−"}{won(n.amount)}</b>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="sum">
                <td>합계 {res.rows.length}개월</td>
                <td className="r mono pos">{compact(m.totalIn)}</td>
                <td className="r mono neg">{compact(m.totalOut)}</td>
                <td className={`r mono ${m.totalIn - m.totalOut < 0 ? "neg" : "pos"}`}>{compact(m.totalIn - m.totalOut)}</td>
                <td className="r mono b">{compact(m.end)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </>
  );
}

function GapPanel({ gaps, setTab }) {
  const [open, setOpen] = useState(false);
  if (!gaps.length) {
    return (
      <div className="gaps ok">
        <span className="g-dot ok" />
        <div className="g-text"><b>빠진 항목 없이 다 채우셨습니다.</b> 아래 결과를 그대로 믿으셔도 됩니다.</div>
      </div>
    );
  }
  const must = gaps.filter((x) => x.level === "must");
  const LABEL = { must: "꼭 필요", should: "넣는 게 좋음", nice: "있으면 좋음" };

  return (
    <div className={`gaps${must.length ? " warn" : ""}`}>
      <button className="g-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`g-dot${must.length ? " warn" : " mild"}`} />
        <span className="g-text">
          {must.length > 0
            ? <><b>아직 안 넣은 항목이 {must.length}개 있습니다.</b> 지출이 빠져 있으면 결과가 실제보다 낙관적으로 나옵니다.</>
            : <><b>더 챙기면 좋을 항목이 {gaps.length}개 있습니다.</b> 지금도 볼 수는 있지만 더 정확해집니다.</>}
        </span>
        <span className="g-toggle">{open ? "접기" : `${gaps.length}개 보기`}</span>
      </button>

      {open && (
        <ul className="g-list">
          {gaps.map((x, i) => (
            <li key={i} className={x.level}>
              <div>
                <b>{x.title}</b>
                <em>{LABEL[x.level]}</em>
                <p>{x.why}</p>
              </div>
              <button className="btn sm" onClick={() => setTab(x.tab)}>
                {x.tab === "dash" ? "위에서 고치기" : "넣으러 가기"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ k, v, sub, tone }) {
  return (
    <div className={`stat ${tone || ""}`}>
      <span className="eyebrow">{k}</span>
      <strong className="mono">{v}</strong>
      {sub ? <span className="sub mono">{sub}</span> : null}
    </div>
  );
}

/* ---------------- 수입·지출 탭 ---------------- */
/* 매달 나가지 않아 빠뜨리기 쉬운 지출들.
   금액은 집집마다 달라 비워 두고, 주기와 분류만 맞춰 띄웁니다. */
const FORGOTTEN = [
  { name: "경조사비", cat: "기타", freq: "quarterly", why: "결혼·장례·돌잔치. 몰릴 때 한 번에 나갑니다" },
  { name: "명절비", cat: "기타", freq: "semiannual", why: "선물, 용돈, 교통비" },
  { name: "자동차세", cat: "기타", freq: "semiannual", why: "6월·12월 (연납하면 1월)" },
  { name: "자동차 보험", cat: "보험", freq: "yearly", why: "1년에 한 번 목돈" },
  { name: "재산세", cat: "기타", freq: "yearly", why: "집이 있다면 7월·9월" },
  { name: "휴가·여행", cat: "변동비", freq: "yearly", why: "미리 잡아두면 죄책감 없이 씁니다" },
  { name: "건강검진·병원비", cat: "기타", freq: "yearly", why: "치과는 특히 큽니다" },
  { name: "가전·가구 교체", cat: "기타", freq: "yearly", why: "고장은 예고 없이 옵니다" },
  { name: "아이 학기 초 비용", cat: "교육·육아", freq: "semiannual", why: "입학·새 학기에 몰립니다" },
  { name: "종합소득세", cat: "기타", freq: "yearly", why: "사업·임대 소득이 있다면 5월" },
];

/* ==================================================================
   아껴보기 — 입력한 지출 항목에 맞는 절약 방법
   기본 팁(savetips.js)과 사용자가 올린 꿀팁을 함께 보여줍니다.
================================================================== */

/** 사용자 꿀팁의 키워드가 항목 이름에 걸리는지 */
const tipKeyHit = (tip, name) => {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  const words = String(tip.keywords || "")
    .split(/[,\s·/]+/).map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2);
  return words.some((w) => n.includes(w) || w.includes(n));
};

function EffortTag({ kind }) {
  const e = EFFORT[kind];
  if (!e) return null;
  return <span className={`eff ${e.tone}`}>{e.label}</span>;
}

function BuiltinTip({ t }) {
  return (
    <div className="tipcard">
      <div className="tiphead"><b>{t.title}</b><EffortTag kind={t.effort} /></div>
      <p>{t.body}</p>
      {t.links && t.links.length > 0 && (
        <p className="tiplinks">
          {t.links.map((l) => (
            <a key={l.href} className="ilink" href={l.href} target="_blank" rel="noopener noreferrer nofollow">{l.label} ↗</a>
          ))}
        </p>
      )}
    </div>
  );
}

function UserTip({ t, mine, myVote, onVote, onEdit, onDelete, admin, onHide }) {
  const [why, setWhy] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <div className={`tipcard user${t.hidden ? " hid" : ""}`}>
      <div className="tiphead">
        <b>{t.title}</b>
        <span className="eff who">{t.nick ? `${t.nick} 님` : "익명"}</span>
        {mine && <span className="eff mine">내 글</span>}
        {t.hidden && <span className="eff bad">가려짐</span>}
      </div>
      <p>{t.body}</p>
      <div className="tipfoot">
        <button className={myVote === 1 ? "vt on" : "vt"} onClick={() => onVote(t, myVote === 1 ? 0 : 1)}>
          추천{t.up > 0 ? ` ${t.up}` : ""}
        </button>
        <button className={myVote === -1 ? "vt bad on" : "vt bad"}
          onClick={() => { if (myVote === -1) onVote(t, 0); else setWhy(true); }}>
          비추천{t.down > 0 ? ` ${t.down}` : ""}
        </button>
        {mine && <button className="vt plain" onClick={() => onEdit(t)}>고치기</button>}
        {mine && <button className="vt plain" onClick={() => onDelete(t)}>삭제</button>}
        {admin && (
          <button className="vt plain" onClick={() => onHide(t, !t.hidden)}>
            {t.hidden ? "다시 보이기" : "가리기"}
          </button>
        )}
      </div>
      {why && (
        <div className="whybox">
          <span className="fld-l">어디가 잘못됐나요?<em className="fld-h">관리자가 보고 가릴지 판단합니다</em></span>
          <textarea className="in" rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)}
            placeholder="예: 지금은 없어진 제도입니다 / 사실과 다릅니다 / 광고입니다" />
          <div className="cact">
            <button className="btn sm" disabled={reason.trim().length < 4}
              onClick={() => { onVote(t, -1, reason); setWhy(false); setReason(""); }}>비추천 보내기</button>
            <button className="btn sm" onClick={() => { setWhy(false); setReason(""); }}>취소</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TipForm({ draft, setDraft, onSave, onCancel, busy, err }) {
  const problem = tipProblem(cleanTip(draft));
  const set = (k) => (e) => setDraft({ ...draft, [k]: e.target.value });
  return (
    <section className="card">
      <div className="card-h">
        <div>
          <span className="eyebrow">{draft.id ? "고치기" : "올리기"}</span>
          <h2>{draft.id ? "꿀팁 고치기" : "내가 아끼는 방법"}</h2>
        </div>
      </div>
      <p className="mut sm">
        실제로 해 본 방법을 적어 주세요. 금액은 상품과 시점마다 달라지니 <b>어떻게 하는지</b>를 적는 쪽이 오래 쓰입니다.
        제휴 링크가 들어간 글은 올라가지 않습니다.
      </p>
      <div className="grid">
        <Field label="어떤 지출에 쓰나요?" hint="항목 이름에 이 말이 있으면 자동으로 붙습니다">
          <input className="in" value={draft.keywords || ""} maxLength={TIP_LIMITS.keywords}
            onChange={set("keywords")} placeholder="통신비, 휴대폰" />
        </Field>
        <Field label="표시할 이름" hint="비워 두면 익명">
          <input className="in" value={draft.nick || ""} maxLength={TIP_LIMITS.nick} onChange={set("nick")} placeholder="익명" />
        </Field>
        <Field label="제목" wide>
          <input className="in" value={draft.title || ""} maxLength={TIP_LIMITS.title}
            onChange={set("title")} placeholder="가족 결합을 풀고 각자 알뜰폰으로" />
        </Field>
        <Field label="어떻게 하는지" hint={`${String(draft.body || "").length} / ${TIP_LIMITS.body}자`} wide>
          <textarea className="in" rows={5} value={draft.body || ""} maxLength={TIP_LIMITS.body} onChange={set("body")}
            placeholder="순서대로 적어 주세요. 무엇을 확인하고, 어디에서 신청하고, 무엇을 주의해야 하는지." />
        </Field>
      </div>
      {(err || problem) && <div className="wtip bad">{err || problem}</div>}
      <div className="cact">
        <button className="btn primary" disabled={!!problem || busy} onClick={onSave}>
          {busy ? "올리는 중…" : draft.id ? "고친 내용 저장" : "올리기"}
        </button>
        <button className="btn" onClick={onCancel}>취소</button>
      </div>
    </section>
  );
}

function SaveTab({ plan, conn, unit, setTab }) {
  const [tips, setTips] = useState([]);
  const [votes, setVotes] = useState({});
  const [admin, setAdmin] = useState(false);
  const [reports, setReports] = useState([]);
  const [showReports, setShowReports] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [del, setDel] = useState(null);

  const writable = canWrite(conn);
  const local = !canRead(conn);

  const reload = useCallback(async () => {
    try {
      const [list, mine] = await Promise.all([listTips(conn), myVotes(conn)]);
      setTips(list); setVotes(mine);
    } catch (e) { setErr(e.message || "꿀팁을 불러오지 못했습니다."); }
  }, [conn]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    let alive = true;
    isAdmin(conn).then((a) => { if (alive) setAdmin(a); }).catch(() => {});
    return () => { alive = false; };
  }, [conn]);

  const outs = useMemo(
    () => (plan.items || []).filter((i) => i.flow === "out" && i.kind !== "oneoff" && String(i.name || "").trim()),
    [plan.items]
  );

  /* 항목별로 기본 팁 + 사용자 꿀팁을 모읍니다. 같은 분류가 두 번 나오지 않게 합니다. */
  const matched = useMemo(() => {
    const seen = new Set();
    const used = new Set();
    const rows = [];
    for (const it of outs) {
      const bts = tipsFor(it.name);
      const uts = tips.filter((t) => tipKeyHit(t, it.name));
      if (!bts.length && !uts.length) continue;
      const fresh = bts.filter((b) => !seen.has(b.id));
      fresh.forEach((b) => seen.add(b.id));
      uts.forEach((u) => used.add(u.id));
      rows.push({ item: it, builtins: fresh, users: uts, dup: bts.length > 0 && fresh.length === 0 });
    }
    return { rows: rows.filter((r) => r.builtins.length || r.users.length), used };
  }, [outs, tips]);

  const others = useMemo(() => tips.filter((t) => !matched.used.has(t.id)), [tips, matched.used]);
  const noMatch = useMemo(
    () => outs.filter((it) => !tipsFor(it.name).length && !tips.some((t) => tipKeyHit(t, it.name))),
    [outs, tips]
  );

  const doVote = async (t, v, reason) => {
    setErr("");
    if (!writable && !local) { setErr("추천하려면 로그인하세요."); return; }
    try {
      await vote(conn, t.id, v, reason);
      await reload();
    } catch (e) { setErr(e.message || "투표하지 못했습니다."); }
  };

  const save = async () => {
    setErr(""); setBusy(true);
    try {
      const clean = cleanTip(draft);
      const dup = findDuplicate(clean, draft.id ? tips.filter((t) => t.id !== draft.id) : tips);
      if (dup) {
        setErr(`이미 올라온 꿀팁과 거의 같습니다 — "${dup.title}". 다른 점이 있으면 그 부분만 적어 주세요.`);
        setBusy(false); return;
      }
      if (draft.id) await editTip(conn, draft.id, clean);
      else await addTip(conn, clean);
      setDraft(null);
      setMsg(local
        ? "이 브라우저에 저장했습니다. 로그인하면 다른 사람에게도 보입니다."
        : "올렸습니다. 같은 항목을 적어 둔 사람에게 바로 보입니다.");
      await reload();
    } catch (e) { setErr(e.message || "올리지 못했습니다."); }
    setBusy(false);
  };

  const openReports = async () => {
    setShowReports(true);
    try { setReports(await listReports(conn)); }
    catch (e) { setErr(e.message || "신고를 불러오지 못했습니다."); }
  };

  const hide = async (t, h) => {
    try {
      await setHidden(conn, t.id, h);
      await reload();
      if (showReports) setReports(await listReports(conn));
    } catch (e) { setErr(e.message || "처리하지 못했습니다."); }
  };

  const myId = conn.user ? conn.user.id : "local";
  const tipProps = {
    onVote: doVote,
    onEdit: (x) => { setMsg(""); setErr(""); setDraft({ ...x }); },
    onDelete: (x) => setDel(x),
    admin, onHide: hide,
  };

  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow">SAVE</span>
            <h2>아껴보기</h2>
            <p className="sub">수입·지출에 적어 둔 항목 이름을 보고, 그 지출을 줄이는 방법을 모아 보여줍니다.</p>
          </div>
          {(writable || local) && !draft && (
            <button className="btn sm primary" onClick={() => { setMsg(""); setErr(""); setDraft({ keywords: "", title: "", body: "", nick: "" }); }}>
              꿀팁 올리기
            </button>
          )}
        </div>

        <p className="mut sm">
          줄일 곳은 커피값이 아니라 <b>매달 자동으로 빠져나가는 고정비</b>입니다.
          한 번 갈아타면 다음 달부터 계속 줄어드는 항목을 먼저 보세요.{" "}
          <a className="ilink" href="/guide/spending-habits">읽어보기</a>
        </p>

        {outs.length === 0 && (
          <div className="wtip">
            아직 매달 나가는 지출이 없습니다. 항목을 넣으면 그 이름에 맞는 방법을 찾아 줍니다.{" "}
            <button className="btn sm" onClick={() => setTab("items")}>지출 넣으러 가기</button>
          </div>
        )}
        {local && (
          <div className="wtip">
            지금 올리는 꿀팁은 이 브라우저에만 저장됩니다. 로그인하면 다른 사람에게도 보이고, 다른 사람의 꿀팁도 받아옵니다.{" "}
            <button className="btn sm" onClick={() => setTab("conn")}>계정 열기</button>
          </div>
        )}
        {msg && <div className="wtip">{msg}</div>}
        {err && !draft && <div className="wtip bad">{err}</div>}
      </section>

      {draft && (
        <TipForm draft={draft} setDraft={setDraft} onSave={save} busy={busy} err={err}
          onCancel={() => { setDraft(null); setErr(""); }} />
      )}

      {matched.rows.map(({ item, builtins, users, dup }) => (
        <section className="card" key={item.id}>
          <div className="card-h">
            <div>
              <span className="eyebrow">내 항목</span>
              <h2>{item.name}</h2>
              <p className="sub">
                {money(num(item.amount), unit)} · {(FREQ.find((f) => f.v === item.freq) || FREQ[0]).label}
              </p>
            </div>
          </div>
          {dup && <p className="mut sm">위에 나온 항목과 같은 분류입니다. 방법은 위를 보세요.</p>}
          {builtins.map((b) => (
            <div className="tipgroup" key={b.id}>
              <span className="eyebrow">{b.headline}</span>
              {b.tips.map((t) => <BuiltinTip key={t.title} t={t} />)}
            </div>
          ))}
          {users.length > 0 && (
            <div className="tipgroup">
              <span className="eyebrow">쓰는 사람들이 올린 방법</span>
              {users.map((t) => (
                <UserTip key={t.id} t={t} mine={t.userId === myId} myVote={votes[t.id] || 0} {...tipProps} />
              ))}
            </div>
          )}
        </section>
      ))}

      {noMatch.length > 0 && (
        <section className="card">
          <div className="card-h">
            <div>
              <span className="eyebrow">아직 방법이 없는 항목</span>
              <h2>{noMatch.length}개</h2>
            </div>
          </div>
          <p className="mut sm">
            {noMatch.map((i) => i.name).join(", ")} — 이 항목을 줄여 본 적이 있으면 올려 주세요.
            다음 사람이 같은 이름을 적었을 때 바로 보입니다.
          </p>
        </section>
      )}

      {others.length > 0 && (
        <section className="card">
          <div className="card-h">
            <div>
              <span className="eyebrow">COMMUNITY</span>
              <h2>다른 사람의 꿀팁 보기</h2>
              <p className="sub">내 항목에는 안 걸렸지만, 쓸 만하다고 추천받은 방법 {others.length}개</p>
            </div>
          </div>
          {(showAll ? others : others.slice(0, 3)).map((t) => (
            <UserTip key={t.id} t={t} mine={t.userId === myId} myVote={votes[t.id] || 0} {...tipProps} />
          ))}
          {others.length > 3 && (
            <button className="btn sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? "접기" : `${others.length - 3}개 더 보기`}
            </button>
          )}
        </section>
      )}

      {admin && (
        <section className="card">
          <div className="card-h">
            <div>
              <span className="eyebrow">관리자</span>
              <h2>신고 보기</h2>
              <p className="sub">비추천에 적힌 사유를 모아 봅니다. 사유는 글쓴이에게 보이지 않습니다.</p>
            </div>
            {!showReports && <button className="btn sm" onClick={openReports}>불러오기</button>}
          </div>
          {showReports && (reports.length === 0 ? (
            <p className="mut sm">사유가 적힌 비추천이 없습니다.</p>
          ) : reports.map((r) => (
            <div className="tipcard user" key={r.id}>
              <div className="tiphead">
                <b>{r.title}</b>
                <span className="eff bad">비추천 {r.down}</span>
                {r.hidden && <span className="eff bad">가려짐</span>}
              </div>
              <ul className="reasons">{r.reasons.map((x, i) => <li key={i}>{x.reason}</li>)}</ul>
              <div className="tipfoot">
                <button className="vt plain" onClick={() => hide({ id: r.id }, !r.hidden)}>
                  {r.hidden ? "다시 보이기" : "가리기"}
                </button>
              </div>
            </div>
          )))}
        </section>
      )}

      <Confirm open={!!del} name={del ? del.title : ""} kind="꿀팁"
        onCancel={() => setDel(null)}
        onConfirm={async () => {
          const t = del; setDel(null);
          try { await removeTip(conn, t.id); await reload(); }
          catch (e) { setErr(e.message || "삭제하지 못했습니다."); }
        }} />
    </>
  );
}

function ItemsTab({ plan, up, unit }) {
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);

  const blank = (kind, flow) => ({
    id: uid(), kind, flow, name: "", amount: 0, cat: flow === "in" ? "급여" : "고정비",
    freq: "monthly", startMonth: plan.settings.startMonth, endMonth: "", growth: 0,
    month: plan.settings.startMonth,
  });

  const save = (it) => {
    up((p) => {
      const i = p.items.findIndex((x) => x.id === it.id);
      if (i >= 0) p.items[i] = it; else p.items.push(it);
    });
    setEdit(null);
  };

  const monthlyEq = (it) => (it.kind === "oneoff" ? 0 : num(it.amount) / freqStep(it.freq));
  const sumMonthly = (list) => list.reduce((a, i) => a + monthlyEq(i), 0);
  const sumOneoff = (list) => list.filter((i) => i.kind === "oneoff").reduce((a, i) => a + num(i.amount), 0);

  const inList = plan.items.filter((i) => i.flow === "in");
  const outList = plan.items.filter((i) => i.flow === "out");
  const netMonthly = sumMonthly(inList) - sumMonthly(outList);

  const groups = [
    { flow: "in", title: "수입", list: inList },
    { flow: "out", title: "지출", list: outList },
  ];

  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">RECURRING & ONE-OFF</span>
            <h2>매달 들어오고 나가는 돈</h2>
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => setEdit(blank("recurring", "in"))}>수입 추가</button>
            <button className="btn sm" onClick={() => setEdit(blank("recurring", "out"))}>지출 추가</button>
          </div>
        </div>

        <div className="sumbar">
          <div><span className="eyebrow">월 환산 수입</span><b className="mono pos">{money(sumMonthly(inList), unit)}</b></div>
          <div><span className="eyebrow">월 환산 지출</span><b className="mono neg">{money(sumMonthly(outList), unit)}</b></div>
          <div><span className="eyebrow">월 순현금흐름</span><b className={`mono ${netMonthly < 0 ? "neg" : "pos"}`}>{money(netMonthly, unit)}</b></div>
          <p className="mut sm">주기가 다른 항목은 월 단위로 환산해 더했습니다. 일회성 항목과 연 증가율은 빠져 있으니 실제 흐름은 대시보드에서 확인하세요.</p>
        </div>

        {(() => {
          const have = new Set(plan.items.map((i) => (i.name || "").trim()));
          const todo = FORGOTTEN.filter((f) => !have.has(f.name));
          if (!todo.length) return null;
          return (
            <div className="forgot">
              <span className="eyebrow">매달 나가진 않지만 분명히 나가는 돈</span>
              <p>
                이런 지출은 달력에 없으니 계획에서 빠지고, 그래서 그달에 잔고가 꺼집니다.
                <b> 미리 넣어두면 놀라지 않습니다.</b> 누르면 주기가 맞춰진 채로 열리니 금액만 적으세요.
              </p>
              <div className="forgot-chips">
                {todo.map((f) => (
                  <button key={f.name} className="fchip" title={f.why}
                    onClick={() => setEdit({
                      id: uid(), kind: "recurring", flow: "out", name: f.name, amount: 0,
                      cat: f.cat, freq: f.freq, startMonth: plan.settings.startMonth,
                      endMonth: "", growth: 0, month: plan.settings.startMonth,
                    })}>
                    <b>{f.name}</b>
                    <em>{(FREQ.find((x) => x.v === f.freq) || {}).label}</em>
                  </button>
                ))}
              </div>
              <p className="mut sm" style={{ marginTop: 9 }}>
                금액을 모르겠으면 작년에 얼마 썼는지 떠올려 대충 넣으세요. 0으로 두는 것보다 낫습니다.
              </p>
            </div>
          );
        })()}

        <div className="habitnote">
          <span className="eyebrow">여기 적은 숫자가 맞아야 판정도 맞습니다</span>
          <p>
            이 화면에서 가장 틀리기 쉬운 항목은 <b>식비와 생활비</b>입니다. 고정비는 고지서가 있어 정확하지만,
            변동비는 기억으로 적고 기억은 대개 실제보다 적게 잡습니다. 그 차이만큼 뒤의 계산이 낙관적으로 나옵니다.
          </p>
          <p>
            <b>카드 결제 내역을 보는 목적은 아끼기 위해서가 아닙니다.</b>{" "}
            내가 어디에 얼마를 쓰는지 알기 위해서입니다. 한 달치를 내려받아 식비·배달·교통처럼 큰 덩어리로만
            나눠 보세요. 두세 달이면 평균이 잡히고, 그 뒤로는 계속 적지 않아도 됩니다.
          </p>

          <div className="habit-split">
            <div className="hs keep">
              <span className="hs-tag">그대로 두세요</span>
              <b>가끔 맛있는 거 먹기</b>
              <p>
                한 달에 한두 번 좋은 걸 먹거나 사고 싶던 걸 사는 돈은 줄이지 마세요.
                줄여도 액수가 작고, 참다가 한 번에 무너지면 그게 더 큽니다.
                이런 지출은 계속 쓰기 위해 버티게 해주는 쪽입니다.
              </p>
            </div>
            <div className="hs cut">
              <span className="hs-tag">여기를 줄이세요</span>
              <b>매달 똑같이 나가는 고정비</b>
              <p>
                한 번 줄이면 <b>매달 자동으로</b> 줄어듭니다. 신경 쓸 일도, 참을 일도 없습니다.
                같은 1만원이라도 고정비에서 줄인 1만원은 1년이면 12만원, 3년이면 36만원입니다.
              </p>
            </div>
          </div>

          <ul className="habit-list">
            <li>
              <b>통신비</b> — 알뜰폰으로 옮기면 쓰는 양을 그대로 두고도 요금이 줄어듭니다.
              통신사업자들이 함께 운영하는 <a className="ilink" href="https://www.mvnohub.kr/product/products.do"
                target="_blank" rel="noopener noreferrer">알뜰폰허브</a>나{" "}
              <a className="ilink" href="https://www.smartchoice.or.kr" target="_blank" rel="noopener noreferrer">스마트초이스</a>에서
              지금 쓰는 데이터량 기준으로 비교해 보세요. 번호는 그대로 가져갑니다
            </li>
            <li>
              <b>인터넷·TV</b> — 약정이 끝났는데 그대로 두고 있는 경우가 많습니다.
              지역 케이블이나 결합 상품을 함께 견적 내 보세요. 안 보는 채널 묶음을 빼는 것만으로도 줄어듭니다
            </li>
            <li>
              <b>전기</b> — 한전 <b>주택용 에너지캐시백</b>은 지난 2년 같은 기간보다 1%만 덜 써도
              kWh당 돈을 돌려줍니다. 절감률이 클수록 단가가 올라갑니다. 한전 에너지마켓플레이스에서 신청합니다
            </li>
            <li>
              <b>가스·수도</b> — 난방 설정 온도와 샤워 시간이 대부분을 차지합니다.
              고지서의 전년 같은 달 사용량과 비교하는 습관만 들여도 달라집니다
            </li>
            <li>
              <b>구독</b> — 안 보는 OTT, 겹치는 음악 서비스, 잊은 멤버십.
              카드 내역을 훑을 때 가장 확실하게 나오는 항목입니다
            </li>
          </ul>

          <p className="habit-do">
            고정비를 줄였으면 <b>위 항목의 금액도 함께 고치세요.</b>{" "}
            그래야 줄인 만큼이 현금흐름에 반영되고, 감당 가능 판정도 달라집니다.
          </p>
        </div>

        {groups.map((g) => (
          <div key={g.flow} className="grp">
            <h3 className="grp-t">{g.title} <span className="mono mut">{g.list.length}</span></h3>
            {g.list.length === 0 && <p className="mut sm">아직 없습니다. 위 버튼으로 추가하세요.</p>}
            <div className="tablewrap">
              {g.list.length > 0 && (
                <table className="tbl tbl-cards">
                  <thead>
                    <tr><th>이름</th><th>분류</th><th>주기</th><th>기간</th><th className="r">금액</th><th className="r">연 증가율</th><th /></tr>
                  </thead>
                  <tbody>
                    {g.list.map((it) => (
                      <tr key={it.id}>
                        <td className="cname">{it.name || <span className="mut">(이름 없음)</span>}</td>
                        <td className="mut" data-l="분류">{it.cat}</td>
                        <td className="mono" data-l="주기">{it.kind === "oneoff" ? "일회성" : (FREQ.find((f) => f.v === it.freq) || {}).label}</td>
                        <td className="mono mut" data-l="기간">
                          {it.kind === "oneoff" ? labelYM(it.month) : `${labelYM(it.startMonth)} ~ ${it.endMonth ? labelYM(it.endMonth) : "계속"}`}
                        </td>
                        <td className={`r mono ${it.flow === "in" ? "pos" : "neg"}`} data-l="금액">{money(it.amount, unit)}</td>
                        <td className="r mono mut" data-l="연 증가율">{num(it.growth) ? `${it.growth}%` : "—"}</td>
                        <td className="r nowrap cact">
                          <button className="link" onClick={() => setEdit({ ...it })}>수정</button>
                          <button className="link del" onClick={() => setDel(it)}>삭제</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="sum">
                      <td colSpan={4}>합계 · 월 환산</td>
                      <td className={`r mono ${g.flow === "in" ? "pos" : "neg"}`}>{money(sumMonthly(g.list), unit)}</td>
                      <td colSpan={2} />
                    </tr>
                    {sumOneoff(g.list) > 0 && (
                      <tr className="sum sub">
                        <td colSpan={4}>일회성 합계</td>
                        <td className="r mono mut">{money(sumOneoff(g.list), unit)}</td>
                        <td colSpan={2} />
                      </tr>
                    )}
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        ))}
      </section>

      <Confirm open={!!del} name={del && del.name} kind={del && del.flow === "in" ? "수입 항목" : "지출 항목"}
        onCancel={() => setDel(null)}
        onConfirm={() => { up((p) => { p.items = p.items.filter((x) => x.id !== del.id); }); setDel(null); }} />

      {edit && (
        <Modal title={edit.flow === "in" ? "수입 항목" : "지출 항목"} onClose={() => setEdit(null)}
          footer={<>
            <button className="btn" onClick={() => setEdit(null)}>취소</button>
            <button className="btn primary" onClick={() => save(edit)}>저장</button>
          </>}>
          <div className="grid">
            <Field label="이름" wide>
              <input className="in" value={edit.name} placeholder="예: 급여, 관리비, 학원비"
                onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="구분">
              <select className="in" value={edit.flow} onChange={(e) => setEdit({ ...edit, flow: e.target.value })}>
                <option value="in">수입</option><option value="out">지출</option>
              </select>
            </Field>
            <Field label="분류">
              <select className="in" value={edit.cat} onChange={(e) => setEdit({ ...edit, cat: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="금액">
              <NumIn value={edit.amount} step={10000} onChange={(v) => setEdit({ ...edit, amount: num(v) })} suffix="원" comma />
            </Field>
            <Field label="반복 여부">
              <select className="in" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                <option value="recurring">반복</option><option value="oneoff">일회성</option>
              </select>
            </Field>
            {edit.kind === "oneoff" ? (
              <Field label="발생 월">
                <input className="in mono" type="month" value={edit.month} onChange={(e) => setEdit({ ...edit, month: e.target.value })} />
              </Field>
            ) : (
              <>
                <Field label="주기">
                  <select className="in" value={edit.freq} onChange={(e) => setEdit({ ...edit, freq: e.target.value })}>
                    {FREQ.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
                  </select>
                </Field>
                <Field label="시작 월">
                  <input className="in mono" type="month" value={edit.startMonth} onChange={(e) => setEdit({ ...edit, startMonth: e.target.value })} />
                </Field>
                <Field label="종료 월" hint="비우면 계속">
                  <input className="in mono" type="month" value={edit.endMonth || ""} onChange={(e) => setEdit({ ...edit, endMonth: e.target.value })} />
                </Field>
                <Field label="연 증가율" hint="물가·인상률 반영">
                  <NumIn value={edit.growth} step={0.5} onChange={(v) => setEdit({ ...edit, growth: num(v) })} suffix="%" />
                </Field>
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}

/* ---------------- 큰 지출 탭 ---------------- */
function BigsTab({ plan, up, unit, catalog, results, primary }) {
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);

  const blank = () => ({
    id: uid(), name: "", amount: 0, month: addM(plan.settings.startMonth, 6),
    method: "lump", productId: "", down: 0, months: 12, apr: 0, feeRate: 0,
    repayment: "annuity", defer: 1,
  });

  const save = (be) => {
    up((p) => {
      const i = p.bigs.findIndex((x) => x.id === be.id);
      if (i >= 0) p.bigs[i] = be; else p.bigs.push(be);
    });
    setEdit(null);
  };

  const prodName = (id) => {
    const p = catalog.products.find((x) => x.id === id);
    if (!p) return "";
    const o = catalog.orgs.find((x) => x.id === p.orgId);
    return `${o ? o.name + " · " : ""}${p.name}`;
  };

  const bigTotals = plan.bigs.reduce((a, be) => {
    const s = bigSchedule(be);
    a.price += num(be.amount);
    a.interest += s.interest;
    a.fee += s.financed * (num(be.feeRate) / 100);
    a.monthly += be.method === "lump" ? 0 : s.monthly;
    return a;
  }, { price: 0, interest: 0, fee: 0, monthly: 0 });

  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">MAJOR PURCHASES</span>
            <h2>계획 중인 큰 지출</h2>
          </div>
          <button className="btn sm primary" onClick={() => setEdit(blank())}>큰 지출 추가</button>
        </div>

        {plan.bigs.length === 0 ? (
          <div className="empty inner">
            <h3>차, 이사, 수술, 여행 — 목돈이 나갈 일을 넣어보세요.</h3>
            <p>일시불·할부·대출 중 무엇을 고르느냐에 따라 잔고 곡선이 크게 달라집니다.</p>
          </div>
        ) : (
          <div className="biglist">
            {plan.bigs.map((be) => {
              const s = bigSchedule(be);
              return (
                <div key={be.id} className="bigrow">
                  <div className="bigmain">
                    <span className="eyebrow en">{labelYM(be.month)}</span>
                    <h3>{be.name || "(이름 없음)"}</h3>
                    <p className="mono">{won(be.amount)}</p>
                  </div>
                  <div className="bigmeta mono">
                    {be.method === "lump" ? (
                      <span>일시불</span>
                    ) : (
                      <>
                        <span>{be.method === "loan" ? "대출" : "할부"} {s.n}개월 · 연 {num(be.apr)}%</span>
                        <span>월 {won(s.monthly)}</span>
                        <span>선납 {won(be.down)}</span>
                        <span className={s.interest > 0 ? "neg" : ""}>이자합계 {won(s.interest)}</span>
                        <span className="mut">마지막 {labelYM(s.lastMonth)}</span>
                      </>
                    )}
                    {be.productId && <span className="mut">{prodName(be.productId)}</span>}
                  </div>
                  <div className="bigact">
                    <button className="link" onClick={() => setEdit({ ...be })}>수정</button>
                    <button className="link" onClick={() => up((p) => {
                      const c = { ...be, id: uid(), name: be.name + " (사본)" };
                      p.bigs.push(c);
                    })}>복제</button>
                    <button className="link del" onClick={() => setDel(be)}>삭제</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {plan.bigs.length > 0 && (
          <div className="sumbar">
            <div><span className="eyebrow">지출 원금 합계</span><b className="mono">{money(bigTotals.price, unit)}</b></div>
            <div><span className="eyebrow">이자·수수료 합계</span><b className={`mono ${bigTotals.interest + bigTotals.fee > 0 ? "neg" : ""}`}>{money(bigTotals.interest + bigTotals.fee, unit)}</b></div>
            <div><span className="eyebrow">총 부담 합계</span><b className="mono">{money(bigTotals.price + bigTotals.interest + bigTotals.fee, unit)}</b></div>
            <div><span className="eyebrow">월 상환액 합계</span><b className="mono">{money(bigTotals.monthly, unit)}</b></div>
            <p className="mut sm">월 상환액은 각 항목의 첫 회 상환액을 더한 값입니다. 상환 시기가 겹치지 않으면 실제로 이만큼 동시에 나가지는 않습니다.</p>
          </div>
        )}
      </section>

      <Confirm open={!!del} name={del && del.name} kind="큰 지출"
        note="구성 항목과 상환 계획이 함께 사라집니다. 되돌릴 수 없습니다."
        onCancel={() => setDel(null)}
        onConfirm={() => { up((p) => { p.bigs = p.bigs.filter((x) => x.id !== del.id); }); setDel(null); }} />

      {edit && (
        <BigEditor
          be={edit} setBe={setEdit} catalog={catalog}
          onCancel={() => setEdit(null)} onSave={() => save(edit)}
        />
      )}
    </>
  );
}

function BigEditor({ be, setBe, catalog, onCancel, onSave }) {
  const [delLine, setDelLine] = useState(null);
  const [clearAll, setClearAll] = useState(false);
  const s = bigSchedule(be);
  const product = catalog.products.find((p) => p.id === be.productId);
  const lines = be.lines || [];
  const hasLines = lines.length > 0;
  const base = baseAmount(lines);

  /* 항목이 있으면 총 금액은 항목 합계로 유지합니다 */
  const setLines = (next) => setBe({ ...be, lines: next, amount: linesTotal(next) });
  const patchLine = (id, patch) =>
    setLines(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLine = (id) => setLines(lines.filter((l) => l.id !== id));
  const addLine = () => setLines([...lines, newLine({ name: "" })]);
  const useTemplate = (tplId) => {
    const next = makeLines(tplId);
    const t = BIG_TEMPLATES.find((x) => x.id === tplId);
    setBe({ ...be, lines: next, amount: 0, name: be.name || (t ? t.label : "") });
  };

  const pickProduct = (id) => {
    const p = catalog.products.find((x) => x.id === id);
    if (!p) { setBe({ ...be, productId: "" }); return; }
    const free = num(p.freeMonths) >= num(be.months);
    setBe({
      ...be, productId: id,
      apr: free ? 0 : num(p.apr),
      feeRate: num(p.feeRate),
      months: Math.min(num(be.months) || 12, num(p.maxMonths) || 60),
    });
  };

  return (
    <Modal title="큰 지출" wide onClose={onCancel}
      footer={<>
        <button className="btn" onClick={onCancel}>취소</button>
        <button className="btn primary" onClick={onSave}>저장</button>
      </>}>
      <div className="grid">
        <Field label="이름" wide>
          <input className="in" value={be.name} placeholder="예: 자동차 구입, 전세 보증금, 이사"
            onChange={(e) => setBe({ ...be, name: e.target.value })} />
        </Field>
        {hasLines ? (
          <Field label="총 금액" hint="아래 구성 항목의 합계">
            <span className="numwrap boxed readonly">
              <em className="krin">{readable(be.amount)}</em>
              <span className="mono roval">{won(be.amount)}</span>
            </span>
          </Field>
        ) : (
          <Field label="총 금액">
            <NumIn value={be.amount} step={100000} onChange={(v) => setBe({ ...be, amount: num(v) })} suffix="원" comma />
          </Field>
        )}
        <Field label="지출 시점">
          <input className="in mono" type="month" value={be.month} onChange={(e) => setBe({ ...be, month: e.target.value })} />
        </Field>
        <Field label="결제 방식">
          <select className="in" value={be.method} onChange={(e) => setBe({ ...be, method: e.target.value })}>
            <option value="lump">일시불</option>
            <option value="installment">할부</option>
            <option value="loan">대출</option>
          </select>
        </Field>

        {be.method !== "lump" && (
          <>
            <Field label="상품 선택" hint={product ? product.note : "카탈로그의 조건을 불러옵니다"}>
              <select className="in" value={be.productId} onChange={(e) => pickProduct(e.target.value)}>
                <option value="">직접 입력</option>
                {catalog.products.map((p) => {
                  const o = catalog.orgs.find((x) => x.id === p.orgId);
                  return <option key={p.id} value={p.id}>{o ? o.name + " · " : ""}{p.name}</option>;
                })}
              </select>
            </Field>
            <Field label="선납금 / 계약금">
              <NumIn value={be.down} step={100000} onChange={(v) => setBe({ ...be, down: num(v) })} suffix="원" comma />
            </Field>
            <Field label="기간">
              <NumIn value={be.months} min={1} onChange={(v) => setBe({ ...be, months: Math.max(1, num(v)) })} suffix="개월" />
            </Field>
            <Field label="연 이자율" hint="무이자면 0">
              <NumIn value={be.apr} step={0.1} onChange={(v) => setBe({ ...be, apr: num(v) })} suffix="%" />
            </Field>
            <Field label="상환 방식">
              <select className="in" value={be.repayment} onChange={(e) => setBe({ ...be, repayment: e.target.value })}>
                {REPAY.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
              </select>
            </Field>
            <Field label="취급수수료" hint="대출금 대비 %">
              <NumIn value={be.feeRate} step={0.1} onChange={(v) => setBe({ ...be, feeRate: num(v) })} suffix="%" />
            </Field>
            <Field label="첫 상환까지" hint="0이면 당월부터">
              <NumIn value={be.defer} min={0} onChange={(v) => setBe({ ...be, defer: Math.max(0, num(v)) })} suffix="개월 뒤" />
            </Field>
          </>
        )}
      </div>

      <h4 className="sub-h">구성 항목</h4>
      {!hasLines ? (
        <div className="tplpick">
          <p className="note">
            어떤 지출인지 고르면 들어가는 비용 항목이 자동으로 채워집니다. 금액은 직접 넣으시면 됩니다.
          </p>
          <div className="row">
            {BIG_TEMPLATES.map((t) => (
              <button key={t.id} className="btn sm" onClick={() => useTemplate(t.id)} title={t.hint}>
                {t.label}
              </button>
            ))}
            <button className="btn sm" onClick={addLine}>빈 항목부터</button>
          </div>
          <p className="mut sm" style={{ marginTop: 10 }}>
            항목 없이 위의 총 금액만 넣어도 됩니다.
          </p>
        </div>
      ) : (
        <>
          <div className="lines">
            {lines.map((l) => (
              <div key={l.id} className={`lrow${l.base ? " isbase" : ""}`}>
                <input className="in lname" value={l.name} placeholder="항목 이름"
                  onChange={(e) => patchLine(l.id, { name: e.target.value })} />

                <select className="in lkind" value={l.kind}
                  onChange={(e) => patchLine(l.id, { kind: e.target.value })}
                  disabled={l.base}>
                  <option value="amount">금액</option>
                  <option value="pct">비율</option>
                </select>

                {l.kind === "pct" ? (
                  <NumIn value={l.pct} step={0.1} suffix="%"
                    onChange={(v) => patchLine(l.id, { pct: num(v) })} />
                ) : (
                  <NumIn value={l.amount} step={10000} suffix="원" comma
                    onChange={(v) => patchLine(l.id, { amount: num(v) })} />
                )}

                <span className="lcalc mono">{won(lineValue(l, base))}</span>

                <button className="link del lx" aria-label="항목 삭제"
                  onClick={() => {
                    /* 비어 있는 줄은 묻지 않고 바로 지웁니다 */
                    const empty = !String(l.name || "").trim() && !num(l.amount) && !num(l.pct);
                    if (empty) removeLine(l.id); else setDelLine(l);
                  }}>삭제</button>

                {l.base && <span className="lbadge">기준</span>}
                {l.note && <span className="lnote mut">{l.note}</span>}
              </div>
            ))}
          </div>

          <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
            <button className="btn sm" onClick={addLine}>항목 추가</button>
            <span className="ltotal mono">합계 <b>{won(be.amount)}</b></span>
          </div>

          <p className="mut sm" style={{ marginTop: 8 }}>
            비율 항목은 <b>기준</b> 항목({lines.find((l) => l.base)?.name || "첫 항목"}) 금액에 곱해 계산합니다.
            세율과 수수료율은 조건마다 달라 비워뒀으니 직접 확인해 넣으세요.
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="link del" onClick={() => setClearAll(true)}>항목 전부 지우고 금액만 입력</button>
          </div>
        </>
      )}

      <div className="calcbox">
        <span className="eyebrow">계산 결과</span>
        {be.method === "lump" ? (
          <p className="mono">{labelYM(be.month)}에 {won(be.amount)}이 한 번에 빠져나갑니다.</p>
        ) : (
          <ul className="mono">
            <li><span>대출·할부 원금</span><b>{won(s.financed)}</b></li>
            <li><span>첫 회 상환액</span><b>{won(s.monthly)}</b></li>
            <li><span>총 이자</span><b className={s.interest > 0 ? "neg" : ""}>{won(s.interest)}</b></li>
            <li><span>총 부담액</span><b>{won(num(be.amount) + s.interest + s.financed * (num(be.feeRate) / 100))}</b></li>
            <li><span>상환 기간</span><b>{labelYM(addM(be.month, num(be.defer)))} ~ {labelYM(s.lastMonth)}</b></li>
          </ul>
        )}
      </div>

      <Confirm open={!!delLine} name={delLine && delLine.name} kind="구성 항목"
        note="총 금액이 그만큼 줄어듭니다."
        onCancel={() => setDelLine(null)}
        onConfirm={() => { removeLine(delLine.id); setDelLine(null); }} />

      <Confirm open={clearAll} name={be.name} kind="지출의 구성 항목"
        confirmLabel="전부 지우기"
        note="항목을 모두 지우고 총 금액만 직접 넣는 방식으로 돌아갑니다. 적어 둔 항목과 금액은 사라집니다."
        onCancel={() => setClearAll(false)}
        onConfirm={() => { setBe({ ...be, lines: [] }); setClearAll(false); }} />
    </Modal>
  );
}

/* ---------------- 저축 탭 ---------------- */

/* 안전선을 지키면서 매달 넣을 수 있는 최대 금액을 찾습니다.
   단, 전부 넣으라고 권하지는 않습니다. 아래 CARE_SHARE 를 남겨 둡니다. */
const CARE_SHARE = 0.2;

function maxMonthlySaving(plan, sc, draft) {
  const fits = (amt) => {
    const p2 = JSON.parse(JSON.stringify(plan));
    p2.savings = [...(p2.savings || []), { ...draft, id: "probe", amount: amt }];
    return verdictOf(extendHorizon(p2), sc).ok;
  };
  if (!fits(10000)) return 0;
  let lo = 10000, hi = 10000;
  while (hi < 50000000 && fits(hi * 2)) hi *= 2;
  hi = Math.min(hi * 2, 50000000);
  for (let i = 0; i < 24; i++) {
    const mid = Math.floor((lo + hi) / 2 / 10000) * 10000;
    if (mid <= lo) break;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  return lo;
}

function SavingsTab({ plan, up, unit, results, primary }) {
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);

  const list = plan.savings || [];
  const res = results[primary.id];
  const m = res.metrics;

  const blank = () => ({
    id: uid(), kind: "regular", name: "",
    amount: 0, startMonth: plan.settings.startMonth,
    months: 12, apr: 0, compound: "simple", taxRate: TAX_RATE,
  });

  const save = (sv) => {
    up((p) => {
      p.savings = p.savings || [];
      const i = p.savings.findIndex((x) => x.id === sv.id);
      if (i >= 0) p.savings[i] = sv; else p.savings.push(sv);
    });
    setEdit(null);
  };

  const totals = list.reduce((a, sv) => {
    const sch = savingSchedule(sv);
    a.monthly += sv.kind === "regular" ? num(sv.amount) : 0;
    a.principal += sch.principal;
    a.net += sch.net;
    a.payout += sch.payout;
    return a;
  }, { monthly: 0, principal: 0, net: 0, payout: 0 });

  const free = m.avgFree;
  const leftover = free - totals.monthly;

  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">FREE CASH FLOW</span>
            <h2>매달 남는 돈</h2>
          </div>
          <button className="btn sm primary" onClick={() => setEdit(blank())}>저축 추가</button>
        </div>

        <div className="sumbar">
          <div><span className="eyebrow">저축 전 월평균 여유</span>
            <b className={`mono ${free < 0 ? "neg" : "pos"}`}>{money(free, unit)}</b></div>
          <div><span className="eyebrow">지금 넣고 있는 적금</span>
            <b className="mono">{money(totals.monthly, unit)}</b></div>
          <div><span className="eyebrow">그러고도 남는 돈</span>
            <b className={`mono ${leftover < 0 ? "neg" : ""}`}>{money(leftover, unit)}</b></div>
          <p className="mut sm">
            수입에서 지출을 뺀 금액의 월평균입니다. 큰 지출의 상환액도 지출에 들어가 있습니다.
          </p>
        </div>

        {free > 0 && leftover > 0 && (
          <div className="wtip">
            매달 <b>{money(leftover, unit)}</b>이 통장에 그냥 쌓이고 있습니다.
            쓸 일이 정해지지 않은 돈이라면 적금으로 묶어두는 편이 낫습니다.
            다만 전부 넣지는 마세요 — 아래를 읽어보세요.
          </div>
        )}

        {free > 0 && leftover <= 0 && totals.monthly > 0 && (
          <div className="wtip bad">
            여유보다 많이 넣고 있습니다. 저축이 생활비를 밀어내면 결국 중도해지하게 됩니다.
            금액을 줄이거나 기간을 늘리는 편이 낫습니다.
          </div>
        )}

        {free <= 0 && (
          <div className="wtip bad">
            지금은 매달 돈이 모자랍니다. 저축보다 <b>수입·지출</b>을 먼저 맞추는 게 순서입니다.
          </div>
        )}

        <div className="seednote">
          <span className="eyebrow">조급해지면 그때가 가장 위험합니다</span>
          <p>
            모으다 보면 남들이 벌었다는 얘기가 들립니다. 쌓이는 속도가 답답해 보이고 나만 뒤처지는 것 같습니다.
            그때 적금을 깨거나 모은 돈을 한 번에 옮기게 됩니다.
          </p>
          <p>
            <b>원금이 작을 때는 수익률이 납입액을 못 이깁니다.</b>{" "}
            1,000만원으로 10%를 벌면 100만원이지만, 매달 30만원씩 모으면 1년에 360만원입니다.
            수익률이 의미를 갖는 건 원금이 충분히 커진 뒤입니다. 순서는 <b>먼저 모으고, 그다음에 굴리기</b>입니다.
          </p>
          <p>
            그리고 반토막이 나면 원금 회복에 100%가 필요합니다. 2년 모은 돈을 잃으면 다시 2년입니다.
            <b> 기회가 왔을 때 잡는 사람은 그때 현금이 있는 사람입니다.</b> 그 현금이 시드머니고,
            시드머니는 꾸준히 모아야만 생깁니다.
          </p>
          <p className="seed-do">
            <b>자동이체로 걸어두세요.</b> 매달 넣을까 말까를 고민하면 시장이 좋을 때 많이 넣고 나쁠 때 멈추게 됩니다.
            결정을 없애는 쪽이 오래갑니다.{" "}
            <a className="ilink" href="/guide/saving-plan">더 읽기</a>
          </p>
        </div>

        <div className="carenote">
          <span className="eyebrow">모으기만 하면 지칩니다</span>
          <p>
            남는 돈을 전부 적금에 넣으면 숫자는 좋아 보이지만 오래 못 갑니다.
            참다가 한 번에 무너지는 쪽이 조금씩 쓰는 쪽보다 결국 더 많이 씁니다.
          </p>
          <p>
            <b>여유의 {Math.round(CARE_SHARE * 100)}% 정도는 나를 위해 남겨두세요.</b>{" "}
            취미, 운동, 친구 만나기, 혼자 쉬는 시간처럼 돈이 들더라도 버티게 해주는 것들입니다.
            저축은 생활을 쥐어짜서가 아니라 <b>남는 돈에서</b> 하는 것이 오래갑니다.
          </p>
          {free > 0 && (
            <p className="mono carefig">
              이 계획이라면 매달 <b>{money(free * CARE_SHARE, unit)}</b> 정도는 나를 위해 써도 괜찮습니다.
            </p>
          )}
          <div className="freefun">
            <b>그리고 그중 상당 부분은 돈이 들지 않습니다.</b>
            <p>
              걷기·달리기, 등산, 명상, 도서관, 공공체육시설, 공공자전거처럼
              0원에 가까운 것들로 하루가 채워집니다. 돈을 쓰지 않고도 쉴 줄 알면
              아끼는 일이 참는 일이 아니게 됩니다.
            </p>
            <p>
              이런 활동에는 사람이 붙습니다. 러닝 모임이나 동네 산행처럼
              <b> 같은 시간을 쓰는 관계</b>는 비싼 자리에서 만난 사이보다 오래가고,
              만나는 데 드는 비용도 낮습니다. 둘이 되고 아이가 생겨도
              공원·하천·도서관·산은 그대로 씁니다.{" "}
              <a className="ilink" href="/guide/free-leisure">돈을 쓰지 않고 쉬는 법</a>
            </p>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-h">
          <div><span className="eyebrow en">SAVINGS</span><h2>적금·예금 {list.length}개</h2></div>
        </div>

        {list.length === 0 ? (
          <div className="empty inner">
            <h3>아직 등록한 저축이 없습니다.</h3>
            <p>적금이나 예금을 넣으면 납입액이 매달 빠지고, 만기에 이자까지 더해 돌아오는 것으로 계산합니다.</p>
          </div>
        ) : (
          <>
            <div className="tablewrap">
              <table className="tbl">
                <thead>
                  <tr><th>이름</th><th>종류</th><th>기간</th><th className="r">금액</th><th className="r">연이율</th>
                    <th className="r">세후 이자</th><th className="r">만기 수령</th><th /></tr>
                </thead>
                <tbody>
                  {list.map((sv) => {
                    const sch = savingSchedule(sv);
                    return (
                      <tr key={sv.id}>
                        <td><b>{sv.name || <span className="mut">(이름 없음)</span>}</b></td>
                        <td className="mut">{sv.kind === "deposit" ? "예금" : "적금"}</td>
                        <td className="mono mut">{labelYM(sv.startMonth)} ~ {labelYM(sch.maturity)}</td>
                        <td className="r mono">{money(sv.amount, unit)}{sv.kind === "regular" ? "/월" : ""}</td>
                        <td className="r mono">{num(sv.apr) ? `${sv.apr}%` : "—"}</td>
                        <td className="r mono pos">{money(sch.net, unit)}</td>
                        <td className="r mono b">{money(sch.payout, unit)}</td>
                        <td className="r nowrap">
                          <button className="link" onClick={() => setEdit({ ...sv })}>수정</button>
                          <button className="link del" onClick={() => setDel(sv)}>삭제</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="sum">
                    <td colSpan={3}>합계</td>
                    <td className="r mono">{money(totals.monthly, unit)}/월</td>
                    <td />
                    <td className="r mono pos">{money(totals.net, unit)}</td>
                    <td className="r mono b">{money(totals.payout, unit)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="mut sm" style={{ marginTop: 10 }}>
              만기에 받는 돈은 원금에 이자를 더하고 이자소득세 {TAX_RATE}%를 뺀 금액입니다.
              비과세 상품이라면 편집에서 세율을 0으로 두세요.
            </p>
          </>
        )}
      </section>

      <Confirm open={!!del} name={del && del.name} kind={del && del.kind === "deposit" ? "예금" : "적금"}
        note="납입과 만기 수령이 현금흐름에서 빠집니다."
        onCancel={() => setDel(null)}
        onConfirm={() => { up((p) => { p.savings = p.savings.filter((x) => x.id !== del.id); }); setDel(null); }} />

      {edit && (
        <SavingEditor sv={edit} setSv={setEdit} plan={plan} sc={primary} unit={unit}
          free={free} onCancel={() => setEdit(null)} onSave={() => save(edit)} />
      )}
    </>
  );
}

function SavingEditor({ sv, setSv, plan, sc, unit, free, onCancel, onSave }) {
  const sch = savingSchedule(sv);
  const [maxAmt, setMaxAmt] = useState(null);
  const regular = sv.kind !== "deposit";

  const findMax = () => {
    const others = { ...plan, savings: (plan.savings || []).filter((x) => x.id !== sv.id) };
    setMaxAmt(maxMonthlySaving(others, sc, { ...sv, id: "probe" }));
  };

  /* 적금은 매달 버는 돈에서 냅니다. 안전선만 보면 모아둔 돈을 헐어
     채우는 금액까지 "가능"으로 나오므로, 월 여유로 한 번 더 묶습니다. */
  const flowCap = free > 0 ? free : 0;
  const base = maxAmt === null ? null : Math.min(maxAmt, flowCap);
  const safe = base === null ? null : Math.max(0, Math.floor(base * (1 - CARE_SHARE) / 10000) * 10000);
  const limitedByFlow = maxAmt !== null && flowCap < maxAmt;

  return (
    <Modal title={regular ? "적금" : "예금"} wide onClose={onCancel}
      footer={<>
        <button className="btn" onClick={onCancel}>취소</button>
        <button className="btn primary" onClick={onSave}>저장</button>
      </>}>
      <div className="grid">
        <Field label="이름" wide>
          <input className="in" value={sv.name} placeholder={regular ? "예: 비상금 적금" : "예: 전세자금 예금"}
            onChange={(e) => setSv({ ...sv, name: e.target.value })} />
        </Field>
        <Field label="종류">
          <select className="in" value={sv.kind} onChange={(e) => setSv({ ...sv, kind: e.target.value })}>
            {SAVE_KINDS.map((k) => <option key={k.v} value={k.v}>{k.label}</option>)}
          </select>
        </Field>
        <Field label={regular ? "월 납입액" : "예치 금액"}>
          <NumIn value={sv.amount} step={100000} onChange={(v) => setSv({ ...sv, amount: num(v) })} suffix="원" comma />
        </Field>
        <Field label="시작 월">
          <input className="in mono" type="month" value={sv.startMonth}
            onChange={(e) => setSv({ ...sv, startMonth: e.target.value })} />
        </Field>
        <Field label="기간">
          <NumIn value={sv.months} min={1} onChange={(v) => setSv({ ...sv, months: Math.max(1, num(v)) })} suffix="개월" />
        </Field>
        <Field label="연 이자율" hint="세전">
          <NumIn value={sv.apr} step={0.1} onChange={(v) => setSv({ ...sv, apr: num(v) })} suffix="%" />
        </Field>
        {!regular && (
          <Field label="이자 방식">
            <select className="in" value={sv.compound} onChange={(e) => setSv({ ...sv, compound: e.target.value })}>
              <option value="simple">단리</option>
              <option value="monthly">월복리</option>
            </select>
          </Field>
        )}
        <Field label="이자소득세" hint="비과세면 0">
          <NumIn value={sv.taxRate} step={0.1} onChange={(v) => setSv({ ...sv, taxRate: num(v) })} suffix="%" />
        </Field>
      </div>

      {regular && (
        <div className="calcbox">
          <span className="eyebrow">얼마까지 넣을 수 있나</span>
          {maxAmt === null ? (
            <>
              <p className="mut sm" style={{ margin: "6px 0 10px" }}>
                지금 계획에서 안전선을 지키며 넣을 수 있는 최대 금액을 찾아 봅니다.
              </p>
              <button className="btn sm" onClick={findMax}>계산하기</button>
            </>
          ) : maxAmt === 0 ? (
            <p className="mut" style={{ margin: "6px 0 0", fontSize: 13 }}>
              지금은 여유가 없습니다. 적금을 넣으면 안전선이 깨집니다.
            </p>
          ) : (
            <>
              <ul className="mono">
                <li><span>매달 남는 돈</span><b>{won(flowCap)}</b></li>
                <li><span>안전선만 보면 최대</span><b>{won(maxAmt)}</b></li>
                <li><span>권하는 금액</span><b className="pos">{won(safe)}</b></li>
              </ul>
              {limitedByFlow ? (
                <p className="mut sm" style={{ marginTop: 8 }}>
                  안전선만 따지면 {won(maxAmt)}까지 가능하지만, 그건 모아둔 돈을 헐어서 채우는 금액입니다.
                  적금은 매달 버는 돈에서 내는 것이라 <b>월 여유 {won(flowCap)}</b>을 넘지 않게 잡았고,
                  거기서 나를 위해 쓸 몫 {Math.round(CARE_SHARE * 100)}%를 남겼습니다.
                  목돈을 묶어두려면 적금이 아니라 <b>예금</b>이 맞습니다.
                </p>
              ) : (
                <p className="mut sm" style={{ marginTop: 8 }}>
                  최대까지 넣으면 여유가 0이 됩니다. 나를 위해 쓸 몫 {Math.round(CARE_SHARE * 100)}%를 남긴
                  금액을 권합니다. 모으는 일은 몇 년을 이어가야 하고, 숨 쉴 틈이 없으면 중간에 깨지기 마련입니다.
                </p>
              )}
              {safe > 0 && (
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn sm primary" onClick={() => setSv({ ...sv, amount: safe })}>권하는 금액으로</button>
                  <button className="btn sm" onClick={() => setSv({ ...sv, amount: Math.floor(flowCap / 10000) * 10000 })}>여유 전부</button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="calcbox">
        <span className="eyebrow">만기에 받는 돈</span>
        <ul className="mono">
          <li><span>원금</span><b>{won(sch.principal)}</b></li>
          <li><span>이자 (세전)</span><b>{won(sch.interest)}</b></li>
          <li><span>이자소득세 {num(sv.taxRate)}%</span><b className="neg">− {won(sch.tax)}</b></li>
          <li><span>세후 이자</span><b className="pos">{won(sch.net)}</b></li>
          <li><span><b>만기 수령액</b></span><b>{won(sch.payout)}</b></li>
          <li><span>만기</span><b>{longYM(sch.maturity)}</b></li>
        </ul>
        {regular && num(sv.apr) > 0 && (
          <p className="mut sm" style={{ marginTop: 8 }}>
            적금은 매달 넣은 돈이 남은 기간만큼만 이자를 받습니다. 그래서 연 {sv.apr}% 라도
            실제로 붙는 이자는 원금의 {((sch.interest / Math.max(1, sch.principal)) * 100).toFixed(2)}% 입니다.
            예금 금리와 그대로 비교하면 안 됩니다.
          </p>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- 시나리오 탭 ---------------- */
function ScenTab({ plan, up, unit, results }) {
  const [openId, setOpenId] = useState(null);
  const [del, setDel] = useState(null);
  const floor = num(plan.settings.floor);

  const addScenario = () => up((p) => {
    const src = p.scenarios[0];
    const id = uid();
    p.scenarios.push({
      ...JSON.parse(JSON.stringify(src)), id,
      name: `시나리오 ${p.scenarios.length + 1}`,
      color: SC_COLORS[p.scenarios.length % SC_COLORS.length], note: "",
    });
    p.shown.push(id);
  });

  const dup = (sc) => up((p) => {
    const id = uid();
    p.scenarios.push({
      ...JSON.parse(JSON.stringify(sc)), id, name: sc.name + " 사본",
      color: SC_COLORS[p.scenarios.length % SC_COLORS.length],
    });
    p.shown.push(id);
  });

  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">SCENARIOS</span>
            <h2>같은 지출, 다른 구조</h2>
          </div>
          <button className="btn sm primary" onClick={addScenario}>시나리오 추가</button>
        </div>
        <p className="note">시나리오를 복제한 뒤 결제 방식이나 시점만 바꾸면, 어느 쪽이 잔고를 덜 흔드는지 바로 비교됩니다.</p>

        <div className="tablewrap">
          <table className="tbl">
            <thead>
              <tr><th>시나리오</th><th className="r">기간 말 잔고</th><th className="r">최저 잔고</th><th>안전선 하회</th><th className="r">이자·수수료</th><th /></tr>
            </thead>
            <tbody>
              {plan.scenarios.map((sc) => {
                const m = results[sc.id].metrics;
                return (
                  <tr key={sc.id}>
                    <td><i className="dot" style={{ background: sc.color }} /> <b>{sc.name}</b>
                      {sc.note ? <span className="mut sm"> · {sc.note}</span> : null}</td>
                    <td className={`r mono ${m.end < 0 ? "neg" : ""}`}>{compact(m.end)}</td>
                    <td className={`r mono ${m.min < 0 ? "neg" : m.min < floor ? "warnT" : ""}`}>{compact(m.min)}</td>
                    <td className="mono">{m.negative ? <span className="tag bad">{labelYM(m.negative)} 바닥</span>
                      : m.breach ? <span className="tag warn">{labelYM(m.breach)}</span>
                      : <span className="tag ok">없음</span>}</td>
                    <td className="r mono">{compact(m.interest)}</td>
                    <td className="r nowrap">
                      <button className="link" onClick={() => setOpenId(sc.id)}>편집</button>
                      <button className="link" onClick={() => dup(sc)}>복제</button>
                      {plan.scenarios.length > 1 && (
                        <button className="link del" onClick={() => setDel(sc)}>삭제</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <Confirm open={!!del} name={del && del.name} kind="시나리오"
        note="이 시나리오에만 적용했던 조정 값이 함께 사라집니다. 수입·지출과 큰 지출 자체는 남습니다."
        onCancel={() => setDel(null)}
        onConfirm={() => {
          up((p) => {
            p.scenarios = p.scenarios.filter((x) => x.id !== del.id);
            p.shown = p.shown.filter((x) => x !== del.id);
            if (!p.shown.length) p.shown = [p.scenarios[0].id];
          });
          setDel(null);
        }} />

      {openId && (
        <ScenEditor plan={plan} up={up} sc={plan.scenarios.find((s) => s.id === openId)} onClose={() => setOpenId(null)} />
      )}
    </>
  );
}

function ScenEditor({ plan, up, sc, onClose }) {
  if (!sc) return null;
  const patch = (fn) => up((p) => {
    const t = p.scenarios.find((x) => x.id === sc.id);
    fn(t);
  });

  const isOff = (id) => !!(sc.off && sc.off[id]);
  const ov = (id) => (sc.ov && sc.ov[id]) || {};
  const setOv = (id, key, val) => patch((t) => {
    t.ov = t.ov || {};
    t.ov[id] = { ...(t.ov[id] || {}), [key]: val };
  });
  const clearOv = (id) => patch((t) => { if (t.ov) delete t.ov[id]; });

  return (
    <Modal title={`시나리오 · ${sc.name}`} wide onClose={onClose}
      footer={<button className="btn primary" onClick={onClose}>닫기</button>}>
      <div className="grid">
        <Field label="이름"><input className="in" value={sc.name} onChange={(e) => patch((t) => { t.name = e.target.value; })} /></Field>
        <Field label="메모"><input className="in" value={sc.note || ""} placeholder="이 시나리오의 전제"
          onChange={(e) => patch((t) => { t.note = e.target.value; })} /></Field>
        <Field label="색">
          <select className="in" value={sc.color} onChange={(e) => patch((t) => { t.color = e.target.value; })}>
            {SC_COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="일반 수입 조정" hint="100 = 그대로">
          <NumIn value={sc.inFactor} step={5} onChange={(v) => patch((t) => { t.inFactor = num(v); })} suffix="%" />
        </Field>
        <Field label="일반 지출 조정" hint="100 = 그대로">
          <NumIn value={sc.outFactor} step={5} onChange={(v) => patch((t) => { t.outFactor = num(v); })} suffix="%" />
        </Field>
      </div>

      <h4 className="sub-h">큰 지출 — 이 시나리오에서만 바꾸기</h4>
      {plan.bigs.length === 0 && <p className="mut sm">등록된 큰 지출이 없습니다.</p>}
      {plan.bigs.map((be) => {
        const o = ov(be.id);
        const eff = { ...be, ...o };
        return (
          <div key={be.id} className={`ovrow${isOff(be.id) ? " off" : ""}`}>
            <div className="ovhead">
              <label className="chk">
                <input type="checkbox" checked={!isOff(be.id)}
                  onChange={(e) => patch((t) => { t.off = t.off || {}; if (e.target.checked) delete t.off[be.id]; else t.off[be.id] = true; })} />
                <b>{be.name || "(이름 없음)"}</b>
              </label>
              {Object.keys(o).length > 0 && <button className="link" onClick={() => clearOv(be.id)}>기본값으로</button>}
            </div>
            {!isOff(be.id) && (
              <div className="grid tight">
                <Field label="시점"><input className="in mono" type="month" value={eff.month}
                  onChange={(e) => setOv(be.id, "month", e.target.value)} /></Field>
                <Field label="결제 방식">
                  <select className="in" value={eff.method} onChange={(e) => setOv(be.id, "method", e.target.value)}>
                    <option value="lump">일시불</option><option value="installment">할부</option><option value="loan">대출</option>
                  </select>
                </Field>
                {eff.method !== "lump" && (
                  <>
                    <Field label="기간"><NumIn value={eff.months} min={1} onChange={(v) => setOv(be.id, "months", Math.max(1, num(v)))} suffix="개월" /></Field>
                    <Field label="연 이자율"><NumIn value={eff.apr} step={0.1} onChange={(v) => setOv(be.id, "apr", num(v))} suffix="%" /></Field>
                    <Field label="선납금"><NumIn value={eff.down} step={100000} onChange={(v) => setOv(be.id, "down", num(v))} suffix="원" comma /></Field>
                  </>
                )}
                <Field label="총 금액"><NumIn value={eff.amount} step={100000} onChange={(v) => setOv(be.id, "amount", num(v))} suffix="원" comma /></Field>
              </div>
            )}
          </div>
        );
      })}

      {(plan.savings || []).length > 0 && (
        <>
          <h4 className="sub-h">저축 켜고 끄기</h4>
          <div className="togglelist">
            {plan.savings.map((sv) => (
              <label key={sv.id} className={`chk pill${isOff(sv.id) ? " off" : ""}`}>
                <input type="checkbox" checked={!isOff(sv.id)}
                  onChange={(e) => patch((t) => { t.off = t.off || {}; if (e.target.checked) delete t.off[sv.id]; else t.off[sv.id] = true; })} />
                {sv.name || (sv.kind === "deposit" ? "예금" : "적금")}
              </label>
            ))}
          </div>
        </>
      )}

      <h4 className="sub-h">수입·지출 항목 켜고 끄기</h4>
      <div className="togglelist">
        {plan.items.map((it) => (
          <label key={it.id} className={`chk pill${isOff(it.id) ? " off" : ""}`}>
            <input type="checkbox" checked={!isOff(it.id)}
              onChange={(e) => patch((t) => { t.off = t.off || {}; if (e.target.checked) delete t.off[it.id]; else t.off[it.id] = true; })} />
            <span className={it.flow === "in" ? "pos" : "neg"}>{it.flow === "in" ? "+" : "−"}</span>
            {it.name || "(이름 없음)"}
          </label>
        ))}
        {plan.items.length === 0 && <p className="mut sm">등록된 항목이 없습니다.</p>}
      </div>
    </Modal>
  );
}

/* ---------------- 카탈로그 탭 ---------------- */
function CatalogTab({ catalog, saveCatalog }) {
  const [edit, setEdit] = useState(null);
  const [orgEdit, setOrgEdit] = useState(null);
  const [del, setDel] = useState(null);
  const [delOrg, setDelOrg] = useState(null);
  const [filter, setFilter] = useState("all");

  const list = catalog.products.filter((p) => filter === "all" || p.type === filter);

  const saveProduct = (p) => {
    const products = catalog.products.some((x) => x.id === p.id)
      ? catalog.products.map((x) => (x.id === p.id ? p : x))
      : [...catalog.products, p];
    saveCatalog({ ...catalog, products });
    setEdit(null);
  };

  const saveOrg = (o) => {
    const orgs = catalog.orgs.some((x) => x.id === o.id)
      ? catalog.orgs.map((x) => (x.id === o.id ? o : x))
      : [...catalog.orgs, o];
    saveCatalog({ ...catalog, orgs });
    setOrgEdit(null);
  };

  return (
    <>
      <div className="shared-note">
        <b>여기에 등록한 내용은 이 앱을 쓰는 모든 사람에게 보입니다.</b>
        <span>개인 금액이나 계좌 정보는 넣지 마세요. 상품의 일반 조건만 등록하는 곳입니다.</span>
      </div>

      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">SHARED CATALOG</span>
            <h2>할부·대출 상품</h2>
          </div>
          <div className="row">
            <button className="btn sm" onClick={() => setOrgEdit({ id: uid(), kind: "bank", name: "" })}>기관 추가</button>
            <button className="btn sm primary" onClick={() => setEdit({ id: uid(), orgId: catalog.orgs[0]?.id || "", type: "installment", name: "", apr: 0, freeMonths: 0, maxMonths: 12, feeRate: 0, note: "" })}>상품 추가</button>
          </div>
        </div>

        <div className="chips">
          {[["all", "전체"], ["card", "카드"], ["installment", "할부"], ["loan", "대출"]].map(([v, l]) => (
            <button key={v} className={filter === v ? "chip on" : "chip"} onClick={() => setFilter(v)}>{l}</button>
          ))}
        </div>

        <div className="tablewrap">
          <table className="tbl">
            <thead>
              <tr><th>기관</th><th>상품</th><th>유형</th><th className="r">연 이자율</th><th className="r">무이자</th><th className="r">최대 기간</th><th className="r">수수료</th><th /></tr>
            </thead>
            <tbody>
              {list.map((p) => {
                const o = catalog.orgs.find((x) => x.id === p.orgId);
                return (
                  <tr key={p.id}>
                    <td className="mut">{o ? o.name : "—"}</td>
                    <td><b>{p.name}</b>{p.note ? <div className="mut sm">{p.note}</div> : null}</td>
                    <td className="mono mut">{p.type === "card" ? "카드" : p.type === "loan" ? "대출" : "할부"}</td>
                    <td className="r mono">{num(p.apr) ? `${p.apr}%` : "—"}</td>
                    <td className="r mono">{num(p.freeMonths) ? `${p.freeMonths}개월` : "—"}</td>
                    <td className="r mono">{num(p.maxMonths) ? `${p.maxMonths}개월` : "—"}</td>
                    <td className="r mono">{num(p.feeRate) ? `${p.feeRate}%` : "—"}</td>
                    <td className="r nowrap">
                      <button className="link" onClick={() => setEdit({ ...p })}>수정</button>
                      <button className="link del" onClick={() => setDel(p)}>삭제</button>
                    </td>
                  </tr>
                );
              })}
              {list.length === 0 && <tr><td colSpan={8} className="mut">이 유형에는 등록된 상품이 없습니다.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="grp">
          <h3 className="grp-t">등록된 기관</h3>
          <div className="togglelist">
            {catalog.orgs.map((o) => (
              <span key={o.id} className="pill">
                {o.name}
                <button className="link" onClick={() => setOrgEdit({ ...o })}>수정</button>
                <button className="link del" onClick={() => setDelOrg(o)}>삭제</button>
              </span>
            ))}
          </div>
        </div>
      </section>

      <Confirm open={!!del} name={del && del.name} kind="상품"
        note="모든 사용자가 함께 쓰는 목록에서 사라집니다. 되돌릴 수 없습니다."
        onCancel={() => setDel(null)}
        onConfirm={() => { saveCatalog({ ...catalog, products: catalog.products.filter((x) => x.id !== del.id) }); setDel(null); }} />

      {edit && (
        <Modal title="상품" onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>취소</button>
            <button className="btn primary" onClick={() => saveProduct(edit)}>모두에게 저장</button></>}>
          <div className="grid">
            <Field label="상품 이름" wide>
              <input className="in" value={edit.name} placeholder="예: 자동차 할부 60개월"
                onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="기관">
              <select className="in" value={edit.orgId} onChange={(e) => setEdit({ ...edit, orgId: e.target.value })}>
                {catalog.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </Field>
            <Field label="유형">
              <select className="in" value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
                <option value="card">카드</option><option value="installment">할부</option><option value="loan">대출</option>
              </select>
            </Field>
            <Field label="연 이자율"><NumIn value={edit.apr} step={0.1} onChange={(v) => setEdit({ ...edit, apr: num(v) })} suffix="%" /></Field>
            <Field label="무이자 기간"><NumIn value={edit.freeMonths} onChange={(v) => setEdit({ ...edit, freeMonths: num(v) })} suffix="개월" /></Field>
            <Field label="최대 기간"><NumIn value={edit.maxMonths} onChange={(v) => setEdit({ ...edit, maxMonths: num(v) })} suffix="개월" /></Field>
            <Field label="취급수수료"><NumIn value={edit.feeRate} step={0.1} onChange={(v) => setEdit({ ...edit, feeRate: num(v) })} suffix="%" /></Field>
            <Field label="설명" wide hint="조건 확인 시점이나 출처를 함께 적어두면 다른 사람에게 도움이 됩니다">
              <input className="in" value={edit.note || ""} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
            </Field>
          </div>
        </Modal>
      )}

      <Confirm open={!!delOrg} name={delOrg && delOrg.name} kind="기관"
        note={delOrg && catalog.products.some((x) => x.orgId === delOrg.id)
          ? "이 기관에 속한 상품도 함께 사라집니다. 모든 사용자가 함께 쓰는 목록입니다."
          : "모든 사용자가 함께 쓰는 목록에서 사라집니다."}
        onCancel={() => setDelOrg(null)}
        onConfirm={() => {
          saveCatalog({
            ...catalog,
            orgs: catalog.orgs.filter((x) => x.id !== delOrg.id),
            products: catalog.products.filter((x) => x.orgId !== delOrg.id),
          });
          setDelOrg(null);
        }} />

      {orgEdit && (
        <Modal title="기관" onClose={() => setOrgEdit(null)}
          footer={<><button className="btn" onClick={() => setOrgEdit(null)}>취소</button>
            <button className="btn primary" onClick={() => saveOrg(orgEdit)}>모두에게 저장</button></>}>
          <div className="grid">
            <Field label="이름" wide><input className="in" value={orgEdit.name}
              onChange={(e) => setOrgEdit({ ...orgEdit, name: e.target.value })} /></Field>
            <Field label="유형">
              <select className="in" value={orgEdit.kind} onChange={(e) => setOrgEdit({ ...orgEdit, kind: e.target.value })}>
                <option value="bank">은행</option><option value="card">카드사</option><option value="capital">캐피탈·기타</option>
              </select>
            </Field>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ---------------- 스냅샷 탭 ---------------- */
function SnapTab({ plan, setPlan, snaps, saveSnaps, results, primary, unit }) {
  const [name, setName] = useState("");
  const [memo, setMemo] = useState("");
  const [cmp, setCmp] = useState(null);
  const [del, setDel] = useState(null);
  const fileRef = useRef(null);

  const take = () => {
    const snap = {
      id: uid(),
      name: name.trim() || `${new Date().toLocaleDateString("ko-KR")} 버전`,
      memo: memo.trim(),
      at: new Date().toISOString(),
      plan: JSON.parse(JSON.stringify(plan)),
    };
    saveSnaps([snap, ...snaps]);
    setName(""); setMemo("");
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ plan, snaps }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cashflow-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJson = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result));
        if (d.plan) setPlan(d.plan);
        if (Array.isArray(d.snaps)) saveSnaps(d.snaps);
      } catch (err) { /* 잘못된 파일 */ }
    };
    r.readAsText(f);
    e.target.value = "";
  };

  const cur = results[primary.id].metrics;
  const cmpSnap = snaps.find((s) => s.id === cmp);
  const cmpMetrics = useMemo(() => {
    if (!cmpSnap) return null;
    const p = cmpSnap.plan;
    const sc = p.scenarios.find((x) => x.id === (p.shown && p.shown[0])) || p.scenarios[0];
    return compute(p, sc).metrics;
  }, [cmpSnap]);

  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">VERSIONS</span>
            <h2>지금 상태를 기록해 두기</h2>
          </div>
          <div className="row">
            <button className="btn sm" onClick={exportJson}>파일로 내보내기</button>
            <button className="btn sm" onClick={() => fileRef.current && fileRef.current.click()}>파일 불러오기</button>
            <input ref={fileRef} type="file" accept="application/json" style={{ display: "none" }} onChange={importJson} />
          </div>
        </div>

        <div className="grid">
          <Field label="버전 이름" wide>
            <input className="in" value={name} placeholder="예: 차 36개월 할부안" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="메모" wide>
            <input className="in" value={memo} placeholder="무엇을 바꿨는지 한 줄" onChange={(e) => setMemo(e.target.value)} />
          </Field>
        </div>
        <div className="row"><button className="btn primary" onClick={take}>현재 상태 저장</button></div>
      </section>

      <section className="card">
        <div className="card-h"><div><span className="eyebrow en">HISTORY</span><h2>저장된 버전 {snaps.length}개</h2></div></div>
        {snaps.length === 0 ? (
          <div className="empty inner">
            <h3>아직 기록된 버전이 없습니다.</h3>
            <p>계획을 크게 바꾸기 전에 한 번 저장해두면 언제든 되돌릴 수 있습니다.</p>
          </div>
        ) : (
          <div className="tablewrap">
            <table className="tbl">
              <thead><tr><th>버전</th><th>저장 시각</th><th className="r">항목</th><th /></tr></thead>
              <tbody>
                {snaps.map((s) => (
                  <tr key={s.id}>
                    <td><b>{s.name}</b>{s.memo ? <div className="mut sm">{s.memo}</div> : null}</td>
                    <td className="mono mut">{new Date(s.at).toLocaleString("ko-KR")}</td>
                    <td className="r mono mut">{s.plan.items.length + s.plan.bigs.length}</td>
                    <td className="r nowrap">
                      <button className="link" onClick={() => setCmp(cmp === s.id ? null : s.id)}>{cmp === s.id ? "비교 닫기" : "현재와 비교"}</button>
                      <button className="link" onClick={() => setPlan(JSON.parse(JSON.stringify(s.plan)))}>되돌리기</button>
                      <button className="link del" onClick={() => setDel(s)}>삭제</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {cmpMetrics && (
          <div className="cmp">
            <span className="eyebrow">{cmpSnap.name} vs 현재</span>
            <table className="tbl">
              <thead><tr><th>지표</th><th className="r">{cmpSnap.name}</th><th className="r">현재</th><th className="r">차이</th></tr></thead>
              <tbody>
                {[
                  ["기간 말 잔고", cmpMetrics.end, cur.end],
                  ["최저 잔고", cmpMetrics.min, cur.min],
                  ["월평균 순현금흐름", cmpMetrics.avgNet, cur.avgNet],
                  ["총 이자·수수료", cmpMetrics.interest, cur.interest],
                ].map(([k, a, b]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td className="r mono mut">{compact(a)}</td>
                    <td className="r mono">{compact(b)}</td>
                    <td className={`r mono ${b - a < 0 ? "neg" : "pos"}`}>{b - a >= 0 ? "+" : ""}{compact(b - a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Confirm open={!!del} name={del && del.name} kind="버전"
        note="저장해 둔 그 시점의 계획이 사라집니다. 지금 작업 중인 내용에는 영향이 없습니다."
        onCancel={() => setDel(null)}
        onConfirm={() => { saveSnaps(snaps.filter((x) => x.id !== del.id)); setDel(null); }} />
    </>
  );
}

/* ---------------- 스타일 ---------------- */
export function Style() {
  return (
    <style>{`
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+KR:wght@300;400;500;600;700&display=swap');

.app{
  --ink:#0D1B22; --ink2:#3B4C54; --ink3:#6E7F86;
  --paper:#E9EDEC; --card:#FFFFFF; --line:#D3DCDA; --line2:#E4EAE9;
  --deep:#0F5F6B; --pos:#1F6B4E; --neg:#A8453A; --warn:#8A6508; --bad:#8C1D18;
  --warnbg:#FBF3DE; --badbg:#F9E9E7; --okbg:#E6F0EC;
  font-family:'IBM Plex Sans KR',system-ui,sans-serif;
  background:var(--paper); color:var(--ink);
  min-height:100%; padding:20px; line-height:1.55;
  -webkit-font-smoothing:antialiased;
}
.app *{box-sizing:border-box}
.mono{font-family:'IBM Plex Mono','IBM Plex Sans KR',ui-monospace,monospace;font-variant-numeric:tabular-nums}
.boot{padding:60px;text-align:center;color:var(--ink3)}

.top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.brand{display:flex;gap:12px;align-items:center}
.mark{width:26px;height:26px;flex:none;background:
  linear-gradient(var(--deep),var(--deep)) 0 60%/100% 40% no-repeat,
  linear-gradient(#C6D3D1,#C6D3D1) 0 0/100% 100% no-repeat;
  border:1px solid var(--ink);border-radius:2px}
.top h1{font-size:20px;font-weight:700;letter-spacing:-.02em;margin:0}
.top p{margin:0;font-size:11px;color:var(--ink3);letter-spacing:.01em}
.topright{font-size:11px;color:var(--ink3)}

.topright{display:flex;flex-direction:row;align-items:center;gap:12px;font-size:11px;color:var(--ink3)}
.topmeta{display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.wizbtn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--deep);
  background:var(--deep);color:#fff;border-radius:20px;padding:7px 14px;
  font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;flex:none}
.wizbtn:hover{background:#0B4C56;border-color:#0B4C56}
.wizbtn svg{flex:none}
.freefun{margin-top:12px;padding-top:12px;border-top:1px dashed var(--line)}
.freefun>b{display:block;margin-bottom:5px;font-size:13.5px}
.freefun p{margin:0 0 6px}

/* 아껴보기 */
.tipgroup{margin-top:14px}
.tipgroup>.eyebrow{display:block;margin-bottom:8px;color:var(--deep)}
.tipcard{border:1px solid var(--line2);border-radius:10px;padding:12px 14px;margin-bottom:8px;background:#FBFCFC}
.tipcard.user{border-left:3px solid var(--deep)}
.tipcard.hid{opacity:.55}
.tiphead{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:5px}
.tiphead b{font-size:14.5px;line-height:1.45}
.tipcard p{margin:0;font-size:13.5px;line-height:1.65;color:var(--ink2)}
.eff{flex:none;font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);
  color:var(--ink3);background:var(--card);white-space:nowrap}
.eff.once{border-color:#A8CDB8;color:var(--pos)}
.eff.swap{border-color:#A6C6CC;color:var(--deep)}
.eff.habit{border-color:#DFCB94;color:var(--warn)}
.eff.who{border-style:dashed}
.eff.mine{border-color:var(--deep);color:var(--deep)}
.eff.bad{border-color:#E0AFAB;color:var(--bad)}
.tipfoot{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.vt{font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:var(--card);color:var(--ink2)}
.vt:hover{border-color:var(--deep);color:var(--deep)}
.vt.on{background:var(--deep);border-color:var(--deep);color:#fff}
.vt.bad.on{background:var(--bad);border-color:var(--bad);color:#fff}
.vt.plain{border-color:transparent;background:transparent;color:var(--ink3);text-decoration:underline}
.whybox{margin-top:10px;padding:10px;border:1px dashed var(--line);border-radius:9px}
.whybox textarea{margin-top:6px}
textarea.in{resize:vertical;line-height:1.6}
.reasons{margin:8px 0 0;padding-left:18px;font-size:13px;line-height:1.6;color:var(--ink2)}
.reasons li{margin:3px 0}
.tiplinks{margin-top:8px;display:flex;flex-wrap:wrap;gap:12px}
.guidebtn{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);
  background:#fff;color:var(--ink2);border-radius:20px;padding:7px 14px;
  font-size:12.5px;font-weight:500;cursor:pointer;white-space:nowrap;flex:none;text-decoration:none}
.guidebtn:hover{border-color:var(--deep);color:var(--deep)}
.guidebtn svg{flex:none}
.wizlabel-sm{display:none}
.topright .stat-line{font-size:10.5px}
.tagline{margin:1px 0 0;font-size:12px;color:var(--ink3);line-height:1.4}
.conn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:20px;
  padding:3px 10px;font-size:11.5px;background:#fff;cursor:pointer;color:var(--ink2)}
.conn.on{border-color:#B6D2C4;color:#1F6B4E}
.sqlbox{background:#0D1B22;color:#D7E3E1;border-radius:4px;padding:14px;font-size:11px;line-height:1.55;
  overflow-x:auto;white-space:pre;margin:10px 0 0;max-height:340px;overflow-y:auto}
.msg{font-size:12.5px;margin:14px 0 0;padding:9px 12px;border-radius:4px;border:1px solid}
.msg.err{background:var(--badbg);border-color:#E3BDB8;color:#7A1A15}
.msg.ok{background:var(--okbg);border-color:#BFD6CC;color:#175A3F}
.btn:disabled{opacity:.5;cursor:default}
.btn.danger{border-color:#D8B4AE;color:var(--bad);background:#fff}
.btn.danger:hover{background:var(--badbg);border-color:#C89A93}
.confirm{background:var(--badbg);border:1px solid #E3BDB8;border-radius:4px;padding:13px 15px}
.confirm p{margin:0 0 10px;font-size:13px;line-height:1.55}
.confirm-msg{margin:0 0 8px;font-size:14.5px;line-height:1.6}
.confirm-msg b{font-weight:600}
.authswitch{margin-top:12px;gap:14px}
.ilink{color:var(--deep);text-decoration:underline;text-underline-offset:2px}
.fdot{opacity:.45;margin:0 2px}

.eyebrow{font-family:'IBM Plex Sans KR',system-ui,sans-serif;font-size:11.5px;font-weight:500;
  letter-spacing:0;text-transform:none;color:var(--ink3);display:block;line-height:1.4}
.eyebrow.en{font-family:'IBM Plex Mono','IBM Plex Sans KR',monospace;font-size:10px;font-weight:500;
  letter-spacing:.14em;text-transform:uppercase}

.tabs{display:flex;gap:2px;flex-wrap:wrap;border-bottom:1px solid var(--line);margin-bottom:18px}
.tb{background:none;border:0;border-bottom:2px solid transparent;padding:9px 13px;font:inherit;font-size:13.5px;
  color:var(--ink3);cursor:pointer;margin-bottom:-1px}
.tb:hover{color:var(--ink)}
.tb.on{color:var(--deep);border-bottom-color:var(--deep);font-weight:600}
.tb:focus-visible,.btn:focus-visible,.chip:focus-visible,.in:focus-visible{outline:2px solid var(--deep);outline-offset:2px}

.card{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:18px;margin-bottom:16px}
.card-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.card-h h2{font-size:16px;font-weight:600;letter-spacing:-.01em;margin:2px 0 0}
.note{font-size:12.5px;color:var(--ink3);margin:-6px 0 14px}

.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:12px;
  background:var(--card);border:1px solid var(--line);border-radius:4px;padding:14px 16px;margin-bottom:14px}

.fld{display:flex;flex-direction:column;gap:3px;min-width:0}
/* 설명 줄 수가 달라도 입력란이 한 줄에 맞도록 아래쪽으로 정렬합니다 */
.grid,.settings{align-items:end}
.fld.wide{grid-column:1/-1}
.fld-l{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;
  font-size:11.5px;color:var(--ink2);font-weight:500;line-height:1.35}
.fld-h{font-style:normal;font-size:10.5px;font-weight:400;color:var(--ink3);
  font-family:'IBM Plex Sans KR',system-ui,sans-serif}
.in{width:100%;border:1px solid var(--line);background:#fff;border-radius:3px;padding:7px 9px;font:inherit;font-size:13.5px;color:var(--ink)}
.in:focus{border-color:var(--deep)}
.numwrap{position:relative;display:flex;align-items:center}

/* 금액 칸: 테두리를 감싸는 쪽이 맡고 입력은 투명하게 */
.numwrap.boxed{width:100%;gap:6px;border:1px solid var(--line);background:#fff;
  border-radius:3px;padding:0 9px}
.numwrap.boxed:focus-within{border-color:var(--deep)}
.numwrap.boxed .krin{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-style:normal;font-size:10.5px;color:var(--ink3)}
.numwrap.boxed input{flex:0 0 8.4em;min-width:8.4em;border:0;background:none;outline:none;
  padding:7px 0;font:inherit;font-size:13.5px;text-align:right;color:var(--ink);
  font-family:'IBM Plex Mono','IBM Plex Sans KR',monospace;font-variant-numeric:tabular-nums}
.numwrap.boxed.readonly{background:#F4F7F7}
.numwrap.boxed .roval{flex:0 0 8.4em;min-width:8.4em;text-align:right;padding:7px 0;
  font-size:13.5px;color:var(--ink2)}
/* 구성 항목 줄은 좁고 오른쪽에 계산값이 따로 있어 생략합니다 */
.lrow .numwrap.boxed .krin{display:none}
.numwrap:not(.boxed) em{position:absolute;right:9px;font-style:normal;font-size:11px;color:var(--ink3);pointer-events:none;font-family:'IBM Plex Mono','IBM Plex Sans KR',monospace}
.numwrap:not(.boxed) .in{padding-right:34px;text-align:right}

.btn{border:1px solid var(--line);background:#fff;border-radius:3px;padding:7px 13px;font:inherit;font-size:13px;cursor:pointer;color:var(--ink)}
.btn:hover{border-color:var(--ink3)}
.btn.primary{background:var(--deep);border-color:var(--deep);color:#fff}
.btn.primary:hover{background:#0B4C56}
.btn.sm{padding:5px 10px;font-size:12.5px}
.link{background:none;border:0;font:inherit;font-size:12.5px;color:var(--deep);cursor:pointer;padding:2px 5px;text-decoration:underline;text-underline-offset:2px}
.link.del{color:var(--neg)}
.icon{background:none;border:0;font-size:15px;cursor:pointer;color:var(--ink3);padding:4px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

.gaps{background:var(--card);border:1px solid var(--line);border-radius:4px;margin-bottom:12px;overflow:hidden}
.gaps.warn{border-color:#E4D4A0}
.gaps.ok{display:flex;align-items:center;gap:10px;padding:11px 15px;
  background:var(--okbg);border-color:#BFD6CC}
.g-head{display:flex;align-items:center;gap:10px;width:100%;background:none;border:0;
  padding:11px 15px;font:inherit;text-align:left;cursor:pointer}
.gaps.warn .g-head{background:var(--warnbg)}
.g-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--ink3)}
.g-dot.warn{background:#C99A1F} .g-dot.mild{background:var(--deep)} .g-dot.ok{background:var(--pos)}
.g-text{flex:1;font-size:12.5px;line-height:1.6;color:var(--ink2)}
.g-text b{color:var(--ink)}
.g-toggle{flex:none;font-size:12px;color:var(--deep);font-weight:500;white-space:nowrap}
.g-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.g-list li{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;
  padding:11px 15px;border-bottom:1px solid var(--line2)}
.g-list li:last-child{border-bottom:0}
.g-list li>div{flex:1}
.g-list b{font-size:13.5px;font-weight:600}
.g-list em{font-style:normal;font-size:10px;margin-left:7px;padding:1px 6px;border-radius:2px;
  background:#EEF2F1;color:var(--ink3);vertical-align:1px}
.g-list li.must em{background:var(--warnbg);color:var(--warn)}
.g-list p{margin:4px 0 0;font-size:12.5px;line-height:1.6;color:var(--ink2)}

.floorhint{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap;
  background:var(--card);border:1px solid var(--line);border-left:3px solid var(--deep);
  border-radius:4px;padding:11px 15px;margin-bottom:12px}
.floorhint.low{border-left-color:#C99A1F;background:var(--warnbg);border-color:#E4D4A0}
.fh-text{font-size:12.5px;line-height:1.65;color:var(--ink2);flex:1 1 320px}
.fh-text b{color:var(--ink)}

.verdict{display:flex;flex-direction:column;gap:2px;padding:12px 15px;border-radius:4px;margin-bottom:14px;border:1px solid}
.verdict strong{font-size:14.5px;font-weight:600}
.verdict span{font-size:12.5px;color:var(--ink2)}
.verdict.ok{background:var(--okbg);border-color:#BFD6CC}
.verdict.warn{background:var(--warnbg);border-color:#E4D4A0}
.verdict.bad{background:var(--badbg);border-color:#E3BDB8}
.verdict.stale{background:#F3F4F2;border-color:var(--line);border-style:dashed}
.verdict.stale strong{color:var(--ink3)}
.v-warn{display:block;margin-top:7px;padding-top:7px;border-top:1px solid var(--line);
  font-size:12.5px;color:var(--warn)}
.v-warn b{color:var(--ink)}

/* 시그니처 스트립 */
.strip-card{background:var(--card);border:1px solid var(--line);border-radius:4px;padding:14px 16px 10px;margin-bottom:14px}
.strip-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:8px}
.strip-read{font-size:12px;color:var(--ink2)}
.strip-read b{font-size:13.5px;color:var(--ink)}
.strip{position:relative;display:flex;gap:1px;height:74px;background:
  repeating-linear-gradient(to right,transparent 0 11px,var(--line2) 11px 12px);border-radius:2px;overflow:hidden}
.strip-line{position:absolute;left:0;right:0;height:1px;z-index:2}
.strip-line.zero{background:var(--ink3)}
.strip-line.floor{background:repeating-linear-gradient(to right,var(--warn) 0 5px,transparent 5px 10px)}
.cell{position:relative;flex:1;min-width:3px;cursor:pointer}
.cell .bar{position:absolute;left:0;right:0;border-radius:1px;background:var(--deep);opacity:.82}
.cell.warn .bar{background:#C99A1F}
.cell.bad .bar{background:var(--bad)}
.cell.on .bar{opacity:1}
.cell.on{background:rgba(15,95,107,.07)}
.cell .pip{position:absolute;top:2px;left:50%;transform:translateX(-50%);width:5px;height:5px;border-radius:50%;background:#6B2D5C;z-index:3}
.strip-axis{display:flex;gap:1px;margin-top:5px}
.strip-axis span{flex:1;text-align:center;font-size:10px;color:var(--ink3);min-width:0}
.strip-axis span.on{color:var(--ink);font-weight:600}
.strip-foot{display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:10px;color:var(--ink3);margin-top:6px;flex-wrap:wrap}
.legend{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.sw{width:8px;height:8px;border-radius:1px;display:inline-block;margin-left:6px}
.sw.ok{background:var(--deep)} .sw.warn{background:#C99A1F} .sw.bad{background:var(--bad)}
.sw.pipm{background:#6B2D5C;border-radius:50%}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:16px}
.stat{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--line);border-radius:4px;padding:11px 13px}
.stat strong{display:block;font-size:17px;font-weight:600;margin-top:4px;letter-spacing:-.01em}
.stat .sub{display:block;font-size:10.5px;color:var(--ink3);margin-top:2px}
.stat.ok{border-left-color:var(--deep)}
.stat.warn{border-left-color:#C99A1F}
.stat.bad{border-left-color:var(--bad)}
.stat.bad strong{color:var(--bad)}

.scentag{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:20px;
  padding:4px 12px;font-size:12.5px;font-weight:500;white-space:nowrap;align-self:center}

.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.chip{border:1px solid var(--line);background:#fff;border-radius:20px;padding:4px 11px;font:inherit;font-size:12.5px;
  color:var(--ink3);cursor:pointer;display:inline-flex;align-items:center;gap:6px}
.chip.on{background:#fff;font-weight:500;border-color:var(--ink);color:var(--ink)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block}
.chart{margin:0 -6px}

.tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;font-weight:600;font-size:11.5px;letter-spacing:0;text-transform:none;
  color:var(--ink3);padding:7px 9px;border-bottom:1px solid var(--line);white-space:nowrap;
  font-family:'IBM Plex Sans KR',system-ui,sans-serif}
.tbl td{padding:8px 9px;border-bottom:1px solid var(--line2);vertical-align:top}
.tbl .r{text-align:right}
.tbl tbody tr:hover{background:#F5F8F7}
.tbl tr.warn{background:var(--warnbg)}
.tbl tr.bad{background:var(--badbg)}
.tbl tr.detail:hover{background:none}
.tbl .b{font-weight:600}
.tbl .chev{color:var(--ink3);width:24px}
.tbl tr.detail ul{margin:0;padding:4px 0 8px 4px;list-style:none;font-size:12.5px}
.tbl tr.detail li{display:flex;justify-content:space-between;gap:14px;padding:2px 0;max-width:520px}
.tbl tr.detail .big{font-weight:600}
.nowrap{white-space:nowrap}
.pos{color:var(--pos)} .neg{color:var(--neg)} .warnT{color:var(--warn)}
.mut{color:var(--ink3)} .sm{font-size:11.5px}

.tbl tfoot td{padding:9px;border-top:2px solid var(--line);border-bottom:0;font-weight:600;font-size:12.5px}
.tbl tfoot tr.sum td:first-child{font-family:'IBM Plex Sans KR',system-ui,sans-serif;font-size:11.5px;
  letter-spacing:0;text-transform:none;color:var(--ink3);font-weight:600}
.tbl tfoot tr.sub td{border-top:0;padding-top:0;font-weight:400}
.tbl tfoot tr:hover{background:none}

.sumbar{display:flex;flex-wrap:wrap;gap:10px 28px;align-items:flex-end;background:#F4F7F7;
  border:1px solid var(--line2);border-radius:4px;padding:12px 15px;margin-bottom:6px}
.sumbar>div{display:flex;flex-direction:column;gap:2px}
.sumbar b{font-size:16px;font-weight:600;letter-spacing:-.01em}
.sumbar p{flex-basis:100%;margin:2px 0 0;line-height:1.45}

.grp{margin-top:18px}
.grp-t{font-size:13px;font-weight:600;margin:0 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line)}

.empty{background:var(--card);border:1px dashed var(--line);border-radius:4px;padding:34px 24px;text-align:center}
.empty h2{font-size:19px;font-weight:600;margin:6px 0 8px;letter-spacing:-.015em}
.empty h3{font-size:15px;font-weight:600;margin:0 0 6px}
.empty p{color:var(--ink2);font-size:13.5px;max-width:460px;margin:0 auto 16px}
.empty .row{justify-content:center}
.empty.inner{padding:26px;border:0;background:#F6F8F8}

.biglist{display:flex;flex-direction:column;gap:1px;background:var(--line2)}
.bigrow{background:#fff;display:grid;grid-template-columns:minmax(160px,1fr) 2fr auto;gap:14px;padding:13px 4px;align-items:center}
.bigmain h3{font-size:15px;font-weight:600;margin:2px 0}
.bigmain p{margin:0;font-size:13px;color:var(--ink2)}
.bigmeta{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--ink2)}
.bigact{display:flex;gap:2px;flex-wrap:wrap;justify-content:flex-end}

.tag{font-style:normal;font-size:10.5px;padding:1px 6px;border-radius:2px;margin-left:6px;font-family:'IBM Plex Mono','IBM Plex Sans KR',monospace}
.tag.ok{background:var(--okbg);color:var(--pos)}
.tag.warn{background:var(--warnbg);color:var(--warn)}
.tag.bad{background:var(--badbg);color:var(--bad)}

.scrim{position:fixed;inset:0;background:rgba(13,27,34,.42);display:flex;align-items:flex-start;justify-content:center;
  padding:24px 14px;z-index:50;overflow-y:auto}
.modal{background:#fff;border-radius:5px;width:100%;max-width:480px;border:1px solid var(--line);box-shadow:0 18px 40px rgba(13,27,34,.18)}
.modal.wide{max-width:720px}
.modal-h{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid var(--line)}
.modal-h h3{margin:0;font-size:15px;font-weight:600}
.modal-b{padding:18px}
.modal-f{display:flex;justify-content:flex-end;gap:8px;padding:13px 18px;border-top:1px solid var(--line);background:#FAFCFB}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:13px}
.grid.tight{gap:9px;margin-top:8px}

.calcbox{margin-top:16px;background:#F4F7F7;border:1px solid var(--line2);border-radius:4px;padding:12px 14px}
.calcbox ul{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}
.calcbox li{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dotted var(--line)}
.calcbox li:last-child{border:0}
.calcbox p{margin:6px 0 0;font-size:12.5px}

.in.readonly{background:#F4F7F7;color:var(--ink2);display:flex;align-items:center;justify-content:flex-end}

.wsteps{display:flex;gap:4px;list-style:none;margin:0 0 16px;padding:0;flex-wrap:wrap}
.wsteps li{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ink3);
  padding:5px 10px;border-radius:20px;border:1px solid var(--line);background:#fff}
.wsteps li b{width:17px;height:17px;border-radius:50%;background:var(--line);color:#fff;
  display:grid;place-items:center;font-size:10.5px;font-weight:600}
.wsteps li.on{border-color:var(--deep);color:var(--deep);font-weight:600}
.wsteps li.on b{background:var(--deep)}
.wsteps li.done b{background:var(--pos)}
.wsteps li.done{color:var(--ink2)}

.wrow{display:grid;grid-template-columns:1fr 200px auto;gap:8px;align-items:center}
.wlabel{font-size:13.5px}
.wtip{margin-top:14px;background:var(--okbg);border:1px solid #BFD6CC;border-radius:4px;
  padding:11px 14px;font-size:12.5px;color:var(--ink2);line-height:1.5}
.wtip.bad{background:var(--warnbg);border-color:#E4D4A0}
.forgot{margin-top:14px;background:#F2F6F7;border:1px solid #D3E0E3;border-radius:4px;padding:15px 17px}
.forgot .eyebrow{color:#2C5661;font-weight:600;margin-bottom:7px}
.forgot p{margin:0;font-size:13px;line-height:1.72;color:var(--ink2)}
.forgot b{color:var(--ink)}
.forgot-chips{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
.fchip{display:inline-flex;align-items:baseline;gap:6px;background:#fff;border:1px solid var(--line);
  border-radius:20px;padding:6px 13px;font:inherit;font-size:12.5px;cursor:pointer;color:var(--ink)}
.fchip:hover{border-color:var(--deep);color:var(--deep)}
.fchip b{font-weight:500}
.fchip em{font-style:normal;font-size:10.5px;color:var(--ink3)}
.fchip:hover em{color:var(--deep)}

.habitnote{margin-top:14px;background:#FBF7F0;border:1px solid #E6DCCB;border-radius:4px;padding:15px 17px}
.habitnote .eyebrow{color:#7A5E2E;font-weight:600;margin-bottom:7px}
.habitnote p{margin:0 0 9px;font-size:13px;line-height:1.72;color:var(--ink2)}
.habitnote b{color:var(--ink)}
.habit-do{background:#fff;border-radius:3px;padding:9px 12px;margin:10px 0 0!important}

.habit-split{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}
.hs{border-radius:4px;padding:12px 14px;background:#fff;border:1px solid var(--line2)}
.hs.keep{border-left:3px solid var(--pos)}
.hs.cut{border-left:3px solid #B5882C}
.hs-tag{display:block;font-size:10.5px;font-weight:600;letter-spacing:.02em;margin-bottom:5px}
.hs.keep .hs-tag{color:var(--pos)}
.hs.cut .hs-tag{color:#8A6508}
.hs>b{display:block;font-size:14px;margin-bottom:6px;color:var(--ink)}
.hs p b{color:var(--ink)}
.hs p{margin:0!important;font-size:12.5px!important;line-height:1.65!important}
@media (max-width:640px){ .habit-split{grid-template-columns:1fr} }
.habit-list{margin:0;padding-left:18px;font-size:12.5px;line-height:1.7;color:var(--ink2)}
.habit-list li{margin-bottom:5px}
.habit-list li:last-child{margin:0}

.seednote{margin-top:14px;background:#F1F5F2;border:1px solid #CFE0D4;border-radius:4px;padding:15px 17px}
.seednote .eyebrow{color:#2F5B40;font-weight:600;margin-bottom:7px}
.seednote p{margin:0 0 9px;font-size:13px;line-height:1.72;color:var(--ink2)}
.seednote p:last-child{margin:0}
.seednote b{color:var(--ink)}
.seed-do{background:#fff;border-radius:3px;padding:9px 12px}

.carenote{margin-top:14px;background:#F6F2F7;border:1px solid #DED2E2;border-radius:4px;padding:14px 16px}
.carenote .eyebrow{color:#6B4A66;font-weight:600;margin-bottom:6px}
.carenote p{margin:0 0 8px;font-size:13px;line-height:1.7;color:var(--ink2)}
.carenote p:last-child{margin:0}
.carenote b{color:var(--ink)}
.carefig{background:#fff;border-radius:3px;padding:8px 11px;font-size:12.5px!important}
.wtip b{color:var(--ink)}

.wverdict{display:flex;flex-direction:column;gap:3px;padding:14px 16px;border-radius:4px;border:1px solid}
.wverdict strong{font-size:16px;font-weight:700;letter-spacing:-.01em}
.wverdict span{font-size:13px;color:var(--ink2)}
.wverdict.ok{background:var(--okbg);border-color:#BFD6CC}
.wverdict.warn{background:var(--warnbg);border-color:#E4D4A0}
.wverdict.bad{background:var(--badbg);border-color:#E3BDB8}

.fixes{display:flex;flex-direction:column;gap:8px}
.fix{border:1px solid var(--line2);border-left:3px solid var(--deep);border-radius:4px;padding:10px 13px}
.fix p{margin:3px 0 0;font-size:13px}
.fix p.mut{font-size:12px}

@media (max-width:640px){
  .wrow{grid-template-columns:1fr 150px}
  .wsteps li{font-size:11px;padding:4px 8px}
}

.tplpick{background:#F4F7F7;border:1px solid var(--line2);border-radius:4px;padding:14px}
.tplpick .note{margin:0 0 10px}

.lines{display:flex;flex-direction:column;gap:6px}
.lrow{display:grid;grid-template-columns:1fr 78px 132px 96px auto;gap:6px;align-items:center;
  padding:6px 8px;border:1px solid var(--line2);border-radius:4px;background:#fff}
.lrow.isbase{border-color:#BFD6CC;background:#FAFCFB}
.lrow .in{padding:6px 8px;font-size:13px}
.lrow .numwrap .in{padding-right:30px}
.lcalc{text-align:right;font-size:12.5px;color:var(--ink2);white-space:nowrap}
.lrow.isbase .lcalc{font-weight:600;color:var(--ink)}
.lx{white-space:nowrap}
.lbadge{grid-column:1;font-size:10px;color:var(--pos);background:var(--okbg);
  border-radius:2px;padding:1px 5px;justify-self:start}
.lnote{grid-column:1/-1;font-size:11px;line-height:1.35}
.ltotal{font-size:13px;color:var(--ink2)}
.ltotal b{font-size:15px;color:var(--ink);margin-left:6px}

@media (max-width:640px){
  .lrow{grid-template-columns:78px 1fr;gap:6px 8px}
  .lrow .lname{grid-column:1/-1}
  .lrow .lkind{padding-left:6px;padding-right:4px}
  .lcalc{grid-column:1/2;text-align:left;font-weight:600;color:var(--ink)}
  .lx{grid-column:2;justify-self:end}
  .lbadge{grid-column:1/-1;justify-self:start}
}

.sub-h{font-size:12.5px;font-weight:600;margin:20px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line)}
.ovrow{border:1px solid var(--line2);border-radius:4px;padding:10px 12px;margin-bottom:8px}
.ovrow.off{opacity:.5}
.ovhead{display:flex;justify-content:space-between;align-items:center;gap:10px}
.chk{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}
.togglelist{display:flex;flex-wrap:wrap;gap:6px}
.pill{border:1px solid var(--line);border-radius:20px;padding:4px 11px;font-size:12.5px;display:inline-flex;align-items:center;gap:6px}
.pill.off{opacity:.45;text-decoration:line-through}

.shared-note{background:#F1EDF3;border:1px solid #DCD0E0;border-radius:4px;padding:11px 14px;margin-bottom:14px;
  display:flex;flex-direction:column;gap:2px}
.shared-note b{font-size:13px;color:#4E2A46}
.shared-note span{font-size:12px;color:#6B5266}

.cmp{margin-top:18px;border-top:1px solid var(--line);padding-top:14px}
/* ── 소개·가이드·약관 페이지 ── */
.page{max-width:780px;margin:0 auto;padding:0 2px}
.page-top{display:flex;justify-content:space-between;align-items:center;gap:16px;
  flex-wrap:wrap;padding:6px 0 20px;border-bottom:1px solid var(--line);margin-bottom:26px}
.brand.plain{text-decoration:none;color:inherit;align-items:center}
.page-top h1{font-size:20px;font-weight:700;letter-spacing:-.02em;margin:0}
.page-top .tagline{margin:1px 0 0}
.page-body{padding-bottom:10px}
.page-title{font-size:27px;font-weight:700;letter-spacing:-.025em;margin:0 0 8px;line-height:1.25}
.page-lead{font-size:14.5px;color:var(--ink2);margin:0 0 26px;line-height:1.6}

.pr-h{font-size:17px;font-weight:600;letter-spacing:-.015em;margin:30px 0 10px;
  padding-bottom:7px;border-bottom:1px solid var(--line2)}
.pr-p{font-size:14.5px;line-height:1.78;margin:0 0 15px;color:var(--ink)}
.pr-ul{margin:0 0 15px;padding-left:19px;font-size:14.5px;line-height:1.75}
.pr-ul li{margin-bottom:7px}
.pr-quote{background:var(--okbg);border-left:3px solid var(--deep);border-radius:0 4px 4px 0;
  padding:13px 17px;margin:0 0 18px}
.pr-quote p{margin:0 0 8px;font-size:14px;line-height:1.7}
.pr-quote p:last-child{margin:0}
.pr-tbl{font-size:13.5px;margin-bottom:18px}
.pr-tbl td{vertical-align:middle}

.hero{padding:40px 0 30px;border-bottom:1px solid var(--line)}
.hero-eyebrow{font-size:12.5px;color:var(--ink3);margin:0 0 10px;letter-spacing:.01em}
.hero h2{font-size:40px;line-height:1.22;font-weight:700;letter-spacing:-.035em;margin:0 0 18px}
.hero-lead{font-size:16px;line-height:1.72;color:var(--ink2);max-width:580px;margin:0 0 24px}
.btn.big{padding:11px 22px;font-size:14.5px}

.feat{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:1px;
  background:var(--line2);border:1px solid var(--line2);border-radius:4px;margin:30px 0;overflow:hidden}
.feat article{background:#fff;padding:20px 22px}
.feat h3{font-size:16px;font-weight:600;margin:5px 0 8px;letter-spacing:-.015em}
.feat p{margin:0;font-size:13.5px;line-height:1.7;color:var(--ink2)}

.sec-h{font-size:18px;font-weight:600;letter-spacing:-.02em;margin:34px 0 14px}
.steps{list-style:none;counter-reset:s;margin:0;padding:0;
  display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px}
.steps li{counter-increment:s;background:#fff;border:1px solid var(--line);border-radius:4px;
  padding:14px 16px 14px 44px;position:relative;font-size:14px}
.steps li::before{content:counter(s);position:absolute;left:15px;top:14px;
  width:19px;height:19px;border-radius:50%;background:var(--deep);color:#fff;
  display:grid;place-items:center;font-size:11px;font-weight:600;
  font-family:'IBM Plex Mono',monospace}
.steps li b{display:block;font-weight:600;margin-bottom:3px}
.steps li span{font-size:12.5px;color:var(--ink3);line-height:1.5}

.trust{margin-bottom:10px}
.cta{text-align:center;background:var(--card);border:1px solid var(--line);border-radius:4px;
  padding:34px 24px;margin:34px 0 10px}
.cta h3{font-size:21px;font-weight:700;letter-spacing:-.02em;margin:0 0 7px}
.cta p{margin:0 0 18px;color:var(--ink2);font-size:14px}

.path{display:flex;flex-direction:column;gap:30px}
.stage-h{display:flex;gap:13px;align-items:flex-start;margin-bottom:13px}
.stage-n{flex:none;width:28px;height:28px;border-radius:50%;background:var(--deep);color:#fff;
  display:grid;place-items:center;font-size:13px;font-weight:600;
  font-family:'IBM Plex Mono',monospace;margin-top:1px}
.stage-h h3{font-size:17px;font-weight:600;letter-spacing:-.02em;margin:0 0 4px}
.stage-h p{margin:0;font-size:13px;line-height:1.65;color:var(--ink2)}
.stage{position:relative}
.stage:not(:last-child)::after{content:"";position:absolute;left:14px;top:34px;bottom:-30px;
  width:1px;background:var(--line);z-index:0}
.stage>*{position:relative;z-index:1}
.stage .glist{margin-left:41px}
@media (max-width:640px){
  .stage .glist{margin-left:0}
  .stage:not(:last-child)::after{display:none}
}

.glist{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:12px}
.gcard{display:block;background:var(--card);border:1px solid var(--line);border-radius:4px;
  padding:18px 20px;text-decoration:none;color:inherit}
.gcard:hover{border-color:var(--deep)}
.gcard h3{font-size:16px;font-weight:600;margin:0 0 7px;letter-spacing:-.015em;line-height:1.4}
.gcard p{margin:0;font-size:13px;line-height:1.65;color:var(--ink2)}
.gmore{display:inline-block;margin-top:11px;font-size:12.5px;color:var(--deep);font-weight:500}
.gnext{margin-top:40px;padding-top:4px;border-top:1px solid var(--line)}

@media (max-width:640px){
  .hero{padding:26px 0 22px}
  .hero h2{font-size:29px}
  .hero-lead{font-size:14.5px}
  .page-title{font-size:23px}
  .page-top{padding-bottom:16px;margin-bottom:20px}
}

.foot{text-align:center;font-size:10.5px;color:var(--ink3);padding:16px 0 4px}

@media (max-width:640px){
  .app{padding:12px}
  .top{align-items:center}
  .topright{gap:8px}
  .wizbtn,.guidebtn{padding:7px 11px}
  .wizlabel{display:none}
  .wizlabel-sm{display:inline}
  .topmeta{font-size:10px}

  /* 가로로 눌리는 대신 옆으로 넘겨 보기 */
  .tablewrap .tbl{min-width:520px}

  /* 수입·지출: 행을 카드로 쌓기 */
  .tablewrap .tbl.tbl-cards{min-width:0;width:100%}
  .tbl-cards thead{display:none}
  .tbl-cards tbody,.tbl-cards tbody tr,.tbl-cards tbody td,
  .tbl-cards tfoot,.tbl-cards tfoot tr,.tbl-cards tfoot td{display:block;width:100%}
  .tbl-cards tbody tr{border:1px solid var(--line);border-radius:4px;padding:10px 12px;margin-bottom:8px;background:#fff}
  .tbl-cards tbody tr:hover{background:#fff}
  .tbl-cards tbody td{border:0;padding:3px 0;text-align:left;
    display:flex;justify-content:space-between;align-items:baseline;gap:14px}
  .tbl-cards tbody td::before{content:attr(data-l);flex:none;color:var(--ink3);font-size:11.5px;
    font-family:'IBM Plex Sans KR',system-ui,sans-serif}
  .tbl-cards tbody td.cname{display:block;font-weight:600;font-size:14.5px;
    padding-bottom:7px;margin-bottom:5px;border-bottom:1px solid var(--line2)}
  .tbl-cards tbody td.cact{display:flex;justify-content:flex-end;gap:4px;
    padding-top:7px;margin-top:5px;border-top:1px solid var(--line2)}
  .tbl-cards tbody td.cact::before,.tbl-cards tbody td.cname::before{content:none}
  .tbl-cards tfoot tr{display:flex;justify-content:space-between;align-items:baseline;gap:14px;
    border-top:2px solid var(--line);padding:9px 12px 3px;margin-top:2px}
  .tbl-cards tfoot tr.sub{border-top:0;padding-top:0;margin-top:0}
  .tbl-cards tfoot td{display:block;width:auto;border:0;padding:0;text-align:left}
  .tbl-cards tfoot td:empty{display:none}
  .bigrow{grid-template-columns:1fr;gap:8px}
  .bigact{justify-content:flex-start}
  .strip{height:60px}
  .tabs{overflow-x:auto;flex-wrap:nowrap}
  .tb{white-space:nowrap}
}
@media (prefers-reduced-motion:reduce){
  .app *{transition:none!important;animation:none!important}
}
`}</style>
  );
}
