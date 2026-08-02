/**
 * Verrou d'accès unique pour l'utilisateur "receptionnaire".
 * Insère un override UserPermission DENY sur TOUTES les permissions
 * SAUF RECEPTION_WRITE (héritée du rôle EMPLOYE).
 *
 * Usage: npx tsx prisma/lock-receptionnaire.ts [username] [permAGarder...]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const username = process.argv[2] || 'receptionnaire';
  const keep = process.argv.length > 3 ? process.argv.slice(3) : ['RECEPTION_WRITE'];

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new Error(`Utilisateur ${username} introuvable`);

  const perms = await prisma.permission.findMany({ select: { id: true, code: true } });
  const aRefuser = perms.filter((p) => !keep.includes(p.code));

  // Reset des overrides existants pour cet utilisateur.
  await prisma.userPermission.deleteMany({ where: { userId: user.id } });

  await prisma.userPermission.createMany({
    data: aRefuser.map((p) => ({ userId: user.id, permissionId: p.id, type: 'DENY' })),
    skipDuplicates: true,
  });

  console.log(
    `[lock] ${username} : ${aRefuser.length} permissions DENY, conservées = ${keep.join(', ')}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
