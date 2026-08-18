// api/vangioi-config-v2.js
// Nhận config của AutoLoginMod (vangioi) và lưu vào database Redis Cloud (chuyển
// từ Upstash Redis ngày 2026-08-18, xem api/_redis.js).
// BẮT BUỘC key bản quyền hợp lệ (đổi từ "không cần key" ngày 2026-08-18 - endpoint
// mở KHÔNG xác thực bị nghi lạm dụng, gọi liên tục ~1.7 req/s suốt ~107 phút, góp
// phần lớn làm tràn quota lệnh Redis).
//
// ĐỔI ĐƯỜNG DẪN từ "vangioi-config" sang "vangioi-config-v2" CÙNG lúc thêm key bắt
// buộc (2026-08-18). Client hiện tại (build 4 trở lên) đã trỏ sang URL này. File
// "vangioi-config" cũ từng bị xóa hẳn (404) nhưng đã KHÔI PHỤC LẠI (2026-08-18,
// xem api/vangioi-config.js) cho các bản THẬT SỰ cũ (VD build 2) không hề biết
// URL "-v2" này - route đó không bắt buộc key nhưng có rate limit + giới hạn
// dung lượng riêng.
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
//   https://server-minerua.vercel.app/api/vangioi-config-v2?key=<KEY bản quyền>
// Trả về: { ok: true, config, updatedAt } - "config" được dựng lại thành đúng
// định dạng nhiều dòng "acc=user:pass" như cũ để không phải đổi gì bên mod.

import { getRedis } from "./_redis.js";
import { isRateLimited } from "./_ratelimit.js";
const redis = getRedis();

const ACCOUNTS_HASH = "vangioi_config:accounts"; // field = username, value = password
const EXTRA_SET = "vangioi_config:extra_lines";  // các dòng khác (không phải acc=...) nếu có
const UPDATED_AT_KEY = "vangioi_config:updatedAt";
// field = username, value = JSON {ip, at} - IP request gửi config lên gần nhất cho
// account đó. admin.html tự đối chiếu IP này với cột "Đang dùng (IP)" bên danh sách
// key (vangioi-check.js cũng ghi IP theo key) để suy ra key tương ứng.
const ACCOUNT_META_HASH = "vangioi_config:account_meta";

// Rate limit + giới hạn dung lượng (thêm 2026-08-18 sau vụ endpoint bị lạm dụng) -
// mỗi lần join chỉ gửi 1 lần nên 20 request/phút/IP đã rất dư dả cho dùng bình
// thường (kể cả vài người chung mạng/router), nhưng đủ thấp để chặn spam.
const RATE_LIMIT_PER_MIN = 20;
const RATE_LIMIT_WINDOW_SEC = 60;
// 20KB - dư sức cho vài chục tài khoản (mỗi dòng "acc=user:pass" chỉ vài chục ký
// tự), chặn được kiểu nhồi rác làm đầy 30MB free tier.
const MAX_CONFIG_LENGTH = 20_000;

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
  const ip = getClientIp(req);

  if (req.method === "GET") {
    if (await isRateLimited(redis, "config-get", ip, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_SEC, { key: req.query.key })) {
      return res.status(429).json({ ok: false, error: "Gọi quá nhanh, thử lại sau." });
    }

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

  if (await isRateLimited(redis, "config-post", ip, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_SEC, { key: body.key })) {
    return res.status(429).json({ ok: false, error: "Gọi quá nhanh, thử lại sau." });
  }

  const lic = await checkLicense(body.key);
  if (!lic) return res.status(403).json({ ok: false, error: "Key không hợp lệ" });

  // CỐ Ý không khóa theo build ở đây - đúng như thiết kế "keyOk" của
  // vangioi-check.js (tách riêng khỏi "valid"): mod bị khóa tính năng do build cũ
  // vẫn phải đồng bộ config lên được, để không mất tài khoản khách chỉ vì chưa
  // kịp cập nhật. Từng thêm nhầm khóa build vào đây lúc vá bảo mật, mâu thuẫn với
  // chính thiết kế đó - bỏ lại (2026-08-18).

  if (config === undefined || config === null) {
    return res.status(400).json({ ok: false, error: "Thiếu config" });
  }

  if (typeof config === "string" && config.length > MAX_CONFIG_LENGTH) {
    return res.status(413).json({ ok: false, error: "Config quá dài (tối đa " + MAX_CONFIG_LENGTH + " ký tự)" });
  }

  try {
    const { accounts, extraLines } = parseConfigText(config);

    // Chỉ ghi khi THẬT SỰ đổi so với dữ liệu đang lưu - mod gọi lại uploadConfig()
    // mỗi 10 phút (mỗi lần checkAsync() thấy keyOk) dù tài khoản chưa đổi gì, ghi
    // lại y hệt mỗi lần là lãng phí ops Redis (2026-08-18). LƯU Ý: ACCOUNTS_HASH
    // gộp tài khoản từ NHIỀU key/người dùng khác nhau - config gửi lên chỉ là 1
    // TẬP CON, nên phải so sánh từng account/dòng riêng với dữ liệu đang lưu, chứ
    // không so nguyên văn 2 chuỗi (chuỗi tổng hợp luôn khác chuỗi của riêng 1 người).
    const [existingAccounts, existingExtraArr] = await Promise.all([
      redis.hgetall(ACCOUNTS_HASH),
      redis.smembers(EXTRA_SET)
    ]);
    const existingExtra = new Set(existingExtraArr || []);

    let changed = false;
    for (const [user, pass] of Object.entries(accounts)) {
      if ((existingAccounts || {})[user] !== pass) { changed = true; break; }
    }
    if (!changed) {
      for (const line of extraLines) {
        if (!existingExtra.has(line)) { changed = true; break; }
      }
    }

    if (!changed) {
      return res.status(200).json({ ok: true, message: "Config không đổi, bỏ qua." });
    }

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
