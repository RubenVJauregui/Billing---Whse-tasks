# WISE Assigned Tasks

Standalone Next.js dashboard for facility-scoped WISE assigned tasks.

## Configuration

Copy `.env.example` to `.env.local` and set the ItemGPT and WMS base URLs for the target deployment. The tenant, facility, and timezone values are initial defaults only; authenticated facility data determines the selectable scope and each facility's timezone determines its local report date.

## Run

```bash
npm install
npm run build
npm run start -- -H 0.0.0.0 -p 3000
```

Open `http://localhost:3000` and sign in with a WISE account.
