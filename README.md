# RCM AI Backend

## Production Deployment Checklist & Migration Policy

> **CRITICAL DEPLOYMENT NOTE:**
> "Any PR that adds a migration file must run `npm run migrate` against production before/during deploy — it does not happen automatically."

### Automated Migration Pipeline (Recommendation)
To close the process gap permanently and avoid relying solely on human memory, migrations can be wired into the deployment pipeline as an automatic pre-start or release step (e.g., in CI/CD workflows, GitHub Actions, or PaaS deployment scripts like `render.yaml` or Procfile):

```json
"release": "npm run migrate"
```
Or executed as part of the container startup / deployment script before `npm start`.

## Social video sync

Instagram Reels and YouTube Shorts scraping/syncing run outside this API in the sibling `../rcm-reels-worker` directory. Run that local worker with `npm start` there; it connects directly to the shared TiDB database. The backend retains the existing admin and user read/CRUD routes and does not start social scraping or sync schedules.
