import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  commandRunner,
  type JobSpec,
  loadJobs,
  pythonRunner,
  registerJobSchedulers,
  type StepRunner,
} from '@samsam/core/ops/job-runs';
import type { Queue } from 'bullmq';

// Lịch BullMQ của worker = 34 job `deploy/onprem/jobs.json` (thay systemd timer). Bước Python
// (`-m <module>` / `scripts/<file>.py`) → lệnh CLI TS CÙNG CỜ (chỉ đổi tên lệnh), chạy tiến trình
// con `cli.ts` với cwd = gốc repo như Python (`--out-dir data/reports` tương đối). Khóa chống chạy
// chồng + dòng `job_runs` `job:<tên>` do core `runScheduled` giữ.

/** Bước Python → lệnh TS (cờ giữ nguyên). */
export const TS_STEPS: Record<string, string> = {
  'crawler.intel': 'crawler-intel',
  'crawler.collect': 'crawler-collect',
  'scripts/intel_bulletin.py': 'intel-bulletin',
  'pipelines.intel_alert': 'intel-alert',
  'pipelines.red_alert': 'red-alert',
  'agents.ra_kenh': 'ra-kenh',
  'agents.hdtv_report': 'hdtv-report',
  'agents.vt_thoitiet': 'vt-thoitiet',
  'agents.vt_thuhoach': 'vt-thuhoach',
  'scripts/webhook_probe.py': 'webhook-probe',
  'pipelines.anchor': 'anchor',
  'pipelines.legal_updates': 'legal-updates',
  'agents.sales_director': 'sales-director',
  'agents.kd_quote': 'kd-quote',
  'agents.kd_orders': 'kd-orders',
  'agents.kd_price': 'kd-price',
  'agents.ceo_promo': 'ceo-promo',
  'scripts/intel_weekly.py': 'intel-weekly',
  'pipelines.cockpit': 'cockpit',
  'agents.ceo_report': 'ceo-report',
  'agents.acc_invoice': 'acc-invoice',
  'pipelines.content': 'content',
  'scripts/db_backup.py': 'db-backup',
  'scripts/dr_drill.py': 'dr-drill',
  'scripts/ops_monthly.py': 'ops-monthly',
  'scripts/health_bulletin.py': 'health-bulletin',
  'agents.garden_director': 'garden-director',
  'agents.kd_listing': 'kd-listing',
  'agents.ceo_audit': 'ceo-audit',
  'agents.bks_audit': 'bks-audit',
  'pipelines.production': 'production',
};

/** Bước GIỮ Python (KE_HOACH mục 3: công cụ không viết lại) — tiến trình con `python`, cùng cờ.
 * Image worker không có Python → bước exit 127, job_runs ghi lỗi (không im lặng). */
export const PY_STEPS = new Set(['scripts/db_restore_drill.py']);

const stepKey = (step: string[]) => (step[0] === '-m' ? (step[1] ?? '') : (step[0] ?? ''));

export type StepPlan = { kind: 'ts' | 'python'; argv: string[] } | { kind: 'none'; key: string };

/** Bước của jobs.json → argv lệnh TS | argv Python nguyên vẹn | không được phép. */
export function planStep(step: string[]): StepPlan {
  const key = stepKey(step);
  const cmd = Object.hasOwn(TS_STEPS, key) ? TS_STEPS[key] : undefined;
  if (cmd) return { kind: 'ts', argv: [cmd, ...step.slice(step[0] === '-m' ? 2 : 1)] };
  if (PY_STEPS.has(key)) return { kind: 'python', argv: step };
  return { kind: 'none', key };
}

export const CLI_FILE = fileURLToPath(new URL('./cli.ts', import.meta.url));
// tsx đọc tsconfig từ cwd (gốc repo không có) — thiếu `experimentalDecorators` thì DI Nest hỏng.
export const API_TSCONFIG = fileURLToPath(new URL('../tsconfig.json', import.meta.url));

/** `node --import tsx cli.ts <lệnh> ...` — loader tsx tuyệt đối (cwd = gốc repo không thấy gói). */
const tsRunner: StepRunner = (argv, o) =>
  commandRunner(
    () => process.execPath,
    ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href, CLI_FILE],
  )(argv, { ...o, env: { ...o.env, TSX_TSCONFIG_PATH: API_TSCONFIG } });

/** StepRunner của worker: lệnh TS, hoặc Python cho bước giữ Python; bước lạ → 127 (fail-closed). */
export function jobStepRunner(
  ts: StepRunner = tsRunner,
  py: StepRunner = pythonRunner,
): StepRunner {
  return (step, o) => {
    const plan = planStep(step);
    if (plan.kind === 'none') {
      console.log(`[worker] bước '${plan.key}' không có lệnh TS/Python được phép — bỏ (exit 127)`);
      return Promise.resolve(127);
    }
    if (plan.kind === 'ts') return ts(plan.argv, o);
    console.log(`[worker] bước '${step.join(' ')}' chưa có bản TS — chạy bản Python`);
    return py(plan.argv, o);
  };
}

/** Lịch cho worker: bước phải có lệnh TS hoặc thuộc PY_STEPS (image không chứa mã Python). */
export const loadWorkerJobs = (path?: string): Record<string, JobSpec> =>
  loadJobs(path, (s) => planStep(s).kind !== 'none');

/** Job cần thứ image worker không có (Python / DATABASE_URL quản trị + docker CLI) — `all` không gồm;
 * muốn chạy ở worker thì liệt kê tường minh. */
export const SYSTEMD_ONLY = new Set(['restore_drill', 'dr_drill']);

/**
 * `WORKER_JOBS` = danh sách tên job (phẩy) chuyển sang BullMQ. Job còn bật ở systemd (Python) KHÔNG
 * được có ở đây — khóa advisory TS không loại trừ khóa tệp Python. Fail-closed (review cuối): trống
 * → lỗi (worker exit 78), KHÔNG mặc định cả lịch; `all` = cả lịch trừ SYSTEMD_ONLY.
 */
export function selectJobs(
  jobs: Record<string, JobSpec>,
  raw: string | undefined,
): Record<string, JobSpec> {
  const names = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) {
    throw new RangeError(
      'WORKER_JOBS trống — liệt kê job đã tắt timer systemd (hoặc `all` khi không còn timer nào), ' +
        'deploy/compose/README.md mục 7',
    );
  }
  if (names.length === 1 && names[0] === 'all') {
    return Object.fromEntries(Object.entries(jobs).filter(([n]) => !SYSTEMD_ONLY.has(n)));
  }
  const unknown = names.filter((n) => !Object.hasOwn(jobs, n));
  if (unknown.length) throw new RangeError(`WORKER_JOBS có job lạ: ${unknown.join(', ')}`);
  return Object.fromEntries(names.map((n) => [n, jobs[n] as JobSpec]));
}

/** Đồng bộ lịch Redis với `jobs`: gỡ scheduler không còn bật (tồn từ lần chạy trước), upsert phần còn lại. */
export async function syncSchedulers(
  queue: Pick<Queue, 'getJobSchedulers' | 'removeJobScheduler' | 'upsertJobScheduler'>,
  jobs: Record<string, JobSpec>,
): Promise<string[]> {
  for (const s of await queue.getJobSchedulers()) {
    if (!Object.hasOwn(jobs, s.key)) await queue.removeJobScheduler(s.key);
  }
  return registerJobSchedulers(queue, jobs);
}
