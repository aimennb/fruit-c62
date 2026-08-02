// Création (upsert) de l'utilisateur restreint "receptionnaire".
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

(async () => {
  const passwordHash = await bcrypt.hash('Reception123', 10);
  const u = await prisma.user.upsert({
    where: { username: 'receptionnaire' },
    update: { passwordHash, isActive: true, role: 'EMPLOYE', deletedAt: null },
    create: {
      email: 'reception@fruiterie.dz',
      username: 'receptionnaire',
      passwordHash,
      fullName: 'Réceptionnaire',
      role: 'EMPLOYE',
      isActive: true,
    },
    select: { id: true, username: true, email: true, role: true, isActive: true },
  });
  console.log('USER OK:', JSON.stringify(u));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
