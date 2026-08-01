import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { notImplemented } from './_helpers';

/**
 * Construit un routeur REST "stub" pour un module métier non encore implémenté (Phase A).
 * Toutes les routes sont documentées via swagger (voir src/swagger.ts) mais renvoient 501,
 * car le schéma DB est complet mais la logique métier arrivera en Phase B/C/D.
 *
 * Chaque entrée : { path, tag, create, update } où create/update sont des schémas zod
 * optionnels servant uniquement à documenter/valider la forme attendue.
 */
export interface StubModule {
  path: string; // ex: '/purchases'
  tag: string; // groupe swagger
  create?: z.ZodTypeAny;
  update?: z.ZodTypeAny;
}

function buildStub(m: StubModule): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/', (_req: Request, res: Response) => notImplemented(res));
  r.get('/:id', (_req: Request, res: Response) => notImplemented(res));
  if (m.create) {
    r.post('/', (req: Request, res: Response) => {
      const parsed = m.create!.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
      notImplemented(res);
    });
  } else {
    r.post('/', (_req: Request, res: Response) => notImplemented(res));
  }
  if (m.update) {
    r.put('/:id', (req: Request, res: Response) => {
      const parsed = m.update!.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
      notImplemented(res);
    });
    r.patch('/:id', (req: Request, res: Response) => {
      const parsed = (m.update as any).partial().safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
      notImplemented(res);
    });
  } else {
    r.put('/:id', (_req: Request, res: Response) => notImplemented(res));
    r.patch('/:id', (_req: Request, res: Response) => notImplemented(res));
  }
  r.delete('/:id', (_req: Request, res: Response) => notImplemented(res));

  return r;
}

// Schémas volontairement minimaux pour la documentation/validation (forme attendue).
const decimal = z.union([z.string(), z.number()]);

