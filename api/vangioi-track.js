// api/vangioi-track.js
// Ghi nhận IP + IGN của người dùng bản "Chiến Đấu" rút gọn (không có hệ thống key
// bản quyền, dùng để nộp đăng ký) - vì bản này không gọi vangioi-check nữa nên
// không có cách nào khác biết ai đang chạy nó.
//
// Mod gửi (GET):
//   https://server-minerua.vercel.app/api/vangioi-track?user=<IGN>
//
// Lưu vào 1 Redis HASH, field = IGN, value = JSON {ip, at} - IP lấy từ chính
// request này (không cần mod gửi kèm, giống getClientIp() ở các endpoint khác).

import { getRedis } from "./_redis.js";
import { isRateLimited } from "./_ratelimit.js";
const redis = getRedis();

const TRACK_HASH = "vangioi_chiendau_track:users";

// Endpoint này KHÔNG có key bản quyền để xác thực (đúng mục đích - bản "Chiến
// Đấu" rút gọn dùng để đăng ký, chưa có key) nên không thể chặn theo key như các
// endpoint khác - dựa hết vào rate limit + giới hạn độ dài + chỉ ghi khi THẬT SỰ
// đổi để hạn chế lạm dụng (2026-08-18, trước đó hoàn toàn không có bảo vệ gì).
const RATE_LIMIT_PER_MIN = 10; // đăng ký chỉ cần gọi vài lần/phiên là cùng
const RATE_LIMIT_WINDOW_SEC = 60;
const MAX_USER_LENGTH = 32; // IGN Minecraft tối đa 16 ký tự, để dư cho an toàn

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

export default async function handler(req, res) {
  const user = (req.query.user || "").toString().trim();
  if (!user) {
    return res.status(400).json({ ok: false, error: "Thiếu user" });
  }
  if (user.length > MAX_USER_LENGTH) {
    return res.status(400).json({ ok: false, error: "Dữ liệu không hợp lệ" });
  }

  const ip = getClientIp(req);

  if (await isRateLimited(redis, "track", ip, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_SEC, { user })) {
    return res.status(429).json({ ok: false, error: "Gọi quá nhanh, thử lại sau." });
  }

  try {
    // Chỉ ghi khi THẬT SỰ đổi (IGN mới, hoặc IP đổi so với lần ghi nhận trước) -
    // gọi lặp lại y hệt (VD mod tự gọi lại nhiều lần trong 1 phiên) không tốn
    // thêm lệnh ghi Redis nào, chỉ 1 lệnh đọc rẻ để so sánh.
    let existing = await redis.hget(TRACK_HASH, user);
    if (typeof existing === "string") { try { existing = JSON.parse(existing); } catch (e) { existing = null; } }
    if (existing && existing.ip === ip) {
      return res.status(200).json({ ok: true });
    }

    const at = new Date().toISOString();
    await redis.hset(TRACK_HASH, { [user]: JSON.stringify({ ip, at }) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi database" });
  }

  return res.status(200).json({ ok: true });
}
