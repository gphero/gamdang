import React, { useMemo } from "react";
import { GUIDES, PRIVACY, TERMS } from "./content.js";
import { SERVICE } from "./config.js";
import { Style } from "./App.jsx";

/* 본문 안의 **굵게** 와 [글자](주소) 만 처리합니다 */
function inline(text, keyBase) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0, m, i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(<b key={`${keyBase}b${i++}`}>{tok.slice(2, -2)}</b>);
    } else {
      const label = tok.slice(1, tok.indexOf("]"));
      const href = tok.slice(tok.indexOf("(") + 1, -1);
      const ext = /^https?:/.test(href);
      out.push(
        <a key={`${keyBase}a${i++}`} href={href} className="ilink"
          {...(ext ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{label}</a>
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Prose({ body }) {
  const blocks = useMemo(() => {
    const lines = body.trim().split("\n");
    const out = [];
    let buf = [];
    const flush = (kind) => {
      if (!buf.length) return;
      out.push({ kind, lines: buf });
      buf = [];
    };
    let mode = null;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const next =
        line.startsWith("## ") ? "h"
        : line.startsWith("- ") ? "ul"
        : line.startsWith("> ") ? "quote"
        : line.startsWith("|") ? "table"
        : line.trim() === "" ? null
        : "p";
      if (next !== mode) { flush(mode); mode = next; }
      if (next) buf.push(line);
    }
    flush(mode);
    return out;
  }, [body]);

  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "h") {
          return b.lines.map((l, j) => <h3 key={`${i}-${j}`} className="pr-h">{l.slice(3)}</h3>);
        }
        if (b.kind === "ul") {
          return (
            <ul key={i} className="pr-ul">
              {b.lines.map((l, j) => <li key={j}>{inline(l.slice(2), `${i}-${j}`)}</li>)}
            </ul>
          );
        }
        if (b.kind === "quote") {
          return (
            <div key={i} className="pr-quote">
              {b.lines.map((l, j) => <p key={j}>{inline(l.slice(2), `${i}-${j}`)}</p>)}
            </div>
          );
        }
        if (b.kind === "table") {
          const rows = b.lines.map((l) =>
            l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
          );
          const [head, ...rest] = rows;
          return (
            <div key={i} className="tablewrap">
              <table className="tbl pr-tbl">
                <thead><tr>{head.map((c, j) => <th key={j}>{c}</th>)}</tr></thead>
                <tbody>
                  {rest.map((r, j) => (
                    <tr key={j}>{r.map((c, k) => <td key={k}>{inline(c, `${i}-${j}-${k}`)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        return b.lines.map((l, j) => <p key={`${i}-${j}`} className="pr-p">{inline(l, `${i}-${j}`)}</p>);
      })}
    </>
  );
}

function PageShell({ title, lead, children, onHome }) {
  return (
    <div className="app">
      <Style />
      <div className="page">
      <header className="page-top">
        <a href="/" className="brand plain" onClick={onHome}>
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>{SERVICE.name}</h1>
            <p className="tagline">{SERVICE.tagline}</p>
          </div>
        </a>
        <a href="/" className="btn primary" onClick={onHome}>계산해 보기</a>
      </header>
      <main className="page-body">
        <h2 className="page-title">{title}</h2>
        {lead ? <p className="page-lead">{lead}</p> : null}
        {children}
      </main>
      <PageFoot onHome={onHome} />
      </div>
    </div>
  );
}

function PageFoot({ onHome }) {
  return (
    <footer className="foot">
      <a href="/" className="ilink" onClick={onHome}>홈</a>
      <span className="fdot">·</span>
      <a href="/about" className="ilink">소개</a>
      <span className="fdot">·</span>
      <a href="/guide" className="ilink">가이드</a>
      <span className="fdot">·</span>
      <a href="/privacy" className="ilink">개인정보처리방침</a>
      <span className="fdot">·</span>
      <a href="/terms" className="ilink">이용약관</a>
    </footer>
  );
}

export function AboutPage({ onHome }) {
  return (
    <div className="app">
      <Style />
      <div className="page">
      <header className="page-top">
        <a href="/" className="brand plain" onClick={onHome}>
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>{SERVICE.name}</h1>
            <p className="tagline">{SERVICE.tagline}</p>
          </div>
        </a>
        <a href="/" className="btn primary" onClick={onHome}>계산해 보기</a>
      </header>

      <section className="hero">
        <p className="hero-eyebrow">집을 살까, 차를 바꿀까 고민할 때</p>
        <h2>그 지출, 하고 나서도<br />생활이 돌아갈까요?</h2>
        <p className="hero-lead">
          달마다 얼마가 들어오고 나가는지, 그리고 계획 중인 큰 지출을 넣으면
          앞으로 몇 년치 통장 잔고가 어떻게 움직이는지 그려 줍니다.
          감당하기 어렵다면 <b>무엇을 얼마나 바꿔야 하는지</b>까지 계산합니다.
        </p>
        <div className="row">
          <a href="/" className="btn primary big" onClick={onHome}>차근차근 시작하기</a>
          <a href="/guide" className="btn big">먼저 읽어보기</a>
        </div>
        <p className="mut sm" style={{ marginTop: 14 }}>
          가입하지 않아도 바로 쓸 수 있습니다. 계좌를 연결하지 않고, 직접 적은 금액만 다룹니다.
        </p>
      </section>

      <section className="feat">
        <article>
          <span className="eyebrow">판정</span>
          <h3>감당 가능한지 말해 줍니다</h3>
          <p>
            "잔고가 이렇게 움직입니다"에서 끝나지 않습니다.
            최소 유지 잔고를 정해 두면 그 선을 지키는지 판정하고,
            못 지키면 언제 무너지는지 짚어 줍니다.
          </p>
        </article>
        <article>
          <span className="eyebrow">처방</span>
          <h3>안 되면 대안을 계산합니다</h3>
          <p>
            매달 얼마를 덜 써야 하는지, 몇 개월 미루면 되는지,
            상환 기간을 얼마로 늘리면 되는지, 예산을 어디까지 줄이면 되는지.
            실제로 계획을 바꿔가며 돌려서 통과하는 지점을 찾습니다.
          </p>
        </article>
        <article>
          <span className="eyebrow">비교</span>
          <h3>여러 안을 나란히 놓습니다</h3>
          <p>
            일시불과 36개월 할부, 지금과 1년 뒤.
            같은 지출을 다른 구조로 놓고 잔고 곡선을 겹쳐 봅니다.
            총 이자와 최저 잔고가 함께 나옵니다.
          </p>
        </article>
        <article>
          <span className="eyebrow">부대비용</span>
          <h3>가격 말고도 나가는 돈까지</h3>
          <p>
            주택 구입을 고르면 취득세·지방교육세·중개보수·등기비용 항목이 채워집니다.
            주택 수와 면적을 넣으면 세율이 계산되고, 필요한 항목은 직접 더할 수 있습니다.
          </p>
        </article>
      </section>

      <section className="howto">
        <h3 className="sec-h">쓰는 순서</h3>
        <ol className="steps">
          <li><b>지금 사정</b><span>가진 현금과 매달 들어오는 돈</span></li>
          <li><b>매달 나가는 돈</b><span>주거비, 식비, 보험료 같은 고정 지출</span></li>
          <li><b>큰 지출</b><span>집·차·이사 등 계획 중인 목돈</span></li>
          <li><b>자금 조달</b><span>얼마를 내 돈으로, 얼마를 빌릴지</span></li>
          <li><b>감당 가능한가</b><span>판정과 대안</span></li>
        </ol>
      </section>

      <section className="trust">
        <h3 className="sec-h">짚고 갈 점</h3>
        <ul className="pr-ul">
          <li><b>금융상품을 권유하지 않습니다.</b> 대출·카드를 소개하거나 중개하지 않고, 금융회사에서 대가를 받지 않습니다.</li>
          <li><b>계좌를 연결하지 않습니다.</b> 거래내역을 가져오지 않고, 계좌·카드 번호를 받지 않습니다. 직접 적은 금액만 다룹니다.</li>
          <li><b>가입하지 않아도 됩니다.</b> 그 경우 입력한 내용은 브라우저 안에만 남고 서버로 가지 않습니다.</li>
          <li><b>재무 자문이 아닙니다.</b> 입력한 가정에 따른 계산이며, 세율 같은 값은 참고용입니다. 실제 결정 전에는 확인이 필요합니다.</li>
        </ul>
      </section>

      <section className="cta">
        <h3>지금 재 보세요</h3>
        <p>5분이면 됩니다. 숫자가 대략이어도 방향은 보입니다.</p>
        <a href="/" className="btn primary big" onClick={onHome}>시작하기</a>
      </section>

      <PageFoot onHome={onHome} />
      </div>
    </div>
  );
}

export function GuideIndex({ onHome }) {
  return (
    <PageShell title="가이드" onHome={onHome}
      lead="앱이 계산에 쓰는 기준을 글로 풀었습니다. 숫자를 넣기 전에 읽으면 무엇을 넣어야 할지 분명해집니다.">
      <div className="glist">
        {GUIDES.map((g) => (
          <a key={g.slug} className="gcard" href={`/guide/${g.slug}`}>
            <h3>{g.title}</h3>
            <p>{g.summary}</p>
            <span className="gmore">읽기 →</span>
          </a>
        ))}
      </div>
    </PageShell>
  );
}

export function GuidePage({ slug, onHome }) {
  const g = GUIDES.find((x) => x.slug === slug);
  if (!g) {
    return (
      <PageShell title="찾을 수 없는 글" onHome={onHome}>
        <p className="pr-p">주소가 바뀌었거나 없는 글입니다.</p>
        <p className="pr-p"><a className="ilink" href="/guide">가이드 목록으로</a></p>
      </PageShell>
    );
  }
  const others = GUIDES.filter((x) => x.slug !== slug);
  return (
    <PageShell title={g.title} lead={g.summary} onHome={onHome}>
      <Prose body={g.body} />
      <div className="gnext">
        <h4 className="sub-h">이어서 읽기</h4>
        <div className="glist">
          {others.map((o) => (
            <a key={o.slug} className="gcard" href={`/guide/${o.slug}`}>
              <h3>{o.title}</h3>
              <p>{o.summary}</p>
            </a>
          ))}
        </div>
      </div>
    </PageShell>
  );
}

export function LegalPage({ which, onHome }) {
  const doc = which === "privacy" ? PRIVACY : TERMS;
  return (
    <PageShell title={doc.title} lead={`마지막 갱신 ${doc.updated}`} onHome={onHome}>
      <Prose body={doc.body} />
    </PageShell>
  );
}
