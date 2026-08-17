// api/vangioi-config.js
// Nhận config của AutoLoginMod (vangioi) và lưu vào database (Upstash Redis).
// KHÔNG yêu cầu key bản quyền (tạm thời) - ai gọi được URL cũng gửi/đọc được.
//
// Mod gửi (POST, body JSON):
//   { "config": <nội dung file autologin_accounts.txt> }
//
// LƯU Ý QUAN TRỌNG: mỗi tài khoản là 1 field riêng trong 1 Redis HASH
// ("vangioi_config:accounts"), ghi bằng HSET - đây là thao tác ATOMIC của Redis,
// không cần đọc dữ liệu cũ ra rồi ghi đè lại. Trước đây code đọc-gộp-ghi (get rồi
// set) nên 2 người gửi cùng lúc có thể làm mất tài khoản của nhau (lost update);
// giờ mỗi tài khoản ghi độc lập nên không còn tranh chấp nữa.
//
// Xem lại config đã lưu (GET):
//   https://server-minerua.vercel.app/api/vangioi-config
// Trả về: { ok: true, config, updatedAt } - "config" được dựng lại thành đúng
// định dạng nhiều dòng "acc=user:pass" như cũ để không phải đổi gì bên mod.

import { Redis } from "@upstash/redis";
const redis = Redis.fromEnv();

const ACCOUNTS_HASH = "vangioi_config:accounts"; // field = username, value = password
const EXTRA_SET = "vangioi_config:extra_lines";  // các dòng khác (không phải acc=...) nếu có
const UPDATED_AT_KEY = "vangioi_config:updatedAt";
// field = username, value = JSON {ip, at} - IP request gửi config lên gần nhất cho
// account đó. Endpoint này KHÔNG nhận key bản quyền (mod không gửi kèm) nên không
// thể ghi thẳng "key nào gửi" - nhưng admin.html có thể tự đối chiếu IP này với cột
// "Đang dùng (IP)" bên danh sách key (vangioi-check.js cũng ghi IP theo key) để suy
// ra được key tương ứng, hoàn toàn không cần sửa gì bên mod.
const ACCOUNT_META_HASH = "vangioi_config:account_meta";

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
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