export const stubModules: StubModule[] = [
  {
    path: '/units', tag: 'Units',
    create: z.object({ name: z.string().min(1), symbol: z.string().min(1) }),
    update: z.object({ name: z.string().min(1), symbol: z.string().min(1) }),
  },
  {
    path: '/product-categories', tag: 'ProductCategories',
    create: z.object({ name: z.string().min(1), description: z.string().optional() }),
    update: z.object({ name: z.string().min(1), description: z.string().optional() }),
  },
  {
    path: '/supplier-account-entries', tag: 'SupplierAccountEntries',
    create: z.object({ supplierId: z.string(), type: z.enum(['DEBIT', 'CREDIT']), amount: decimal, description: z.string().optional(), reference: z.string().optional() }),
    update: z.object({ amount: decimal, description: z.string().optional() }),
  },
  {
    path: '/purchases', tag: 'Purchases',
    create: z.object({ supplierId: z.string(), reference: z.string(), date: z.string().optional(), status: z.string().optional(), notes: z.string().optional(), items: z.array(z.object({ productId: z.string(), quantity: decimal, unitPrice: decimal })) }),
    update: z.object({ status: z.string().optional(), notes: z.string().optional() }),
  },
  {
    path: '/purchase-items', tag: 'PurchaseItems',
    create: z.object({ purchaseId: z.string(), productId: z.string(), quantity: decimal, unitPrice: decimal }),
    update: z.object({ quantity: decimal, unitPrice: decimal }),
  },
  {
    path: '/purchase-bulletins', tag: 'PurchaseBulletins',
    create: z.object({ reference: z.string(), purchaseId: z.string(), carrier: z.string().optional(), notes: z.string().optional() }),
    update: z.object({ carrier: z.string().optional(), notes: z.string().optional() }),
  },
  {
    path: '/purchase-bulletin-items', tag: 'PurchaseBulletinItems',
    create: z.object({ bulletinId: z.string(), productId: z.string(), weight: decimal, amount: decimal }),
    update: z.object({ weight: decimal, amount: decimal }),
  },
  {
    path: '/arrivals', tag: 'Arrivals',
    create: z.object({ reference: z.string(), purchaseId: z.string(), notes: z.string().optional() }),
    update: z.object({ status: z.string().optional(), notes: z.string().optional() }),
  },
  {
    path: '/stock-lots', tag: 'StockLots',
    create: z.object({ productId: z.string(), arrivalId: z.string().optional(), quantity: decimal, unitCost: decimal, expiryDate: z.string().optional() }),
    update: z.object({ quantity: decimal, unitCost: decimal }),
  },
  {
    path: '/stock-movements', tag: 'StockMovements',
    create: z.object({ productId: z.string(), lotId: z.string().optional(), type: z.enum(['IN', 'OUT', 'ADJUST', 'TRANSFER', 'LOSS']), quantity: decimal, reason: z.string().optional() }),
    update: z.object({ quantity: decimal, reason: z.string().optional() }),
  },
  {
    path: '/sale-items', tag: 'SaleItems',
    create: z.object({ saleId: z.string(), productId: z.string(), quantity: decimal, unitPrice: decimal }),
    update: z.object({ quantity: decimal, unitPrice: decimal }),
  },
  {
    path: '/invoices', tag: 'Invoices',
    create: z.object({ saleId: z.string().optional(), customerId: z.string().optional(), dueDate: z.string().optional(), notes: z.string().optional() }),
    update: z.object({ status: z.string().optional(), notes: z.string().optional() }),
  },
  {
    path: '/credit-notes', tag: 'CreditNotes',
    create: z.object({ invoiceId: z.string().optional(), customerId: z.string().optional(), amount: decimal, reason: z.string().optional() }),
    update: z.object({ status: z.string().optional(), reason: z.string().optional() }),
  },
  /* /payments est implémenté (Phase C) — voir src/routes/payments.routes.ts */
  {
    path: '/losses', tag: 'Losses',
    create: z.object({ productId: z.string().optional(), lotId: z.string().optional(), quantity: decimal, reason: z.string().optional(), cost: decimal }),
    update: z.object({ quantity: decimal, reason: z.string().optional(), cost: decimal }),
  },
  {
    path: '/price-history', tag: 'PriceHistory',
    create: z.object({ productId: z.string(), unitPrice: decimal, effectiveDate: z.string().optional(), reason: z.string().optional() }),
    update: z.object({ unitPrice: decimal, reason: z.string().optional() }),
  },
  {
    path: '/settings', tag: 'CompanySettings',
    create: z.object({ companyName: z.string(), address: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), taxId: z.string().optional(), currency: z.string().optional() }),
    update: z.object({ companyName: z.string().optional(), address: z.string().optional(), phone: z.string().optional(), email: z.string().optional(), taxId: z.string().optional(), currency: z.string().optional() }),
  },
  {
    path: '/print-templates', tag: 'PrintTemplates',
    create: z.object({ name: z.string(), type: z.enum(['INVOICE', 'RECEIPT', 'PURCHASE_ORDER', 'DELIVERY_NOTE', 'LABEL']), content: z.string(), isDefault: z.boolean().optional() }),
    update: z.object({ name: z.string().optional(), content: z.string().optional(), isDefault: z.boolean().optional() }),
  },
  {
    path: '/backups', tag: 'Backups',
    create: z.object({ filename: z.string(), path: z.string(), type: z.enum(['MANUAL', 'AUTO']).optional() }),
    update: z.object({ status: z.enum(['PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED']).optional() }),
  },
  {
    path: '/audit-logs', tag: 'AuditLogs',
    create: z.object({ userId: z.string().optional(), action: z.string(), entity: z.string().optional(), entityId: z.string().optional() }),
    update: z.object({}),
  },
  {
    path: '/sessions', tag: 'Sessions',
    create: z.object({}), update: z.object({}),
  },
  {
    path: '/permissions', tag: 'Permissions',
    create: z.object({ code: z.string(), label: z.string(), module: z.string(), description: z.string().optional() }),
    update: z.object({ label: z.string().optional(), description: z.string().optional() }),
  },
  {
    path: '/roles', tag: 'Roles',
    create: z.object({ role: z.enum(['ADMIN', 'RESPONSABLE', 'EMPLOYE']), permissionId: z.string() }),
    update: z.object({ permissionId: z.string() }),
  },
];

/** Renvoie un Routeur montant tous les stubs sous /api. */
export function buildStubRouters(): { path: string; router: Router }[] {
  return stubModules.map((m) => ({ path: `/api${m.path}`, router: buildStub(m) }));
}
