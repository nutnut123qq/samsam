import { Module } from '@nestjs/common';
import {
  IntelAlertCommand,
  IntelBulletinCommand,
  LegalUpdatesCommand,
  PersonaSimCommand,
} from './intel-alert.command.js';

// Nhóm intel_alert: `pipelines/intel_alert.py` (intel-02.1/02.2/02.3 + legal_hr-07 cảnh báo đỏ
// intel), `scripts/intel_bulletin.py` (intel-01.1 bản tin, intel-01.2 gợi ý chủ đề),
// `pipelines/legal_updates.py` (legal_hr-07 hàng duyệt Pháp chế), `scripts/persona_sim.py`
// (intel-05.1). Không controller: Python không có giao diện/webhook riêng (xác nhận cảnh báo qua
// CLI/`red_alert --ack`, gợi ý duyệt ở hàng duyệt chung). Job lịch (deploy/onprem/jobs.json):
// `intel` (bước `intel-bulletin --period day --suggest`), `red_alert_sweep` (bước
// `intel-alert --run`), `legal_updates` (`legal-updates --submit`).
@Module({
  providers: [IntelAlertCommand, IntelBulletinCommand, LegalUpdatesCommand, PersonaSimCommand],
})
export class IntelAlertModule {}
