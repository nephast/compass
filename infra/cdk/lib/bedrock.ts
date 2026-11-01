import { Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";

// Bedrock invoke permissions, scoped to the models Compass uses (COMPASS-33).
// Invoking through an inference profile needs the profile ARN AND the
// foundation-model ARN in every region the profile can route to
// (packages/llm/README.md) -- hence the region wildcard on foundation models
// only, never on the action or the model family.
export function bedrockInvokeStatement(
  scope: Construct,
  use: { embeddings?: boolean; completions?: boolean },
): iam.PolicyStatement {
  const { account, partition, region } = Stack.of(scope);
  const resources: string[] = [];
  if (use.embeddings) {
    resources.push(
      `arn:${partition}:bedrock:${region}::foundation-model/amazon.titan-embed-text-v2:0`,
    );
  }
  if (use.completions) {
    resources.push(
      `arn:${partition}:bedrock:${region}:${account}:inference-profile/eu.amazon.nova-*`,
      `arn:${partition}:bedrock:*::foundation-model/amazon.nova-*`,
      `arn:${partition}:bedrock:${region}:${account}:inference-profile/eu.anthropic.claude-*`,
      `arn:${partition}:bedrock:*::foundation-model/anthropic.claude-*`,
    );
  }
  return new iam.PolicyStatement({
    actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
    resources,
  });
}
