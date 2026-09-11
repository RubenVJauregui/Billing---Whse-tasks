# WISE Assigned Tasks

Standalone Next.js dashboard for facility-scoped WISE assigned tasks.

## Configuration

For local development, copy `.env.example` to `.env.local`. For Ibis, configure these as container runtime environment variables rather than Docker build arguments or image contents.

| Variable | Required | Secret | Purpose |
| --- | --- | --- | --- |
| `ITEMGPT_BASE_URL` | Yes (preferred) | No | Server-side ItemGPT BFF origin used for password grant and token refresh. |
| `NEXT_PUBLIC_BASE_URL` | Compatibility only | No | Existing ItemGPT BFF origin; used only when `ITEMGPT_BASE_URL` is absent. |
| `WMS_API_BASE_URL` | Yes | No | WMS API origin used after sign-in. |
| `BNP_BASE_URL` | Yes | No | Server-side BNP BillPay origin. Configure as `https://bnp.unisco.com`. |
| `BNP_USERNAME` | Yes | Yes | Server-only BNP service username used for read-only price-list access. |
| `BNP_PASSWORD` | Yes | Yes | Server-only BNP service password used for read-only price-list access. |
| `DEFAULT_WMS_TENANT_ID` | No | No | Login tenant; defaults to `LT`. |
| `DEFAULT_WMS_FACILITY_ID` | No | No | Initial facility hint; defaults to Valley View (`LT_F1`) and falls back to the first accessible facility. |
| `DEFAULT_WMS_TIMEZONE` | No | No | Initial timezone hint; defaults to `America/Los_Angeles` until facility metadata is loaded. |

Production must provide `ITEMGPT_BASE_URL`, unless the deployment already provides the ItemGPT BFF origin as `NEXT_PUBLIC_BASE_URL`. If both are present, `ITEMGPT_BASE_URL` takes precedence.

Production must also provide `BNP_BASE_URL`, `BNP_USERNAME`, and `BNP_PASSWORD`. Keep the BNP credentials in deployment secrets and never expose them through `NEXT_PUBLIC_` variables. When BNP is not configured, unreachable, or cannot produce one fully confirmed active/effective price-list match, the dashboard shows `Rate not available at task level` and does not estimate a charge.

The app does not require IAM client credentials. Those secrets remain in the ItemGPT BFF. Do not configure development-only values such as `ITEM_AUTHORIZATION`, `ITEM_IAM_USER_ID`, or user credentials in Ibis.

The tenant, facility, and timezone values are initial defaults only; authenticated facility data determines the selectable scope and each facility's timezone determines its local report date.

## Run

```bash
npm install
npm run build
npm run start -- -H 0.0.0.0 -p 3000
```

Open `http://localhost:3000` and sign in with a WISE account.
