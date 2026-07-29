// api/check.js
// Kiểm tra key bản quyền - đọc từ database Upstash Redis.
// Mod gọi:  https://server-minerua.vercel.app/api/check?key=XXXX
//
// Mỗi key lưu trong Redis dưới dạng:
//   khóa:  "license:<KEY>"
//   giá trị (JSON): { "user": "tên", "expires": "2026-12-31" }
//
// Key chủ (lưu ở Redis khóa "owner_key", tạo/xem trong admin.html): luôn
// hợp lệ, dùng chung cho cả mod minerua và vangioi, không có ngày hết hạn.

import { Redis } from "@upstash/redis";

// Tự đọc biến môi trường KV/Upstash mà Vercel đã thêm vào project
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  const key = req.query.key;

  if (!key) {
    return res.status(400).json({ valid: false, reason: "Thiếu key" });
  }

  // Key chủ -> luôn hợp lệ, bỏ qua Redis license
  const ownerKey = await redis.get("owner_key").catch(() => null);
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

  // Lấy thông tin key từ database
  let info;
  try {
    info = await redis.get("license:" + key);
  } catch (e) {
    // Lỗi database -> báo lỗi (an toàn: không cấp phép khi không tra được)
    return res.status(500).json({ valid: false, reason: "Lỗi database" });
  }

  if (!info) {
    return res.status(200).json({ valid: false, reason: "Key không tồn tại" });
  }

  // info có thể là object (Upstash tự parse JSON) hoặc chuỗi - xử lý cả hai
  if (typeof info === "string") {
    try { info = JSON.parse(info); } catch (e) { info = { expires: info }; }
  }

  // Tính thời gian còn lại
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
