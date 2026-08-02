/**
 * Setup idempotent de l'utilisateur « réceptionnaire » (accès RESTREINT aux bons de réception).
 *
 * Contexte : RECEPTION_WRITE/RECEPTION_READ n'étaient pas dans le seed d'origine
 * (créées manuellement sur le serveur). Ce script garantit :
 *   1. que la permission RECEPTION_WRITE existe (manquante sur les bases seedées avant le 02/08),
 *   2. que le user réceptionnaire / Reception123 existe (role EMPLOYE, isActive),
 *   3. que son verrou DENY est appliqué (tout refusé SAUF RECEPTION_WRITE, héritée du rôle EMPLOYE).
 *
 * Idempotent : peut être relancé sans doublon ni perte de données.
 * Usage: npx tsx prisma/setup-receptionnaire.ts
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // 1. Permission RECEPTION_WRITE (hors seed d'origine)
  await prisma.permission.upsert({
    where: { code: 'RECEPTION_WRITE' },
    update: {},
    create: { code: 'RECEPTION_WRITE', label: 'Réception fournisseur - écriture', module: 'purchases' },
  });

  // 2. User réceptionnaire
  const hash = await bcrypt.hash('Reception123', 10);
  const user = await prisma.user.upsert({
    where: { username: 'receptionnaire' },
    update: { passwordHash: hash, isActive: true, role: 'EMPLOYE', deletedAt: null },
    create: {
      username: 'receptionnaire',
      email: 'receptionnaire@fruiterie.dz',
      fullName: 'Réceptionnaire',
      passwordHash: hash,
      role: 'EMPLOYE',
    },
  });

  // 3. Verrou : DENY sur TOUTES les perms SAUF RECEPTION_WRITE (héritée du rôle EMPLOYE)
  const perms = await prisma.permission.findMany({ select: { id: true, code: true } });
  const keep = ['RECEPTION_WRITE'];
  const aRefuser = perms.filter((p) => !keep.includes(p.code));

  await prisma.userPermission.deleteMany({ where: { userId: user.id } });
  await prisma.userPermission.createMany({
    data: aRefuser.map((p) => ({ userId: user.id, permissionId: p.id, type: 'DENY' })),
    skipDuplicates: true,
  });

  console.log(
    `[setup] ${user.username} OK — DENY=${aRefuser.length}, keep=${keep.join(', ')}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
