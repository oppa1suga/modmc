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
// KHÓA CỨNG IP (nút "Khóa IP" trong admin.html, action=hardlockip trong
// api/admin.js): đánh dấu "hardLocked":true lên bản ghi khóa hiện tại của key -
// từ đó CHỈ đúng IP đó mới dùng được key này, IP khác bị từ chối vĩnh viễn (bỏ
// qua cơ chế hết hạn thuê 12 phút ở trên), cho tới khi admin gỡ (action=unhardlockip
// hoặc "Gỡ IP" xóa hẳn khóa).
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

import { getRedis } from "./_redis.js";

const redis = getRedis();

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
      keyOk: true,
      reason: "Key chủ",
      user: "owner",
      expires: "9999-12-31",
      secondsLeft: 999999999,
      daysLeft: 999999,
      hoursLeft: 0,
      kick
    });
  }

  // === Khóa phiên bản: bản mod cũ hơn mức tối thiểu -> CHỈ khóa tính năng mod
  // (trường "valid" mà LicenseManager.isLicensed() dựa vào), KHÔNG được return
  // sớm ở đây nữa - vẫn phải đi tiếp để ghi nhận "đang dùng"/cho phép Kick qua
  // admin.html và vẫn đồng bộ config (xem "keyOk" ở dưới) dù build cũ.
  const minBuild = parseInt(minBuildRaw, 10) || 0;
  const clientBuild = parseInt(req.query.build, 10) || 0;
  const buildBlocked = minBuild > 0 && clientBuild < minBuild;

  let info = parseJson(infoRaw);
  if (!info) {
    return res.status(200).json({ valid: false, keyOk: false, reason: "Key không tồn tại", kick });
  }

  const now = new Date();
  const expireDate = new Date(info.expires);
  const msLeft = expireDate.getTime() - now.getTime();

  if (msLeft <= 0) {
    return res.status(200).json({
      valid: false,
      keyOk: false,
      reason: "Key đã hết hạn",
      user: info.user || "",
      expires: info.expires,
      secondsLeft: 0,
      kick
    });
  }

  // === Khóa theo (IP + session), có thể "khóa cứng" 1 IP qua admin.html ===
  const ip = getClientIp(req);
  const session = req.query.session || "";
  const lock = parseJson(lockRaw);

  const now2 = Date.now();
  const hardLocked = !!(lock && lock.hardLocked);
  const leaseExpired = !lock || (now2 - (lock.lastSeen || 0) > LEASE_TIMEOUT_MS);
  const igName = req.query.user || "";

  const sameIp = !!(lock && lock.ip === ip);
  const sameSession = sameIp && lock.session === session;

  if (hardLocked && !sameIp) {
    // Admin đã khóa cứng key này vào 1 IP cụ thể (nút "Khóa IP" trong admin.html) -
    // IP khác KHÔNG BAO GIỜ chiếm được, kể cả khi IP đã khóa ngừng hoạt động lâu
    // (bỏ qua leaseExpired hoàn toàn, khác với khóa mềm 12 phút bình thường).
    return res.status(200).json({
      valid: false,
      keyOk: false,
      reason: "Key đã bị khóa cứng vào IP khác"
        + (lock.igName ? " (tài khoản: " + lock.igName + ")" : ""),
      user: info.user || "",
      expires: info.expires,
      kick
    });
  }

  if (!hardLocked && !leaseExpired && !sameSession) {
    // Phiên khác (IP khác, hoặc cùng IP nhưng khác tab/instance) đang giữ key
    // này và vẫn còn hoạt động (chưa hết hạn thuê)
    return res.status(200).json({
      valid: false,
      keyOk: false,
      reason: "Key đang được dùng ở nơi khác"
        + (lock.igName ? " (tài khoản: " + lock.igName + ")" : ""),
      user: info.user || "",
      expires: info.expires,
      kick
    });
  }

  // Chiếm/gia hạn khóa cho phiên này (giữ nguyên cờ khóa cứng nếu IP không đổi) -
  // làm BẤT KỂ build cũ hay mới, để admin.html vẫn thấy "đang dùng"/Kick được dù
  // client đang bị khóa tính năng mod do build cũ (xem buildBlocked ở trên).
  await redis.set(lockKeyName, JSON.stringify({
    ip, session, lastSeen: now2, igName,
    hardLocked: hardLocked && sameIp
  }));

  const secondsLeft = Math.floor(msLeft / 1000);
  const daysLeft = Math.floor(secondsLeft / 86400);
  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);

  // keyOk:true từ đây trở đi -> key/phiên hợp lệ thật sự (dù build cũ hay mới),
  // mod dùng để vẫn cho đồng bộ config lên server (AutoLoginMod.uploadConfig())
  // ngay cả khi "valid":false chỉ vì lý do build cũ.
  if (buildBlocked) {
    return res.status(200).json({
      valid: false,
      keyOk: true,
      reason: "Phiên bản mod đã cũ, vui lòng tải bản mới",
      user: info.user || "",
      expires: info.expires,
      secondsLeft: secondsLeft,
      daysLeft: daysLeft,
      hoursLeft: hoursLeft,
      kick
    });
  }

  return res.status(200).json({
    valid: true,
    keyOk: true,
    reason: "Key còn hạn",
    user: info.user || "",
    expires: info.expires,
    secondsLeft: secondsLeft,
    daysLeft: daysLeft,
    hoursLeft: hoursLeft,
    kick
  });
}
