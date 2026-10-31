import { Module } from '@nestjs/common';
import { ApprovalWebModule } from '../approval/approval.module.js';
import { PersonSessions } from '../approval/person-sessions.js';
import { ContentCommand, MktCalendarCommand } from './content.command.js';
import { ContentController, WebController } from './content.controller.js';
import { ContentService, PERSON_DB, type PersonDb } from './content.service.js';

// Nhóm content: `pipelines/content.py` (MKT-02 nháp đa kênh + listing sàn sales-03 + 3 nháp
// bài/ngày marketing-01.1) và `pipelines/mkt_calendar.py` (MKT-01 lịch mùa vụ marketing-01.2).

/** Lệnh CLI của nhóm — đăng ký trong CliModule (cli.ts); tự mở kết nối DATABASE_URL, không cần PG_POOL. */
export const CONTENT_COMMANDS = [ContentCommand, MktCalendarCommand];

// Studio dùng PG_POOL (svc_ui) + AI_GATEWAY global của DbModule. WebController: GET /me (tab theo
// vai trò cho thanh điều hướng của web — cổng danh tính dùng chung ở web-auth.ts).
// PERSON_DB: chế độ thực "Lưu vào hàng duyệt" ghi bằng phiên login Postgres riêng của người đã mở ở
// tab Duyệt & Lịch (`PersonSessions.forUser` của ApprovalWebModule — như Streamlit
// `_person_conn(form=False)`); chưa mở → 409.
@Module({
  imports: [ApprovalWebModule],
  controllers: [ContentController, WebController],
  providers: [
    ContentService,
    {
      provide: PERSON_DB,
      inject: [PersonSessions],
      useFactory:
        (s: PersonSessions): PersonDb =>
        (who) =>
          s.forUser(who.username),
    },
  ],
  exports: [ContentService],
})
export class ContentModule {}
