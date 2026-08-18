import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';
import { HttpError } from '../../utils/http-error.js';
import { hashToken, signAccessToken, signRefreshToken, verifyRefreshToken } from '../../utils/token.js';
import {
  createMerchantUser,
  findActiveRefreshToken,
  findUserByEmail,
  findUserById,
  revokeRefreshToken,
  storeRefreshToken
} from './auth.repository.js';

function refreshExpiryDate(): Date {
  const days = env.JWT_REFRESH_EXPIRES_IN.endsWith('d')
    ? Number(env.JWT_REFRESH_EXPIRES_IN.replace('d', ''))
    : 7;
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
}

async function issueTokens(user: Awaited<ReturnType<typeof findUserById>> & { id: number }) {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user);

  await storeRefreshToken({
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt: refreshExpiryDate()
  });

  return {
    user,
    accessToken,
    refreshToken
  };
}

export async function registerMerchant(input: {
  email: string;
  password: string;
  merchantName: string;
}) {
  const existingUser = await findUserByEmail(input.email);
  if (existingUser) {
    throw new HttpError(409, 'AUTH_EMAIL_EXISTS', 'A merchant account already exists for this email.');
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const user = await createMerchantUser({
    email: input.email,
    passwordHash,
    merchantName: input.merchantName
  });

  return issueTokens(user);
}

export async function loginMerchant(input: { email: string; password: string }) {
  const user = await findUserByEmail(input.email);
  if (!user) {
    throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  const passwordMatches = await bcrypt.compare(input.password, user.passwordHash);
  if (!passwordMatches) {
    throw new HttpError(401, 'AUTH_INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }

  return issueTokens(user);
}

export async function refreshMerchantSession(refreshToken: string) {
  let userId: number;

  try {
    userId = verifyRefreshToken(refreshToken);
  } catch {
    throw new HttpError(401, 'AUTH_REFRESH_INVALID', 'Refresh token is invalid or expired.');
  }

  const tokenHash = hashToken(refreshToken);
  const storedToken = await findActiveRefreshToken(tokenHash);
  if (!storedToken || storedToken.userId !== userId) {
    throw new HttpError(401, 'AUTH_REFRESH_REVOKED', 'Refresh token is no longer active.');
  }

  const user = await findUserById(userId);
  if (!user) {
    throw new HttpError(401, 'AUTH_USER_INACTIVE', 'Merchant account is inactive.');
  }

  await revokeRefreshToken(tokenHash);
  return issueTokens(user);
}
