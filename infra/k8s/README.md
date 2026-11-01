# infra/k8s

Kustomize manifests for the two EKS services (COMPASS-17). Plain YAML over Helm:
two services, one environment overlay, no templating logic worth a chart.

```
base/                 namespace (PSA restricted), api, agent-tools, network policies
overlays/dev/         config + IRSA ARNs, generated from SSM at deploy time
```

## Deploy

```bash
scripts/k8s-deploy.sh dev <git-sha>
```

reads `/compass/dev/*` from SSM into the overlay's gitignored `config.env` /
`irsa.env`, pins both images to `<registry>/compass-*:<git-sha>`, applies, and waits
for both rollouts.

## What the acceptance criteria rest on

| Criterion | Mechanism |
|---|---|
| sane resource usage in `kubectl top pods` | requests sized from idle usage; memory limits with headroom; metrics-server add-on |
| killing a pod → clean, fast replacement | 2 replicas spread across nodes, readiness gate, `maxUnavailable: 0`, PDB `minAvailable: 1` |
| no cascading failure | probes hit `/healthz`, which touches no dependency |
| HPA on CPU | 2 → 4 replicas at 70% of request, 5-minute scale-down window |

Try it:

```bash
kubectl -n compass delete pod -l app.kubernetes.io/name=api --wait=false \
  --field-selector=status.phase=Running | head -1
kubectl -n compass get pods -w     # replacement Ready in ~10s, the other replica keeps serving
kubectl -n compass top pods
```

## Security posture

- Namespace enforces Pod Security **restricted**: non-root, no privilege escalation,
  all capabilities dropped, RuntimeDefault seccomp, read-only root filesystem.
- **Default-deny ingress**; api admitted from the VPC on 8080, agent-tools from api
  pods only (enforced by the VPC CNI network policy agent, enabled in `modules/eks`).
- Each service has its own IRSA role (created by CDK, `infra/cdk/lib/irsa.ts`); the
  nodes' IMDS hop limit means pods cannot fall back to the node role.
