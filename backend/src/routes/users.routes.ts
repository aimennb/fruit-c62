import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../prisma';
import { config } from '../config';
import { requireAuth, requireRole, requirePermission } from '../auth/middleware';
import { Role } from '@prisma/client';
import { auditLog } from '../auth/audit';

const router = Router();

const upsertSchema = z.object({
  email: z.string().email(),
  username: z.string().min(2).max(50),
  password: z.string().min(6).max(200),
  fullName: z.string().min(1).max(120),
  role: z.nativeEnum(Role).default(Role.EMPLOYE),
  isActive: z.boolean().default(true),
});

router.use(requireAuth);

// GET /api/users — liste (lecture pour RESPONSABLE+)
router.get('/', requirePermission('USER_READ'), async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: { id: true, email: true, username: true, fullName: true, role: true, isActive: true, lastLoginAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json(users);
});

// GET /api/users/:id
router.get('/:id', requirePermission('USER_READ'), async (req, res) => {
  const u = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!u || u.deletedAt) return res.status(404).json({ error: 'Introuvable' });
  res.json(u);
});

// POST /api/users — création (ADMIN)
router.post('/', requireRole(Role.ADMIN), requirePermission('USER_CREATE'), async (req, res) => {
  const parsed = upsertSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const data = parsed.data;
  const exists = await prisma.user.findFirst({ where: { OR: [{ email: data.email }, { username: data.username }] } });
  if (exists) return res.status(409).json({ error: 'Email ou username déjà utilisé' });
  const hash = await bcrypt.hash(data.password, config.bcryptRounds);
  const u = await prisma.user.create({
    data: { email: data.email, username: data.username, passwordHash: hash, fullName: data.fullName, role: data.role, isActive: data.isActive, createdBy: req.user!.id } as any,
    select: { id: true, email: true, username: true, fullName: true, role: true, isActive: true },
  });
  auditLog({ userId: req.user!.id, action: 'USER_CREATE', entity: 'User', entityId: u.id, req }).catch(() => {});
  res.status(201).json(u);
});

// PUT /api/users/:id — ADMIN
router.put('/:id', requireRole(Role.ADMIN), requirePermission('USER_UPDATE'), async (req, res) => {
  const parsed = upsertSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalide', details: parsed.error.flatten() });
  const data = { ...parsed.data } as any;
  data.updatedBy = req.user!.id;
  if (data.password) data.passwordHash = await bcrypt.hash(data.password, config.bcryptRounds);
  delete data.password;
  const u = await prisma.user.update({ where: { id: req.params.id }, data, select: { id: true, email: true, username: true, fullName: true, role: true, isActive: true } });
  auditLog({ userId: req.user!.id, action: 'USER_UPDATE', entity: 'User', entityId: u.id, req }).catch(() => {});
  res.json(u);
});

// DELETE /api/users/:id — soft delete, ADMIN
router.delete('/:id', requireRole(Role.ADMIN), requirePermission('USER_DELETE'), async (req, res) => {
  await prisma.user.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), updatedBy: req.user!.id } as any });
  auditLog({ userId: req.user!.id, action: 'USER_DELETE', entity: 'User', entityId: req.params.id, req }).catch(() => {});
  res.json({ message: 'Utilisateur désactivé (soft delete)' });
});

export default router;
