/*
 * Copyright (c) 2023-2025 - Restate Software, Inc., Restate GmbH
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
  DescribeServicesCommand,
  ECSClient,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateServiceCommand,
  type Service,
} from "@aws-sdk/client-ecs";

import { ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";

import {
  ApplicationAutoScalingClient,
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
  RegisterScalableTargetCommand,
} from "@aws-sdk/client-application-auto-scaling";

import { SUPERSEDED_SCALING_POLICY_NAME, TAG, type FargateReleaseProperties } from "./fargate-contract.mjs";
import {
  deleteRulesForTargetGroups,
  deleteTargetGroup,
  describeServices,
  ignoreObjectNotFound,
  isInStack,
  listServiceArns,
  parseNumber,
  scalableTarget,
  SCALABLE_DIMENSION,
  serviceTargetGroupArns,
  tagValue,
} from "./fargate-shared.mjs";
import { prune } from "./fargate-prune.mjs";

const PRUNE_TIME_RESERVE_MS = 120_000;

/** The release path: tag the live deployment, undo an earlier demotion, then remove stale copies of this version. */
export async function completeRelease(
  props: FargateReleaseProperties,
  deploymentId: string,
  context: Context,
): Promise<void> {
  const ecs = new ECSClient({});
  const elbv2 = new ElasticLoadBalancingV2Client({});
  const autoScaling = new ApplicationAutoScalingClient({});
  const cloudFormation = new CloudFormationClient({});

  console.log(`Tagging ECS service ${props.serviceArn} with ${TAG.deploymentId}=${deploymentId}.`);
  await ecs.send(
    new TagResourceCommand({
      resourceArn: props.serviceArn,
      tags: [{ key: TAG.deploymentId, value: deploymentId }],
    }),
  );

  const current = await describeService(ecs, props.prune.clusterArn, props.serviceArn);
  await restoreCapacity(ecs, autoScaling, props.prune.clusterArn, current);

  await retireStaleCopies(cloudFormation, ecs, elbv2, autoScaling, props);

  if (context.getRemainingTimeInMillis() > PRUNE_TIME_RESERVE_MS) {
    try {
      await prune(props.prune, context, { currentServiceArn: props.serviceArn });
    } catch (e) {
      console.warn(`Fargate prune failed after release: ${(e as Error)?.message}`);
    }
  } else {
    console.log(`Skipping prune: only ${context.getRemainingTimeInMillis()} ms remain in the Lambda invocation.`);
  }
}

async function describeService(ecs: ECSClient, clusterArn: string, serviceArn: string): Promise<Service> {
  const response = await ecs.send(
    new DescribeServicesCommand({
      cluster: clusterArn,
      services: [serviceArn],
      include: ["TAGS"],
    }),
  );

  const service = response.services?.find((candidate) => candidate.serviceArn === serviceArn) ?? response.services?.[0];
  if (!service) {
    throw new Error(`ECS service ${serviceArn} was not found.`);
  }
  return service;
}

