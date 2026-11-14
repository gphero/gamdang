import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from "recharts";
import { storage } from "./storage.js";

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
    months, rows, bigMonths, bigDetail,
    metrics: {
      end: bal, min, minMonth, breach, negative,
      totalIn, totalOut, interest, tail,
      avgNet: rows.length ? (totalIn - totalOut) / rows.length : 0,
    },
  };
}

/* ---------------- 작은 UI 조각 ---------------- */
function Field({ label, hint, children, wide }) {
  return (
    <label className={`fld${wide ? " wide" : ""}`}>
      <span className="fld-l">{label}</span>
      {children}
      {hint ? <span className="fld-h">{hint}</span> : null}
    </label>
  );
}

function NumIn({ value, onChange, suffix, step = 1, min, comma }) {
  if (comma) {
    const shown =
      value === "" || value === null || value === undefined || Number.isNaN(Number(value))
        ? ""
        : Number(value).toLocaleString("ko-KR");
    return (
      <span className="numwrap">
        <input
          className="in mono"
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
        {suffix ? <em>{suffix}</em> : null}
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
export default function Cashflow() {
  const [plan, setPlan] = useState(emptyPlan);
  const [catalog, setCatalog] = useState(seedCatalog);
  const [snaps, setSnaps] = useState([]);
  const [conn, setConn] = useState({ url: "", key: "", token: "", refresh: "", user: null });
  const [tab, setTab] = useState("dash");
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
          <span className={online ? "conn on" : "conn"} onClick={() => setTab("conn")} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter") setTab("conn"); }}>
            <i className="dot" style={{ background: online ? "#1F6B4E" : "#9AA9AE" }} />
            {online ? conn.user.email : "이 브라우저에만 저장 중"}
          </span>
          <span className="mono stat-line">{status}</span>
        </div>
      </header>

      <nav className="tabs" role="tablist">
        {[
          ["dash", "대시보드"],
          ["items", "수입·지출"],
          ["bigs", "큰 지출"],
          ["scen", "시나리오"],
          ["cat", "상품 카탈로그"],
          ["snap", "스냅샷"],
          ["conn", "연결"],
        ].map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "tb on" : "tb"} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>

      <main>
        {tab === "dash" && (
          empty ? (
            <div className="empty">
              <p className="eyebrow">시작하기</p>
              <h2>아직 넣은 항목이 없습니다.</h2>
              <p>수입과 지출을 넣으면 앞으로의 월말 잔고가 그려집니다. 감이 안 잡히면 예시로 채운 뒤 숫자만 바꿔도 됩니다.</p>
              <div className="row">
                <button className="btn primary" onClick={() => setPlan(samplePlan())}>예시로 채우기</button>
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
        {tab === "scen" && <ScenTab plan={plan} up={up} unit={unit} results={results} />}
        {tab === "cat" && <CatalogTab catalog={catalog} saveCatalog={saveCatalog} />}
        {tab === "snap" && <SnapTab plan={plan} setPlan={setPlan} snaps={snaps} saveSnaps={saveSnaps} results={results} primary={primary} unit={unit} />}
        {tab === "conn" && (
          <ConnTab
            conn={conn} persistConn={persistConn} online={online}
            plan={plan} snaps={snaps} catalog={catalog}
            pullRemote={pullRemote} setStatus={setStatus} setSnaps={setSnaps}
          />
        )}
      </main>

      <footer className="foot">
        {online
          ? "내 계획과 스냅샷은 내 계정에만 보입니다 · 상품 카탈로그는 모든 사용자와 공유됩니다"
          : "지금은 이 브라우저에만 저장됩니다 · '연결' 탭에서 Supabase를 붙이면 어디서든 이어서 볼 수 있습니다"}
      </footer>
    </div>
  );
}

/* ---------------- 연결 탭 ---------------- */
function ConnTab({ conn, persistConn, online, plan, snaps, catalog, pullRemote, setStatus, setSnaps }) {
  const [url, setUrl] = useState(conn.url || "");
  const [key, setKey] = useState(conn.key || "");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [showSql, setShowSql] = useState(false);

  const run = async (label, fn) => {
    setBusy(label); setErr(""); setMsg("");
    try { await fn(); } catch (e) { setErr(e.message || String(e)); }
    setBusy("");
  };

  const saveEndpoint = () => run("endpoint", async () => {
    if (!trimUrl(url) || !key.trim()) throw new Error("주소와 API 키를 모두 입력하세요.");
    await persistConn({ ...conn, url: trimUrl(url), key: key.trim() });
    setMsg("주소를 저장했습니다. 이제 로그인하세요.");
  });

  const doSignUp = () => run("signup", async () => {
    const c = { ...conn, url: trimUrl(url), key: key.trim() };
    const r = await sbSignUp(c, email.trim(), pw);
    if (r && r.access_token) {
      const next = { ...c, token: r.access_token, refresh: r.refresh_token, user: r.user };
      await persistConn(next);
      await pullRemote(next);
      setMsg("가입하고 바로 연결했습니다.");
    } else {
      setMsg("가입 확인 메일을 보냈습니다. 메일에서 확인한 뒤 로그인하세요.");
    }
  });

  const doSignIn = () => run("signin", async () => {
    const c = { ...conn, url: trimUrl(url), key: key.trim() };
    const r = await sbSignIn(c, email.trim(), pw);
    const next = { ...c, token: r.access_token, refresh: r.refresh_token, user: r.user };
    await persistConn(next);
    const d = await pullRemote(next);
    setMsg(d.plan ? "서버에 있던 계획을 불러왔습니다." : "서버에 계획이 없어 지금 화면의 내용을 올릴 수 있습니다.");
    setPw("");
  });

  const doSignOut = () => run("signout", async () => {
    await persistConn({ ...conn, token: "", refresh: "", user: null });
    setMsg("로그아웃했습니다. 데이터는 서버에 그대로 남아 있습니다.");
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
    setMsg("서버 내용을 불러왔습니다.");
  });

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(SCHEMA_SQL);
      setMsg("SQL을 복사했습니다. Supabase의 SQL Editor에 붙여넣고 실행하세요.");
    } catch (e) {
      setShowSql(true);
      setMsg("복사가 막혀 있어 아래에 펼쳤습니다. 직접 복사하세요.");
    }
  };

  return (
    <>
      <section className="card">
        <div className="card-h">
          <div>
            <span className="eyebrow en">CONNECTION</span>
            <h2>{online ? "서버에 연결되어 있습니다" : "Supabase에 연결하기"}</h2>
          </div>
          {online && <span className="scentag" style={{ borderColor: "#1F6B4E", color: "#1F6B4E" }}>
            <i className="dot" style={{ background: "#1F6B4E" }} />{conn.user.email}
          </span>}
        </div>

        {!online && (
          <p className="note">
            연결하면 계획·스냅샷이 내 계정에 저장돼 다른 기기에서도 이어서 볼 수 있고, 상품 카탈로그는 모든 사용자가 함께 씁니다.
            연결 전까지는 지금처럼 이 브라우저에만 저장됩니다.
          </p>
        )}

        <h4 className="sub-h">1단계 · 테이블 만들기</h4>
        <p className="note">
          Supabase 프로젝트의 SQL Editor에서 아래 스키마를 한 번 실행하세요. 테이블 4개와 RLS 정책이 함께 만들어집니다.
        </p>
        <div className="row">
          <button className="btn sm" onClick={copySql}>스키마 SQL 복사</button>
          <button className="btn sm" onClick={() => setShowSql(!showSql)}>{showSql ? "접기" : "SQL 보기"}</button>
        </div>
        {showSql && <pre className="sqlbox mono">{SCHEMA_SQL}</pre>}

        <h4 className="sub-h">2단계 · 프로젝트 주소와 키</h4>
        <p className="note">
          Supabase 대시보드의 Settings → API Keys에서 확인할 수 있습니다. 공개용 키라 브라우저에 두어도 되며,
          실제 접근 제어는 1단계에서 만든 RLS 정책이 담당합니다. <b>service_role 키는 절대 넣지 마세요.</b>
        </p>
        <div className="grid">
          <Field label="Project URL" wide hint="예: https://xxxxxxxx.supabase.co">
            <input className="in mono" value={url} placeholder="https://....supabase.co"
              onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label="Publishable key" wide hint="sb_publishable_... 또는 예전 anon key">
            <input className="in mono" value={key} placeholder="sb_publishable_..." type="password"
              onChange={(e) => setKey(e.target.value)} />
          </Field>
        </div>
        <div className="row"><button className="btn" onClick={saveEndpoint} disabled={busy === "endpoint"}>주소 저장</button></div>

        <h4 className="sub-h">3단계 · 로그인</h4>
        {online ? (
          <div className="row">
            <button className="btn" onClick={pull} disabled={!!busy}>{busy === "pull" ? "불러오는 중…" : "서버에서 불러오기"}</button>
            <button className="btn" onClick={pushAll} disabled={!!busy}>{busy === "push" ? "올리는 중…" : "지금 화면 내용을 서버로 올리기"}</button>
            <button className="btn" onClick={doSignOut} disabled={!!busy}>로그아웃</button>
          </div>
        ) : (
          <>
            <div className="grid">
              <Field label="이메일">
                <input className="in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="비밀번호" hint="6자 이상">
                <input className="in" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
              </Field>
            </div>
            <div className="row">
              <button className="btn primary" onClick={doSignIn} disabled={!!busy}>{busy === "signin" ? "연결 중…" : "로그인"}</button>
              <button className="btn" onClick={doSignUp} disabled={!!busy}>{busy === "signup" ? "가입 중…" : "새로 가입"}</button>
            </div>
          </>
        )}

        {err && <p className="msg err">{err}</p>}
        {msg && <p className="msg ok">{msg}</p>}
      </section>

      <section className="card">
        <div className="card-h"><div><span className="eyebrow en">DATA MAP</span><h2>어디에 무엇이 저장되나</h2></div></div>
        <div className="tablewrap">
          <table className="tbl">
            <thead><tr><th>내용</th><th>테이블</th><th>공개 범위</th></tr></thead>
            <tbody>
              <tr><td>수입·지출·큰 지출·시나리오</td><td className="mono">plans</td><td>본인만</td></tr>
              <tr><td>버전 스냅샷</td><td className="mono">snapshots</td><td>본인만</td></tr>
              <tr><td>은행·카드사 등 기관</td><td className="mono">orgs</td><td>모든 사용자 공유</td></tr>
              <tr><td>할부·대출 상품</td><td className="mono">products</td><td>모든 사용자 공유</td></tr>
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: 12 }}>
          연결한 뒤에도 모든 변경은 이 브라우저에 함께 저장됩니다. 서버 저장이 실패해도 작업 내용이 사라지지 않고,
          화면 오른쪽 위에 어느 쪽에 저장됐는지 표시됩니다.
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
        <Field label="시작 잔고" hint={won(plan.settings.opening)}>
          <NumIn value={plan.settings.opening} step={100000} onChange={(v) => up((p) => { p.settings.opening = num(v); })} suffix="원" comma />
        </Field>
        <Field label="안전선(최소 유지 잔고)" hint={won(plan.settings.floor)}>
          <NumIn value={plan.settings.floor} step={100000} onChange={(v) => up((p) => { p.settings.floor = num(v); })} suffix="원" comma />
        </Field>
        <Field label="금액 표기">
          <select className="in" value={unit} onChange={(e) => up((p) => { p.settings.unit = e.target.value; })}>
            <option value="man">만원 단위</option>
            <option value="won">원 단위</option>
          </select>
        </Field>
      </section>

      <div className={`verdict ${verdict.t}`}>
        <strong>{verdict.h}</strong>
        <span>{verdict.s}</span>
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
function ItemsTab({ plan, up, unit }) {
  const [edit, setEdit] = useState(null);

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
                          <button className="link del" onClick={() => up((p) => { p.items = p.items.filter((x) => x.id !== it.id); })}>삭제</button>
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
            <Field label="금액" hint={won(edit.amount)}>
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
                    <button className="link del" onClick={() => up((p) => { p.bigs = p.bigs.filter((x) => x.id !== be.id); })}>삭제</button>
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
  const s = bigSchedule(be);
  const product = catalog.products.find((p) => p.id === be.productId);

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
        <Field label="총 금액" hint={won(be.amount)}>
          <NumIn value={be.amount} step={100000} onChange={(v) => setBe({ ...be, amount: num(v) })} suffix="원" comma />
        </Field>
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
            <Field label="선납금 / 계약금" hint={won(be.down)}>
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
    </Modal>
  );
}

/* ---------------- 시나리오 탭 ---------------- */
function ScenTab({ plan, up, unit, results }) {
  const [openId, setOpenId] = useState(null);
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
                        <button className="link del" onClick={() => up((p) => {
                          p.scenarios = p.scenarios.filter((x) => x.id !== sc.id);
                          p.shown = p.shown.filter((x) => x !== sc.id);
                          if (!p.shown.length) p.shown = [p.scenarios[0].id];
                        })}>삭제</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

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
                      <button className="link del" onClick={() => saveCatalog({ ...catalog, products: catalog.products.filter((x) => x.id !== p.id) })}>삭제</button>
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
              </span>
            ))}
          </div>
        </div>
      </section>

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
                      <button className="link del" onClick={() => saveSnaps(snaps.filter((x) => x.id !== s.id))}>삭제</button>
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
    </>
  );
}

