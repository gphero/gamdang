/**
 * 사용자가 올린 절약 꿀팁 — 저장소
 *
 * 로그인해서 서버에 연결돼 있으면 Supabase 의 tips / tip_votes 를 씁니다.
 * 연결 전이면 이 브라우저에만 저장해서, 기능을 먼저 써 볼 수 있게 합니다.
 *
 * 투표 수(up_count / down_count)는 서버 트리거가 세어 tips 행에 적어 둡니다.
 * 그래서 목록을 볼 때 투표 내역을 읽지 않아도 되고, 비추천 사유는
 * 글쓴이에게도 보이지 않습니다. 사유는 관리자만 봅니다.
 */

const LK_TIPS = "gamdang:tips";
const LK_VOTES = "gamdang:tipvotes";

const nowIso = () => new Date().toISOString();
const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `t${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

const lsGet = (k, fb) => {
  try {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : fb;
  } catch (e) { return fb; }
};
const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 저장 공간 없음 */ }
};

/* ── 입력값 다듬기 ─────────────────────────────────────────── */

export const TIP_LIMITS = { title: 60, body: 600, nick: 16, keywords: 60 };

export function cleanTip(d) {
  const s = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
  return {
    title: s(d.title, TIP_LIMITS.title),
    body: String(d.body || "").trim().slice(0, TIP_LIMITS.body),
    nick: s(d.nick, TIP_LIMITS.nick),
    keywords: s(d.keywords, TIP_LIMITS.keywords),
    topic: s(d.topic, 24) || "etc",
  };
}

export function tipProblem(t) {
  if (t.title.length < 4) return "제목을 조금 더 적어 주세요.";
  if (t.body.length < 15) return "방법을 15자 이상 적어 주세요. 어떻게 하는지가 빠지면 도움이 되지 않습니다.";
  if (/https?:\/\/[^\s]*(\?|&)(ref|utm_|affiliate|partner)/i.test(t.body))
    return "추천 링크(제휴 링크)는 올릴 수 없습니다. 링크를 빼고 방법만 적어 주세요.";
  return "";
}

/** 이미 있는 팁과 겹치는지 — 제목·본문 글자 겹침으로 거칠게 봅니다 */
export function findDuplicate(t, list) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^가-힣a-z0-9]/g, "");
  const a = norm(t.title) + norm(t.body).slice(0, 60);
  for (const x of list || []) {
    const b = norm(x.title) + norm(x.body).slice(0, 60);
    if (!a || !b) continue;
    if (a === b) return x;
    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (shorter.length >= 12 && longer.includes(shorter)) return x;
    if (norm(t.title) && norm(t.title) === norm(x.title)) return x;
  }
  return null;
}

/* ── 서버 ──────────────────────────────────────────────────── */

const isNewKey = (k) => /^sb_/.test(String(k || ""));
const trimUrl = (u) => String(u || "").trim().replace(/\/+$/, "");

async function rest(conn, path, opts = {}) {
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
    const m = (data && (data.message || data.msg || data.error_description || data.error)) || `HTTP ${res.status}`;
    throw new Error(String(m));
  }
  return data;
}

const rowToTip = (r) => ({
  id: r.id,
  userId: r.user_id || "",
  nick: r.nick || "",
  topic: r.topic || "etc",
  keywords: r.keywords || "",
  title: r.title || "",
  body: r.body || "",
  up: Number(r.up_count || 0),
  down: Number(r.down_count || 0),
  hidden: !!r.hidden,
  at: r.created_at || "",
});

/** 서버에 연결됐는지 — 읽기는 로그인 없이도 됩니다 */
export const canRead = (conn) => !!(conn && conn.url && conn.key);
/** 쓰기는 로그인이 필요합니다 */
export const canWrite = (conn) => !!(conn && conn.url && conn.key && conn.token && conn.user);

/* ── 공개 API ───────────────────────────────────────────────── */

/** 공개된 팁 목록 (가려진 것 제외, 추천 많은 순) */
export async function listTips(conn) {
  if (canRead(conn)) {
    const rows = await rest(
      conn,
      "/rest/v1/tips?hidden=is.false&select=id,user_id,nick,topic,keywords,title,body,up_count,down_count,hidden,created_at" +
        "&order=up_count.desc,created_at.desc&limit=400"
    );
    return (rows || []).map(rowToTip);
  }
  const list = lsGet(LK_TIPS, []);
  return list
    .filter((t) => !t.hidden)
    .sort((a, b) => (b.up - a.up) || String(b.at).localeCompare(String(a.at)));
}

/** 내가 어디에 투표했는지 { [tipId]: 1 | -1 } */
export async function myVotes(conn) {
  if (canWrite(conn)) {
    const rows = await rest(conn, `/rest/v1/tip_votes?user_id=eq.${conn.user.id}&select=tip_id,vote`);
    const m = {};
    for (const r of rows || []) m[r.tip_id] = Number(r.vote);
    return m;
  }
  if (canRead(conn)) return {};
  const v = lsGet(LK_VOTES, {});
  const m = {};
  for (const k of Object.keys(v)) m[k] = v[k].vote;
  return m;
}

export async function addTip(conn, draft) {
  const t = cleanTip(draft);
  if (canWrite(conn)) {
    const rows = await rest(conn, "/rest/v1/tips?select=*", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: conn.user.id,
        nick: t.nick, topic: t.topic, keywords: t.keywords,
        title: t.title, body: t.body,
      }),
    });
    return rowToTip((rows || [])[0] || {});
  }
  const list = lsGet(LK_TIPS, []);
  const row = { ...t, id: uid(), userId: "local", up: 0, down: 0, hidden: false, at: nowIso() };
  lsSet(LK_TIPS, [row, ...list]);
  return row;
}

export async function editTip(conn, id, draft) {
  const t = cleanTip(draft);
  if (canWrite(conn)) {
    await rest(conn, `/rest/v1/tips?id=eq.${id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ nick: t.nick, topic: t.topic, keywords: t.keywords, title: t.title, body: t.body }),
    });
    return;
  }
  const list = lsGet(LK_TIPS, []).map((x) => (x.id === id ? { ...x, ...t } : x));
  lsSet(LK_TIPS, list);
}

