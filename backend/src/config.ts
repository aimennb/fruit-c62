import dotenv from 'dotenv';
dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Variable d'environnement manquante: ${name}`);
  }
  return v;
}

export const config = {
  port: parseInt(process.env.PORT ?? '8080', 10),
  databaseUrl: required('DATABASE_URL'),
  corsOrigin: (process.env.CORS_ORIGIN ?? '*').split(',').map((s) => s.trim()),
  jwtSecret: required('JWT_SECRET'),
  jwtRefreshSecret: required('JWT_REFRESH_SECRET'),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '10', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // anti-force brute : 5 essais / 15 min par IP
  maxLoginAttempts: 5,
  loginWindowMs: 15 * 60 * 1000,
};

export type AppConfig = typeof config;
