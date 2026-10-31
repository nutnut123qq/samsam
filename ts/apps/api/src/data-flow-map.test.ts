import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT } from '@samsam/core/paths';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Drift-guard egress bản TS (như tests/test_data_flow_map.py cho `.py`): mọi tệp .ts (không phải test)
// trong apps/api/src + packages/core/src có đường ra mạng — `fetch` toàn cục, import node:http(s)/
// tls/dgram/nodemailer/@anthropic-ai/sdk/undici (kể cả import động/require), hoặc gọi `.chat(`/
// `.embed(` của AI Gateway — PHẢI nằm trong `modules` của một flow ở data/data_flow_map.json.
// Quét bằng AST (bỏ comment/chuỗi). Giới hạn như bản Python: gọi gián tiếp qua hàm fetch được
// truyền vào dưới tên khác / module trung gian không bắt — map vẫn phải khai bằng tay.

const NET = new Set([
  'node:http',
  'node:https',
  'http',
  'https',
  'node:tls',
  'tls',
  'node:dgram',
  'dgram',
  'nodemailer',
  '@anthropic-ai/sdk',
  'undici',
]);
const ROOTS = ['ts/apps/api/src', 'ts/packages/core/src'];
// Bỏ tệp test + helper chỉ test dùng (`*.testing.ts`, `web-testing.ts`, `test-helpers.ts`, testing/).
const SKIP = /(\.test\.ts|[.-]testing\.ts|test-helpers\.ts)$|\/(testing|__fixtures__)\//;

/** `fetch` dùng như GIÁ TRỊ (gọi, mặc định tham số, `?? fetch`) — không tính tên thuộc tính/khai báo/kiểu. */
function isFetchValue(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isTypeQueryNode(p) || ts.isQualifiedName(p)) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  if (
    (ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isBindingElement(p)) &&
    p.name === n
  ) {
    return false;
  }
  return !(ts.isBindingElement(p) && p.propertyName === n);
}

/** Lý do một mã nguồn TS có egress (rỗng = không). */
function egressReasons(src: string, file = 'x.ts'): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      NET.has(n.moduleSpecifier.text) &&
      !n.importClause?.isTypeOnly
    ) {
      out.add(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n)) {
      const [a] = n.arguments;
      const dyn =
        n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require');
      if (dyn && a && ts.isStringLiteralLike(a) && NET.has(a.text)) out.add(a.text);
      // Chữ ký gateway: chat|embed(agentId, input, { feature }) — `collectors.chat(since, until)` không tính.
      const e = n.expression;
      const gw = ts.isPropertyAccessExpression(e) && ['chat', 'embed'].includes(e.name.text);
      if (gw && n.arguments.length >= 3) out.add(`.${e.name.text}()`);
    } else if (ts.isIdentifier(n) && n.text === 'fetch' && isFetchValue(n)) {
      out.add('fetch');
    } else if (
      ts.isPropertyAccessExpression(n) &&
      n.name.text === 'fetch' &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'globalThis'
    ) {
      out.add('fetch');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...out];
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return d.name === 'node_modules' ? [] : walk(p);
    return d.name.endsWith('.ts') && !d.name.endsWith('.d.ts') ? [p] : [];
  });
}

/** {đường dẫn posix tương đối gốc repo: lý do} — tệp TS có egress. */
function egressModules(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of ROOTS) {
    for (const f of walk(join(REPO_ROOT, r))) {
      const rel = relative(REPO_ROOT, f).replaceAll('\\', '/');
      if (SKIP.test(rel)) continue;
      const why = egressReasons(readFileSync(f, 'utf8'), f);
      if (why.length) out.set(rel, why);
    }
  }
  return out;
}

const MAP = JSON.parse(readFileSync(join(REPO_ROOT, 'data', 'data_flow_map.json'), 'utf8')) as {
  flows: { id: string; modules: string[]; recipients: string }[];
};
const declared = new Set(MAP.flows.flatMap((f) => f.modules));

describe('data_flow_map ↔ egress bản TS', () => {
  it('scanner bắt đúng dạng egress, bỏ comment/chuỗi/kiểu/tên thuộc tính', () => {
    const yes = [
      "await fetch('https://x')",
      'const f = o.fetch ?? fetch;',
      'function g(f = fetch) {}',
      'const f = globalThis.fetch;',
      "import https from 'node:https';",
      "import { request } from 'node:http';",
      "import nodemailer from 'nodemailer';",
      "import Anthropic from '@anthropic-ai/sdk';",
      "const m = await import('node:https');",
      "const n = require('nodemailer');",
      "await this.ai.chat('a', [], { feature: 'x' });",
      "await gw.embed('a', ['x'], { feature: 'x' });",
    ];
    for (const s of yes) expect(egressReasons(s), s).not.toEqual([]);
    const no = [
      '// fetch(url) trong comment',
      "const s = 'fetch(';",
      'type F = typeof fetch;',
      'type O = { fetch?: F };',
      'const o = { fetch: f };',
      'o.fetch;',
      'function h(fetch: F) {}',
      "import type http from 'node:http';",
      "import { isIP } from 'node:net';",
      'const chat = 1;',
      'await opts.collectors.chat(since, until);',
      'export async function fetch(db) {}',
      "import { fetch as rows } from './x.js';",
    ];
    for (const s of no) expect(egressReasons(s), s).toEqual([]);
  });

  it('chống scanner rỗng: các đường ra mạng đã biết đều bị bắt', () => {
    const got = egressModules();
    for (const m of [
      'ts/packages/core/src/ai/providers.ts',
      'ts/packages/core/src/ops/red-alert.ts',
      'ts/apps/api/src/modules/zalo/zalo.sender.ts',
      'ts/apps/api/src/modules/market/market-api.ts',
      'ts/apps/api/src/modules/content/content.ts',
    ]) {
      expect(got.has(m), m).toBe(true);
    }
  });

  it('mọi tệp TS có egress đã khai trong modules của data/data_flow_map.json', () => {
    const missing = [...egressModules()]
      .filter(([m]) => !declared.has(m))
      .map(([m, why]) => `${m} (${why.join(', ')})`);
    expect(missing, 'module TS gửi dữ liệu ra ngoài CHƯA khai báo trong data_flow_map').toEqual([]);
  });

  it('AI Gateway TS: nơi nhận = Ollama nội bộ + Anthropic CHỈ khi ai_policy cho phép', () => {
    const f = MAP.flows.find((x) => x.modules.includes('ts/packages/core/src/ai/providers.ts'));
    expect(f?.recipients).toMatch(/Ollama/);
    expect(f?.recipients).toMatch(/Anthropic/);
    expect(f?.recipients).toMatch(/ai_policy/);
  });
});
