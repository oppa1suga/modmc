// api/decide.js
// Bộ não quyết định của AutoDotPha - chạy TRÊN SERVER (giấu logic khỏi client).
//
// Mod gửi lên (POST, body JSON):
//   {
//     "key": "<KEY bản quyền>",
//     "lines": ["dòng scoreboard 1", "dòng 2", ...],
//     "autoDoKiep": true/false
//   }
//
// Server trả về:
//   { "action": "DO_KIEP" | "DOT_PHA" | "CHO", "licensed": true/false }
//
// Client KHÔNG biết ngưỡng độ kiếp, cách nhận biết "sẽ nhận = 0"...
// -> crack lấy được mod cũng không biết logic.

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

// ===== Ngưỡng bí mật (chỉ có trên server) =====
const DOKIEP_MAX_TUVI = 20_000_000;

// Chuyển "1.5K" -> 1500, "2M" -> 2000000
function parseNumber(s) {
  if (s == null) return -1;
  let t = String(s).toUpperCase().replace(/[^0-9.KMB]/g, "");
  if (t === "") return -1;
  let mult = 1;
  if (t.endsWith("K")) { mult = 1e3; t = t.slice(0, -1); }
  else if (t.endsWith("M")) { mult = 1e6; t = t.slice(0, -1); }
  else if (t.endsWith("B")) { mult = 1e9; t = t.slice(0, -1); }
  if (t === "") return -1;
  const v = parseFloat(t);
  if (isNaN(v)) return -1;
  return Math.floor(v * mult);
}

// Đủ điều kiện ĐỘ KIẾP: dòng tu vi có max = ngưỡng
function canDoKiep(lines) {
  for (let raw of lines) {
    const line = raw.replace(/§./g, "").trim();
    if (!line) continue;
    const slash = line.indexOf("/");
    if (slash <= 0) continue;
    const after = line.substring(slash + 1).trim();
    if (/^\d+\s*[sS].*/.test(after)) continue;       // bỏ dòng thời gian
    if (parseNumber(after) === DOKIEP_MAX_TUVI) return true;
  }
  return false;
}

// Đủ điều kiện ĐỘT PHÁ: dòng "sẽ nhận" (dạng +N/2s) có N = 0
function canBreakthrough(lines) {
  for (let raw of lines) {
    const line = raw.replace(/§./g, "").trim();
    if (!line) continue;
    const slash = line.indexOf("/");
    if (slash <= 0) continue;
    const after = line.substring(slash + 1).trim();
    if (!/^\d+\s*[sS].*/.test(after)) continue;      // phần sau '/' phải là thời gian
    const before = line.substring(0, slash);
    const m = before.match(/([+-]?\d[\d.,]*[KMBkmb]?)\s*$/);
    if (!m) continue;
    if (parseNumber(m[1]) === 0) return true;         // ngừng cộng -> đầy
  }
  return false;
}

export default async function handler(req, res) {
  // Chỉ nhận POST
  if (req.method !== "POST") {
    return res.status(405).json({ action: "CHO", licensed: false, reason: "Chỉ nhận POST" });
  }

  const body = req.body || {};
  const key = body.key;
  const lines = Array.isArray(body.lines) ? body.lines : [];
  const autoDoKiep = body.autoDoKiep === true;

  // === Kiểm tra bản quyền trước ===
  if (!key) return res.status(200).json({ action: "CHO", licensed: false, reason: "Thiếu key" });

  let info;
  try {
    info = await redis.get("license:" + key);
  } catch (e) {
    return res.status(200).json({ action: "CHO", licensed: false, reason: "Lỗi DB" });
  }
  if (!info) return res.status(200).json({ action: "CHO", licensed: false, reason: "Key sai" });
  if (typeof info === "string") { try { info = JSON.parse(info); } catch (e) {} }

  const msLeft = new Date(info.expires).getTime() - Date.now();
  if (msLeft <= 0) {
    return res.status(200).json({ action: "CHO", licensed: false, reason: "Hết hạn" });
  }

  // === Có bản quyền -> chạy logic quyết định ===
  let action = "CHO";
  if (autoDoKiep && canDoKiep(lines)) {
    action = "DO_KIEP";        // ưu tiên độ kiếp
  } else if (canBreakthrough(lines)) {
    action = "DOT_PHA";
  }

  return res.status(200).json({ action: action, licensed: true });
}
