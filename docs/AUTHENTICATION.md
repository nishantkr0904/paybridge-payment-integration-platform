# Authentication

PayBridge uses JWT authentication for merchant portal access, API interactions, and recovery operations.

## Identity Architecture

Merchants are registered and authenticated directly via the `users` table:
- `users.id` acts as the canonical `merchantId` throughout the application.
- Each user has a `merchant_name`, `email`, `password_hash`, and associated roles via `roles` and `user_roles`.
- Multi-tenancy is enforced at the repository SQL boundary using `users.id` / `merchant_id`.

## Authentication Flow

1. **Registration & Login**: Merchant registers (`POST /api/auth/register`) or logs in (`POST /api/auth/login`).
2. **Token Issuance**: The server issues a pair of JSON Web Tokens:
   - **Access Token**: Short-lived (default **15 minutes**, `JWT_ACCESS_EXPIRES_IN`), carrying user identity (`sub`), email, merchant name, and roles.
   - **Refresh Token**: Long-lived (default **7 days**, `JWT_REFRESH_EXPIRES_IN`), stored securely as a SHA-256 hash in `refresh_tokens`.
3. **Authenticated Ingress**: Clients include the access token in HTTP request headers:
   ```http
   Authorization: Bearer <access_token>
   ```
4. **Token Refresh**: When the access token expires, clients call `POST /api/auth/refresh` with `{ "refreshToken": "<token>" }`. The server validates the signature, looks up the active hash in MySQL, rotates the refresh token, and issues a fresh access/refresh pair.
5. **Logout / Session Teardown**: Logout is client-side and stateless; clients drop the stored tokens from local storage / memory. Stored refresh tokens can be invalidated in the database.

## Endpoints

| Method | Path | Auth Required | Description |
|---|---|---|---|
| `POST` | `/api/auth/register` | No | Registers new merchant user; returns user profile and token pair. |
| `POST` | `/api/auth/login` | No | Authenticates merchant via email/password; returns user profile and token pair. |
| `POST` | `/api/auth/refresh` | No | Rotates refresh token and issues a new access token. |
| `GET` | `/api/merchants/me` | Yes (Bearer) | Returns authenticated merchant profile, role, and live summary counts. |

## Tables

- `users`: Core merchant user accounts (`id`, `email`, `password_hash`, `merchant_name`, `is_active`).
- `roles`: Role definitions (`id`, `name`).
- `user_roles`: Mapping between users and assigned roles.
- `refresh_tokens`: Stored SHA-256 token hashes, user foreign key, expiration timestamps, and revocation flags.

## Error Codes

- `AUTH_EMAIL_EXISTS`: Registration attempted with an email already present in `users`.
- `AUTH_INVALID_CREDENTIALS`: Incorrect email or password supplied to `/login`.
- `AUTH_TOKEN_MISSING`: Missing `Authorization: Bearer` header on protected route.
- `AUTH_TOKEN_INVALID`: Expired, malformed, or signature-mismatched JWT access token.
- `AUTH_REFRESH_INVALID`: Expired or malformed refresh token signature.
- `AUTH_REFRESH_REVOKED`: Refresh token hash revoked or not found in `refresh_tokens`.
- `AUTH_USER_INACTIVE`: Account disabled or flagged inactive.
