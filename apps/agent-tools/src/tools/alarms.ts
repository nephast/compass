import {
  CloudWatchClient,
  DescribeAlarmsCommand,
  type StateValue,
} from "@aws-sdk/client-cloudwatch";
import type { Tool } from "./types.js";

export interface AlarmInput {
  state?: StateValue;
  namePrefix?: string;
}

export function alarmsTool(client = new CloudWatchClient({})): Tool<AlarmInput> {
  return {
    readOnly: true,
    spec: {
      name: "get_cloudwatch_alarm_status",
      description:
        "CloudWatch alarms in this account and region, optionally filtered by state or name prefix. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string", enum: ["OK", "ALARM", "INSUFFICIENT_DATA"] },
          // Bounded charset: this string reaches an AWS API call, and the
          // model's arguments are untrusted input like any other.
          namePrefix: { type: "string", pattern: "^[A-Za-z0-9_./-]{1,64}$" },
        },
        additionalProperties: false,
      },
    },
    async execute({ state, namePrefix }) {
      const response = await client.send(
        new DescribeAlarmsCommand({
          MaxRecords: 50,
          ...(state ? { StateValue: state } : {}),
          ...(namePrefix ? { AlarmNamePrefix: namePrefix } : {}),
        }),
      );
      const alarms = [...(response.MetricAlarms ?? []), ...(response.CompositeAlarms ?? [])].map(
        (alarm) => ({
          name: alarm.AlarmName,
          state: alarm.StateValue,
          reason: alarm.StateReason?.slice(0, 200),
          since: alarm.StateUpdatedTimestamp?.toISOString(),
        }),
      );
      return {
        count: alarms.length,
        inAlarm: alarms.filter((a) => a.state === "ALARM").length,
        alarms,
      };
    },
  };
}
