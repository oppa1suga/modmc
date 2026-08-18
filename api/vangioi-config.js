// api/vangioi-config.js
// KHÔI PHỤC LẠI (2026-08-18) endpoint config đời đầu cho các bản mod THẬT SỰ cũ
// (VD build 2) - loại client này hardcode URL này, gửi ĐÚNG {"config":"..."},
// KHÔNG có "key" lẫn "build" trong body (đã xác minh qua decompile jar build 2).
// Route "vangioi-config-v2" (bắt buộc key) vẫn là đường chính cho bản mod hiện tại
// - file này CHỈ để không bỏ rơi hẳn các bản cũ, có 2 lớp bảo mật y hệt đợt vá sau
// vụ endpoint mở bị lạm dụng:
//
//   1) Rate limit theo IP - chặn spam tốc độ cao.
//   2) Giới hạn độ dài "config" - chặn nhồi rác làm đầy dung lượng free tier.
//
// KHÔNG khóa theo build (CỐ Ý, giống vangioi-config-v2.js - xem comment ở đó): mod
// bị khóa tính năng do build cũ vẫn phải đồng bộ config lên được, không nên mất
// tài khoản khách chỉ vì build cũ. Khóa build chỉ đáng áp cho Phó Bản/Thủ Thành -
// nơi có logic bí mật thật sự cần giấu.
//
// KHÔNG bắt buộc key (khác vangioi-config-v2.js) vì bản cũ này không hề gửi key -
// đòi hỏi key sẽ chặn luôn 100% request, coi như vẫn đóng cửa như cũ.
//
// Ghi vào ĐÚNG cấu trúc Redis chung với vangioi-config-v2.js (cùng
// ACCOUNTS_HASH/EXTRA_SET/UPDATED_AT_KEY/ACCOUNT_META_HASH) để admin.html
// ("Xem config", "Rà tài khoản nghi dùng mod không qua key") thấy dữ liệu từ cả
// 2 nguồn như nhau, không cần phân biệt.

import { getRedis } from "./_redis.js";
import { isRateLimited } from "./_ratelimit.js";
const redis = getRedis();

const ACCOUNTS_HASH = "vangioi_config:accounts";
const EXTRA_SET = "vangioi_config:extra_lines";
const UPDATED_AT_KEY = "vangioi_config:updatedAt";
const ACCOUNT_META_HASH = "vangioi_config:account_meta";

// Cửa sổ ngắn (10s) thay vì dài (60s) - lý do y hệt vangioi-config-v2.js: Fixed
// Window cho phép dồn hết hạn mức vào giây đầu cửa sổ, cửa sổ dài thì burst tối
// đa trong 1s càng lớn, dễ vượt trần 100 ops/giây Redis Cloud (2026-08-18).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SEC = 10;
const MAX_CONFIG_LENGTH = 20_000;

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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Chỉ nhận POST" });
  }

  const ip = getClientIp(req);
  const body = req.body || {};
  const config = body.config;

  if (await isRateLimited(redis, "config-legacy", ip, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_SEC, {})) {
    return res.status(429).json({ ok: false, error: "Gọi quá nhanh, thử lại sau." });
  }

  // CỐ Ý không khóa theo build (giống vangioi-config-v2.js, xem comment ở đó) -
  // đồng bộ config không nên phụ thuộc build, chỉ Phó Bản/Thủ Thành mới đáng khóa
  // vì đó là chỗ có logic bí mật thật sự (2026-08-18, sửa lại nhận định sai lúc
  // mới tạo file này).

  if (config === undefined || config === null) {
    return res.status(400).json({ ok: false, error: "Thiếu config" });
  }
  if (typeof config === "string" && config.length > MAX_CONFIG_LENGTH) {
    return res.status(413).json({ ok: false, error: "Config quá dài (tối đa " + MAX_CONFIG_LENGTH + " ký tự)" });
  }

  try {
    const { accounts, extraLines } = parseConfigText(config);

    // Chỉ ghi khi THẬT SỰ đổi - cùng lý do/cách làm như vangioi-config-v2.js.
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
      ops.push(redis.hset(ACCOUNTS_HASH, accounts));
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
