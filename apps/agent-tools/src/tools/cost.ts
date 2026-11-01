import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";
import type { Tool } from "./types.js";

// Cost Explorer is a global service served from us-east-1 only, whatever
// region the cluster runs in. Each GetCostAndUsage call costs $0.01, which is
// why `days` is capped and the agent's iteration cap matters for spend, not
// just latency.

export interface CostInput {
  days?: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function costTool(
  client = new CostExplorerClient({ region: "us-east-1" }),
): Tool<CostInput> {
  return {
    readOnly: true,
    spec: {
      name: "get_aws_cost_summary",
      description:
        "Unblended AWS cost for this account over the last N days (default 7), total and by service. Read-only.",
      inputSchema: {
        type: "object",
        properties: { days: { type: "integer", minimum: 1, maximum: 31, default: 7 } },
        additionalProperties: false,
      },
    },
    async execute({ days = 7 }) {
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);
      const response = await client.send(
        new GetCostAndUsageCommand({
          // End is exclusive in Cost Explorer, so "today" includes today.
          TimePeriod: { Start: isoDate(start), End: isoDate(new Date(end.getTime() + 86_400_000)) },
          Granularity: "DAILY",
          Metrics: ["UnblendedCost"],
          GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        }),
      );

      const byService = new Map<string, number>();
      let currency = "USD";
      for (const day of response.ResultsByTime ?? []) {
        for (const group of day.Groups ?? []) {
          const metric = group.Metrics?.UnblendedCost;
          const service = group.Keys?.[0] ?? "unknown";
          byService.set(service, (byService.get(service) ?? 0) + Number(metric?.Amount ?? 0));
          currency = metric?.Unit ?? currency;
        }
      }
      const services = [...byService.entries()]
        .map(([service, amount]) => ({ service, amount: Math.round(amount * 100) / 100 }))
        .filter((s) => s.amount > 0)
        .sort((a, b) => b.amount - a.amount);
      const total = services.reduce((sum, s) => sum + s.amount, 0);

      return {
        period: { start: isoDate(start), end: isoDate(end), days },
        currency,
        total: Math.round(total * 100) / 100,
        topServices: services.slice(0, 8),
        note: "Cost Explorer data lags by up to 24 hours.",
      };
    },
  };
}
