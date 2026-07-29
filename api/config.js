// api/config.js
// Nhận config từ mod gửi lên và lưu vào database (Upstash Redis).
// Chỉ LƯU TRỮ (gửi lên), một config chung.
//
// Mod gửi (POST, body JSON):
//   { "key": "<KEY bản quyền>", "config": <nội dung config tùy ý> }
//
// Server lưu vào khóa "config:main" và trả về xác nhận.
//
// Xem lại config đã lưu (GET):
//   https://server-minerua.vercel.app/api/config?key=<KEY bản quyền>
// Trả về: { ok: true, config, updatedAt, updatedBy }

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

async function checkLicense(key) {
  if (!key) return { ok: false, status: 400, error: "Thiếu key" };
  let info;
  try {
    info = await redis.get("license:" + key);
  } catch (e) {
    return { ok: false, status: 500, error: "Lỗi database" };
  }
  if (!info) return { ok: false, status: 403, error: "Key không hợp lệ" };
  if (typeof info === "string") { try { info = JSON.parse(info); } catch (e) {} }
  if (new Date(info.expires).getTime() <= Date.now()) {
    return { ok: false, status: 403, error: "Key đã hết hạn" };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const key = req.query.key;
    const lic = await checkLicense(key);
    if (!lic.ok) return res.status(lic.status).json({ ok: false, error: lic.error });

    let record;
    try {
      record = await redis.get("config:main");
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
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy
    });
  }

  // Chỉ nhận POST (gửi lên) ngoài GET
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Chỉ nhận GET hoặc POST" });
  }

  const body = req.body || {};
  const key = body.key;
  const config = body.config;

  // Kiểm tra bản quyền trước (chỉ ai có key hợp lệ mới gửi được)
  const lic = await checkLicense(key);
  if (!lic.ok) return res.status(lic.status).json({ ok: false, error: lic.error });

  // Thiếu nội dung config
  if (config === undefined || config === null) {
    return res.status(400).json({ ok: false, error: "Thiếu config" });
  }

  // Lưu config chung vào database
  try {
    const record = {
      config: config,
      updatedAt: new Date().toISOString(),
      updatedBy: key
    };
    await redis.set("config:main", JSON.stringify(record));
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi khi lưu: " + e.message });
  }

  return res.status(200).json({ ok: true, message: "Đã lưu config" });
}
