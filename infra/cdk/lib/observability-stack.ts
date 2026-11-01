import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as actions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import type * as logsT from "aws-cdk-lib/aws-logs";
import type * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type * as sfn from "aws-cdk-lib/aws-stepfunctions";
import type { Construct } from "constructs";
import { platform as readPlatform } from "./seam.js";

// COMPASS-29 (dashboard) and COMPASS-30 (alarms).
//
// The dashboard's job is one question: "how many requests failed in the last
// hour, and why" -- answerable without opening a log group. Top row: rates.
// Second row: the WHY, as Logs Insights tables grouped by route and error
// message (api) and by failure reason (ingestion).
//
// Alarms are for failure modes a human must act on, not vanity metrics:
//   - an ingestion execution failed after retries   (the DLQ-depth equivalent)
//   - the api's 5xx rate spiked
//   - a node is not ready
//   - the ingest Lambda is erroring
export class ObservabilityStack extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: StackProps & {
      envName: string;
     
      httpApi: apigw.IHttpApi;
      apiAccessLogs: logs.ILogGroup;
      stateMachine: sfn.IStateMachine;
      ingestFunction: lambda.IFunction;
      ingestLogGroup: logsT.ILogGroup;
      alertEmail?: string | undefined;
    },
  ) {
    super(scope, id, props);
    const { envName } = props;
    const platform = readPlatform(this, envName);
    const window = Duration.minutes(5);

    const topic = new sns.Topic(this, "Alarms", { topicName: `compass-${envName}-alarms` });
    // Never committed: passed as -c alertEmail=... or ALERT_EMAIL at deploy.
    if (props.alertEmail) topic.addSubscription(new subscriptions.EmailSubscription(props.alertEmail));
    const notify = new actions.SnsAction(topic);

    // --- Metrics ------------------------------------------------------------

    const apiMetric = (metricName: string, statistic = "Sum") =>
      new cw.Metric({
        namespace: "AWS/ApiGateway",
        metricName,
        dimensionsMap: { ApiId: props.httpApi.apiId, Stage: "$default" },
        statistic,
        period: window,
      });
    const requests = apiMetric("Count");
    const errors5xx = apiMetric("5xx");
    const errors4xx = apiMetric("4xx");
    const errorRate = new cw.MathExpression({
      expression: "IF(requests > 0, 100 * errors / requests, 0)",
      usingMetrics: { requests, errors: errors5xx },
      label: "5xx rate (%)",
      period: window,
    });

    const sfnMetric = (metricName: string) =>
      new cw.Metric({
        namespace: "AWS/States",
        metricName,
        dimensionsMap: { StateMachineArn: props.stateMachine.stateMachineArn },
        statistic: "Sum",
        period: window,
      });

    const failedNodes = new cw.Metric({
      namespace: "ContainerInsights",
      metricName: "cluster_failed_node_count",
      dimensionsMap: { ClusterName: platform.eks.clusterName },
      statistic: "Maximum",
      period: Duration.minutes(1),
    });

    const appLogGroup = `/aws/containerinsights/compass-${envName}/application`;

    // --- Dashboard ----------------------------------------------------------

    const dashboard = new cw.Dashboard(this, "Dashboard", {
      dashboardName: `compass-${envName}`,
      defaultInterval: Duration.hours(3),
    });

    dashboard.addWidgets(
      new cw.TextWidget({
        markdown: `# Compass ${envName}\nTop: rates. Middle: **why** things failed, from structured logs. Bottom: ingestion.`,
        width: 24,
        height: 2,
      }),
      new cw.GraphWidget({
        title: "API requests / 5 min",
        left: [requests],
        width: 6,
      }),
      new cw.GraphWidget({
        title: "API errors / 5 min",
        left: [errors5xx.with({ label: "5xx" }), errors4xx.with({ label: "4xx" })],
        width: 6,
      }),
      new cw.GraphWidget({
        title: "API 5xx rate (%)",
        left: [errorRate],
        leftYAxis: { min: 0, max: 100 },
        width: 6,
      }),
      new cw.GraphWidget({
        title: "API latency (ms)",
        left: [apiMetric("Latency", "p50"), apiMetric("Latency", "p90"), apiMetric("Latency", "p99")],
        width: 6,
      }),
      new cw.LogQueryWidget({
        title: "Failed requests, last hour: by route, status and reason (api pods)",
        logGroupNames: [appLogGroup],
        queryLines: [
          "filter kubernetes.container_name = 'api'",
          "parse log '\"route\":\"*\"' as route",
          "parse log '\"status\":*,' as status",
          "parse log '\"message\":\"*\"' as message",
          "filter status >= 500 or message = 'request failed'",
          "stats count(*) as failures by route, status, message",
          "sort failures desc",
        ],
        width: 12,
        height: 6,
      }),
      new cw.LogQueryWidget({
        title: "Rejected at the edge, last hour (gateway access log)",
        logGroupNames: [props.apiAccessLogs.logGroupName],
        queryLines: [
          "filter status >= 400",
          "stats count(*) as requests by status, route, authorizerError, integrationError",
          "sort requests desc",
        ],
        width: 12,
        height: 6,
      }),
      new cw.GraphWidget({
        title: "Ingestion executions",
        left: [
          sfnMetric("ExecutionsStarted").with({ label: "started" }),
          sfnMetric("ExecutionsSucceeded").with({ label: "succeeded" }),
          sfnMetric("ExecutionsFailed").with({ label: "failed" }),
        ],
        width: 8,
      }),
      new cw.GraphWidget({
        title: "Ingest Lambda duration (ms) / errors",
        left: [props.ingestFunction.metricDuration({ statistic: "p90", period: window })],
        right: [props.ingestFunction.metricErrors({ period: window })],
        width: 8,
      }),
      new cw.LogQueryWidget({
        title: "Documents that failed to ingest, last hour: by reason",
        logGroupNames: [props.ingestLogGroup.logGroupName],
        queryLines: [
          "filter message = 'ingest failed'",
          "stats count(*) as documents by reason",
          "sort documents desc",
        ],
        width: 8,
        height: 6,
      }),
      new cw.LogQueryWidget({
        title: "Agent tool calls, last hour: by tool and status",
        logGroupNames: [appLogGroup],
        queryLines: [
          "filter kubernetes.container_name = 'agent-tools'",
          "parse log '\"tool\":\"*\"' as tool",
          "parse log '\"status\":\"*\"' as status",
          "filter ispresent(tool)",
          "stats count(*) as calls by tool, status",
        ],
        width: 12,
        height: 6,
      }),
      new cw.GraphWidget({
        title: "EKS failed nodes",
        left: [failedNodes],
        width: 12,
      }),
    );

    // --- Alarms (COMPASS-30) -------------------------------------------------

    const alarm = (id: string, props: cw.CreateAlarmOptions & { metric: cw.Metric | cw.MathExpression }) => {
      const created = props.metric.createAlarm(this, id, {
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
        ...props,
      });
      created.addAlarmAction(notify);
      created.addOkAction(notify);
      return created;
    };

    alarm("IngestionFailed", {
      alarmName: `compass-${envName}-ingestion-failed`,
      alarmDescription:
        "An ingestion execution failed after retries (the DLQ-depth equivalent). Open the execution in Step Functions; the Lambda log has the document's failure_reason.",
      metric: sfnMetric("ExecutionsFailed"),
      threshold: 0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
    });

    alarm("IngestLambdaErrors", {
      alarmName: `compass-${envName}-ingest-lambda-errors`,
      alarmDescription: "The ingest Lambda threw in 2 consecutive 5-minute windows (usually Bedrock throttling or the database).",
      metric: props.ingestFunction.metricErrors({ period: window }),
      threshold: 0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
    });

    alarm("Api5xxRate", {
      alarmName: `compass-${envName}-api-5xx-rate`,
      alarmDescription: "More than 5% of API requests returned 5xx for 10 minutes. Dashboard: 'Failed requests, last hour'.",
      metric: errorRate,
      threshold: 5,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
    });

    alarm("NodeNotReady", {
      alarmName: `compass-${envName}-eks-node-not-ready`,
      alarmDescription: "At least one EKS node has been NotReady for 3 minutes.",
      metric: failedNodes,
      threshold: 0,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
    });
  }
}
