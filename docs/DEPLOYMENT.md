# Production deployment checklist

Set the variables in `.env.example` through the deployment secret manager. Do not commit real values.

- Use `NODE_ENV=production` and `APP_DEPLOYMENT_MODE=production`.
- Use a dedicated MongoDB database; `courier_testing` and `test` are rejected.
- Use a new JWT secret of at least 32 characters.
- Set exact HTTPS frontend origins in `CORS_ALLOWED_ORIGINS`; wildcards are rejected.
- Configure the production Delhivery base URL and rotated token.
- Keep `MOCK_COURIER_ADAPTER_ENABLED=false`.
- Enable carrier mutation flags only after explicit client approval.
- Build the frontend with `VITE_API_BASE_URL` set to the deployed HTTPS backend `/api` URL.
- Verify `/health/live` and `/health/ready` after startup.
- Confirm development-only diagnostic and mock routes are absent in production.
