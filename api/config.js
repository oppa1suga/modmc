// api/config.js
// Nhận config từ mod gửi lên và lưu vào database (Upstash Redis).
// Chỉ LƯU TRỮ (gửi lên), một config chung.
//
// Mod gửi (POST, body JSON):
//   { "key": "<KEY bản quyền>", "config": <nội dung config tùy ý> }
//
// Server GỘP (merge) config mới với config đã lưu theo từng dòng
// "acc=<user>:<pass>": trùng user thì lấy bản mới nhất, không mất dữ liệu
// của những người dùng khác đã gửi trước đó. Lưu vào khóa "config:main".
//
// Xem lại config đã lưu (GET):
//   https://server-minerua.vercel.app/api/config?key=<KEY bản quyền>
// Trả về: { ok: true, config, updatedAt, updatedBy }

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

// Gộp 2 bản config dạng nhiều dòng "acc=user:pass", loại trùng user (giữ bản mới).
function mergeAccountConfigs(oldText, newText) {
  const accounts = new Map(); // user -> pass (thứ tự chèn = thứ tự gặp lần đầu)
  const extraLines = [];      // dòng không đúng dạng acc=user:pass -> giữ nguyên, không trùng lặp

  function ingest(text) {
    if (!text) return;
    for (const raw of String(text).split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("acc=")) {
        const v = line.substring(4);
        const c = v.indexOf(":");
        if (c > 0) {
          const user = v.substring(0, c).trim();
          const pass = v.substring(c + 1).trim();
          if (user && pass) { accounts.set(user, pass); continue; }
        }
      }
      if (!extraLines.includes(line)) extraLines.push(line);
    }
  }

  ingest(oldText);
  ingest(newText); // gửi sau -> ghi đè user trùng

  const lines = [...extraLines, ...[...accounts.entries()].map(([u, p]) => "acc=" + u + ":" + p)];
  return lines.join("\n");
}

async function checkLicense(key) {
  if (!key) return { ok: false, status: 400, error: "Thiếu key" };

  // Key chủ -> luôn hợp lệ, bỏ qua Redis license
  const ownerKey = await redis.get("owner_key").catch(() => null);
  if (ownerKey && key === ownerKey) return { ok: true };

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

  // Gộp với config đã lưu (nếu có) rồi lưu vào database
  try {
    let existing = await redis.get("config:main");
    if (typeof existing === "string") { try { existing = JSON.parse(existing); } catch (e) {} }
    const oldConfig = existing && typeof existing === "object" ? existing.config : null;

    const merged = mergeAccountConfigs(oldConfig, config);

    const record = {
      config: merged,
      updatedAt: new Date().toISOString(),
      updatedBy: key
    };
    await redis.set("config:main", JSON.stringify(record));
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi khi lưu: " + e.message });
  }

  return res.status(200).json({ ok: true, message: "Đã lưu config" });
}
