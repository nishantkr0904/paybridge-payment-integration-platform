# Troubleshooting

## Docker daemon is not running

If `docker compose up -d mysql` fails with a Docker socket error, start Docker Desktop and retry.

## MySQL connection fails

Confirm the container is healthy:

```bash
docker compose ps
```

Then test the connection:

```bash
mysql --host=127.0.0.1 --port=3306 --user=paybridge --password=change_me --database=paybridge --execute="SELECT 1;"
```

## JWT configuration fails

The server requires JWT secrets with at least 16 characters:

```bash
JWT_ACCESS_SECRET=change_me_access_secret_at_least_32_chars
JWT_REFRESH_SECRET=change_me_refresh_secret_at_least_32_chars
```

## New schema not applied

Docker MySQL init scripts only run when the volume is created for the first time.

If you added a new SQL file (e.g. `002_payment_schema.sql`) but the tables do not exist:

```bash
docker compose down -v
docker compose up -d mysql
```

This destroys existing data. To preserve data, apply the migration manually:

```bash
docker exec -i paybridge-mysql mysql -upaybridge -pchange_me paybridge < database/002_payment_schema.sql
```

## Payment returns ORDER_NOT_FOUND

Ensure the order reference in the URL matches a valid `order_ref` from the `orders` table.

Order references are 26-character ULID strings returned in the `orderRef` field when creating an order.

## Payment returns ORDER_ALREADY_PAID

A successfully paid order cannot be paid again. Create a new order to process another payment.

Failed orders can be retried with any payment method.

## Dashboard shows zero counts

If the dashboard summary tiles show all zeros despite having processed payments, verify:

1. The merchant is logged in with the same account that created the orders.
2. The server is running and connected to MySQL.
3. The `/api/merchants/me` endpoint returns real counts (not hardcoded zeros from Version 1).
