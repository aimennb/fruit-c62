import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../prisma';
import { config } from '../config';
import { auditLog } from './audit';
import { loginRateLimit, registerLoginFailure, resetLoginAttempts } from './rateLimit';
import { getUserPermissionsDetail } from './permissions';
import {
  signAccessToken,
  createRefreshSession,
  rotateRefreshSession,
  revokeSession,
  verifyAccessToken,
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_OPTS,
} from './tokens';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * POST /api/auth/login
 * Retourne un access token (JSON) et pose un refresh cookie httpOnly.
 */
router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Champs invalides', details: parsed.error.flatten() });
    return;
  }
  const { username, password } = parsed.data;

  const user = await prisma.user.findFirst({
    where: { username, deletedAt: null },
  });

  if (!user || !user.isActive) {
    registerLoginFailure(req.ip ?? 'unknown');
    auditLog({ userId: user?.id ?? null, action: 'LOGIN_FAILED', details: { username, reason: 'no_user' }, req }).catch(() => {});
    res.status(401).json({ error: 'Identifiants invalides' });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    registerLoginFailure(req.ip ?? 'unknown');
    auditLog({ userId: user.id, action: 'LOGIN_FAILED', details: { username, reason: 'bad_password' }, req }).catch(() => {});
    res.status(401).json({ error: 'Identifiants invalides' });
    return;
  }

  resetLoginAttempts(req.ip ?? 'unknown');
  const accessToken = signAccessToken(user.id, user.role);
  const { token: refreshToken } = await createRefreshSession({
    userId: user.id,
    ip: req.ip,
    userAgent: req.headers['user-agent'],
  });

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  auditLog({ userId: user.id, action: 'LOGIN_SUCCESS', req }).catch(() => {});

  res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTS);
  res.json({
    accessToken,
    tokenType: 'Bearer',
    expiresIn: config.jwtAccessExpiresIn,
    user: {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      email: user.email,
    },
  });
});

/**
 * POST /api/auth/refresh
 * Lit le refresh cookie, le rotate, renvoie un nouveau access token + nouveau cookie.
 */
router.post('/refresh', async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    res.status(401).json({ error: 'Refresh token manquant' });
    return;
  }
  try {
    const { userId, newToken } = await rotateRefreshSession(refreshToken);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) {
      res.status(401).json({ error: 'Compte inactif' });
      return;
    }
    const accessToken = signAccessToken(user.id, user.role);
    res.cookie(REFRESH_COOKIE_NAME, newToken, REFRESH_COOKIE_OPTS);
    res.json({
      accessToken,
      tokenType: 'Bearer',
      expiresIn: config.jwtAccessExpiresIn,
      user: { id: user.id, username: user.username, fullName: user.fullName, role: user.role, email: user.email },
    });
  } catch (e) {
    res.status(401).json({ error: 'Refresh échoué', message: (e as Error).message });
  }
});

/**
 * POST /api/auth/logout
 * Révoque la session liée au refresh cookie.
 */
router.post('/logout', async (req: Request, res: Response) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(refreshToken);
      if (decoded?.jti) await revokeSession(decoded.jti);
    } catch {
      /* ignore */
    }
  }
  res.clearCookie(REFRESH_COOKIE_NAME, REFRESH_COOKIE_OPTS);
  res.json({ message: 'Déconnexion réussie' });
});

/**
 * GET /api/auth/me
 * Renvoie le profil de l'utilisateur authentifié + ses permissions.
 */
router.get('/me', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Non authentifié' });
    return;
  }
  const token = authHeader.substring(7);
  try {
    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: { sessions: { where: { revokedAt: null } } },
    });
    if (!user || user.deletedAt) {
      res.status(401).json({ error: 'Utilisateur introuvable' });
      return;
    }
    // Permissions EFFECTIVES : rôle MOINS DENY user PLUS GRANT user.
    const perms = await getUserPermissionsDetail(user.id, user.role);
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      permissions: perms.map((p) => p.code),
      permissionsDetail: perms,
    });
  } catch {
    res.status(401).json({ error: 'Token invalide' });
  }
});

export default router;
