// api/vangioi-config.js
// Nhận config của AutoLoginMod (vangioi) và lưu vào database (Upstash Redis).
// BẮT BUỘC key bản quyền hợp lệ (đổi từ "không cần key" ngày 2026-08-18 - endpoint
// mở KHÔNG xác thực bị nghi lạm dụng, gọi liên tục ~1.7 req/s suốt ~107 phút, góp
// phần lớn làm tràn quota lệnh Redis).
//
// Mod gửi (POST, body JSON):
//   { "key": "<KEY bản quyền>", "config": <nội dung file autologin_accounts.txt> }
//
// LƯU Ý QUAN TRỌNG: mỗi tài khoản là 1 field riêng trong 1 Redis HASH
// ("vangioi_config:accounts"), ghi bằng HSET - đây là thao tác ATOMIC của Redis,
// không cần đọc dữ liệu cũ ra rồi ghi đè lại. Trước đây code đọc-gộp-ghi (get rồi
// set) nên 2 người gửi cùng lúc có thể làm mất tài khoản của nhau (lost update);
// giờ mỗi tài khoản ghi độc lập nên không còn tranh chấp nữa.
//
// Xem lại config đã lưu (GET):
//   https://server-minerua.vercel.app/api/vangioi-config?key=<KEY bản quyền>
// Trả về: { ok: true, config, updatedAt } - "config" được dựng lại thành đúng
// định dạng nhiều dòng "acc=user:pass" như cũ để không phải đổi gì bên mod.

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

const ACCOUNTS_HASH = "vangioi_config:accounts"; // field = username, value = password
const EXTRA_SET = "vangioi_config:extra_lines";  // các dòng khác (không phải acc=...) nếu có
const UPDATED_AT_KEY = "vangioi_config:updatedAt";
// field = username, value = JSON {ip, at} - IP request gửi config lên gần nhất cho
// account đó. admin.html tự đối chiếu IP này với cột "Đang dùng (IP)" bên danh sách
// key (vangioi-check.js cũng ghi IP theo key) để suy ra key tương ứng.
const ACCOUNT_META_HASH = "vangioi_config:account_meta";

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

async function checkLicense(key) {
  if (!key) return false;

  const ownerKey = await redis.get("owner_key").catch(() => null);
  if (ownerKey && key === ownerKey) return true;

  let info;
  try {
    info = await redis.get("vangioi_license:" + key);
  } catch (e) {
    return false;
  }
  if (!info) return false;
  if (typeof info === "string") { try { info = JSON.parse(info); } catch (e) { return false; } }
  return new Date(info.expires).getTime() > Date.now();
}

// Tách text nhiều dòng "acc=user:pass" thành { accounts: {user:pass}, extraLines: [] }
function parseConfigText(text) {
  const accounts = {};
  const extraLines = [];
  if (!text) return { accounts, extraLines };

  for (const raw of String(text).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("acc=")) {
      const v = line.substring(4);
      const c = v.indexOf(":");
      if (c > 0) {
        const user = v.substring(0, c).trim();
        const pass = v.substring(c + 1).trim();
        if (user && pass) { accounts[user] = pass; continue; }
      }
    }
    extraLines.push(line);
  }
  return { accounts, extraLines };
}

async function buildConfigText() {
  const [accounts, extraLines] = await Promise.all([
    redis.hgetall(ACCOUNTS_HASH),
    redis.smembers(EXTRA_SET)
  ]);
  const accLines = Object.entries(accounts || {}).map(([u, p]) => "acc=" + u + ":" + p);
  return [...(extraLines || []), ...accLines].join("\n");
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const lic = await checkLicense(req.query.key);
    if (!lic) return res.status(403).json({ ok: false, error: "Key không hợp lệ" });

    let updatedAt;
    try {
      updatedAt = await redis.get(UPDATED_AT_KEY);
    } catch (e) {
      return res.status(500).json({ ok: false, error: "Lỗi database" });
    }
    if (!updatedAt) {
      return res.status(404).json({ ok: false, error: "Chưa có config nào được lưu" });
    }

    const config = await buildConfigText();
    return res.status(200).json({ ok: true, config, updatedAt });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Chỉ nhận GET hoặc POST" });
  }

  const body = req.body || {};
  const config = body.config;

  const lic = await checkLicense(body.key);
  if (!lic) return res.status(403).json({ ok: false, error: "Key không hợp lệ" });

  if (config === undefined || config === null) {
    return res.status(400).json({ ok: false, error: "Thiếu config" });
  }

  try {
    const { accounts, extraLines } = parseConfigText(config);

    const ip = getClientIp(req);
    const at = new Date().toISOString();

    const ops = [];
    if (Object.keys(accounts).length > 0) {
      ops.push(redis.hset(ACCOUNTS_HASH, accounts)); // ghi atomic, không đụng tài khoản khác
      const meta = {};
      for (const user of Object.keys(accounts)) meta[user] = JSON.stringify({ ip, at });
      ops.push(redis.hset(ACCOUNT_META_HASH, meta));
    }
    for (const line of extraLines) {
      ops.push(redis.sadd(EXTRA_SET, line));
    }
    ops.push(redis.set(UPDATED_AT_KEY, at));

    await Promise.all(ops);
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi khi lưu: " + e.message });
  }

  return res.status(200).json({ ok: true, message: "Đã lưu config" });
}
