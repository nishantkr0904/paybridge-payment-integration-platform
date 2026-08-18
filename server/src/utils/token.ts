import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import type { AuthUser } from '../types/auth.js';

type JwtPayload = {
  sub: string;
  email: string;
  merchantName: string;
  roles: string[];
};

export function signAccessToken(user: AuthUser): string {
  const expiresIn = env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'];

  return jwt.sign(
    {
      email: user.email,
      merchantName: user.merchantName,
      roles: user.roles
    },
    env.JWT_ACCESS_SECRET,
    {
      subject: String(user.id),
      expiresIn
    }
  );
}

export function signRefreshToken(user: AuthUser): string {
  const expiresIn = env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'];

  return jwt.sign({}, env.JWT_REFRESH_SECRET, {
    subject: String(user.id),
    expiresIn
  });
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtPayload;

  return {
    id: Number(payload.sub),
    email: payload.email,
    merchantName: payload.merchantName,
    roles: payload.roles ?? []
  };
}

export function verifyRefreshToken(token: string): number {
  const payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtPayload;
  return Number(payload.sub);
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
