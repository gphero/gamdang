/**
 * 서비스 설정
 *
 * Supabase 주소와 publishable key 는 공개용 값입니다. 브라우저에 그대로
 * 노출돼도 괜찮고, 실제 접근 제어는 서버의 RLS 정책이 맡습니다.
 * 그래서 빌드에 넣어 두고, 방문자는 이메일·비밀번호만으로 가입합니다.
 *
 * 값을 넣는 곳
 *   - 로컬:   프로젝트 루트의 .env.local
 *   - Netlify: Project configuration → Environment variables
 *
 *   VITE_SUPABASE_URL = https://xxxxx.supabase.co
 *   VITE_SUPABASE_KEY = sb_publishable_...
 *
 * 비워 두면 앱이 '직접 연결' 모드로 떨어집니다. 사용자가 자기 Supabase
 * 프로젝트를 연결해 쓰는 방식이며, 개발이나 자체 호스팅에 쓰입니다.
 *
 * secret key(sb_secret_...) 는 절대 넣지 마세요. RLS 를 우회합니다.
 */

const env = import.meta.env || {};

export const SUPABASE_URL = String(env.VITE_SUPABASE_URL || "").trim().replace(/\/+$/, "");
export const SUPABASE_KEY = String(env.VITE_SUPABASE_KEY || "").trim();

/** 서비스로 운영 중인지(= 가입을 바로 받을 수 있는지) */
export const HOSTED = !!(SUPABASE_URL && SUPABASE_KEY);

/** secret key 가 잘못 들어간 경우를 빌드 산출물에서 바로 알아채기 위한 방어 */
if (SUPABASE_KEY && /^sb_secret_/.test(SUPABASE_KEY)) {
  throw new Error(
    "VITE_SUPABASE_KEY 에 secret key 가 들어갔습니다. publishable key 를 쓰세요."
  );
}

export const SERVICE = {
  name: "감당할수있겠나!",
  tagline: "큰 지출을 감당할 수 있는지 미리 굴려보는 가계 현금흐름 예측 시스템",
  url: "https://canyougetit.netlify.app",
  contact: "", // 문의 이메일을 넣으면 약관·방침에 표시됩니다
  since: "2026-11-14",
};
