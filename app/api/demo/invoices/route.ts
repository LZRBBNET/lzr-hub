import { NextResponse } from 'next/server';
import { authorize } from '@/lib/platform/session-guard';
import { getSyntheticInvoiceDemo } from '@/lib/integrations/ixc/synthetic-demo';

/** Process-local simulation, never a financial receipt or external payment. */
export async function POST(request: Request) {
  // Gate before auth/DB: this endpoint must be inert outside explicit demo.
  let demo;
  try { demo = getSyntheticInvoiceDemo(); } catch { return NextResponse.json({ error: 'Demo indisponível' }, { status: 404 }); }
  const guard = await authorize(request, 'billing.write-demo');
  if (!guard.allowed) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const body = await request.json().catch(() => null);
  if (body?.action === 'reset_fixture' && body?.invoiceId === '901' && body?.confirmation === 'RESET_SYNTHETIC_INVOICE_901') {
    return NextResponse.json(demo.reset(body.confirmation), { headers: { 'cache-control': 'no-store' } });
  }
  if (body?.action !== 'simulate_payment' || body?.invoiceId !== '901') return NextResponse.json({ error: 'Ação sintética inválida' }, { status: 400 });
  return NextResponse.json(demo.markPaid(), { headers: { 'cache-control': 'no-store' } });
}
