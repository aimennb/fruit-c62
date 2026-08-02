// Upsert de la permission RECEPTION_WRITE + rattachement aux rôles.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const perm = await prisma.permission.upsert({
    where: { code: 'RECEPTION_WRITE' },
    update: {
      label: 'Réception fournisseur - écriture',
      module: 'purchases',
      description: 'Créer/saisir les bons de réception fournisseur',
    },
    create: {
      code: 'RECEPTION_WRITE',
      label: 'Réception fournisseur - écriture',
      module: 'purchases',
      description: 'Créer/saisir les bons de réception fournisseur',
    },
  });
  console.log('Permission OK:', perm.code, perm.id);

  const roles = (process.env.ROLES || 'EMPLOYE,ADMIN').split(',');
  for (const role of roles) {
    await prisma.rolePermission.upsert({
      where: { role_permissionId: { role, permissionId: perm.id } },
      update: {},
      create: { role, permissionId: perm.id },
    });
    console.log('RolePermission OK:', role);
  }

  const cPerm = await prisma.permission.count({ where: { code: 'RECEPTION_WRITE' } });
  const cRp = await prisma.rolePermission.count({
    where: { permissionId: perm.id, role: 'EMPLOYE' },
  });
  console.log('COUNT Permission RECEPTION_WRITE =', cPerm);
  console.log('COUNT RolePermission EMPLOYE     =', cRp);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
