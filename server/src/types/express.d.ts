import type { AuthUser } from './auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      correlationId?: string;
      id?: string;
    }
  }
}