export async function removeTip(conn, id) {
  if (canWrite(conn)) {
    await rest(conn, `/rest/v1/tips?id=eq.${id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return;
  }
  lsSet(LK_TIPS, lsGet(LK_TIPS, []).filter((x) => x.id !== id));
}

/**
 * 추천 / 비추천. 같은 쪽을 다시 누르면 취소됩니다.
 * 비추천은 사유를 함께 보냅니다. 사유는 관리자만 봅니다.
 */
export async function vote(conn, tipId, v, reason = "") {
  if (canWrite(conn)) {
    if (v === 0) {
      await rest(conn, `/rest/v1/tip_votes?tip_id=eq.${tipId}&user_id=eq.${conn.user.id}`, {
        method: "DELETE", headers: { Prefer: "return=minimal" },
      });
      return;
    }
    await rest(conn, "/rest/v1/tip_votes?on_conflict=tip_id,user_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        tip_id: tipId, user_id: conn.user.id, vote: v,
        reason: v < 0 ? String(reason || "").trim().slice(0, 300) : "",
      }),
    });
    return;
  }
  const votes = lsGet(LK_VOTES, {});
  const list = lsGet(LK_TIPS, []);
  const prev = votes[tipId] ? votes[tipId].vote : 0;
  if (v === 0 || v === prev) delete votes[tipId];
  else votes[tipId] = { vote: v, reason: v < 0 ? String(reason || "").slice(0, 300) : "" };
  const next = votes[tipId] ? votes[tipId].vote : 0;
  lsSet(LK_VOTES, votes);
  lsSet(
    LK_TIPS,
    list.map((t) => {
      if (t.id !== tipId) return t;
      let up = t.up, down = t.down;
      if (prev === 1) up -= 1;
      if (prev === -1) down -= 1;
      if (next === 1) up += 1;
      if (next === -1) down += 1;
      return { ...t, up: Math.max(0, up), down: Math.max(0, down) };
    })
  );
}

/* ── 관리자 ─────────────────────────────────────────────────── */

/** 내가 관리자인지 */
export async function isAdmin(conn) {
  if (!canWrite(conn)) return false;
  try {
    const rows = await rest(conn, `/rest/v1/tip_admins?user_id=eq.${conn.user.id}&select=user_id`);
    return !!(rows && rows.length);
  } catch (e) { return false; }
}

/** 신고(비추천 사유)가 달린 팁 — 관리자만 읽힙니다 */
export async function listReports(conn) {
  if (!canWrite(conn)) return [];
  const rows = await rest(
    conn,
    "/rest/v1/tip_votes?vote=lt.0&reason=neq.&select=tip_id,reason,created_at,tips(id,title,body,nick,hidden,up_count,down_count)" +
      "&order=created_at.desc&limit=200"
  );
  const byTip = new Map();
  for (const r of rows || []) {
    const t = r.tips || {};
    if (!byTip.has(r.tip_id)) {
      byTip.set(r.tip_id, {
        id: r.tip_id,
        title: t.title || "(삭제된 팁)",
        body: t.body || "",
        nick: t.nick || "",
        hidden: !!t.hidden,
        up: Number(t.up_count || 0),
        down: Number(t.down_count || 0),
        reasons: [],
      });
    }
    byTip.get(r.tip_id).reasons.push({ reason: r.reason, at: r.created_at });
  }
  return [...byTip.values()];
}

export async function setHidden(conn, tipId, hidden) {
  await rest(conn, `/rest/v1/tips?id=eq.${tipId}`, {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ hidden: !!hidden }),
  });
}

/* ── 스키마 ─────────────────────────────────────────────────── */

export const TIPS_SQL = `-- 감당할수있겠나! 사용자 꿀팁 (supabase-schema.sql 실행 후 이어서 실행)

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
`;
