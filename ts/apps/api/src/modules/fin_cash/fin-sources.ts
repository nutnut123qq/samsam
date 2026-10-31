import type { Db } from '@samsam/core/ops/deps';
import { loadUsers } from '@samsam/core/security/auth';
import type { FinSources } from '../fin_ar_pnl/fin-director.js';
import * as cash from './fp-cash.js';
import * as ops from './fp-opscost.js';

// Nguồn FP-OpsCost/FP-Cash cho bản tin tuần GĐ tài chính (`agents/fin_director.py` gọi
// `fp_opscost.load_cfg/summary` + `fp_cash.load_inputs/run(measure(...))`). Bước tích hợp nối:
// `setFinSources(finSources)` (fin_ar_pnl/fin-director). Lỗi cấu hình/giả định → RangeError(lý do)
// → mục bản tin "(chưa có dữ liệu: …)", không bịa số.

export const finSources: FinSources = {
  ops: async (db: Db, month: string, fpaConfig: string) => {
    const [cfg, why] = ops.loadCfg(fpaConfig);
    if (cfg === null) throw new RangeError(why);
    return { cfg, summary: await ops.summary(db, month, cfg, loadUsers()) };
  },
  cash: async (db: Db, asOf: string, fpaConfig: string) => {
    const inp = cash.loadInputs(fpaConfig);
    return cash.run(await cash.measure(db, asOf), asOf, inp.cfg.opening_balance_vnd, inp);
  },
  cashWeeks: (fpaConfig: string) => cash.loadCfg(fpaConfig)[0]?.weeks ?? null,
};
