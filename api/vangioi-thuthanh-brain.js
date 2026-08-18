// api/vangioi-thuthanh-brain.js
// Bộ não quyết định của AutoThuThanhMod - chạy TRÊN SERVER (giấu logic khỏi
// client, chống crack), giống hệt kiến trúc vangioi-phoban-brain.js (dù bên đó
// hiện KHÔNG được client thật sự gọi tới - AutoPhoBanSoloMod chạy local hoàn
// toàn). Thủ Thành nối THẬT vào endpoint này, không chỉ có cho có.
//
// Client gửi trạng thái quan sát được mỗi ~250ms (POST):
//   {
//     "key": "<KEY bản quyền>",
//     "active": true/false,       // false -> server dọn session, không làm gì thêm
//     "screenOpen": true/false,   // có bất kỳ màn hình nào đang mở không (kể cả GUI thường)
//     "guiOpen": true/false,      // màn hình đang mở có phải HandledScreen (rương/GUI container) không
//     "dim": "minecraft:overworld", // id dimension hiện tại
//     "roundEnded": true/false    // client tự dò được chat "TỔNG KẾT ĐIỂM" (không bí mật, ai
//                                  // cũng đọc được trong chat, không cần giấu)
//   }
// Cố ý KHÔNG bắt client tự kiểm tra ô emerald có item hay chưa (client sẽ phải biết
// SỐ Ô để làm vậy, lộ luôn bí mật) - chỉ dựa vào guiOpen + độ trễ cố định
// (CLICK_DELAY_MS) để chờ GUI đồng bộ xong, giống cách team_mem của Phó Bản làm.
//
// Server trả về hành động cần làm (client chỉ thực thi, không biết vì sao):
//   { "action": "NONE"|"SEND_COMMAND"|"CLICK_CONFIRM"|"ESC_CLOSE", "command": "...",
//     "clickSlot": 31, "msg": "..." }
//
// Số ô cần bấm (EMERALD_SLOT), các ngưỡng thời gian... đều nằm ở đây, KHÔNG có
// trong client - crack lấy được mod cũng không biết logic thật.

import { getRedis } from "./_redis.js";
import { isRateLimited } from "./_ratelimit.js";
const redis = getRedis();

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Polling THÍCH ỨNG (2026-08-18, cùng cơ chế với vangioi-phoban-brain.js) - server
// tự báo client "bao lâu nữa gọi lại" qua field "nextPollMs" trong response, KHÔNG
// lộ tên giai đoạn. Nhanh lúc cần phản ứng (gửi lệnh, chờ GUI, vừa xong 1 lượt) -
// chậm hơn lúc chờ đổi dimension vào ải (cửa sổ có hạn ENTER_TIMEOUT_MS, cần đủ
// nhặt để không lỡ mốc) - chậm nhất lúc đang Ở TRONG ải chờ đánh xong (không biết
// trước bao lâu, hỏi dồn dập mỗi 250ms vô ích, tốn ops/giây Redis Cloud).
const FAST_POLL_MS = 250;        // giữ nguyên nhịp hiện tại cho giai đoạn cần phản ứng
const SLOW_POLL_MS = 2000;       // WAIT_ENTER
const LONG_WAIT_POLL_MS = 60000; // WAIT_RETURN (đang trong ải) - ~1 phút, theo yêu cầu 2026-08-18

// ===== Bí mật (chỉ có trên server) =====
const EMERALD_SLOT = 31; // ô khối emerald trong GUI "Sảnh Thủ Thành"

const IDLE_GUI_CLOSE_DELAY_MS = 3000;  // có GUI chặn lúc IDLE -> đợi rồi tự ESC
const GUI_APPEAR_TIMEOUT_MS = 5000;    // gửi /thuthanh rồi mà không thấy GUI -> thử lại
const CLICK_DELAY_MS = 500;            // GUI vừa mở -> đợi thêm chút mới bấm (chờ đồng bộ ô, không tự soi nội dung ô)
const ENTER_TIMEOUT_MS = 15000;        // bấm rồi mà không đổi dimension (vào ải) -> thử lại
const AFTER_DONE_DELAY_MS = 2000;      // nghỉ giữa 2 lượt

const SESSION_TTL_SEC = 3600;

const RATE_LIMIT_PER_MIN = 1500; // cùng ngưỡng phoban-brain (~250ms/lần = ~240/phút/người)
const RATE_LIMIT_WINDOW_SEC = 60;

