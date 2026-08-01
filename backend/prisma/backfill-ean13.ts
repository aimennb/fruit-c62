// =====================================================================
// BACKFILL EAN13 (one-shot, IDÉMPOTENT).
//   Attribue un ean13 à tous les documents existants qui n'en ont pas :
//     Invoice           -> préfixe 2
//     SupplierReception -> préfixe 3
//     SupplierBordereau -> préfixe 4
//   Rejouable sans créer de doublon (les documents déjà pourvus sont ignorés,
//   la séquence repart du max existant).
//
// Usage : cd backend && npx ts-node prisma/backfill-ean13.ts
//    ou  : node dist/prisma/backfill-ean13.js (si compilé)
// =====================================================================
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function ean13Checksum(digits12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = digits12.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d : d * 3;
  }
  return (10 - (sum % 10)) % 10;
}

function buildEan13(prefix: string, sequence: number): string {
  const base = prefix.slice(0, 1) + String(sequence).padStart(11, '0');
  return base + String(ean13Checksum(base));
}

async function backfill(delegateName: 'invoice' | 'supplierReception' | 'supplierBordereau', prefix: string) {
  const delegate = (prisma as any)[delegateName];
  const existing: { ean13: string | null }[] = await delegate.findMany({
    where: { ean13: { not: null } },
    select: { ean13: true },
  });
  const used = new Set<string>();
  let max = 0;
  for (const r of existing) {
    if (!r.ean13) continue;
    used.add(r.ean13);
    if (r.ean13.startsWith(prefix) && r.ean13.length === 13) {
      const seq = parseInt(r.ean13.slice(1, 12), 10);
      if (!isNaN(seq) && seq > max) max = seq;
    }
  }

  const todo: { id: string; reference: string }[] = await delegate.findMany({
    where: { ean13: null },
    select: { id: true, reference: true },
    orderBy: { createdAt: 'asc' },
  });

  let n = 0;
  for (const doc of todo) {
    let code = buildEan13(prefix, ++max);
    while (used.has(code)) code = buildEan13(prefix, ++max);
    used.add(code);
    await delegate.update({ where: { id: doc.id }, data: { ean13: code } });
    n++;
    console.log(`  ${delegateName.padEnd(18)} ${doc.reference.padEnd(14)} -> ${code}`);
  }
  console.log(`[${delegateName}] ${n} document(s) mis à jour, ${existing.length} déjà pourvu(s).`);
  return n;
}

async function main() {
  console.log('=== BACKFILL EAN13 ===');
  const a = await backfill('invoice', '2');
  const b = await backfill('supplierReception', '3');
  const c = await backfill('supplierBordereau', '4');
  console.log(`TOTAL: ${a + b + c} document(s) nouvellement codés.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
