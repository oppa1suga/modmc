// api/vangioi-phoban-brain.js
// Bộ não quyết định của AutoPhoBanSoloMod + AutoPhoBanTeamMod (Leader) - chạy
// TRÊN SERVER (giấu logic khỏi client, chống crack), giống DotPhaBrain bên minerua.
//
// Client gửi trạng thái quan sát được mỗi ~250ms (POST):
//   {
//     "key": "<KEY bản quyền>",
//     "mode": "solo" | "team_leader",
//     "active": true/false,          // false -> server dọn session, không làm gì thêm
//     "guiOpen": true/false,         // màn hình hiện tại có phải GUI "Are you sure?" không
//     "screenOpen": true/false,      // có bất kỳ màn hình nào đang mở không
//     "pos": {"x":.., "y":.., "z":..},
//     "dim": "minecraft:overworld"   // id dimension hiện tại
//   }
//
// "Kẹt lâu tự /warp spawn" (tuSat) CỐ Ý để lại client-side (không gọi lên đây) -
// chỉ là cơ chế tự cứu đơn giản dựa trên thời gian, không có gì đáng giấu, giữ ở
// client cho đỡ tốn thêm request lên server (2026-08-18).
//
// Server trả về hành động cần làm (client chỉ thực thi, không biết vì sao):
//   { "action": "NONE"|"SEND_COMMAND"|"CLICK_CONFIRM"|"ESC_CLOSE",
//     "command": "...", "clickSlot": 4, "msg": "..." }
//
// Tên lệnh phó bản, ngưỡng thời gian, máy trạng thái... đều nằm ở đây,
// KHÔNG có trong client -> crack lấy được mod cũng không biết logic thật.

import { getRedis } from "./_redis.js";
import { isRateLimited } from "./_ratelimit.js";
const redis = getRedis();

function getClientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

// Client gọi mỗi ~150ms/người khi đang bật (tăng tốc 2026-08-18 để tranh slot phó
// bản - xem LICENSE_CACHE_MS bù lại số lệnh Redis) - 1 người dùng bình thường ra
// ~400 request/phút. Đặt ngưỡng cao (đủ chỗ cho ~6 người CHUNG 1 IP/router cùng
// bật) để không chặn nhầm người dùng thật, chỉ chặn khi có gì đó gọi nhanh bất
// thường (VD lỗi lặp vô hạn, hoặc spam cố ý).
const RATE_LIMIT_PER_MIN = 2500;
const RATE_LIMIT_WINDOW_SEC = 60;

// Cache kết quả kiểm tra bản quyền - bản quyền HIẾM KHI đổi giữa 2 lần poll liên
// tiếp (150ms), check lại (2 lệnh GET: owner_key + license) mỗi lần là lãng phí
// ngân sách ops/giây của Redis Cloud (100 ops/s) một cách không cần thiết. Chỉ
// check lại sau mỗi 30s - đủ nhanh để phát hiện key hết hạn/bị xóa mà không tốn
// quá nhiều lệnh, giải phóng ngân sách để tăng tốc polling (2026-08-18).
const LICENSE_CACHE_MS = 30000;

// Polling THÍCH ỨNG theo giai đoạn (2026-08-18) - server tự báo client "bao lâu
// nữa gọi lại" qua field "nextPollMs" trong response, KHÔNG cần client biết tên
// giai đoạn nào (không lộ gì thêm). Nhanh (FAST) đúng lúc cần phản ứng gấp (đang
// tranh slot IDLE có lệnh sẵn sàng, đang chờ GUI xác nhận/đóng, vừa xong 1 lượt) -
// chậm (SLOW) lúc chỉ đang chờ dài hạn không cần gấp (đang trong hầm chờ đánh
// xong, hoặc IDLE mà cả 3 lệnh còn cooldown lâu).
const FAST_POLL_MS = 200;
const SLOW_POLL_MS = 2000;

// ===== Bí mật (chỉ có trên server) =====
const COMMANDS = [
  "ada join ɴɢụᴄᴛʜầɴ",
  "ada join ɴɢụᴄᴛʜầɴ_2",
  "ada join ɴɢụᴄᴛʜầɴ_3"
];
const CONFIRM_SLOT = 4;