/* ---------------- 스타일 ---------------- */
function Style() {
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

.topright{display:flex;flex-direction:column;align-items:flex-end;gap:3px;font-size:11px;color:var(--ink3)}
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

.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;
  background:var(--card);border:1px solid var(--line);border-radius:4px;padding:14px 16px;margin-bottom:14px}

.fld{display:flex;flex-direction:column;gap:4px;min-width:0}
.fld.wide{grid-column:1/-1}
.fld-l{font-size:11.5px;color:var(--ink2);font-weight:500}
.fld-h{font-size:11px;color:var(--ink3);font-family:'IBM Plex Mono','IBM Plex Sans KR',monospace}
.in{width:100%;border:1px solid var(--line);background:#fff;border-radius:3px;padding:7px 9px;font:inherit;font-size:13.5px;color:var(--ink)}
.in:focus{border-color:var(--deep)}
.numwrap{position:relative;display:flex;align-items:center}
.numwrap em{position:absolute;right:9px;font-style:normal;font-size:11px;color:var(--ink3);pointer-events:none;font-family:'IBM Plex Mono','IBM Plex Sans KR',monospace}
.numwrap .in{padding-right:34px;text-align:right}

.btn{border:1px solid var(--line);background:#fff;border-radius:3px;padding:7px 13px;font:inherit;font-size:13px;cursor:pointer;color:var(--ink)}
.btn:hover{border-color:var(--ink3)}
.btn.primary{background:var(--deep);border-color:var(--deep);color:#fff}
.btn.primary:hover{background:#0B4C56}
.btn.sm{padding:5px 10px;font-size:12.5px}
.link{background:none;border:0;font:inherit;font-size:12.5px;color:var(--deep);cursor:pointer;padding:2px 5px;text-decoration:underline;text-underline-offset:2px}
.link.del{color:var(--neg)}
.icon{background:none;border:0;font-size:15px;cursor:pointer;color:var(--ink3);padding:4px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}

.verdict{display:flex;flex-direction:column;gap:2px;padding:12px 15px;border-radius:4px;margin-bottom:14px;border:1px solid}
.verdict strong{font-size:14.5px;font-weight:600}
.verdict span{font-size:12.5px;color:var(--ink2)}
.verdict.ok{background:var(--okbg);border-color:#BFD6CC}
.verdict.warn{background:var(--warnbg);border-color:#E4D4A0}
.verdict.bad{background:var(--badbg);border-color:#E3BDB8}

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
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:13px}
.grid.tight{gap:9px;margin-top:8px}

.calcbox{margin-top:16px;background:#F4F7F7;border:1px solid var(--line2);border-radius:4px;padding:12px 14px}
.calcbox ul{list-style:none;margin:6px 0 0;padding:0;font-size:12.5px}
.calcbox li{display:flex;justify-content:space-between;gap:12px;padding:3px 0;border-bottom:1px dotted var(--line)}
.calcbox li:last-child{border:0}
.calcbox p{margin:6px 0 0;font-size:12.5px}

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
.foot{text-align:center;font-size:10.5px;color:var(--ink3);padding:16px 0 4px}

@media (max-width:640px){
  .app{padding:12px}

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
