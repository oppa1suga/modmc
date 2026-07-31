// api/vangioi-check.js
// Kiểm tra key bản quyền của mod VANGIOI - đọc từ database Upstash Redis.
// Namespace riêng ("vangioi_license:") để không lẫn với key của mod minerua.
//
// Mod gọi:  https://server-minerua.vercel.app/api/vangioi-check?key=XXXX
//
// Mỗi key lưu trong Redis dưới dạng:
//   khóa:  "vangioi_license:<KEY>"
//   giá trị (JSON): { "user": "tên", "expires": "2026-12-31" }
//
// Key chủ (lưu ở Redis khóa "owner_key", tạo/xem trong admin.html): luôn
// hợp lệ, dùng chung cho cả mod minerua và vangioi, không có ngày hết hạn,
// không bị khóa theo IP.
//
// KHÓA THEO IP: 1 key chỉ dùng được ở 1 IP tại một thời điểm. Mod gọi lại
// endpoint này mỗi 10 phút (xem LicenseManager) để "gia hạn" quyền dùng IP đó.
// Nếu quá LEASE_TIMEOUT_MS không thấy IP cũ gọi lại (game đã tắt) thì IP
// khác dùng key đó sẽ tự chiếm được, không cần thao tác gì thêm.
//
// TỐI ƯU TẢI: gộp 3 lệnh GET (owner_key, license, iplock) thành 1 lệnh MGET
// duy nhất (Redis tính MGET là 1 lệnh dù đọc nhiều key) -> giảm từ 4 lệnh
// Redis/lần xuống còn 2 lệnh/lần (MGET + SET gia hạn khóa).

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

const LEASE_TIMEOUT_MS = 12 * 60 * 1000; // 12 phút (dài hơn chu kỳ check 10 phút của mod)

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

export default async function handler(req, res) {
  const key = req.query.key;

  if (!key) {
    return res.status(400).json({ valid: false, reason: "Thiếu key" });
  }

  const licenseKeyName = "vangioi_license:" + key;
  const lockKeyName = "vangioi_iplock:" + key;

  let ownerKey, infoRaw, lockRaw;
  try {
    [ownerKey, infoRaw, lockRaw] = await redis.mget("owner_key", licenseKeyName, lockKeyName);
  } catch (e) {
    return res.status(500).json({ valid: false, reason: "Lỗi database" });
  }

  // Key chủ -> luôn hợp lệ, bỏ qua license lẫn khóa IP
  if (ownerKey && key === ownerKey) {
    return res.status(200).json({
      valid: true,
      reason: "Key chủ",
      user: "owner",
      expires: "9999-12-31",
      secondsLeft: 999999999,
      daysLeft: 999999,
      hoursLeft: 0
    });
  }

  let info = parseJson(infoRaw);
  if (!info) {
    return res.status(200).json({ valid: false, reason: "Key không tồn tại" });
  }

  const now = new Date();
  const expireDate = new Date(info.expires);
  const msLeft = expireDate.getTime() - now.getTime();

  if (msLeft <= 0) {
    return res.status(200).json({
      valid: false,
      reason: "Key đã hết hạn",
      user: info.user || "",
      expires: info.expires,
      secondsLeft: 0
    });
  }

  // === Khóa theo IP ===
  const ip = getClientIp(req);
  const lock = parseJson(lockRaw);

  const now2 = Date.now();
  const leaseExpired = !lock || (now2 - (lock.lastSeen || 0) > LEASE_TIMEOUT_MS);

  const igName = req.query.user || "";

  if (!leaseExpired && lock.ip !== ip) {
    // IP khác đang giữ key này và vẫn còn hoạt động (chưa hết hạn thuê)
    return res.status(200).json({
      valid: false,
      reason: "Key đang được dùng ở máy/IP khác"
        + (lock.igName ? " (tài khoản: " + lock.igName + ")" : ""),
      user: info.user || "",
      expires: info.expires
    });
  }

  // Chiếm/gia hạn khóa cho IP này
  await redis.set(lockKeyName, JSON.stringify({ ip, lastSeen: now2, igName }));

  const secondsLeft = Math.floor(msLeft / 1000);
  const daysLeft = Math.floor(secondsLeft / 86400);
  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);

  return res.status(200).json({
    valid: true,
    reason: "Key còn hạn",
    user: info.user || "",
    expires: info.expires,
    secondsLeft: secondsLeft,
    daysLeft: daysLeft,
    hoursLeft: hoursLeft
  });
}
