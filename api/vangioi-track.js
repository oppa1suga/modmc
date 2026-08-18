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

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

const TRACK_HASH = "vangioi_chiendau_track:users";

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

  const ip = getClientIp(req);
  const at = new Date().toISOString();

  try {
    await redis.hset(TRACK_HASH, { [user]: JSON.stringify({ ip, at }) });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi database" });
  }

  return res.status(200).json({ ok: true });
}
