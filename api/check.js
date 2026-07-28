// api/check.js
// Đây là endpoint đầu tiên. Khi ai đó mở địa chỉ:
//   https://<app-cua-ban>.vercel.app/api/check
// thì Vercel chạy hàm này và trả về JSON.
//
// "req" = yêu cầu gửi tới (request)
// "res" = phản hồi trả về (response)
export default function handler(req, res) {
  // Trả về một object JSON đơn giản
  res.status(200).json({
    status: "ok",
    message: "Server minerua đang hoạt động!"
  });
}
