import { type Env, pyStrip } from '@samsam/core/env';

// Port hằng của connectors/zalo.py — câu viết tay giữ NGUYÊN chữ Python (không qua guardrail,
// chờ Pháp chế duyệt). Lớp kênh (connectors/channels.py → nhóm channels) import FALLBACK /
// HANDOFF_TEXT từ đây như Python `from connectors.zalo import FALLBACK`.

export const SEND_URL = 'https://openapi.zalo.me/v3.0/oa/message/cs';
export const OAUTH_URL = 'https://oauth.zaloapp.com/v4/oa/access_token';
export const GETOA_URL = 'https://openapi.zalo.me/v2.0/oa/getoa';
export const MAX_TEXT = 2000; // giới hạn text của Zalo CS message
// v13.7: phần ngân sách 30 giây dành cho gửi (= rag.SEND_RESERVE_S).
export const SEND_TIMEOUT_S = 5;
// v14.6: refresh/chờ refresh/gửi lại nằm TRONG hạn chót 30 giây của lượt trả lời.
export const REFRESH_TIMEOUT_S = 15;
export const MIN_CALL_S = 1.0;
export const MAX_BODY = 1024 * 1024; // 1MB — event Zalo là JSON nhỏ; body lớn = DoS

export const FALLBACK =
  'Sâm Sâm xin lỗi, câu trả lời tự động chưa đạt kiểm duyệt nội ' +
  'bộ. Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.';
// Gửi khi answer() crash.
export const ERROR_FALLBACK =
  'Sâm Sâm xin lỗi, hệ thống đang gặp sự cố. Quý khách ' +
  'vui lòng gọi hotline 1800577732 để được hỗ trợ.';
// answer() trả NO_DATA (D6.1): khách có lối thoát, câu hỏi vẫn vào queue answered:false.
export const HANDOFF_TEXT =
  'Sâm Sâm chưa đủ dữ liệu để trả lời câu này — nhân ' +
  'viên sẽ phản hồi sớm nhất. Quý khách cần gấp vui lòng ' +
  'gọi hotline 1800577732 để được hỗ trợ.';
// v13.3 (HĐ 6.7): chatbot chưa vận hành → khách nhận câu này, câu bot thành gợi ý cskh_reply.
export const HOLD_TEXT =
  'Sâm Sâm đã nhận câu hỏi của Quý khách — nhân viên sẽ phản ' +
  'hồi sớm nhất. Quý khách cần gấp vui lòng gọi hotline ' +
  '1800577732 để được hỗ trợ.';
// r12 L3: KHÔNG hứa "nhân viên sẽ phản hồi" — gửi khi không ghi được mục cskh_handoff.
export const NO_HANDOFF_TEXT =
  'Sâm Sâm đã nhận tin nhắn nhưng chưa trả lời tự động ' +
  'được câu này. Quý khách vui lòng gọi hotline 1800577732 ' +
  'để được hỗ trợ.';
export const NO_HANDOFF_TEXTS: Readonly<Record<string, string>> = {
  health:
    'Dạ, Sâm Sâm không tư vấn về tình trạng sức khỏe qua tin nhắn' +
    ' tự động. Quý khách vui lòng hỏi ý kiến bác sĩ về tình trạng' +
    ' của mình; cần hỗ trợ vui lòng gọi hotline 1800577732.',
  alcohol:
    'Dạ, Sâm Sâm không tư vấn sản phẩm này qua tin nhắn tự động.' +
    ' Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.',
};
// V1.4: event user_send_* không phải text (ảnh/file/sticker/...).
export const NON_TEXT_TEXT =
  'Sâm Sâm hiện chỉ hỗ trợ trả lời tin nhắn văn bản. ' +
  'Quý khách vui lòng gọi hotline 1800577732 để được hỗ trợ.';
// V2.5: khách follow OA.
export const WELCOME_TEXT =
  'Cảm ơn Quý khách đã theo dõi Sâm Sâm! Sâm Sâm chuyên ' +
  'các sản phẩm sâm Ngọc Linh chính gốc. Quý khách cần hỗ ' +
  'trợ vui lòng nhắn tin hoặc gọi hotline 1800577732.';

export const SEEN_TTL_S = 3600;
// V7.3/V8.2: key `follow:*` sống 7 ngày (unfollow/refollow trong tuần không spam welcome).
export const FOLLOW_TTL_S = 7 * 86400;
export const CONV_LOG_MAX = 5 * 1024 * 1024; // 5MB → rotate sang .1 (D5.4)
export const RETAIN_DAYS = 30; // convlog không nằm lại > 30 ngày (D5.11)
export const PURGE_RETRY_S = 3600;
export const REFRESH_MIN_INTERVAL_S = 60;
export const REFRESH_AHEAD_S = 300;
export const HIST_MAX_USERS = 1000;
export const DEFAULT_PORT = 8788;

export const DEPLOY_ON = ['1', 'true', 'yes'];
/** DEPLOY=1/true/yes (đọc lúc gọi — test đổi env được). */
export const deployOn = (env: Env): boolean =>
  DEPLOY_ON.includes(pyStrip(env.DEPLOY ?? '').toLowerCase());

/** Đồng hồ (giây). `mono` đo khoảng trong tiến trình (V7.2 — miễn lùi giờ); `wall` = epoch
 * cho dữ liệu sống qua restart (seen ts, expires_at, ts convlog). Test thay rồi khôi phục. */
export const clock = {
  mono: (): number => performance.now() / 1000,
  wall: (): number => Date.now() / 1000,
};
