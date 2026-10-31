import { Module } from '@nestjs/common';
import { personConnect } from '@samsam/core/security/auth';
import { ApprovalController } from './approval.controller.js';
import { PERSON_CONNECT, PERSON_ENV, PersonSessions } from './person-sessions.js';

// Web tab "Duyệt & Lịch" (REST /approval) + phiên login Postgres riêng của người (`PersonSessions`,
// dùng chung với tab "Nhật ký vườn" — GardenWebModule import module này). Cần PG_POOL (svc_ui) của
// DbModule global. Đăng ký trong AppModule (api), KHÔNG trong CliModule.
@Module({
  controllers: [ApprovalController],
  providers: [
    PersonSessions,
    { provide: PERSON_CONNECT, useValue: personConnect },
    { provide: PERSON_ENV, useValue: process.env },
  ],
  exports: [PersonSessions, PERSON_ENV],
})
export class ApprovalWebModule {}