const AFTER_DONE_DELAY_MS = 1000;
const POS_GRACE_MS = 1000;
const POS_ENTER_THRESHOLD = 10.0;
const POS_RETURN_THRESHOLD = 5.0;
const ENTER_TIMEOUT_MS = 10000;
const WAIT_GUI_TIMEOUT_MS = 2000;
const GUI_CLOSE_TIMEOUT_MS = 2000;
const SECOND_GUI_GRACE_MS = 500; // chỉ dùng cho mode team_leader (ESC GUI 2)
const CLICK_DELAY_MS = 500;
const REJECT_CD_MS = 10000;
const NOGUI_CD_MS = 30000;

const SESSION_TTL_SEC = 3600;

function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

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

  const ip = getClientIp(req);
  if (await isRateLimited(redis, "phoban", ip, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_SEC, { key })) {
    return res.status(429).json({ action: "NONE", msg: "Gọi quá nhanh, thử lại sau." });
  }
  const mode = body.mode === "team_leader" ? "team_leader"
             : body.mode === "team_mem" ? "team_mem"
             : "solo";
  const sessionKey = "vangioi_phoban_session:" + key + ":" + mode;

  if (!key) return res.status(400).json({ action: "NONE" });

  // Tắt -> dọn session luôn, không cần kiểm tra bản quyền
  if (body.active === false) {
    await redis.del(sessionKey).catch(() => {});
    return res.status(200).json({ action: "NONE" });
  }

  let s;
  try {
    s = await redis.get(sessionKey);
  } catch (e) {
    return res.status(200).json({ action: "NONE" });
  }
  if (typeof s === "string") { try { s = JSON.parse(s); } catch (e) { s = null; } }

  const now = Date.now();

  if (!s || !s.licenseOkUntil || now > s.licenseOkUntil) {
    const lic = await checkLicense(key);
    if (!lic.ok) return res.status(200).json({ action: "NONE", msg: lic.error });
    if (s) s.licenseOkUntil = now + LICENSE_CACHE_MS; // session cũ còn sống - chỉ cần refresh mốc cache
  }

  if (!s) {
    s = {
      phase: "IDLE",
      runningCmd: -1,
      readyAt: [0, 0, 0],
      nextIndex: 0,
      homePos: null,
      homeDim: null,
      dungeonDim: null,
      phaseStart: now,
      guiSeenAt: null,
      posGraceStart: now,
      escMsgSent: false,
      licenseOkUntil: now + LICENSE_CACHE_MS
    };
  }

  const pos = body.pos && typeof body.pos.x === "number"
      ? body.pos : { x: 0, y: 0, z: 0 };
  const dim = typeof body.dim === "string" ? body.dim : "";
  const guiOpen = !!body.guiOpen;
  const screenOpen = !!body.screenOpen;

  // === team_mem: chờ GUI mời vào đội -> bấm xác nhận -> nếu server nhảy
  // thêm GUI 2 SAU KHI đã đổi dimension (đã thực sự bị kéo vào phó bản theo
  // leader) thì ESC đóng nó. Giống hệt cơ chế của team_leader.
  if (mode === "team_mem") {
    let action = "NONE", msg = null, clickSlot = null;
    if (!s.memPhase) s.memPhase = "WATCHING";

    if (s.memPhase === "WATCHING") {
      if (!guiOpen) {
        s.memGuiSeenAt = null;
      } else {
        if (!s.memGuiSeenAt) s.memGuiSeenAt = now;
        if (now - s.memGuiSeenAt >= CLICK_DELAY_MS) {
          action = "CLICK_CONFIRM";
          clickSlot = CONFIRM_SLOT;
          msg = "Đã xác nhận vào đội.";
          s.memHomeDim = dim; // dimension lúc bấm, để phát hiện GUI 2 sau khi bị kéo vào phó bản
          s.memPhaseStart = now;
          s.memEscMsgSent = false;
          s.memPhase = "WAIT_GUI_CLOSE";
        }
      }
    } else if (s.memPhase === "WAIT_GUI_CLOSE") {
      if (!screenOpen) {
        s.memPhase = "WATCHING";
        s.memGuiSeenAt = null;
      } else {
        const dimChanged = s.memHomeDim && dim && dim !== s.memHomeDim;
        const elapsed = now - s.memPhaseStart;
        // Chỉ ESC khi ĐÃ đổi dimension (đã bị kéo vào phó bản) - tránh lỡ
        // tay đóng GUI hợp lệ khác trong lúc còn ở sảnh.
        if (dimChanged && elapsed >= SECOND_GUI_GRACE_MS) {
          action = "ESC_CLOSE";
          if (!s.memEscMsgSent) { msg = "Có thêm GUI 2, đang ESC đóng..."; s.memEscMsgSent = true; }
        }
        if (elapsed > GUI_CLOSE_TIMEOUT_MS) {
          // Bỏ cuộc, quay về theo dõi lời mời kế tiếp
          s.memPhase = "WATCHING";
          s.memGuiSeenAt = null;
        }
      }
    }

    await redis.set(sessionKey, JSON.stringify(s), "EX", SESSION_TTL_SEC).catch(() => {});
    // team_mem hiện KHÔNG có client nào gọi (mem mode để local) - vẫn trả nextPollMs
    // cho đồng bộ hình dạng response, phòng sau này có ai dùng lại tới.
    return res.status(200).json({ action, command: null, clickSlot, msg, nextPollMs: FAST_POLL_MS });
  }

  function isFarFromHome(threshold) {
    if (!s.homePos) return true;
    if (s.homeDim && dim && dim !== s.homeDim) return true;
    return dist(pos, s.homePos) >= threshold;
  }

  let action = "NONE", command = null, msg = null, clickSlot = null;

  switch (s.phase) {
    case "IDLE": {
      let pick = -1;
      for (let k = 0; k < COMMANDS.length; k++) {
        const i = (s.nextIndex + k) % COMMANDS.length;
        if (s.readyAt[i] <= now) { pick = i; break; }
      }
      if (pick >= 0) {
        s.homePos = pos;
        s.homeDim = dim;
        s.nextIndex = (pick + 1) % COMMANDS.length;
        s.runningCmd = pick;
        s.phase = "WAIT_CONFIRM_GUI";
        s.phaseStart = now;
        s.guiSeenAt = null;
        action = "SEND_COMMAND";
        command = COMMANDS[pick];
        msg = "Vào phó bản " + (pick + 1) + "...";
      }
      break;
    }

    case "WAIT_CONFIRM_GUI": {
      if (guiOpen) {
        if (!s.guiSeenAt) s.guiSeenAt = now;
        if (now - s.guiSeenAt >= CLICK_DELAY_MS) {
          action = "CLICK_CONFIRM";
          clickSlot = CONFIRM_SLOT;
          msg = "Đã xác nhận vào phó bản " + (s.runningCmd + 1) + ".";
          s.phase = "WAIT_GUI_CLOSE";
          s.phaseStart = now;
          s.escMsgSent = false;
        }
      } else {
        s.guiSeenAt = null;
        if (now - s.phaseStart > WAIT_GUI_TIMEOUT_MS) {
          if (s.runningCmd >= 0) s.readyAt[s.runningCmd] = now + NOGUI_CD_MS;
          msg = "Không thấy GUI xác nhận, chuyển lệnh kế.";
          s.runningCmd = -1;
          s.phase = "WAIT_AFTER_DONE";
          s.phaseStart = now;
        }
      }
      break;
    }

    case "WAIT_GUI_CLOSE": {
      if (!screenOpen) {
        s.phase = "WAIT_ENTER";
        s.phaseStart = now;
        s.posGraceStart = now;
        break;
      }
      const dimChanged = s.homeDim && dim && dim !== s.homeDim;
      const elapsed = now - s.phaseStart;
      // Chỉ ESC khi ĐÃ sang dimension khác (đã thực sự vào phó bản) -
      // tránh lỡ tay đóng GUI hợp lệ khác trong lúc còn ở sảnh.
      if (mode === "team_leader" && dimChanged && elapsed >= SECOND_GUI_GRACE_MS) {
        action = "ESC_CLOSE";
        if (!s.escMsgSent) { msg = "Có thêm GUI 2, đang ESC đóng..."; s.escMsgSent = true; }
      }
      if (elapsed > GUI_CLOSE_TIMEOUT_MS) {
        if (s.runningCmd >= 0) s.readyAt[s.runningCmd] = now + REJECT_CD_MS;
        msg = "GUI không đóng sau 5s (có thể bị từ chối), thử lệnh khác.";
        s.runningCmd = -1;
        s.phase = "WAIT_AFTER_DONE";
        s.phaseStart = now;
      }
      break;
    }

    case "WAIT_ENTER": {
      if (now - s.posGraceStart < POS_GRACE_MS) break;
      const dimChanged = s.homeDim && dim && dim !== s.homeDim;
      if (dimChanged || isFarFromHome(POS_ENTER_THRESHOLD)) {
        s.dungeonDim = dim;
        msg = "Đã vào phó bản " + (s.runningCmd + 1) + ", đang chờ hoàn thành...";
        s.phase = "WAIT_RETURN";
        s.phaseStart = now;
        break;
      }
      if (now - s.phaseStart > ENTER_TIMEOUT_MS) {
        if (s.runningCmd >= 0) s.readyAt[s.runningCmd] = now + REJECT_CD_MS;
        msg = "Không đổi dimension, chưa vào được, thử lệnh khác.";
        s.runningCmd = -1;
        s.phase = "WAIT_AFTER_DONE";
        s.phaseStart = now;
      }
      break;
    }

    case "WAIT_RETURN": {
      const leftDungeonDim = s.dungeonDim && dim && dim !== s.dungeonDim;
      const backNearHome = !isFarFromHome(POS_RETURN_THRESHOLD);
      if (leftDungeonDim || backNearHome) {
        s.homePos = null;
        s.homeDim = null;
        s.dungeonDim = null;
        msg = "Hoàn thành phó bản " + (s.runningCmd + 1) + ", chuyển lệnh kế...";
        s.runningCmd = -1;
        s.phase = "WAIT_AFTER_DONE";
        s.phaseStart = now;
      }
      break;
    }

    case "WAIT_AFTER_DONE": {
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
  // chuyển ngay trong lượt này, VD IDLE -> WAIT_CONFIRM_GUI) - không lộ tên giai
  // đoạn ra client, chỉ lộ đúng 1 con số mili-giây.
  let nextPollMs;
  switch (s.phase) {
    case "IDLE": {
      // Không có lệnh nào sẵn sàng ngay (nếu có thì switch phía trên đã bốc và
      // chuyển phase rồi) - đợi tới đúng lúc lệnh gần nhất hết cooldown, không sớm
      // hơn (phí request) mà cũng không trễ hơn SLOW_POLL_MS (lỡ mất mốc bốc lệnh).
      const nearestGapMs = Math.min(...s.readyAt.map((r) => r - now));
      nextPollMs = Math.max(FAST_POLL_MS, Math.min(SLOW_POLL_MS, nearestGapMs));
      break;
    }
    // Đang chờ phản ứng gấp (GUI xác nhận xuất hiện/đóng, vừa xong 1 lượt) - cần
    // phản hồi nhanh để tranh thời điểm.
    case "WAIT_CONFIRM_GUI":
    case "WAIT_GUI_CLOSE":
    case "WAIT_AFTER_DONE":
      nextPollMs = FAST_POLL_MS;
      break;
    // Đang chờ dài hạn (đợi đổi dimension vào hầm, hoặc đang trong hầm chờ đánh
    // xong) - không cần gấp, poll thưa lại để đỡ tốn ops/giây.
    case "WAIT_ENTER":
    case "WAIT_RETURN":
      nextPollMs = SLOW_POLL_MS;
      break;
    default:
      nextPollMs = SLOW_POLL_MS;
  }

  return res.status(200).json({ action, command, clickSlot, msg, nextPollMs });
}
