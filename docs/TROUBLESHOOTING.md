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
