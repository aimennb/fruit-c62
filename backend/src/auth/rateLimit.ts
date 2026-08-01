import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { auditLog } from './audit';

/**
 * Limiteur de tentatives de connexion simple, en mémoire (process-local).
 * 5 essais / 15 min par IP. Pour un déploiement multi-instance, utiliser Redis
 * (hors scope Phase A : serveur local mono-process).
 */
const attempts = new Map<string, { count: number; firstAt: number }>();

export function loginRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const entry = attempts.get(ip);

  if (!entry || now - entry.firstAt > config.loginWindowMs) {
    attempts.set(ip, { count: 0, firstAt: now });
  } else if (entry.count >= config.maxLoginAttempts) {
    const retryAfterMs = entry.firstAt + config.loginWindowMs - now;
    auditLog({ action: 'LOGIN_RATE_LIMITED', req }).catch(() => {});
    res.status(429).json({
      error: 'Trop de tentatives',
      message: `Compte verrouillé temporairement. Réessayez dans ${Math.ceil(retryAfterMs / 1000)}s.`,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    });
    return;
  }
  next();
}

/** Incrémente le compteur d'échecs pour une IP. */
export function registerLoginFailure(ip: string): void {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAt > config.loginWindowMs) {
    attempts.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count += 1;
    attempts.set(ip, entry);
  }
}

/** Réinitialise le compteur en cas de succès. */
export function resetLoginAttempts(ip: string): void {
  attempts.delete(ip);
}
