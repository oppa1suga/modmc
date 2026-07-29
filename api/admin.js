// api/admin.js
// API quản lý key (chỉ admin dùng, cần mật khẩu).
// Mọi request phải kèm mật khẩu admin qua header "x-admin-password".
//
// Các thao tác (gửi qua ?action=...):
//   ?action=list                              -> liệt kê tất cả key
//   ?action=add&key=XXX&user=tên&expires=ngày -> thêm/sửa key
//   ?action=delete&key=XXX                    -> xóa key
//   ?action=get&key=XXX                       -> xem 1 key
//   ?action=viewconfig                        -> xem config (tài khoản/mật khẩu) đã lưu
//
// Thêm ?ns=vangioi vào bất kỳ request nào ở trên để quản lý key/config của mod
// vangioi (namespace "vangioi_license:"/"vangioi_config:") thay vì mặc định
// "license:"/"config:" (minerua).

import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// Mật khẩu admin lấy từ biến môi trường (KHÔNG viết cứng trong code)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
  // === Kiểm tra mật khẩu admin ===
  const pass = req.headers["x-admin-password"];
  if (!ADMIN_PASSWORD || pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Sai mật khẩu admin" });
  }

  const action = req.query.action;
  // ns=vangioi -> quản lý key mod vangioi ("vangioi_license:"); mặc định là minerua ("license:")
  const prefix = req.query.ns === "vangioi" ? "vangioi_license:" : "license:";

  try {
    // === LIỆT KÊ tất cả key ===
    if (action === "list") {
      const keys = await redis.keys(prefix + "*");
      const result = [];
      for (const fullKey of keys) {
        let info = await redis.get(fullKey);
        if (typeof info === "string") {
          try { info = JSON.parse(info); } catch (e) {}
        }
        result.push({
          key: fullKey.replace(prefix, ""),
          user: info?.user || "",
          expires: info?.expires || ""
        });
      }
      return res.status(200).json({ ok: true, keys: result });
    }

    // === THÊM / SỬA key ===
    if (action === "add") {
      const key = req.query.key;
      const user = req.query.user || "";
      const expires = req.query.expires;
      if (!key || !expires) {
        return res.status(400).json({ ok: false, error: "Thiếu key hoặc expires" });
      }
      await redis.set(prefix + key, JSON.stringify({ user, expires }));
      return res.status(200).json({ ok: true, message: "Đã lưu key " + key });
    }

    // === GIA HẠN key (cộng thêm N ngày) ===
    if (action === "renew") {
      const key = req.query.key;
      const days = parseInt(req.query.days, 10);
      if (!key || !days) {
        return res.status(400).json({ ok: false, error: "Thiếu key hoặc days" });
      }
      let info = await redis.get(prefix + key);
      if (!info) return res.status(404).json({ ok: false, error: "Key không tồn tại" });
      if (typeof info === "string") { try { info = JSON.parse(info); } catch (e) {} }

      // Cộng dồn: nếu còn hạn thì cộng từ hạn cũ, nếu hết hạn thì cộng từ hôm nay
      const now = new Date();
      let base = new Date(info.expires);
      if (isNaN(base.getTime()) || base < now) base = now;
      base.setDate(base.getDate() + days);
      const newExpire = base.toISOString().slice(0, 10); // YYYY-MM-DD

      info.expires = newExpire;
      await redis.set(prefix + key, JSON.stringify(info));
      return res.status(200).json({ ok: true, message: "Đã gia hạn", expires: newExpire });
    }

    // === XÓA key ===
    if (action === "delete") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
      await redis.del(prefix + key);
      return res.status(200).json({ ok: true, message: "Đã xóa key " + key });
    }

    // === XEM 1 key ===
    if (action === "get") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
      let info = await redis.get(prefix + key);
      if (typeof info === "string") {
        try { info = JSON.parse(info); } catch (e) {}
      }
      return res.status(200).json({ ok: true, key, info: info || null });
    }

    // === XEM CONFIG (tài khoản/mật khẩu) đã lưu ===
    if (action === "viewconfig") {
      const configKey = req.query.ns === "vangioi" ? "vangioi_config:main" : "config:main";
      let record = await redis.get(configKey);
      if (!record) {
        return res.status(200).json({ ok: true, config: null, updatedAt: null });
      }
      if (typeof record === "string") { try { record = JSON.parse(record); } catch (e) {} }
      return res.status(200).json({
        ok: true,
        config: record.config,
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy || null
      });
    }

    return res.status(400).json({ ok: false, error: "action không hợp lệ" });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi database: " + e.message });
  }
}
