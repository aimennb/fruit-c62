import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma';
import { verifyAccessToken } from './tokens';
import { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  role: Role;
  email: string;
  username: string;
  fullName: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

/** Extrait le Bearer token du header Authorization. */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    return header.substring(7);
  }
  return null;
}

/** Middleware : requiert un utilisateur authentifié (access token valide). */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: 'Non authentifié', message: 'Token d\'accès manquant' });
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    // Charger l'utilisateur pour s'assurer qu'il existe toujours et est actif.
    prisma.user
      .findUnique({ where: { id: payload.sub } })
      .then((user) => {
        if (!user || !user.isActive || user.deletedAt) {
          res.status(401).json({ error: 'Compte inactif ou supprimé' });
          return;
        }
        req.user = {
          id: user.id,
          role: user.role,
          email: user.email,
          username: user.username,
          fullName: user.fullName,
        };
        next();
      })
      .catch(() => {
        res.status(401).json({ error: 'Non authentifié' });
      });
  } catch {
    res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

/** Middleware : requiert un ou plusieurs rôles. */
export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Non authentifié' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        error: 'Accès refusé',
        message: `Rôle requis: ${roles.join(' ou ')}. Votre rôle: ${req.user.role}`,
      });
      return;
    }
    next();
  };
}

/**
 * Middleware : requiert une permission granulaire (ex: "USER_DELETE").
 * Les permissions sont résolues à partir du rôle de l'utilisateur via RolePermission.
 */
export function requirePermission(...codes: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Non authentifié' });
      return;
    }
    try {
      const perms = await prisma.permission.findMany({
        where: {
          code: { in: codes },
          rolePermissions: { some: { role: req.user.role } },
        },
        select: { code: true },
      });
      const ok = codes.every((c) => perms.some((p) => p.code === c));
      if (!ok) {
        res.status(403).json({
          error: 'Permission refusée',
          message: `Permission(s) requise(s): ${codes.join(', ')}`,
        });
        return;
      }
      next();
    } catch {
      res.status(500).json({ error: 'Erreur de vérification de permission' });
    }
  };
}
