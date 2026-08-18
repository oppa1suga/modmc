// api/_ratelimit.js
// Giới hạn tốc độ request theo IP, dùng chung cho các endpoint dễ bị lạm dụng
// (2026-08-18, sau vụ endpoint config bị gọi dồn dập gây tràn quota Redis).
//
// Cơ chế: đếm số request trong 1 cửa sổ thời gian cố định (fixed window) bằng
// INCR + EXPIRE - chỉ tốn 1-2 lệnh Redis/request, đủ rẻ để không tự làm tình hình
// tệ hơn. Không cần chính xác tuyệt đối (fixed window có thể cho phép hơi vượt ở
// biên cửa sổ) - mục tiêu là chặn spam rõ ràng, không phải rate-limit hoàn hảo.

const PREFIX = "vangioi_ratelimit:";
const ABUSE_LOG_KEY = "vangioi_abuse_log"; // Redis LIST, mới nhất ở đầu (LPUSH)
const ABUSE_LOG_MAX = 200; // chỉ giữ 200 lần gần nhất, tránh phình vô hạn

/**
 * @param redis instance ioredis (từ _redis.js)
 * @param bucket tên endpoint (VD "config", "phoban") - tách riêng bộ đếm mỗi endpoint
 * @param ip IP của request
 * @param limit số request tối đa cho phép trong 1 cửa sổ
 * @param windowSec độ dài cửa sổ (giây)
 * @param extra {} thông tin thêm để ghi log nếu bị chặn (VD { key: "..." })
 * @returns true nếu VƯỢT giới hạn (nên từ chối request) - đồng thời tự ghi log khi vượt
 */
export async function isRateLimited(redis, bucket, ip, limit, windowSec, extra = {}) {
  const key = PREFIX + bucket + ":" + ip;
  let over = false;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec);
    }
    over = count > limit;
  } catch (e) {
    // Lỗi Redis ở đây không nên chặn cả request chính - coi như không vượt giới hạn
    return false;
  }

  if (over) {
    const entry = JSON.stringify({ ip, bucket, at: new Date().toISOString(), ...extra });
    // Lỗi ghi log không nên làm hỏng response 429 chính - bỏ qua nếu fail
    redis.lpush(ABUSE_LOG_KEY, entry)
        .then(() => redis.ltrim(ABUSE_LOG_KEY, 0, ABUSE_LOG_MAX - 1))
        .catch(() => {});
  }

  return over;
}
