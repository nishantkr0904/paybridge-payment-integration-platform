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

Returns merchant profile with real-time payment summary.

```json
{
  "user": {
    "id": 1,
    "email": "merchant@example.com",
    "merchantName": "Demo Merchant",
    "roles": ["merchant"]
  },
  "summary": {
    "totalTransactions": 5,
    "successfulPayments": 3,
    "failedPayments": 1,
    "pendingPayments": 1
  }
}
```

## Payments

All payment endpoints require `Authorization: Bearer <accessToken>`.

Write endpoints (`POST /api/payments/orders`, `POST /api/payments/orders/:orderRef/pay`) support an optional `Idempotency-Key` header to safely retry requests without producing duplicate side effects.

### Create checkout order

`POST /api/payments/orders`

Headers:
- `Idempotency-Key` *(optional)* — Unique client key (1–255 chars) for safe retries.

```json
{
  "amount": 999.50,
  "currency": "INR",
  "description": "Premium subscription",
  "customerEmail": "buyer@example.com",
  "metadata": { "planId": "pro" }
}
```

Required fields: `amount` (positive number).

Optional fields: `currency` (3-char, defaults to INR), `description`, `customerEmail`, `metadata`.

Response: `201 Created`

```json
{
  "id": 1,
  "merchantId": 1,
  "orderRef": "01M0AJX6JAD1K8PX8AXXXWJDHS",
  "amount": 999.50,
  "currency": "INR",
  "description": "Premium subscription",
  "status": "pending",
  "customerEmail": "buyer@example.com",
  "metadata": { "planId": "pro" },
  "createdAt": "2026-08-18T14:02:50.831Z",
  "updatedAt": "2026-08-18T14:02:50.831Z"
}
```

### Process payment

`POST /api/payments/orders/:orderRef/pay`

Headers:
- `Idempotency-Key` *(optional)* — Unique client key (1–255 chars) for safe retries.

```json
{
  "paymentMethod": "upi"
}
```

Accepted values for `paymentMethod`: `card`, `upi`, `netbanking`, `wallet`.

Payment is simulated with an 80% success rate.

Failed orders can be retried. Successfully paid orders reject further payment attempts.

Response: `200 OK`

```json
{
  "orderRef": "01M0AJX6JAD1K8PX8AXXXWJDHS",
  "txnRef": "01M0AJX6N6SPVYPE0T9EHPGD5F",
  "status": "success",
  "paymentMethod": "upi",
  "amount": 999.50,
  "currency": "INR",
  "gatewayResponse": {
    "provider": "paybridge-sim",
    "method": "upi",
    "authCode": "01M0AJXVB4NP",
    "processedAt": "2026-08-18T14:03:12.100Z"
  },
  "failureReason": null
}
```

### Get order status

`GET /api/payments/orders/:orderRef`

Returns order details and all transaction attempts.

Response: `200 OK`

```json
{
  "order": { ... },
  "transactions": [
    {
      "id": 1,
      "orderId": 1,
      "txnRef": "01M0AJX6N6SPVYPE0T9EHPGD5F",
      "paymentMethod": "upi",
      "status": "success",
      "gatewayResponse": { ... },
      "failureReason": null,
      "amount": 999.50,
      "createdAt": "2026-08-18T08:32:50.000Z",
      "updatedAt": "2026-08-18T08:32:50.000Z"
    }
  ]
}
```

### List merchant orders

`GET /api/payments/orders`

Query parameters:

- `status` — filter by order status (`pending`, `processing`, `success`, `failed`)
- `page` — page number (default: 1)
- `limit` — results per page (default: 20, max: 100)

Response: `200 OK`

```json
{
  "orders": [ ... ],
  "total": 42
}
```

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description."
  }
}
```

### Payment error codes

- `ORDER_NOT_FOUND` — order reference does not exist
- `ORDER_FORBIDDEN` — order belongs to a different merchant
- `ORDER_ALREADY_PAID` — order has already been successfully paid
- `ORDER_PROCESSING` — a payment is currently being processed
- `VALIDATION_ERROR` — request body failed schema validation
- `IDEMPOTENCY_KEY_MISMATCH` — idempotency key was previously used with a different request payload
- `IDEMPOTENCY_IN_PROGRESS` — a request with this idempotency key is currently in progress
- `INVALID_IDEMPOTENCY_KEY` — idempotency key format or length is invalid
