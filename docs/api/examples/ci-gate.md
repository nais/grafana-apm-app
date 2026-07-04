# CI gate: fail a deploy on new issue fingerprints

This is a runnable-shaped GitHub Actions job that queries the plugin's `/issues`
endpoint **after** a deploy and fails the pipeline if the release introduced
**new** unresolved issue fingerprints that were not present before the deploy.

It uses the **stable** `/issues` endpoint (see
[issues.md](../issues.md)) and a **Grafana service account token**.

## How it works

1. Before deploying, snapshot the current set of issue fingerprints for the
   service (the "baseline").
2. Deploy.
3. Wait for the observation window to fill, then snapshot again.
4. Any fingerprint present *after* but not *before* is a **new** issue — fail the
   job and print it.

This mirrors the `new-exceptions` semantics of the
[`new-exceptions` alert template](../alert-templates.md): a fingerprint absent in
the prior window and present now is treated as new. (Like that alert, this is an
approximate, stateless comparison — it compares two point-in-time snapshots, so a
long-dormant issue re-appearing will register as "new".)

## Secrets / configuration

| Variable | Meaning |
| --- | --- |
| `GRAFANA_URL` | Base Grafana URL, e.g. `https://grafana.example.nais.io`. |
| `GRAFANA_SA_TOKEN` | Grafana **service account token** with Viewer on the org. |

Create the service account in Grafana (Administration → Service accounts → Add
service account → add token) and store the token as a repository/environment
secret. Viewer is sufficient for reading `/issues`.

## Workflow

```yaml
name: deploy-with-apm-gate

on:
  push:
    branches: [main]

env:
  NAMESPACE: fager
  SERVICE: min-side-arbeidsgiver
  ENVIRONMENT: prod
  # How long to observe for new issues after deploy.
  OBSERVE_MINUTES: "15"

jobs:
  deploy-and-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Baseline: fingerprints present before the deploy.
      - name: Snapshot baseline issue fingerprints
        env:
          GRAFANA_URL: ${{ secrets.GRAFANA_URL }}
          GRAFANA_SA_TOKEN: ${{ secrets.GRAFANA_SA_TOKEN }}
        run: |
          now=$(date +%s)
          from=$((now - 3600))
          curl -sf \
            -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
            "$GRAFANA_URL/api/plugins/nais-apm-app/resources/services/$NAMESPACE/$SERVICE/issues?environment=$ENVIRONMENT&from=$from&to=$now" \
            | jq -r '.issues[].fingerprint' | sort -u > baseline.txt
          echo "Baseline fingerprints:"; cat baseline.txt

      # 2. Deploy your app here (nais/deploy-action, etc.).
      - name: Deploy
        run: echo "…run your real deploy step here…"

      # 3. Let the observation window fill.
      - name: Wait for observation window
        run: sleep "$(( OBSERVE_MINUTES * 60 ))"

      # 4. Compare: fail on fingerprints new since the baseline.
      - name: Gate on new issue fingerprints
        env:
          GRAFANA_URL: ${{ secrets.GRAFANA_URL }}
          GRAFANA_SA_TOKEN: ${{ secrets.GRAFANA_SA_TOKEN }}
        run: |
          now=$(date +%s)
          from=$(( now - OBSERVE_MINUTES * 60 ))
          curl -sf \
            -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
            "$GRAFANA_URL/api/plugins/nais-apm-app/resources/services/$NAMESPACE/$SERVICE/issues?environment=$ENVIRONMENT&from=$from&to=$now" \
            | jq -r '.issues[].fingerprint' | sort -u > current.txt
          echo "Current fingerprints:"; cat current.txt

          # Fingerprints present now but not in the baseline.
          new_fps=$(comm -13 baseline.txt current.txt)

          if [ -n "$new_fps" ]; then
            echo "::error::New issue fingerprints introduced by this release:"
            echo "$new_fps"
            # Print titles for the new fingerprints for a friendlier log.
            curl -sf \
              -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
              "$GRAFANA_URL/api/plugins/nais-apm-app/resources/services/$NAMESPACE/$SERVICE/issues?environment=$ENVIRONMENT&from=$from&to=$now" \
              | jq -r --argjson fps "$(printf '%s\n' "$new_fps" | jq -R . | jq -s .)" \
                  '.issues[] | select(.fingerprint as $f | $fps | index($f)) | "  \(.fingerprint)  \(.title)  (count=\(.count), sessions=\(.sessions))"'
            exit 1
          fi

          echo "No new issue fingerprints — gate passed."
```

## Notes and tuning

- **Ignore triaged issues.** To avoid failing on issues a human has already
  acknowledged, subtract resolved/ignored fingerprints using the stable
  `/triage` endpoint:

  ```bash
  curl -sf -H "Authorization: Bearer $GRAFANA_SA_TOKEN" \
    "$GRAFANA_URL/api/plugins/nais-apm-app/resources/services/$NAMESPACE/$SERVICE/triage" \
    | jq -r '.states | to_entries[] | select(.value.status != "active") | .key' \
    | sort -u > triaged.txt
  # then: comm -13 <(sort -u baseline.txt triaged.txt) current.txt
  ```

- **Browser-only gate.** Restrict to frontend exceptions by hitting
  `/exceptions/groups` (also stable) instead of `/issues`.

- **Caching.** Responses are cached ~30 s server-side; the observation `sleep`
  is far longer, so caching does not affect the gate. If you poll in a tight
  loop, look for the plugin's `X-Cache: HIT` header (note Grafana also injects
  its own `X-Cache: DISABLED`; see the [README](../README.md#the-x-cache-header)).

- **Auth 401/403.** Confirm the token is a *Grafana service account* token (not a
  nais or cloud token) and the account has at least Viewer on the org the plugin
  is installed in.
