// api/vangioi-config.js
// Nhận config của AutoLoginMod (vangioi) và lưu vào database (Upstash Redis).
// KHÔNG yêu cầu key bản quyền (tạm thời) - ai gọi được URL cũng gửi/đọc được.
//
// Mod gửi (POST, body JSON):
//   { "config": <nội dung file autologin_accounts.txt> }
//
// Server GỘP (merge) config mới với config đã lưu theo từng dòng
// "acc=<user>:<pass>": trùng user thì lấy bản mới nhất, không mất dữ liệu
// của những người dùng khác đã gửi trước đó. Lưu vào khóa "vangioi_config:main".
//
// Xem lại config đã lưu (GET):
//   https://server-minerua.vercel.app/api/vangioi-config
// Trả về: { ok: true, config, updatedAt }

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

// Gộp 2 bản config dạng nhiều dòng "acc=user:pass", loại trùng user (giữ bản mới).
function mergeAccountConfigs(oldText, newText) {
  const accounts = new Map();
  const extraLines = [];

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
  ingest(newText);

  const lines = [...extraLines, ...[...accounts.entries()].map(([u, p]) => "acc=" + u + ":" + p)];
  return lines.join("\n");
}

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
    let existing = await redis.get("vangioi_config:main");
    if (typeof existing === "string") { try { existing = JSON.parse(existing); } catch (e) {} }
    const oldConfig = existing && typeof existing === "object" ? existing.config : null;

    const merged = mergeAccountConfigs(oldConfig, config);

    const record = {
      config: merged,
      updatedAt: new Date().toISOString()
    };
    await redis.set("vangioi_config:main", JSON.stringify(record));
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi khi lưu: " + e.message });
  }

  return res.status(200).json({ ok: true, message: "Đã lưu config" });
}