async function restoreCapacity(
  ecs: ECSClient,
  autoScaling: ApplicationAutoScalingClient,
  clusterArn: string,
  service: Service,
): Promise<void> {
  const originalCapacity = tagValue(service.tags, TAG.originalCapacity);
  if (originalCapacity === undefined) return;

  const { resourceId } = scalableTarget(service);
  const serviceArn = service.serviceArn!;

  if (originalCapacity.startsWith("none:")) {
    const desiredCount = parseNumber(originalCapacity.slice("none:".length), `${TAG.originalCapacity} desired count`);

    console.log(`Deregistering scalable target ${resourceId} before restoring capacity.`);
    await ignoreObjectNotFound(() =>
      autoScaling.send(
        new DeregisterScalableTargetCommand({
          ServiceNamespace: "ecs",
          ResourceId: resourceId,
          ScalableDimension: SCALABLE_DIMENSION,
        }),
      ),
    );

    console.log(`Restoring desired count ${desiredCount} on ECS service ${serviceArn}.`);
    await ecs.send(
      new UpdateServiceCommand({
        cluster: clusterArn,
        service: serviceArn,
        desiredCount,
      }),
    );
  } else {
    const [minRaw, maxRaw, ...rest] = originalCapacity.split(":");
    if (maxRaw === undefined || rest.length > 0) {
      throw new Error(
        `Invalid value for ${TAG.originalCapacity} on ${serviceArn}: expected "none:<count>" or "<min>:<max>", got ${JSON.stringify(originalCapacity)}.`,
      );
    }
    const minCapacity = parseNumber(minRaw, `${TAG.originalCapacity} minimum capacity`);
    const maxCapacity = parseNumber(maxRaw, `${TAG.originalCapacity} maximum capacity`);

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

    console.log(`Deleting superseded scaling policy ${SUPERSEDED_SCALING_POLICY_NAME} from ${resourceId}.`);
    await ignoreObjectNotFound(() =>
      autoScaling.send(
        new DeleteScalingPolicyCommand({
          ServiceNamespace: "ecs",
          ResourceId: resourceId,
          ScalableDimension: SCALABLE_DIMENSION,
          PolicyName: SUPERSEDED_SCALING_POLICY_NAME,
        }),
      ),
    );
  }

  console.log(`Removing ${TAG.originalCapacity} and ${TAG.drainedAt} from ECS service ${serviceArn}.`);
  await ecs.send(
    new UntagResourceCommand({
      resourceArn: serviceArn,
      tagKeys: [TAG.originalCapacity, TAG.drainedAt],
    }),
  );
}

async function retireStaleCopies(
  cloudFormation: CloudFormationClient,
  ecs: ECSClient,
  elbv2: ElasticLoadBalancingV2Client,
  autoScaling: ApplicationAutoScalingClient,
  props: FargateReleaseProperties,
): Promise<void> {
  const serviceArns = await listServiceArns(ecs, props.prune.clusterArn);
  const services = await describeServices(ecs, props.prune.clusterArn, serviceArns);
  const staleCopies = services.filter((service) => isStaleCopy(service, props));

  if (staleCopies.length === 0) {
    console.log(`No stale copies of version ${props.versionId} found.`);
    return;
  }

  for (const stale of staleCopies) {
    if (await isInStack(cloudFormation, stale.serviceArn!)) {
      console.log(`Skipping ECS service ${stale.serviceArn}: it still belongs to a CloudFormation stack.`);
      continue;
    }
    await retireStaleCopy(ecs, elbv2, autoScaling, stale, props);
  }
}

function isStaleCopy(service: Service, props: FargateReleaseProperties): boolean {
  return (
    service.status === "ACTIVE" &&
    tagValue(service.tags, TAG.version) === props.versionId &&
    tagValue(service.tags, TAG.service) === props.prune.serviceTag &&
    service.serviceArn !== undefined &&
    service.serviceArn !== props.serviceArn
  );
}

async function retireStaleCopy(
  ecs: ECSClient,
  elbv2: ElasticLoadBalancingV2Client,
  autoScaling: ApplicationAutoScalingClient,
  stale: Service,
  props: FargateReleaseProperties,
): Promise<void> {
  const serviceArn = stale.serviceArn!;
  const { resourceId } = scalableTarget(stale);
  const targetGroupArns = serviceTargetGroupArns(stale);
  const versionPathPrefix = new URL(props.prune.endpointPrefix).pathname;

  if (targetGroupArns.size === 0) {
    console.log(`Stale ECS service ${serviceArn} has no target groups; skipping listener rules.`);
  } else {
    await deleteRulesForTargetGroups(elbv2, props.prune.listenerArn, targetGroupArns, versionPathPrefix);
  }

  console.log(`Setting desired count to 0 on stale ECS service ${serviceArn}.`);
  await ecs.send(
    new UpdateServiceCommand({
      cluster: props.prune.clusterArn,
      service: serviceArn,
      desiredCount: 0,
    }),
  );

  console.log(`Deleting stale ECS service ${serviceArn}.`);
  await ecs.send(
    new DeleteServiceCommand({
      cluster: props.prune.clusterArn,
      service: serviceArn,
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
    await deleteTargetGroup(elbv2, targetGroupArn);
  }
}
