// api/vangioi-config.js
// Nhận config của AutoLoginMod (vangioi) và lưu vào database (Upstash Redis).
// KHÔNG yêu cầu key bản quyền (tạm thời) - ai gọi được URL cũng gửi/đọc được.
//
// Mod gửi (POST, body JSON):
//   { "config": <nội dung file autologin_accounts.txt> }
//
// Server lưu vào khóa "vangioi_config:main".
//
// Xem lại config đã lưu (GET):
//   https://server-minerua.vercel.app/api/vangioi-config
// Trả về: { ok: true, config, updatedAt }

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method === "GET") {
    let record;
    try {
      record = await redis.get("vangioi_config:main");
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Lỗi database" });
    }
    if (!record) {
      return res.status(404).json({ ok: false, error: "Chưa có config nào được lưu" });
    }
    if (typeof record === "string") { try { record = JSON.parse(record); } catch (e) {} }

    return res.status(200).json({
      ok: true,
      config: record.config,
      updatedAt: record.updatedAt
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Chỉ nhận GET hoặc POST" });
  }

  const body = req.body || {};
  const config = body.config;

  if (config === undefined || config === null) {
    return res.status(400).json({ ok: false, error: "Thiếu config" });
  }

  try {
    const record = {
      config: config,
      updatedAt: new Date().toISOString()
    };
    await redis.set("vangioi_config:main", JSON.stringify(record));
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi khi lưu: " + e.message });
  }

  return res.status(200).json({ ok: true, message: "Đã lưu config" });
}
