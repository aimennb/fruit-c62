import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '../prisma';
import { config } from '../config';

export interface AccessTokenPayload {
  sub: string; // userId
  role: string;
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  jti: string; // session id (utilisé pour la rotation / révocation)
  type: 'refresh';
}

const ACCESS_SECRET = config.jwtSecret;
const REFRESH_SECRET = config.jwtRefreshSecret;

export function signAccessToken(userId: string, role: string): string {
  const payload: AccessTokenPayload = { sub: userId, role, type: 'access' };
  return jwt.sign(payload, ACCESS_SECRET, {
    expiresIn: config.jwtAccessExpiresIn,
  } as jwt.SignOptions);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, ACCESS_SECRET) as AccessTokenPayload;
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, REFRESH_SECRET) as RefreshTokenPayload;
}

/**
 * Crée une session de refresh + signe le refresh token.
 * Le hash du refresh token (pas le token brut) est stocké en DB (rotation/sécurité).
 */
export async function createRefreshSession(params: {
  userId: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ token: string; jti: string }> {
  const jti = randomBytes(24).toString('hex');
  const token = jwt.sign({ sub: params.userId, jti, type: 'refresh' }, REFRESH_SECRET, {
    expiresIn: config.jwtRefreshExpiresIn,
  } as jwt.SignOptions);

  const expiresAt = jwt.decode(token) as { exp: number };
  const refreshHash = await bcrypt.hash(token, 6);

  await prisma.session.create({
    data: {
      userId: params.userId,
      jti,
      refreshHash,
      ip: params.ip ?? null,
      userAgent: params.userAgent ?? null,
      expiresAt: new Date(expiresAt.exp * 1000),
    },
  });

  return { token, jti };
}

/**
 * Vérifie un refresh token et le révoque (rotation) : on crée une nouvelle session.
 * Renvoie le userId et le nouveau couple token/session.
 */
export async function rotateRefreshSession(refreshToken: string): Promise<{
  userId: string;
  newToken: string;
  newJti: string;
}> {
  const decoded = verifyRefreshToken(refreshToken);
  if (decoded.type !== 'refresh') throw new Error('Type de token invalide');

  const session = await prisma.session.findUnique({ where: { jti: decoded.jti } });
  if (!session) throw new Error('Session introuvable');
  if (session.revokedAt) throw new Error('Session révoquée');
  if (session.expiresAt.getTime() < Date.now()) throw new Error('Session expirée');

  // Vérifier que le token correspond au hash stocké.
  const ok = await bcrypt.compare(refreshToken, session.refreshHash);
  if (!ok) throw new Error('Refresh token invalide');

  // Révoquer l'ancienne session (rotation).
  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const { token, jti } = await createRefreshSession({
    userId: decoded.sub,
    ip: session.ip ?? undefined,
    userAgent: session.userAgent ?? undefined,
  });

  return { userId: decoded.sub, newToken: token, newJti: jti };
}

/** Révoque une session (logout). */
export async function revokeSession(jti: string): Promise<void> {
  await prisma.session.updateMany({
    where: { jti, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export const REFRESH_COOKIE_NAME = 'fruiterie_refresh';
export const REFRESH_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.nodeEnv === 'production',
  path: '/api/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000,
};
