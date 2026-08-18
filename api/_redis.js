// api/_redis.js
// Client Redis dùng chung cho mọi endpoint - đổi từ @upstash/redis (REST, tính phí
// theo TỔNG số lệnh/tháng) sang ioredis (giao thức TCP chuẩn, Redis Cloud free tier
// chỉ giới hạn theo TỐC ĐỘ 100 ops/giây, không giới hạn tổng số lệnh) sau khi
// Upstash bị tràn quota 500K lệnh/tháng (2026-08-18).
//
// Tên file bắt đầu bằng "_" để Vercel KHÔNG coi đây là 1 route/endpoint - chỉ dùng
// để import dùng chung.
//
// Cần biến môi trường REDIS_URL (dạng "redis://default:<password>@<host>:<port>")
// trên Vercel - lấy từ trang "Connect" của database trên Redis Cloud.
//
// Giữ 1 instance DUY NHẤT ở module scope (không tạo mới mỗi lần handler chạy) để
// tái dùng kết nối giữa các lần gọi trên cùng 1 serverless instance còn "ấm" -
// tránh mở quá nhiều kết nối TCP (free tier Redis Cloud giới hạn 30 connections).

import IORedis from "ioredis";

let client;

export function getRedis() {
  if (!client) {
    client = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: false,
    });
    client.on("error", (e) => {
      console.error("[redis] connection error:", e.message);
    });
  }
  return client;
}
