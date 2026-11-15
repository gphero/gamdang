/**
 * 읽을거리 — src/guides/ 의 마크다운 파일을 그대로 읽어옵니다.
 *
 * 글을 하나 더 쓰려면 src/guides/ 에 .md 파일을 하나 만들면 됩니다.
 * 코드는 건드리지 않습니다. 파일 이름이 주소가 됩니다.
 *   src/guides/water-bill.md  →  /guide/water-bill
 *
 * 파일 맨 위에 이렇게 적습니다.
 *
 *   ---
 *   title: 수도요금 고지서 읽는 법
 *   summary: 한 줄 요약. 목록과 검색에 쓰입니다.
 *   stage: 1
 *   order: 20
 *   ---
 *
 *   본문을 여기서부터 씁니다.
 *
 * stage 는 아래 STAGES 의 번호입니다. 빠뜨리면 '그 밖에'로 갑니다.
 * order 는 같은 단계 안에서의 순서이고, 작은 값이 먼저 나옵니다.
 * draft: true 를 넣으면 목록에도 사이트에도 나오지 않습니다.
 * 파일 이름을 밑줄로 시작해도(_메모.md) 글로 치지 않습니다.
 *
 * 본문에서 쓸 수 있는 것
 *   ## 소제목          한 단계짜리 제목만 있습니다 (### 는 없습니다)
 *   - 목록
 *   > 강조 상자
 *   | 표 | 머리글 |     줄마다 | 로 감싸고, 첫 줄이 머리글입니다
 *   **굵게**
 *   [링크](https://…) 또는 [링크](/guide/다른글)
 */

/* 단계. 새 묶음이 필요할 때만 여기를 고칩니다. */
export const STAGES = [
  {
    step: "1",
    title: "내가 얼마를 쓰는지 안다",
    lead: "여기서 틀리면 뒤의 계산이 전부 틀립니다. 아끼는 얘기가 아니라 아는 얘기입니다.",
  },
  {
    step: "2",
    title: "무너지지 않을 선을 만든다",
    lead: "통장을 0원까지 쓰면 안 됩니다. 갑자기 수입이 끊겨도 버틸 수 있는 선을 먼저 정합니다.",
  },
  {
    step: "3",
    title: "남는 돈을 굴린다",
    lead: "선을 지키고도 남는 돈이 생기면 그때 묶습니다. 조급해하지 않고 시드머니를 쌓는 구간입니다.",
  },
  {
    step: "4",
    title: "지치지 않게 유지한다",
    lead: "참아서 모으면 한 번에 무너집니다. 돈을 쓰지 않고도 쉴 줄 알고, 먹는 것을 가려서 고를 줄 알아야 오래갑니다.",
  },
  {
    step: "5",
    title: "큰 지출을 감당한다",
    lead: "집이나 차처럼 목돈이 나갈 때, 가격 말고도 무엇이 붙고 어떻게 나눠 낼지 봅니다.",
  },
];

const OTHER = { step: "0", title: "그 밖에", lead: "아직 어디에도 넣지 않은 글입니다." };

/* 머리말(---로 감싼 부분)을 떼어 냅니다 */
function parse(raw, slug) {
  const text = String(raw).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  let body = text;
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i < 0) continue;
      meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return {
    slug,
    title: meta.title || slug,
    summary: meta.summary || "",
    stage: String(meta.stage || OTHER.step),
    order: Number(meta.order || 50),
    draft: /^(true|1|yes)$/i.test(meta.draft || ""),
    body: body.trim(),
  };
}

const files = import.meta.glob("./guides/*.md", { query: "?raw", import: "default", eager: true });

export const GUIDES = Object.entries(files)
  .map(([path, raw]) => parse(raw, path.replace(/^.*\//, "").replace(/\.md$/, "")))
  /* 밑줄로 시작하는 파일과 README 는 글이 아닙니다 */
  .filter((g) => !g.slug.startsWith("_") && g.slug.toLowerCase() !== "readme")
  .filter((g) => !g.draft)
  .sort((a, b) => (a.stage === b.stage ? a.order - b.order : a.stage.localeCompare(b.stage)));

/* 단계별로 묶어 /guide 에서 보여줍니다. 글이 없는 단계는 빼고요. */
export const GUIDE_PATH = [...STAGES, OTHER]
  .map((st) => ({ ...st, items: GUIDES.filter((g) => g.stage === st.step) }))
  .filter((st) => st.items.length > 0);

export const guideBySlug = (slug) => GUIDES.find((g) => g.slug === slug) || null;
