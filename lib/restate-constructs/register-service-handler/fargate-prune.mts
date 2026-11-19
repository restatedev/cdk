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

import type { Context } from "aws-lambda";

import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import {
  DeleteServiceCommand,
  ECSClient,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateServiceCommand,
  type Service,
} from "@aws-sdk/client-ecs";
import {
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  ElasticLoadBalancingV2Client,
  type Tag as ElbTag,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import {
  ApplicationAutoScalingClient,
  DeregisterScalableTargetCommand,
  DescribeScalableTargetsCommand,
  DescribeScalingPoliciesCommand,
  PutScalingPolicyCommand,
  RegisterScalableTargetCommand,
} from "@aws-sdk/client-application-auto-scaling";

import { escapeSqlString, httpRequest, queryRestate } from "./restate-admin.mjs";
import { SUPERSEDED_SCALING_POLICY_NAME, TAG, type FargatePruneConfig } from "./fargate-contract.mjs";
import {
  actionTargetsTargetGroup,
  buildBaseHeaders,
  deleteRulesForTargetGroups,
  deleteTargetGroup,
  describeServices,
  ignoreObjectNotFound,
  isInStack,
  listRules,
  listServiceArns,
  parseNumber,
  scalableTarget,
  SCALABLE_DIMENSION,
  serviceTargetGroupArns,
  tagValue,
} from "./fargate-shared.mjs";

const MIN_REMAINING_MS = 60_000;
// Removing a registered version makes up to three 30-second Restate requests, then several AWS calls; starting one with
// less time left could kill the Lambda before it answers CloudFormation.
const REMOVAL_REMAINING_MS = 150_000;
const TARGET_GROUP_TAG_BATCH_SIZE = 20;

interface AdminContext {
  adminUrl: string;
  headers: Record<string, string>;
  rejectUnauthorized: boolean;
}

interface RestateState {
  deployments: Map<string, string>;
  latestDeploymentIds: Set<string>;
  pinnedCounts: Map<string, number>;
}

interface TaggedTargetGroup {
  arn: string;
  tags: ElbTag[];
}

interface PruneResources {
  services: Service[];
  targetGroups: TaggedTargetGroup[];
}

export async function prune(
  config: FargatePruneConfig,
  context: Context,
  options?: { currentServiceArn?: string },
): Promise<void> {
  try {
    await runPrune(config, context, options);
  } catch (e) {
    console.error(`Fargate prune failed: ${(e as Error)?.message}`);
  }
}

async function runPrune(
  config: FargatePruneConfig,
  context: Context,
  options?: { currentServiceArn?: string },
): Promise<void> {
  const ecs = new ECSClient({});
  const elbv2 = new ElasticLoadBalancingV2Client({});
  const autoScaling = new ApplicationAutoScalingClient({});
  const cloudFormation = new CloudFormationClient({});

  if (belowBudget(context)) return;
  const resources = await findResources(ecs, elbv2, config);
  const stackMembership = await describeStackMembership(cloudFormation, resources, options?.currentServiceArn);
  if (belowBudget(context)) return;
  // A release can promote any version a stack holds (a rollback, or a revert to earlier code), so their Restate
  // deployments are never removed, even through a stale copy outside the stack.
  const versionsInStacks = new Set(
    resources.services
      .filter(
        (service) =>
          service.serviceArn !== undefined &&
          (service.serviceArn === options?.currentServiceArn ||
            stackMembership.services.get(service.serviceArn) === true),
      )
      .map((service) => tagValue(service.tags, TAG.version))
      .filter((version): version is string => version !== undefined),
  );
  const drainDelayMs = parseNumber(config.drainDelaySeconds, "drainDelaySeconds") * 1_000;

  let admin: AdminContext;
  try {
    admin = await loadAdminContext(config);
  } catch (e) {
    console.error(`Cannot build Restate admin headers; refusing to prune: ${(e as Error)?.message}`);
    return;
  }

  const state = await loadRestateState(admin);
  if (state === undefined) {
    console.error("Cannot read Restate state; refusing to prune anything.");
    return;
  }

  const serviceDeploymentIds = deploymentIdsOnServices(resources.services);
  const removedTargetGroups = new Set<string>();

  for (const service of resources.services) {
    if (belowBudget(context)) return;
    if (service.serviceArn === undefined) continue;
    if (service.serviceArn === options?.currentServiceArn) {
      console.log(`Skipping the current ECS service ${service.serviceArn}.`);
      continue;
    }

    if (stackMembership.services.get(service.serviceArn) === true) {
      console.log(`Skipping ECS service ${service.serviceArn}: it still belongs to a CloudFormation stack.`);
      continue;
    }

    const version = tagValue(service.tags, TAG.version);
    if (version !== undefined && versionsInStacks.has(version)) {
      console.log(
        `Skipping ECS service ${service.serviceArn}: version ${version} is in a stack; the release retires it.`,
      );
      continue;
    }

    let deploymentId = tagValue(service.tags, TAG.deploymentId);
    if (deploymentId === undefined) {
      const versionTag = tagValue(service.tags, TAG.version);
      const endpoint = versionTag !== undefined ? `${config.endpointPrefix}${versionTag}` : undefined;
      const discoveredId = endpoint !== undefined ? findDeploymentIdByEndpoint(state.deployments, endpoint) : undefined;
      if (discoveredId !== undefined) {
        console.log(`Tagging ECS service ${service.serviceArn} with discovered deployment ${discoveredId}.`);
        await ecs.send(
          new TagResourceCommand({
            resourceArn: service.serviceArn,
            tags: [{ key: TAG.deploymentId, value: discoveredId }],
          }),
        );
        deploymentId = discoveredId;
        serviceDeploymentIds.add(discoveredId);
      } else {
        console.log(`Removing unregistered ECS service ${service.serviceArn}.`);
        addAll(removedTargetGroups, await removeVersion(ecs, elbv2, autoScaling, config, service, undefined, admin));
        continue;
      }
    }

    if (!state.deployments.has(deploymentId)) {
      // Only a removal this handler started (drained-at is set) deletes the Restate deployment before the resources.
      // Otherwise the deployment was deleted elsewhere, or the construct now points at another Restate cluster that
      // never knew it, and its invocations may still need this version.
      if (tagValue(service.tags, TAG.drainedAt) === undefined) {
        console.warn(
          `Keeping ECS service ${service.serviceArn}: Restate does not know its deployment ${deploymentId}. ` +
            "Remove it by hand once nothing needs it.",
        );
        continue;
      }
      console.log(`Finishing removal of ECS service ${service.serviceArn}: deployment ${deploymentId} is gone.`);
      addAll(removedTargetGroups, await removeVersion(ecs, elbv2, autoScaling, config, service, undefined, admin));
      continue;
    }

    if (state.latestDeploymentIds.has(deploymentId)) {
      console.log(`ECS service ${service.serviceArn} is active again (deployment ${deploymentId} is latest).`);
      const drainedAt = tagValue(service.tags, TAG.drainedAt);
      if (drainedAt !== undefined) {
        await untag(ecs, service.serviceArn, [TAG.drainedAt]);
      }
      continue;
    }

    await demoteIfNeeded(ecs, autoScaling, service, config);
    const pinned = state.pinnedCounts.get(deploymentId) ?? 0;

    if (pinned > 0) {
      console.log(`Deployment ${deploymentId} still has ${pinned} pinned invocation(s); keeping its ECS service.`);
      const drainedAt = tagValue(service.tags, TAG.drainedAt);
      if (drainedAt !== undefined) {
        await untag(ecs, service.serviceArn, [TAG.drainedAt]);
      }
      continue;
    }

    const drainedAt = tagValue(service.tags, TAG.drainedAt);
    if (drainedAt === undefined) {
      const now = new Date().toISOString();
      console.log(`Marking ECS service ${service.serviceArn} drained at ${now}.`);
      await ecs.send(
        new TagResourceCommand({
          resourceArn: service.serviceArn,
          tags: [{ key: TAG.drainedAt, value: now }],
        }),
      );
      continue;
    }

    const drainedSince = Date.parse(drainedAt);
    if (!Number.isFinite(drainedSince)) {
      console.warn(`Ignoring ECS service ${service.serviceArn}: invalid ${TAG.drainedAt} value ${drainedAt}.`);
      continue;
    }

    if (Date.now() - drainedSince >= drainDelayMs) {
      if (belowBudget(context, REMOVAL_REMAINING_MS)) return;
      console.log(
        `Removing drained ECS service ${service.serviceArn} (deployment ${deploymentId}, drained at ${drainedAt}).`,
      );
      addAll(removedTargetGroups, await removeVersion(ecs, elbv2, autoScaling, config, service, deploymentId, admin));
    } else {
      console.log(`ECS service ${service.serviceArn} is still within its drain delay; keeping it.`);
    }
  }

  const endpointsInStacks = new Set([...versionsInStacks].map((version) => `${config.endpointPrefix}${version}`));
  await removeOrphanedDeployments(config, admin, state, serviceDeploymentIds, context, true, true, endpointsInStacks);
  await sweepTargetGroups(
    cloudFormation,
    elbv2,
    config,
    resources,
    removedTargetGroups,
    context,
    true,
    true,
    undefined,
    stackMembership.targetGroups,
  );
}

/** Force-removes every version of this construct, including retained ones that are still in the stack. */
export async function removeAllVersions(config: FargatePruneConfig, context: Context): Promise<void> {
  const failures: string[] = [];

  try {
    const ecs = new ECSClient({});
    const elbv2 = new ElasticLoadBalancingV2Client({});
    const autoScaling = new ApplicationAutoScalingClient({});

    const resources = await findResources(ecs, elbv2, config);
    const removedTargetGroups = new Set<string>();
    const removedDeploymentIds = new Set<string>();

    let admin: AdminContext | undefined;
    let state: RestateState | undefined;
    try {
      admin = await loadAdminContext(config);
      state = await loadRestateState(admin);
      if (state === undefined) admin = undefined;
    } catch (e) {
      console.warn(`Cannot read Restate state while removing all versions: ${(e as Error)?.message}`);
    }

    for (const service of resources.services) {
      try {
        const deploymentId = tagValue(service.tags, TAG.deploymentId);
        const known = deploymentId !== undefined && state?.deployments.has(deploymentId) === true;
        addAll(
          removedTargetGroups,
          await removeVersion(ecs, elbv2, autoScaling, config, service, known ? deploymentId : undefined, admin, {
            ignoreRestateErrors: true,
            verifyRemoval: false,
            removedDeploymentIds,
            failures,
          }),
        );
      } catch (e) {
        console.warn(`Failed to remove ECS service ${service.serviceArn}: ${(e as Error)?.message}`);
        failures.push(`ECS service ${service.serviceArn}`);
      }
    }

    if (admin !== undefined && state !== undefined) {
      for (const [deploymentId, endpoint] of state.deployments) {
        if (!endpoint.startsWith(config.endpointPrefix)) continue;
        if (removedDeploymentIds.has(deploymentId)) continue;
        try {
          await deleteRestateDeployment(config, deploymentId, admin);
          removedDeploymentIds.add(deploymentId);
        } catch (e) {
          console.warn(`Failed to delete Restate deployment ${deploymentId}: ${(e as Error)?.message}`);
          failures.push(`Restate deployment ${deploymentId}`);
        }
      }
    } else {
      failures.push("Restate deployments (state unavailable)");
    }

    await sweepTargetGroups(undefined, elbv2, config, resources, removedTargetGroups, context, false, false, failures);
  } catch (e) {
    console.warn(`Failed to remove all Fargate versions: ${(e as Error)?.message}`);
    failures.push("Fargate version discovery");
  }

  const uniqueFailures = [...new Set(failures)];
  console.log(
    uniqueFailures.length === 0
      ? "removeAllVersions: removed every Fargate version."
      : `removeAllVersions: could not remove ${uniqueFailures.join(", ")}.`,
  );
}

async function loadAdminContext(config: FargatePruneConfig): Promise<AdminContext> {
  return {
    adminUrl: config.adminUrl,
    headers: await buildBaseHeaders(config),
    rejectUnauthorized: config.insecure !== "true",
  };
}

async function describeStackMembership(
  cloudFormation: CloudFormationClient,
  resources: PruneResources,
  currentServiceArn: string | undefined,
): Promise<{ services: Map<string, boolean>; targetGroups: Map<string, boolean> }> {
  const services = new Map<string, boolean>();
  for (const service of resources.services) {
    if (service.serviceArn === undefined || service.serviceArn === currentServiceArn) continue;
    services.set(service.serviceArn, await isInStack(cloudFormation, service.serviceArn));
  }

  const targetGroups = new Map<string, boolean>();
  for (const targetGroup of resources.targetGroups) {
    targetGroups.set(targetGroup.arn, await isInStack(cloudFormation, targetGroup.arn));
  }

  return { services, targetGroups };
}

async function findResources(
  ecs: ECSClient,
  elbv2: ElasticLoadBalancingV2Client,
  config: FargatePruneConfig,
): Promise<PruneResources> {
  const serviceArns = await listServiceArns(ecs, config.clusterArn);
  const services = (await describeServices(ecs, config.clusterArn, serviceArns)).filter(
    (service) =>
      service.status === "ACTIVE" &&
      service.serviceArn !== undefined &&
      tagValue(service.tags, TAG.service) === config.serviceTag,
  );

  console.log(`Found ${services.length} ACTIVE ECS service(s) for ${config.serviceTag}.`);
  return { services, targetGroups: await listTaggedTargetGroups(elbv2, config.serviceTag) };
}

async function listTaggedTargetGroups(
  client: ElasticLoadBalancingV2Client,
  serviceTag: string,
): Promise<TaggedTargetGroup[]> {
  const targetGroups = await listTargetGroups(client);
  const tagsByArn = await describeTargetGroupTags(
    client,
    targetGroups.map((targetGroup) => targetGroup.TargetGroupArn).filter((arn): arn is string => !!arn),
  );

  const tagged: TaggedTargetGroup[] = [];
  for (const targetGroup of targetGroups) {
    const arn = targetGroup.TargetGroupArn;
    if (!arn) continue;
    const tags = tagsByArn.get(arn) ?? [];
    if (tagValue(tags, TAG.service) === serviceTag) tagged.push({ arn, tags });
  }
  console.log(`Found ${tagged.length} tagged target group(s) for ${serviceTag}.`);
  return tagged;
}

async function listTargetGroups(client: ElasticLoadBalancingV2Client) {
  const targetGroups = [];
  let marker: string | undefined;

  do {
    const response = await client.send(
      new DescribeTargetGroupsCommand({
        ...(marker !== undefined ? { Marker: marker } : {}),
      }),
    );
    targetGroups.push(...(response.TargetGroups ?? []));
    marker = response.NextMarker ?? undefined;
  } while (marker !== undefined);

  return targetGroups;
}

async function describeTargetGroupTags(
  client: ElasticLoadBalancingV2Client,
  targetGroupArns: string[],
): Promise<Map<string, ElbTag[]>> {
  const tagsByArn = new Map<string, ElbTag[]>();

  for (let offset = 0; offset < targetGroupArns.length; offset += TARGET_GROUP_TAG_BATCH_SIZE) {
    const batch = targetGroupArns.slice(offset, offset + TARGET_GROUP_TAG_BATCH_SIZE);
    const response = await client.send(new DescribeTagsCommand({ ResourceArns: batch }));
    for (const description of response.TagDescriptions ?? []) {
      if (description.ResourceArn !== undefined) {
        tagsByArn.set(description.ResourceArn, description.Tags ?? []);
      }
    }
  }

  return tagsByArn;
}

async function loadRestateState(admin: AdminContext): Promise<RestateState | undefined> {
  try {
    const deploymentRows = await queryRestate(
      admin.adminUrl,
      "SELECT id, endpoint FROM sys_deployment",
      admin.headers,
      admin.rejectUnauthorized,
    );
    const latestRows = await queryRestate(
      admin.adminUrl,
      "SELECT name, deployment_id FROM sys_service",
      admin.headers,
      admin.rejectUnauthorized,
    );
    const pinnedRows = await queryRestate(
      admin.adminUrl,
      "SELECT pinned_deployment_id AS id, COUNT(*) AS n FROM sys_invocation_status " +
        "WHERE status != 'completed' AND pinned_deployment_id IS NOT NULL GROUP BY pinned_deployment_id",
      admin.headers,
      admin.rejectUnauthorized,
    );

    const deployments = new Map<string, string>();
    for (const row of deploymentRows) {
      if (typeof row.id === "string" && typeof row.endpoint === "string") deployments.set(row.id, row.endpoint);
    }

    const latestDeploymentIds = new Set<string>();
    for (const row of latestRows) {
      if (typeof row.deployment_id === "string") latestDeploymentIds.add(row.deployment_id);
    }

    const pinnedCounts = new Map<string, number>();
    for (const row of pinnedRows) {
      if (typeof row.id !== "string") continue;
      const count = Number(row.n);
      if (Number.isFinite(count)) pinnedCounts.set(row.id, count);
    }

    return { deployments, latestDeploymentIds, pinnedCounts };
  } catch (e) {
    console.error(`Cannot query Restate state: ${(e as Error)?.message}`);
    return undefined;
  }
}

function deploymentIdsOnServices(services: Service[]): Set<string> {
  const ids = new Set<string>();
  for (const service of services) {
    const id = tagValue(service.tags, TAG.deploymentId);
    if (id !== undefined) ids.add(id);
  }
  return ids;
}

function findDeploymentIdByEndpoint(deployments: Map<string, string>, endpoint: string): string | undefined {
  const wanted = stripOneTrailingSlash(endpoint);
  for (const [deploymentId, candidate] of deployments) {
    if (stripOneTrailingSlash(candidate) === wanted) return deploymentId;
  }
  return undefined;
}

function stripOneTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function demoteIfNeeded(
  ecs: ECSClient,
  autoScaling: ApplicationAutoScalingClient,
  service: Service,
  config: FargatePruneConfig,
): Promise<void> {
  if (service.serviceArn === undefined) return;
  const { resourceId } = scalableTarget(service);

  // The tag is written first, so a demotion that failed halfway is finished by the next run. The policy marks a
  // completed demotion; capacity changed by hand after that is left alone.
  if (tagValue(service.tags, TAG.originalCapacity) !== undefined) {
    if (await hasSupersededPolicy(autoScaling, resourceId)) return;
    console.log(`Finishing the demotion of ECS service ${service.serviceArn}.`);
  } else {
    const target = await describeScalableTarget(autoScaling, resourceId);
    const originalCapacity = target
      ? `${parseNumber(target.MinCapacity ?? service.desiredCount ?? 0, "scalable target MinCapacity")}:${parseNumber(
          target.MaxCapacity ?? service.desiredCount ?? 0,
          "scalable target MaxCapacity",
        )}`
      : `none:${service.desiredCount ?? 0}`;

    console.log(`Recording original capacity ${originalCapacity} on ECS service ${service.serviceArn}.`);
    await ecs.send(
      new TagResourceCommand({
        resourceArn: service.serviceArn,
        tags: [{ key: TAG.originalCapacity, value: originalCapacity }],
      }),
    );
  }

  const minCapacity = parseNumber(config.supersededScaling.minCapacity, "supersededScaling.minCapacity");
  const maxCapacity = parseNumber(config.supersededScaling.maxCapacity, "supersededScaling.maxCapacity");
  const targetValue = parseNumber(
    config.supersededScaling.targetUtilizationPercent,
    "supersededScaling.targetUtilizationPercent",
  );

  console.log(`Registering scalable target ${resourceId} with capacity ${minCapacity}:${maxCapacity}.`);
  await autoScaling.send(
    new RegisterScalableTargetCommand({
      ServiceNamespace: "ecs",
      ResourceId: resourceId,
      ScalableDimension: SCALABLE_DIMENSION,
      MinCapacity: minCapacity,
      MaxCapacity: maxCapacity,
    }),
  );

  console.log(`Putting superseded scaling policy ${SUPERSEDED_SCALING_POLICY_NAME} on ${resourceId}.`);
  await autoScaling.send(
    new PutScalingPolicyCommand({
      PolicyName: SUPERSEDED_SCALING_POLICY_NAME,
      ServiceNamespace: "ecs",
      ResourceId: resourceId,
      ScalableDimension: SCALABLE_DIMENSION,
      PolicyType: "TargetTrackingScaling",
      TargetTrackingScalingPolicyConfiguration: {
        TargetValue: targetValue,
        PredefinedMetricSpecification: {
          PredefinedMetricType: "ECSServiceAverageCPUUtilization",
        },
        ...(config.supersededScaling.scaleInCooldownSeconds !== undefined
          ? {
              ScaleInCooldown: parseNumber(
                config.supersededScaling.scaleInCooldownSeconds,
                "supersededScaling.scaleInCooldownSeconds",
              ),
            }
          : {}),
        ...(config.supersededScaling.scaleOutCooldownSeconds !== undefined
          ? {
              ScaleOutCooldown: parseNumber(
                config.supersededScaling.scaleOutCooldownSeconds,
                "supersededScaling.scaleOutCooldownSeconds",
              ),
            }
          : {}),
      },
    }),
  );
}

async function hasSupersededPolicy(autoScaling: ApplicationAutoScalingClient, resourceId: string): Promise<boolean> {
  const response = await autoScaling.send(
    new DescribeScalingPoliciesCommand({
      ServiceNamespace: "ecs",
      ResourceId: resourceId,
      ScalableDimension: SCALABLE_DIMENSION,
      PolicyNames: [SUPERSEDED_SCALING_POLICY_NAME],
    }),
  );
  return (response.ScalingPolicies ?? []).length > 0;
}

async function describeScalableTarget(autoScaling: ApplicationAutoScalingClient, resourceId: string) {
  let nextToken: string | undefined;

  do {
    const response = await autoScaling.send(
      new DescribeScalableTargetsCommand({
        ServiceNamespace: "ecs",
        ResourceIds: [resourceId],
        ScalableDimension: SCALABLE_DIMENSION,
        ...(nextToken !== undefined ? { NextToken: nextToken } : {}),
      }),
    );
    const target = response.ScalableTargets?.[0];
    if (target !== undefined) return target;
    nextToken = response.NextToken ?? undefined;
  } while (nextToken !== undefined);

  return undefined;
}

async function removeVersion(
  ecs: ECSClient,
  elbv2: ElasticLoadBalancingV2Client,
  autoScaling: ApplicationAutoScalingClient,
  config: FargatePruneConfig,
  service: Service,
  deploymentId: string | undefined,
  admin: AdminContext | undefined,
  options?: {
    ignoreRestateErrors?: boolean;
    verifyRemoval?: boolean;
    removedDeploymentIds?: Set<string>;
    failures?: string[];
  },
): Promise<Set<string>> {
  const removedTargetGroups = new Set<string>();
  if (service.serviceArn === undefined) return removedTargetGroups;

  if (deploymentId !== undefined) {
    if (admin === undefined) {
      throw new Error(`Cannot delete Restate deployment ${deploymentId} without admin connection details.`);
    }
    if (options?.verifyRemoval !== false) {
      const canRemove = await canRemoveRegisteredDeployment(config, admin, deploymentId);
      if (!canRemove) {
        console.log(`Skipping removal of deployment ${deploymentId}: Restate state changed during pruning.`);
        if (tagValue(service.tags, TAG.drainedAt) !== undefined) {
          await untag(ecs, service.serviceArn, [TAG.drainedAt]);
        }
        return removedTargetGroups;
      }
    }
    try {
      await deleteRestateDeployment(config, deploymentId, admin);
      options?.removedDeploymentIds?.add(deploymentId);
    } catch (e) {
      if (options?.ignoreRestateErrors !== true) throw e;
      console.warn(`Failed to delete Restate deployment ${deploymentId}: ${(e as Error)?.message}`);
    }
  }

  const targetGroupArns = serviceTargetGroupArns(service);
  if (targetGroupArns.size > 0) {
    await deleteRulesForTargetGroups(
      elbv2,
      config.listenerArn,
      targetGroupArns,
      new URL(config.endpointPrefix).pathname,
    );
  }

  const { resourceId } = scalableTarget(service);
  console.log(`Setting desired count to 0 on ECS service ${service.serviceArn}.`);
  await ecs.send(
    new UpdateServiceCommand({
      cluster: config.clusterArn,
      service: service.serviceArn,
      desiredCount: 0,
    }),
  );

  console.log(`Deleting ECS service ${service.serviceArn}.`);
  await ecs.send(
    new DeleteServiceCommand({
      cluster: config.clusterArn,
      service: service.serviceArn,
      force: true,
    }),
  );

  console.log(`Deregistering scalable target ${resourceId}.`);
  await ignoreObjectNotFound(() =>
    autoScaling.send(
      new DeregisterScalableTargetCommand({
        ServiceNamespace: "ecs",
        ResourceId: resourceId,
        ScalableDimension: SCALABLE_DIMENSION,
      }),
    ),
  );

  for (const targetGroupArn of targetGroupArns) {
    if (await deleteTargetGroup(elbv2, targetGroupArn)) {
      removedTargetGroups.add(targetGroupArn);
    } else {
      options?.failures?.push(`target group ${targetGroupArn}`);
    }
  }

  return removedTargetGroups;
}

async function canRemoveRegisteredDeployment(
  config: FargatePruneConfig,
  admin: AdminContext,
  deploymentId: string,
): Promise<boolean> {
  const id = escapeSqlString(deploymentId);
  const latestRows = await queryRestate(
    admin.adminUrl,
    `SELECT name FROM sys_service WHERE deployment_id = '${id}'`,
    admin.headers,
    admin.rejectUnauthorized,
  );
  if (latestRows.length > 0) {
    console.log(`Deployment ${deploymentId} is still latest for a service; not removing it.`);
    return false;
  }

  const pinnedRows = await queryRestate(
    admin.adminUrl,
    "SELECT COUNT(*) AS n FROM sys_invocation_status " +
      `WHERE status != 'completed' AND pinned_deployment_id = '${id}'`,
    admin.headers,
    admin.rejectUnauthorized,
  );
  const pinned = Number(pinnedRows[0]?.n ?? 0);
  if (Number.isFinite(pinned) && pinned > 0) {
    console.log(`Deployment ${deploymentId} still has ${pinned} pinned invocation(s); not removing it.`);
    return false;
  }
  return true;
}

async function deleteRestateDeployment(
  config: FargatePruneConfig,
  deploymentId: string,
  admin: AdminContext,
): Promise<void> {
  const url = new URL(
    `${config.adminUrl.replace(/\/+$/, "")}/deployments/${encodeURIComponent(deploymentId)}?force=true`,
  );
  console.log(`Deleting Restate deployment ${deploymentId} at ${url}.`);
  const response = await httpRequest(url, {
    method: "DELETE",
    headers: admin.headers,
    timeout: 30_000,
    rejectUnauthorized: admin.rejectUnauthorized,
  });
  if ((response.statusCode >= 200 && response.statusCode < 300) || response.statusCode === 404) return;
  throw new Error(`Delete deployment ${deploymentId} failed (${response.statusCode}): ${response.body}`);
}

async function removeOrphanedDeployments(
  config: FargatePruneConfig,
  admin: AdminContext,
  state: RestateState,
  serviceDeploymentIds: Set<string>,
  context: Context,
  respectPinned: boolean,
  respectBudget: boolean,
  keepEndpoints: Set<string> = new Set(),
): Promise<void> {
  for (const [deploymentId, endpoint] of state.deployments) {
    if (!endpoint.startsWith(config.endpointPrefix)) continue;
    if (keepEndpoints.has(stripOneTrailingSlash(endpoint))) continue;
    if (state.latestDeploymentIds.has(deploymentId)) continue;
    if (serviceDeploymentIds.has(deploymentId)) continue;

    const pinned = state.pinnedCounts.get(deploymentId) ?? 0;
    if (respectPinned && pinned > 0) {
      console.warn(`Leaving orphaned deployment ${deploymentId}: it still has ${pinned} pinned invocation(s).`);
      continue;
    }

    if (respectBudget && belowBudget(context)) return;
    try {
      await deleteRestateDeployment(config, deploymentId, admin);
    } catch (e) {
      console.error(`Failed to delete orphaned Restate deployment ${deploymentId}: ${(e as Error)?.message}`);
      return;
    }
  }
}

async function sweepTargetGroups(
  cloudFormation: CloudFormationClient | undefined,
  elbv2: ElasticLoadBalancingV2Client,
  config: FargatePruneConfig,
  resources: PruneResources,
  removedTargetGroups: Set<string>,
  context: Context,
  respectStack: boolean,
  respectBudget: boolean,
  failures?: string[],
  stackMembership?: Map<string, boolean>,
): Promise<void> {
  if (resources.targetGroups.length === 0) return;
  if (respectBudget && belowBudget(context)) return;

  const activeVersions = new Set(
    resources.services
      .map((service) => tagValue(service.tags, TAG.version))
      .filter((version): version is string => version !== undefined),
  );
  const rules = await listRules(elbv2, config.listenerArn);

  for (const targetGroup of resources.targetGroups) {
    if (respectBudget && belowBudget(context)) return;
    if (removedTargetGroups.has(targetGroup.arn)) continue;

    const version = tagValue(targetGroup.tags, TAG.version);
    if (version !== undefined && activeVersions.has(version)) continue;

    if (
      rules.some((rule) =>
        (rule.Actions ?? []).some((action) => actionTargetsTargetGroup(action, new Set([targetGroup.arn]))),
      )
    ) {
      continue;
    }

    if (respectStack) {
      if (stackMembership?.get(targetGroup.arn) === true) {
        console.log(`Skipping target group ${targetGroup.arn}: it still belongs to a CloudFormation stack.`);
        continue;
      }
    }

    try {
      if (!(await deleteTargetGroup(elbv2, targetGroup.arn))) {
        failures?.push(`target group ${targetGroup.arn}`);
      }
    } catch (e) {
      console.warn(`Failed to delete target group ${targetGroup.arn}: ${(e as Error)?.message}`);
      failures?.push(`target group ${targetGroup.arn}`);
    }
  }
}

async function untag(ecs: ECSClient, resourceArn: string, tagKeys: string[]): Promise<void> {
  console.log(`Removing tags ${tagKeys.join(", ")} from ${resourceArn}.`);
  await ecs.send(new UntagResourceCommand({ resourceArn, tagKeys }));
}

function addAll(target: Set<string>, values: Set<string>): void {
  for (const value of values) target.add(value);
}

function belowBudget(context: Context, minimumMs: number = MIN_REMAINING_MS): boolean {
  if (context.getRemainingTimeInMillis() < minimumMs) {
    console.log(`Stopping prune: only ${context.getRemainingTimeInMillis()} ms remain in the Lambda invocation.`);
    return true;
  }
  return false;
}
