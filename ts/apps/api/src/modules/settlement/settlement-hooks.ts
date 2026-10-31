import type { SettlementHooks } from '../market/market.command.js';
import { type Params, request } from '../market/market-api.js';
import { type ApiDeps, type Precheck, precheck, run } from './settlement-api.js';

type Ready = Extract<Precheck, { rc: null }>;

/**
 * Cửa nối `ingest.settlement_api` vào lệnh `market-api --kind settlement` của nhóm market — đúng như
 * Python `market_api.main`: `sa.precheck` TRƯỚC cổng triển khai/refresh/mọi request, rồi `sa.run` với
 * `call` = `ma._request` đã ký bằng creds/base của lệnh. Mọi dòng in ra stdout (`log`) như Python.
 */
export function settlementHooks(d: Omit<ApiDeps, 'io'> = {}): SettlementHooks {
  return {
    async precheck(channel, base, dryRun, log) {
      const r = precheck(channel, base, dryRun, { ...d, io: { out: log, err: log } });
      return r.rc === null ? { ctx: r, rc: null } : { ctx: null, rc: r.rc };
    },
    run(args, creds, base, ctx, log) {
      const { cfg, fees, kind } = ctx as Ready;
      return run(
        args,
        (method, path, params, body, pathParams) =>
          request(
            args.channel,
            method,
            path,
            params as Params,
            (body ?? null) as Record<string, unknown> | null,
            { creds, base, pathParams: pathParams ?? undefined },
          ),
        cfg,
        fees,
        kind,
        { ...d, io: { out: log, err: log } },
      );
    },
  };
}
