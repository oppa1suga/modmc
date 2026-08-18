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
//   ?action=releaseiplock&key=XXX&ns=vangioi  -> gỡ khóa IP cho key (mod vangioi, xóa hẳn)
//   ?action=hardlockip&key=XXX&ns=vangioi     -> khóa CỨNG key vào đúng IP đang dùng hiện tại (mod vangioi)
//   ?action=unhardlockip&key=XXX&ns=vangioi   -> gỡ khóa cứng (không xóa khóa, IP khác lại tranh được như bình thường)
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
            entry.hardLocked = !!lock.hardLocked;
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

    // === GỠ KHÓA IP (chỉ áp dụng cho key vangioi, ?ns=vangioi) - xóa hẳn, ai cũng tranh được ===
    if (action === "releaseiplock") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
      await redis.del("vangioi_iplock:" + key);
      return res.status(200).json({ ok: true, message: "Đã gỡ khóa IP cho key " + key });
    }

    // === KHÓA CỨNG vào đúng IP đang dùng hiện tại (chỉ vangioi) ===
    if (action === "hardlockip") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
      const lockKeyName = "vangioi_iplock:" + key;
      let lock = await redis.get(lockKeyName);
      if (typeof lock === "string") { try { lock = JSON.parse(lock); } catch (e) { lock = null; } }
      if (!lock) return res.status(404).json({ ok: false, error: "Key này hiện không có ai dùng, chưa có IP để khóa" });
      lock.hardLocked = true;
      await redis.set(lockKeyName, JSON.stringify(lock));
      return res.status(200).json({ ok: true, message: "Đã khóa cứng key " + key + " vào IP " + lock.ip });
    }

    // === GỠ KHÓA CỨNG (không xóa khóa, chỉ bỏ cờ - IP khác lại tranh được như bình thường) ===
    if (action === "unhardlockip") {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: "Thiếu key" });
      const lockKeyName = "vangioi_iplock:" + key;
      let lock = await redis.get(lockKeyName);
      if (typeof lock === "string") { try { lock = JSON.parse(lock); } catch (e) { lock = null; } }
      if (!lock) return res.status(404).json({ ok: false, error: "Không có khóa nào cho key này" });
      lock.hardLocked = false;
      await redis.set(lockKeyName, JSON.stringify(lock));
      return res.status(200).json({ ok: true, message: "Đã gỡ khóa cứng cho key " + key });
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
      if (req.query.ns === "vangioi") {
        // Vangioi lưu dạng Redis HASH (đổi từ blob "vangioi_config:main" cũ để
        // tránh mất tài khoản khi nhiều người /login cùng lúc - xem
        // api/vangioi-config.js). PHẢI đọc đúng chỗ này, không thì hiện dữ liệu
        // cũ đóng băng từ trước lúc đổi cấu trúc.
        const [accounts, extraLines, updatedAt, accountMetaRaw] = await Promise.all([
          redis.hgetall("vangioi_config:accounts"),
          redis.smembers("vangioi_config:extra_lines"),
          redis.get("vangioi_config:updatedAt"),
          redis.hgetall("vangioi_config:account_meta")
        ]);
        if (!updatedAt) {
          return res.status(200).json({ ok: true, config: null, updatedAt: null });
        }
        const accLines = Object.entries(accounts || {}).map(([u, p]) => "acc=" + u + ":" + p);
        const config = [...(extraLines || []), ...accLines].join("\n");
        // IP ghi lại lúc mod gửi config lên gần nhất cho từng account (xem
        // api/vangioi-config.js) - endpoint đó không nhận key bản quyền nên không ghi
        // thẳng được key, nhưng admin.html tự đối chiếu IP này với cột "Đang dùng (IP)"
        // bên danh sách key để suy ra key tương ứng.
        const accountMeta = {};
        for (const [user, raw] of Object.entries(accountMetaRaw || {})) {
          try { accountMeta[user] = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { }
        }
        return res.status(200).json({ ok: true, config, updatedAt, accountMeta });
      }

      let record = await redis.get("config:main");
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
      if (req.query.ns === "vangioi") {
        await Promise.all([
          redis.del("vangioi_config:accounts"),
          redis.del("vangioi_config:extra_lines"),
          redis.del("vangioi_config:updatedAt")
        ]);
        return res.status(200).json({ ok: true, message: "Đã xóa config" });
      }
      await redis.del("config:main");
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

    // === RÀ TÀI KHOẢN NGHI NGỜ DÙNG MOD KHÔNG QUA KEY HỢP LỆ (chỉ vangioi) ===
    // AutoLoginMod tự gửi config (username/password) lên /api/vangioi-config MỖI LẦN
    // vào server, KHÔNG cần key hợp lệ (endpoint đó không kiểm tra key) - nên nếu ai
    // đó chạy bản mod bị bẻ khóa (bỏ qua bước gọi/kiểm tra vangioi-check), account của
    // họ vẫn xuất hiện trong "vangioi_config:accounts" như bình thường. Ngược lại,
    // "vangioi_iplock:<key>" chỉ được ghi SAU KHI qua được kiểm tra key thật
    // (vangioi-check.js) và có igName kèm theo. Account nào từng gửi config lên mà
    // CHƯA TỪNG đứng tên bất kỳ khóa IP nào là dấu hiệu khả nghi.
    // LƯU Ý: không phải bằng chứng tuyệt đối - khách mới join lần đầu (chưa kịp có
    // lock), hoặc gõ /login trước khi nhập key hợp lệ, cũng rơi vào diện này.
    if (action === "vangioiaudit") {
      const [accounts, accountMetaRaw, lockKeys] = await Promise.all([
        redis.hgetall("vangioi_config:accounts"),
        redis.hgetall("vangioi_config:account_meta"),
        redis.keys("vangioi_iplock:*")
      ]);

      const knownIgNames = new Set();
      if (lockKeys.length > 0) {
        const locks = await redis.mget(...lockKeys);
        lockKeys.forEach((k, i) => {
          let lock = locks[i];
          if (typeof lock === "string") { try { lock = JSON.parse(lock); } catch (e) { lock = null; } }
          if (lock && lock.igName) knownIgNames.add(lock.igName);
        });
      }

      const suspicious = [];
      for (const user of Object.keys(accounts || {})) {
        if (knownIgNames.has(user)) continue;
        let meta = (accountMetaRaw || {})[user];
        if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
        suspicious.push({ user, ip: meta?.ip || null, at: meta?.at || null });
      }

      return res.status(200).json({
        ok: true,
        suspicious,
        totalAccounts: Object.keys(accounts || {}).length,
        knownIgNameCount: knownIgNames.size
      });
    }

    // === XEM danh sách IGN + IP đã ghi nhận từ bản Chiến Đấu rút gọn (không key) ===
    if (action === "getchiendautrack") {
      const raw = await redis.hgetall("vangioi_chiendau_track:users");
      const users = Object.entries(raw || {}).map(([user, v]) => {
        let meta = v;
        if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
        return { user, ip: meta?.ip || null, at: meta?.at || null };
      });
      users.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
      return res.status(200).json({ ok: true, users });
    }

    return res.status(400).json({ ok: false, error: "action không hợp lệ" });

  } catch (e) {
    return res.status(500).json({ ok: false, error: "Lỗi database: " + e.message });
  }
}
