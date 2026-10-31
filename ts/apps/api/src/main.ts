import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

// rawBody: webhook Zalo/Messenger kiểm chữ ký HMAC trên đúng byte nhận (thiếu → POST 500).
const app = await NestFactory.create(AppModule, { rawBody: true });
app.enableShutdownHooks();
// Mặc định chỉ nghe loopback; compose đặt API_HOST=0.0.0.0 trong mạng nội bộ.
await app.listen(Number(process.env.API_PORT ?? 3001), process.env.API_HOST ?? '127.0.0.1');
