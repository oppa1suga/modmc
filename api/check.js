// api/check.js
// Kiểm tra key bản quyền CÓ THỜI HẠN (cho thuê mod).
// Mod gọi:  https://server-minerua.vercel.app/api/check?key=XXXX
// Server trả về: key còn hạn không + còn bao nhiêu thời gian.

// === DANH SÁCH KEY ===
// Mỗi key gắn với 1 ngày hết hạn (định dạng "YYYY-MM-DD" hoặc "YYYY-MM-DDTHH:mm").
// GIA HẠN: chỉ cần sửa ngày expires của key đó rồi commit.
// CẤP KEY MỚI: thêm 1 dòng mới.
// THU HỒI: xóa dòng đó đi (hoặc đặt ngày quá khứ).
const KEYS = {
  "MINERUA-2026-ABCD": { user: "test1",  expires: "2026-07-27" },
  "MINERUA-VIP-9F3K7": { user: "test2",  expires: "2026-08-15" },
  // "KEY-CUA-KHACH":    { user: "tên",   expires: "2026-09-01" },
};

export default function handler(req, res) {
  const key = req.query.key;

  if (!key) {
    return res.status(400).json({ valid: false, reason: "Thiếu key" });
  }

  const info = KEYS[key];
  if (!info) {
    return res.status(200).json({ valid: false, reason: "Key không tồn tại" });
  }

  // Tính thời gian còn lại
  const now = new Date();
  const expireDate = new Date(info.expires);
  const msLeft = expireDate.getTime() - now.getTime();

  if (msLeft <= 0) {
    return res.status(200).json({
      valid: false,
      reason: "Key đã hết hạn",
      user: info.user,
      expires: info.expires,
      secondsLeft: 0
    });
  }

  // Còn hạn -> trả về thời gian còn lại
  const secondsLeft = Math.floor(msLeft / 1000);
  const daysLeft = Math.floor(secondsLeft / 86400);
  const hoursLeft = Math.floor((secondsLeft % 86400) / 3600);

  return res.status(200).json({
    valid: true,
    reason: "Key còn hạn",
    user: info.user,
    expires: info.expires,
    secondsLeft: secondsLeft,
    daysLeft: daysLeft,
    hoursLeft: hoursLeft
  });
}
