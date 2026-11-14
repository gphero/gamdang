/**
 * 로컬 저장소 어댑터
 *
 * 아티팩트 환경의 window.storage 와 같은 모양으로 맞춰 둔 얇은 껍데기입니다.
 * 덕분에 App.jsx 의 저장 로직을 고치지 않고 그대로 쓸 수 있습니다.
 *
 * 여기 담기는 것은 "이 브라우저에만 있는 사본"입니다.
 * 계정에 묶이는 진짜 저장은 앱의 '연결' 탭에서 붙이는 Supabase 쪽이고,
 * 이 어댑터는 서버 저장이 실패하거나 아직 연결 전일 때의 보루 역할을 합니다.
 */

const PREFIX = "gamdang:";

function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    // 시크릿 창, 사이트 데이터 차단 등에서 localStorage 접근이 막힐 수 있습니다.
    return fallback;
  }
}

export const storage = {
  /**
   * @param {string} key
   * @returns {Promise<{value: string}|null>}
   */
  async get(key) {
    const raw = safe(() => window.localStorage.getItem(PREFIX + key), null);
    return raw === null ? null : { value: raw };
  },

  /**
   * @param {string} key
   * @param {string} value  JSON 문자열
   */
  async set(key, value) {
    const ok = safe(() => {
      window.localStorage.setItem(PREFIX + key, value);
      return true;
    }, false);
    if (!ok) throw new Error("브라우저 저장소를 쓸 수 없습니다.");
  },

  async remove(key) {
    safe(() => window.localStorage.removeItem(PREFIX + key), null);
  },
};

export default storage;
