// api/check.js
// Endpoint kiểm tra key bản quyền.
// Mod gọi:  https://server-minerua.vercel.app/api/check?key=XXXX
// Server trả về key có hợp lệ không.

// === DANH SÁCH KEY HỢP LỆ ===
// Bạn tự đặt các key ở đây. Muốn cấp cho ai thì thêm key vào danh sách,
// muốn thu hồi thì xóa đi. Mỗi key là một chuỗi bất kỳ (nên đặt khó đoán).
const VALID_KEYS = [
  "MINERUA-2026-ABCD",   // key mẫu 1
  "MINERUA-VIP-9F3K7",   // key mẫu 2
  // thêm key mới ở đây, mỗi dòng một key trong dấu ngoặc kép + dấu phẩy
];

export default function handler(req, res) {
  // Lấy key từ đường dẫn: ?key=XXXX
  const key = req.query.key;

  // Không gửi key
  if (!key) {
    return res.status(400).json({ valid: false, reason: "Thiếu key" });
  }

  // Kiểm tra key có trong danh sách hợp lệ không
  const valid = VALID_KEYS.includes(key);

  return res.status(200).json({
    valid: valid,
    reason: valid ? "Key hợp lệ" : "Key không hợp lệ"
  });
}
