# CI/CD

The workflow lives at the repository root in `.github/workflows/ci-cd.yml`. It runs backend tests (with a temporary MySQL service), the frontend production build, and both Docker image builds on every pull request targeting `main` and every push to `main`. The staging job runs after those checks pass when `STAGING_DEPLOY_ENABLED` is set to `true`.

## Enable staging deployment

In the GitHub repository settings, add these repository secrets:

| Secret | Value |
| --- | --- |
| `STAGING_HOST` | Staging server hostname or IP address |
| `STAGING_USER` | SSH account allowed to run Docker Compose |
| `STAGING_SSH_KEY` | Private SSH key for that account |
| `STAGING_KNOWN_HOSTS` | Verified `known_hosts` entry for the staging server |

Add these repository variables:

| Variable | Value |
| --- | --- |
| `STAGING_DEPLOY_ENABLED` | `true` to enable automatic deployment |
| `STAGING_DEPLOY_PATH` | Absolute path to the server-side Git checkout |

`STAGING_DEPLOY_PATH` should point to the repository checkout root. The server checkout must have the GitHub repository as `origin`, Docker Engine with the Compose plugin, a valid `Azcentrix_Connect-main/backend/.env`, and the external networks named in `Azcentrix_Connect-main/docker-compose.staging.yml`. The workflow checks out the tested commit in that directory, builds both images there, and recreates the staging services. The SSH account needs permission to run Docker commands.

The Compose file currently bind-mounts `/home/ascent/crm-docker-staging/main.staging.py` over the backend image's `app/main.py`. That server-side file takes precedence over the checked-out backend entry point and must be kept in sync when deploying changes to the application entry point. The uploads and media volumes persist across deployments.

Keep `STAGING_DEPLOY_ENABLED` unset or set to `false` to run CI without deploying. Pull requests never deploy. Manual workflow runs deploy only when run against `main` and the variable is enabled.
