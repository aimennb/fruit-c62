import { prisma } from '../prisma';
import { Role } from '@prisma/client';

export interface PermDetail {
  code: string;
  label: string;
  module: string;
}

/**
 * Permissions EFFECTIVES d'un utilisateur :
 *   perms(rôle)  MOINS  overrides DENY de l'user  PLUS  overrides GRANT de l'user.
 * Un utilisateur sans aucun UserPermission conserve exactement les perms de son rôle
 * (aucune régression pour les autres comptes).
 */
export async function getUserPermissionsDetail(
  userId: string,
  role: Role,
): Promise<PermDetail[]> {
  const [rolePerms, overrides] = await Promise.all([
    prisma.permission.findMany({
      where: { rolePermissions: { some: { role } } },
      select: { code: true, label: true, module: true },
    }),
    prisma.userPermission.findMany({
      where: { userId },
      select: {
        type: true,
        permission: { select: { code: true, label: true, module: true } },
      },
    }),
  ]);

  const denied = new Set(
    overrides.filter((o) => o.type === 'DENY').map((o) => o.permission.code),
  );
  const map = new Map<string, PermDetail>();
  for (const p of rolePerms) {
    if (!denied.has(p.code)) map.set(p.code, p);
  }
  for (const o of overrides) {
    if (o.type === 'GRANT') map.set(o.permission.code, o.permission);
  }
  return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
}

/** Codes de permissions effectives. */
export async function getUserPermissions(userId: string, role: Role): Promise<string[]> {
  return (await getUserPermissionsDetail(userId, role)).map((p) => p.code);
}
