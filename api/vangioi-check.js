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
// KHÓA THEO (IP + SESSION): 1 key chỉ dùng được ở 1 phiên game (1 tab/instance
// Minecraft) tại một thời điểm - kể cả 2 tab CÙNG máy (cùng IP) cũng bị chặn
// lẫn nhau, vì mỗi lần mở game LicenseManager tự sinh 1 session ID ngẫu nhiên
// riêng (không lưu file). Mod gọi lại endpoint này mỗi 10 phút để "gia hạn"
// quyền dùng phiên đó. Nếu quá LEASE_TIMEOUT_MS không thấy phiên cũ gọi lại
// (game đã tắt) thì phiên khác dùng key đó sẽ tự chiếm được, không cần thao
// tác gì thêm.
//
// TỐI ƯU TẢI: gộp 5 lệnh GET (owner_key, license, iplock, min_build, kick) thành 1
// lệnh MGET duy nhất (Redis tính MGET là 1 lệnh dù đọc nhiều key).
//
// KHÓA PHIÊN BẢN: mỗi bản mod gửi kèm "build" (số nguyên, xem LicenseManager).
// Redis khóa "vangioi_min_build" giữ số build TỐI THIỂU được phép chạy - đặt/xem
// qua admin.html (?ns=vangioi, action=getminbuild/setminbuild). Bản mod cũ hơn
// số này bị từ chối luôn, kể cả key còn hạn - buộc phải cập nhật bản mới.
//
// NÚT "KICK" (admin.html): admin bấm -> đặt cờ "vangioi_kick:<key>" trong Redis
// (xem api/admin.js, action=kick). Response trả về "kick": true đúng 1 LẦN (cờ tự
// xóa ngay khi đọc, không lặp lại) - mod (LicenseManager) thấy cờ này thì tự
// disconnect khỏi server, BẤT KỂ key còn hợp lệ hay không. Vì mod chỉ gọi endpoint
// này mỗi 10 phút, kick có thể mất tới ~10 phút mới có hiệu lực (đánh đổi để không
// tốn thêm lệnh Redis polling riêng - xem ghi chú ngân sách Redis trong project memory).

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
  const kickKeyName = "vangioi_kick:" + key;

  let ownerKey, infoRaw, lockRaw, minBuildRaw, kickRaw;
  try {
    [ownerKey, infoRaw, lockRaw, minBuildRaw, kickRaw] =
        await redis.mget("owner_key", licenseKeyName, lockKeyName, "vangioi_min_build", kickKeyName);
  } catch (e) {
    return res.status(500).json({ valid: false, reason: "Lỗi database" });
  }

  // Cờ "kick" (nếu có) -> xóa ngay (chỉ báo 1 lần) rồi gắn vào MỌI response bên
  // dưới, bất kể key có hợp lệ hay không - mod thấy cờ này là tự ngắt kết nối.
  let kick = false;
  if (kickRaw) {
    kick = true;
    try { await redis.del(kickKeyName); } catch (e) { /* không chặn response vì lỗi phụ này */ }
  }

  // Key chủ -> luôn hợp lệ, bỏ qua license, khóa IP lẫn khóa phiên bản
  if (ownerKey && key === ownerKey) {
    return res.status(200).json({
      valid: true,
      reason: "Key chủ",
      user: "owner",
      expires: "9999-12-31",
      secondsLeft: 999999999,
      daysLeft: 999999,
      hoursLeft: 0,
      kick
    });
  }

  // === Khóa phiên bản: bản mod cũ hơn mức tối thiểu -> từ chối luôn ===
  const minBuild = parseInt(minBuildRaw, 10) || 0;
  const clientBuild = parseInt(req.query.build, 10) || 0;
  if (minBuild > 0 && clientBuild < minBuild) {
    return res.status(200).json({
      valid: false,
      reason: "Phiên bản mod đã cũ, vui lòng tải bản mới",
      kick
    });
  }

  let info = parseJson(infoRaw);
  if (!info) {
    return res.status(200).json({ valid: false, reason: "Key không tồn tại", kick });
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
      secondsLeft: 0,
      kick
    });
  }

  // === Khóa theo (IP + session) ===
  const ip = getClientIp(req);
  const session = req.query.session || "";
  const lock = parseJson(lockRaw);

  const now2 = Date.now();
  const leaseExpired = !lock || (now2 - (lock.lastSeen || 0) > LEASE_TIMEOUT_MS);

  const igName = req.query.user || "";

  const sameSession = lock && lock.ip === ip && lock.session === session;

  if (!leaseExpired && !sameSession) {
    // Phiên khác (IP khác, hoặc cùng IP nhưng khác tab/instance) đang giữ key
    // này và vẫn còn hoạt động (chưa hết hạn thuê)
    return res.status(200).json({
      valid: false,
      reason: "Key đang được dùng ở nơi khác"
        + (lock.igName ? " (tài khoản: " + lock.igName + ")" : ""),
      user: info.user || "",
      expires: info.expires,
      kick
    });
  }

  // Chiếm/gia hạn khóa cho phiên này
  await redis.set(lockKeyName, JSON.stringify({ ip, session, lastSeen: now2, igName }));

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
    hoursLeft: hoursLeft,
    kick
  });
}
