/*
 * Copyright (c) 2023-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

/*
 * The contract between RestateFargateService (the construct) and this handler. CloudFormation passes every scalar in
 * ResourceProperties as a string, so numeric fields must be parsed; scheduled events carry the same shapes as JSON.
 */

/** Tags the construct and the handler put on a version's ECS service (and, where noted, other resources). */
export const TAG = {
  /** Set by the construct on every version resource: identifies the RestateFargateService. */
  service: "restate:service",
  /** Set by the construct on every version resource: the version id. */
  version: "restate:version",
  /** Set by the release path on the ECS service once Restate knows the deployment. */
  deploymentId: "restate:deployment-id",
  /** Set by the prune path when it demotes a version: `<min>:<max>` of its scalable target, or `none:<desiredCount>`. */
  originalCapacity: "restate:original-capacity",
  /** Set by the prune path when a superseded version is first seen drained: ISO-8601 timestamp. */
  drainedAt: "restate:drained-at",
} as const;

/** Name of the target-tracking policy the prune path puts on a demoted version. */
export const SUPERSEDED_SCALING_POLICY_NAME = "restate-superseded-cpu";

export interface SupersededScalingConfig {
  minCapacity: number | string;
  maxCapacity: number | string;
  targetUtilizationPercent: number | string;
  scaleInCooldownSeconds?: number | string;
  scaleOutCooldownSeconds?: number | string;
}

/** Everything the prune path needs. Sent as the release resource's `prune` property and in scheduled events. */
export interface FargatePruneConfig {
  adminUrl: string;
  authTokenSecretArn?: string;
  authTokenJsonField?: string;
  additionalHeaders?: Record<string, string>;
  insecure?: "true" | "false";

  /** Value of the `restate:service` tag on this construct's resources. */
  serviceTag: string;
  /** `${baseUrl}/${pathPrefix}/`: every version's URI starts with it. */
  endpointPrefix: string;
  clusterArn: string;
  listenerArn: string;
  drainDelaySeconds: number | string;
  supersededScaling: SupersededScalingConfig;
}

/** Event that EventBridge sends on the prune schedule. It has no `RequestType`, which tells it apart from CloudFormation. */
export interface FargatePruneEvent {
  restateFargatePrune: FargatePruneConfig;
}

/** Extra ResourceProperties of `Custom::RestateFargateService`, on top of RegistrationProperties. */
export interface FargateReleaseProperties {
  /** ARN of the current version's ECS service. */
  serviceArn: string;
  /** The version id of the current version (value of its `restate:version` tag). */
  versionId: string;
  prune: FargatePruneConfig;
}

/** ResourceProperties of `Custom::RestateListenerRulePriority`. */
export interface ListenerRulePriorityProperties {
  listenerArn: string;
  min: number | string;
  max: number | string;
  /** Stable per construct; spreads constructs sharing a listener over the range. */
  seed: string;
}