async function checkLicense(key) {
  if (!key) return { ok: false, error: "Thiếu key" };
  const ownerKey = await redis.get("owner_key").catch(() => null);
  if (ownerKey && key === ownerKey) return { ok: true };

  let info;
  try {
    info = await redis.get("vangioi_license:" + key);
  } catch (e) {
    return { ok: false, error: "Lỗi database" };
  }
  if (!info) return { ok: false, error: "Key không hợp lệ" };
  if (typeof info === "string") { try { info = JSON.parse(info); } catch (e) {} }
  if (new Date(info.expires).getTime() <= Date.now()) {
    return { ok: false, error: "Key đã hết hạn" };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ action: "NONE" });
  }

  const body = req.body || {};
  const key = body.key;
  const sessionKey = "vangioi_thuthanh_session:" + key;

  const ip = getClientIp(req);
  if (await isRateLimited(redis, "thuthanh", ip, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_SEC, { key })) {
    return res.status(429).json({ action: "NONE", msg: "Gọi quá nhanh, thử lại sau." });
  }

  if (!key) return res.status(400).json({ action: "NONE" });

  // Tắt -> dọn session luôn, không cần kiểm tra bản quyền
  if (body.active === false) {
    await redis.del(sessionKey).catch(() => {});
    return res.status(200).json({ action: "NONE" });
  }

  const lic = await checkLicense(key);
  if (!lic.ok) return res.status(200).json({ action: "NONE", msg: lic.error });

  let s;
  try {
    s = await redis.get(sessionKey);
  } catch (e) {
    return res.status(200).json({ action: "NONE" });
  }
  if (typeof s === "string") { try { s = JSON.parse(s); } catch (e) { s = null; } }

  const now = Date.now();
  if (!s) {
    s = {
      phase: "IDLE",
      phaseStart: now,
      idleGuiSeenAt: null,
      guiReadySeenAt: null,
      homeDim: null,
      stageDim: null
    };
  }

  const dim = typeof body.dim === "string" ? body.dim : "";
  const screenOpen = !!body.screenOpen;
  const guiOpen = !!body.guiOpen;
  const roundEnded = !!body.roundEnded;

  let action = "NONE", command = null, clickSlot = null, msg = null;

  switch (s.phase) {
    case "IDLE": {
      if (screenOpen) {
        // GUI còn sót lại (VD bảng phần thưởng lượt trước) chặn vòng lặp -> đợi
        // rồi tự ESC để dọn, không đứng im mãi.
        if (!s.idleGuiSeenAt) s.idleGuiSeenAt = now;
        if (now - s.idleGuiSeenAt >= IDLE_GUI_CLOSE_DELAY_MS) {
          action = "ESC_CLOSE";
        }
      } else {
        s.idleGuiSeenAt = null;
        s.homeDim = dim;
        s.stageDim = null;
        action = "SEND_COMMAND";
        command = "thuthanh";
        msg = "Gửi /thuthanh...";
        s.phase = "WAIT_GUI";
        s.phaseStart = now;
        s.guiReadySeenAt = null;
      }
      break;
    }

    case "WAIT_GUI": {
      if (guiOpen) {
        if (!s.guiReadySeenAt) s.guiReadySeenAt = now;
        if (now - s.guiReadySeenAt >= CLICK_DELAY_MS) {
          action = "CLICK_CONFIRM";
          clickSlot = EMERALD_SLOT;
          msg = "Đã bấm vào ải...";
          s.phase = "WAIT_ENTER";
          s.phaseStart = now;
        }
      } else {
        s.guiReadySeenAt = null;
        if (now - s.phaseStart > GUI_APPEAR_TIMEOUT_MS) {
          msg = "Không thấy GUI, thử lại.";
          s.phase = "IDLE";
          s.phaseStart = now;
        }
      }
      break;
    }

    case "WAIT_ENTER": {
      const dimChanged = s.homeDim && dim && dim !== s.homeDim;
      if (dimChanged) {
        s.stageDim = dim;
        msg = "Đã vào ải, chờ đánh xong...";
        s.phase = "WAIT_RETURN";
        s.phaseStart = now;
      } else if (now - s.phaseStart > ENTER_TIMEOUT_MS) {
        msg = "Không vào được ải, thử lại.";
        s.phase = "IDLE";
        s.phaseStart = now;
      }
      break;
    }

    case "WAIT_RETURN": {
      const leftStageDim = s.stageDim && dim && dim !== s.stageDim;
      if (roundEnded || leftStageDim) {
        msg = roundEnded ? "Kết thúc lượt." : "Đã rời ải.";
        s.homeDim = null;
        s.stageDim = null;
        s.phase = "AFTER_DONE";
        s.phaseStart = now;
      }
      break;
    }

    case "AFTER_DONE": {
      if (now - s.phaseStart >= AFTER_DONE_DELAY_MS) {
        s.phase = "IDLE";
        s.phaseStart = now;
      }
      break;
    }

    default:
      s.phase = "IDLE";
      s.phaseStart = now;
  }

  await redis.set(sessionKey, JSON.stringify(s), "EX", SESSION_TTL_SEC).catch(() => {});

  // Tính "bao lâu nữa gọi lại" dựa trên GIAI ĐOẠN SAU CÙNG (s.phase có thể vừa
  // chuyển ngay trong lượt này) - không lộ tên giai đoạn, chỉ lộ 1 con số mili-giây.
  let nextPollMs;
  switch (s.phase) {
    case "WAIT_ENTER":
      nextPollMs = SLOW_POLL_MS;
      break;
    case "WAIT_RETURN":
      nextPollMs = LONG_WAIT_POLL_MS;
      break;
    case "IDLE":
    case "WAIT_GUI":
    case "AFTER_DONE":
    default:
      nextPollMs = FAST_POLL_MS;
  }

  return res.status(200).json({ action, command, clickSlot, msg, nextPollMs });
}
