import { PrismaClient, Role, AccountEntryType, AdvanceStatus, PurchaseStatus, SaleStatus, MovementType, InvoiceStatus, PaymentMethod, TemplateType, BackupType, BackupStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Seed Phase A — données fictives uniquement (aucune donnée réelle de personne).
 * 3 fournisseurs, 5 clients, 6 produits, catégories, unités, users de démo.
 */
async function main() {
  const bcryptRounds = 10;

  // --- Permissions granulaires (catalogue) -----------------------------
  const permissionCodes = [
    'USER_READ', 'USER_CREATE', 'USER_UPDATE', 'USER_DELETE',
    'PRODUCT_READ', 'PRODUCT_CREATE', 'PRODUCT_UPDATE', 'PRODUCT_DELETE',
    'SUPPLIER_READ', 'SUPPLIER_CREATE', 'SUPPLIER_UPDATE', 'SUPPLIER_DELETE',
    'CUSTOMER_READ', 'CUSTOMER_CREATE', 'CUSTOMER_UPDATE', 'CUSTOMER_DELETE',
    'PURCHASE_READ', 'PURCHASE_WRITE', 'RECEPTION_READ', 'RECEPTION_WRITE',
    'SALE_READ', 'SALE_WRITE',
    'STOCK_READ', 'STOCK_WRITE', 'INVOICE_READ', 'INVOICE_WRITE',
    'PAYMENT_READ', 'PAYMENT_WRITE', 'REPORT_READ', 'SETTINGS_WRITE', 'ADMIN',
  ];
  const moduleOf = (code: string) => code.split('_')[0].toLowerCase();

  const perms: { id: string; code: string }[] = [];
  for (const code of permissionCodes) {
    const p = await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code, label: code, module: moduleOf(code) },
    });
    perms.push(p);
  }

  // --- Mapping Role -> Permissions ------------------------------------
  // ADMIN : tout. RESPONSABLE : tout sauf admin/settings. EMPLOYE : lecture + écriture opérationnelle.
  const adminPerms = perms;
  const responsablePerms = perms.filter((p) => p.code !== 'ADMIN' && p.code !== 'SETTINGS_WRITE' && !p.code.startsWith('USER_'));
  // EMPLOYE : lecture métier (produits/fournisseurs/clients) + écriture opérationnelle
  // (bulletins/ventes/stocks/pertes). AUCUNE permission USER_* (principe du moindre
  // privilège, §5) : l'employé ne gère ni comptes ni rôles.
  const employePerms = perms.filter((p) =>
    ['PRODUCT_READ', 'SUPPLIER_READ', 'CUSTOMER_READ',
     'PURCHASE_READ', 'PURCHASE_WRITE', 'RECEPTION_READ', 'RECEPTION_WRITE',
     'SALE_READ', 'SALE_WRITE',
     'STOCK_READ', 'STOCK_WRITE', 'INVOICE_READ', 'PAYMENT_READ', 'PAYMENT_WRITE',
     'REPORT_READ'].includes(p.code),
  );

  async function setRolePerms(role: Role, list: typeof perms) {
    await prisma.rolePermission.deleteMany({ where: { role } });
    for (const p of list) {
      await prisma.rolePermission.create({ data: { role, permissionId: p.id } });
    }
  }
  await setRolePerms(Role.ADMIN, adminPerms);
  await setRolePerms(Role.RESPONSABLE, responsablePerms);
  await setRolePerms(Role.EMPLOYE, employePerms);

  // --- Users de démo (mots de passe hachés) ----------------------------
  const usersSeed = [
    { username: 'admin', email: 'admin@fruiterie.dz', fullName: 'Administrateur Fruiterie', password: 'admin123', role: Role.ADMIN },
    { username: 'responsable', email: 'resp@fruiterie.dz', fullName: 'Responsable Achats', password: 'resp123', role: Role.RESPONSABLE },
    { username: 'employe', email: 'emp@fruiterie.dz', fullName: 'Employé Caisse', password: 'emp123', role: Role.EMPLOYE },
  ];
  for (const u of usersSeed) {
    const hash = await bcrypt.hash(u.password, bcryptRounds);
    await prisma.user.upsert({
      where: { username: u.username },
      update: { passwordHash: hash, role: u.role, fullName: u.fullName, email: u.email, isActive: true, deletedAt: null },
      create: { username: u.username, email: u.email, fullName: u.fullName, passwordHash: hash, role: u.role },
    });
  }

  // --- Unités ---------------------------------------------------------
  const units = [
    { name: 'Kilogramme', symbol: 'kg' },
    { name: 'Caisse', symbol: 'cs' },
    { name: 'Bouquet', symbol: 'bt' },
    { name: 'Carton', symbol: 'ct' },
  ];
  const unitMap: Record<string, string> = {};
  for (const u of units) {
    const rec = await prisma.unit.upsert({ where: { symbol: u.symbol }, update: {}, create: u });
    unitMap[u.symbol] = rec.id;
  }

  // --- Catégories -----------------------------------------------------
  const cats = [
    { name: 'Légumes', description: 'Légumes frais' },
    { name: 'Fruits', description: 'Fruits frais' },
    { name: 'Dattes & Séchés', description: 'Produits secs' },
  ];
  const catMap: Record<string, string> = {};
  for (const c of cats) {
    const rec = await prisma.productCategory.upsert({ where: { name: c.name }, update: {}, create: c });
    catMap[c.name] = rec.id;
  }

  // --- Produits (~6) --------------------------------------------------
  const products = [
    { name: 'Pommes de terre', sku: 'LEG-PDT', category: 'Légumes', unit: 'kg', reorder: 500 },
    { name: 'Tomates', sku: 'LEG-TOM', category: 'Légumes', unit: 'kg', reorder: 300 },
    { name: 'Oignons', sku: 'LEG-OIG', category: 'Légumes', unit: 'kg', reorder: 200 },
    { name: 'Oranges', sku: 'FRU-ORA', category: 'Fruits', unit: 'kg', reorder: 250 },
    { name: 'Bananes', sku: 'FRU-BAN', category: 'Fruits', unit: 'cs', reorder: 80 },
    { name: 'Dattes Deglet Nour', sku: 'SEC-DAT', category: 'Dattes & Séchés', unit: 'ct', reorder: 50 },
  ];
  const productMap: Record<string, string> = {};
  for (const p of products) {
    const rec = await prisma.product.upsert({
      where: { sku: p.sku! },
      update: {},
      create: {
        name: p.name, sku: p.sku, categoryId: catMap[p.category], unitId: unitMap[p.unit],
        reorderLevel: p.reorder, isActive: true,
      },
    });
    productMap[p.sku!] = rec.id;
  }

  // --- Fournisseurs (3 fictifs) ---------------------------------------
  const suppliers = [
    { name: 'Ferme El Wadi SARL', contact: 'M. Amar', phone: '021551122', email: 'contact@elwadi.dz', address: 'Oued Smar, Alger', rc: 'RC12345', nif: 'NIF998877', ai: 'AI5544', balance: 0 },
    { name: 'Coopérative Agricole Blida', contact: 'Mme Karima', phone: '025334455', email: 'info@blidacoop.dz', address: 'Boudouaou, Blida', rc: 'RC22331', nif: 'NIF776655', ai: 'AI3322', balance: 0 },
    { name: 'Domaine Saharien Dates', contact: 'M. Yacine', phone: '029887766', email: 'ventes@sahariendates.dz', address: 'Touggourt, Ouargla', rc: 'RC33412', nif: 'NIF554433', ai: 'AI1122', balance: 0 },
  ];
  const supplierMap: Record<string, string> = {};
  for (const s of suppliers) {
    const rec = await prisma.supplier.upsert({
      where: { name: s.name },
      update: {},
      create: { name: s.name, contactName: s.contact, phone: s.phone, email: s.email, address: s.address, rc: s.rc, nif: s.nif, ai: s.ai, balance: s.balance },
    });
    supplierMap[s.name] = rec.id;
  }

  // --- Clients (5 fictifs) --------------------------------------------
  const customers = [
    { name: 'Épicerie Centrale Bab El Oued', contact: 'M. Samir', phone: '021998877', email: 'cmd@epiceriecentrale.dz', address: 'Bab El Oued, Alger', credit: 0 },
    { name: 'Supermarché El Madina', contact: 'Mme Nabila', phone: '023667788', email: 'achats@elmadina.dz', address: 'Hussein Dey, Alger', credit: 0 },
    { name: 'Restaurant Le Jardin', contact: 'M. Karim', phone: '024556677', email: 'cuisine@lejardin.dz', address: 'Kouba, Alger', credit: 0 },
    { name: 'Grossiste Fruits Tizi', contact: 'M. Lyes', phone: '026445566', email: 'appro@tfruits.dz', address: 'Tizi Ouzou', credit: 0 },
    { name: 'Hôtel Aurassi Supply', contact: 'Mme Salima', phone: '021334455', email: 'supply@aurassi.dz', address: 'Alger Centre', credit: 0 },
  ];
  const customerMap: Record<string, string> = {};
  for (const c of customers) {
    const rec = await prisma.customer.upsert({
      where: { name: c.name },
      update: {},
      create: { name: c.name, contactName: c.contact, phone: c.phone, email: c.email, address: c.address, balance: 0, creditLimit: c.credit },
    });
    customerMap[c.name] = rec.id;
  }

  // --- Entrée compte fournisseur + acompte (exemple) ------------------
  const wadiId = supplierMap['Ferme El Wadi SARL'];
  await prisma.supplierAccountEntry.upsert({
    where: { id: 'seed-entry-wadi-1' },
    update: {},
    create: { id: 'seed-entry-wadi-1', supplierId: wadiId, type: AccountEntryType.CREDIT, amount: 50000, description: 'Acompte initial (exemple)', reference: 'AV-2026-0001', entryDate: new Date() },
  });
  await prisma.supplierAdvance.upsert({
    where: { reference: 'AV-2026-0001' },
    update: {},
    create: { supplierId: wadiId, reference: 'AV-2026-0001', amount: 50000, advanceDate: new Date(), status: AdvanceStatus.PENDING, notes: 'Acompte de démarrage (exemple Phase A)' },
  });

  // --- Template d'impression défaut -----------------------------------
  await prisma.printTemplate.upsert({
    where: { name: 'Facture standard' },
    update: {},
    create: { name: 'Facture standard', type: TemplateType.INVOICE, content: '<h1>Facture</h1>{{company}}<p>{{customer}}</p><table>{{items}}</table><p>Total: {{total}} DA</p>', isDefault: true },
  });

  // --- Company settings ----------------------------------------------
  await prisma.companySettings.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton', companyName: 'Fruiterie Familiale SARL', address: 'Alger, Algérie', phone: '021000000', email: 'contact@fruiterie.dz', taxId: 'RC00000', currency: 'DA', receiptFooter: 'Merci pour votre confiance — جميع الحسابات بالدينار الجزائري' },
  });

  console.log('✅ Seed terminé :');
  console.log('   -', perms.length, 'permissions');
  console.log('   - 3 users (admin/responsable/employe)');
  console.log('   -', units.length, 'unités,', cats.length, 'catégories,', products.length, 'produits');
  console.log('   -', suppliers.length, 'fournisseurs,', customers.length, 'clients');
}

main()
  .catch((e) => {
    console.error('❌ Seed échoué:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
