# API Documentation

## Health

`GET /api/health`

Returns service health.

## Authentication

`POST /api/auth/register`

```json
{
  "email": "merchant@example.com",
  "password": "password123",
  "merchantName": "Demo Merchant"
}
```

`POST /api/auth/login`

```json
{
  "email": "merchant@example.com",
  "password": "password123"
}
```

`POST /api/auth/refresh`

```json
{
  "refreshToken": "refresh-token"
}
```

## Merchant

`GET /api/merchants/me`

Requires `Authorization: Bearer <accessToken>`.
