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
//   ?action=releaseiplock&key=XXX&ns=vangioi  -> gỡ khóa IP cho key (mod vangioi)
//   ?action=kick&key=XXX&ns=vangioi           -> yêu cầu văng acc đang dùng key khỏi server (mod vangioi)
//   ?action=getminbuild                       -> xem số build tối thiểu hiện tại (mod vangioi)
//   ?action=setminbuild&build=N                -> đặt số build tối thiểu (bản < N bị chặn)
//
// Thêm ?ns=vangioi vào bất kỳ request nào ở trên để quản lý key/config của mod
// vangioi (namespace "vangioi_license:"/"vangioi_config:") thay vì mặc định
// "license:"/"config:" (minerua).

import { Redis } from "@upstash/redis";
import { randomBytes } from "crypto";

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
        const keyOnly = fullKey.replace(prefix, "");
        const entry = {
          key: keyOnly,
          user: info?.user || "",
          expires: info?.expires || ""
        };

        // Kèm thông tin khóa IP hiện tại (chỉ có ý nghĩa với key vangioi)
        if (req.query.ns === "vangioi") {
          let lock = await redis.get("vangioi_iplock:" + keyOnly);
          if (typeof lock === "string") { try { lock = JSON.parse(lock); } catch (e) { lock = null; } }
          if (lock) {
            // Mod chỉ gọi check mỗi 10 phút (xem LicenseManager.CHECK_INTERVAL_MS) nên
            // ngưỡng "đang hoạt động" phải DÀI HƠN 10 phút, không thì luôn hiện trống vì
            // "quá hạn" trước khi có lần check tiếp theo. Khớp với LEASE_TIMEOUT_MS bên
            // vangioi-check.js (12 phút) để nhất quán với logic nhả khóa thật sự.
            const active = (Date.now() - (lock.lastSeen || 0)) <= 12 * 60 * 1000;
            entry.lockIp = lock.ip || "";
            entry.lockIgName = lock.igName || "";
            entry.lockActive = active;
          }
        }

        result.push(entry);
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

    // === GỠ KHÓA IP (chỉ áp dụng cho key vangioi, ?ns=vangioi) ===
    if (action === "releaseiplock") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
      await redis.del("vangioi_iplock:" + key);
      return res.status(200).json({ ok: true, message: "Đã gỡ khóa IP cho key " + key });
    }

    // === KICK: yêu cầu acc đang dùng key này bị ngắt kết nối khỏi server (chỉ vangioi) ===
    // Chỉ đặt 1 CỜ trong Redis - mod chỉ nhận ra ở lần gọi /api/vangioi-check TIẾP THEO
    // (chu kỳ 10 phút), nên có thể mất tới ~10 phút mới có hiệu lực, không phải tức thì.
    if (action === "kick") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
      await redis.set("vangioi_kick:" + key, "1");
      return res.status(200).json({ ok: true, message: "Đã yêu cầu kick key " + key + " (có hiệu lực trong tối đa ~10 phút, ở lần check tiếp theo của mod)" });
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

    // === XÓA CONFIG đã lưu (tài khoản/mật khẩu) ===
    if (action === "deleteconfig") {
      const configKey = req.query.ns === "vangioi" ? "vangioi_config:main" : "config:main";
      await redis.del(configKey);
      return res.status(200).json({ ok: true, message: "Đã xóa config" });
    }

    // === XEM key chủ hiện tại (dùng chung cho cả 2 mod) ===
    if (action === "getownerkey") {
      const ownerKey = await redis.get("owner_key");
      return res.status(200).json({ ok: true, ownerKey: ownerKey || null });
    }

    // === TẠO / ĐỔI key chủ ===
    // ?action=setownerkey            -> tự sinh ngẫu nhiên
    // ?action=setownerkey&key=XXXX   -> đặt key tùy chọn
    if (action === "setownerkey") {
      let ownerKey = req.query.key;
      if (!ownerKey) {
        ownerKey = "OWNER-" + randomBytes(16).toString("hex").toUpperCase();
      }
      await redis.set("owner_key", ownerKey);
      return res.status(200).json({ ok: true, ownerKey });
    }

    // === XÓA key chủ ===
    if (action === "deleteownerkey") {
      await redis.del("owner_key");
      return res.status(200).json({ ok: true, message: "Đã xóa key chủ" });
    }

    // === XEM số build tối thiểu (khóa phiên bản mod vangioi) ===
    if (action === "getminbuild") {
      const minBuild = await redis.get("vangioi_min_build");
      return res.status(200).json({ ok: true, minBuild: parseInt(minBuild, 10) || 0 });
    }

    // === ĐẶT số build tối thiểu (bản mod cũ hơn số này sẽ bị chặn) ===
    if (action === "setminbuild") {
      const build = parseInt(req.query.build, 10);
      if (isNaN(build) || build < 0) {
        return res.status(400).json({ ok: false, error: "Thiếu hoặc sai build (số nguyên >= 0)" });
      }
      await redis.set("vangioi_min_build", build);
      return res.status(200).json({ ok: true, minBuild: build });
    }

    return res.status(400).json({ ok: false, error: "action không hợp lệ" });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi database: " + e.message });
  }
}
