// api/vangioi-kickcheck.js
// Endpoint SIÊU NHẸ - CHỈ để kiểm tra cờ "kick" (nút Kick trong admin.html), tách
// riêng khỏi /api/vangioi-check (endpoint đó còn phải đọc owner_key, license,
// iplock, min_build - nặng hơn nhiều). Mỗi lần gọi ở đây chỉ tốn ĐÚNG 1 lệnh GET
// (và thêm 1 lệnh DEL nếu thật sự có kick), nên có thể gọi dồn dập (mỗi 15s) mà
// không tốn quá nhiều ngân sách Redis, phục vụ mục tiêu "kick gần như tức thì"
// thay vì phải chờ tới chu kỳ check bản quyền 10 phút của /api/vangioi-check.
//
// Mod gọi:  https://server-minerua.vercel.app/api/vangioi-kickcheck?key=XXXX
// Trả về:   { kick: true/false }
// Cờ tự xóa ngay khi đọc thấy (chỉ báo 1 LẦN, không lặp lại).

import { getRedis } from "./_redis.js";

const redis = getRedis();

export default async function handler(req, res) {
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ kick: false, error: "Thiếu key" });
  }

  const kickKeyName = "vangioi_kick:" + key;

  try {
    const kickRaw = await redis.get(kickKeyName);
    if (!kickRaw) {
      return res.status(200).json({ kick: false });
    }
    await redis.del(kickKeyName);
    return res.status(200).json({ kick: true });
  } catch (e) {
    return res.status(200).json({ kick: false });
  }
}
