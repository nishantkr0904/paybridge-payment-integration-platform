# Authentication

PayBridge Version 1 uses JWT authentication for merchant portal access.

## Flow

1. Merchant registers or logs in.
2. Server returns an access token and refresh token.
3. Client sends the access token as `Authorization: Bearer <token>`.
4. Protected routes reject missing, invalid, or expired access tokens.
5. Refresh tokens are stored as SHA-256 hashes and rotated when refreshed.

## Tables

- `users`
- `roles`
- `user_roles`
- `refresh_tokens`

## Error Codes

- `AUTH_EMAIL_EXISTS`
- `AUTH_INVALID_CREDENTIALS`
- `AUTH_TOKEN_MISSING`
- `AUTH_TOKEN_INVALID`
- `AUTH_REFRESH_INVALID`
- `AUTH_REFRESH_REVOKED`
- `AUTH_USER_INACTIVE`
