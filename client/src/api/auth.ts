import { api } from './client';

export type AuthUser = {
  id: number;
  email: string;
  merchantName: string;
  roles: string[];
};

export type AuthResponse = {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
};

export async function loginMerchant(input: {
  email: string;
  password: string;
}): Promise<AuthResponse> {
  const response = await api.post<AuthResponse>('/auth/login', input);
  return response.data;
}

export async function registerMerchant(input: {
  email: string;
  password: string;
  merchantName: string;
}): Promise<AuthResponse> {
  const response = await api.post<AuthResponse>('/auth/register', input);
  return response.data;
}
