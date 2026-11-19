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

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

import { CloudFormationClient, DescribeStackResourcesCommand } from "@aws-sdk/client-cloudformation";

import { DescribeServicesCommand, ECSClient, ListServicesCommand, type Service } from "@aws-sdk/client-ecs";

import {
  DeleteRuleCommand,
  DeleteTargetGroupCommand,
  DescribeRulesCommand,
  ElasticLoadBalancingV2Client,
  type Action,
  type Rule,
} from "@aws-sdk/client-elastic-load-balancing-v2";

export const SCALABLE_DIMENSION = "ecs:service:DesiredCount";
export const DESCRIBE_SERVICES_BATCH_SIZE = 10;

export interface AdminHeadersProperties {
  authTokenSecretArn?: string;
  authTokenJsonField?: string;
  additionalHeaders?: Record<string, string>;
}

interface TagLike {
  key?: string;
  value?: string;
  Key?: string;
  Value?: string;
}

export async function buildBaseHeaders(props: AdminHeadersProperties): Promise<Record<string, string>> {
  const additionalHeaders = props.additionalHeaders ?? {};

  if (!props.authTokenSecretArn) {
    return { ...additionalHeaders };
  }

  console.log(`Using bearer authentication token from secret ${props.authTokenSecretArn}`);
  const ssm = new SecretsManagerClient();
  const response = await ssm.send(
    new GetSecretValueCommand({
      SecretId: props.authTokenSecretArn,
    }),
  );

  console.log(`Successfully retrieved secret "${response.Name}" version ${response.VersionId}`);

  let token = response.SecretString;
  if (props.authTokenJsonField) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(response.SecretString ?? "");
    } catch {
      // Deliberately avoid echoing the secret material in the error.
      throw new Error(`Secret value is not valid JSON; cannot extract field "${props.authTokenJsonField}".`);
    }
    const field = parsed?.[props.authTokenJsonField];
    if (typeof field !== "string" || field.length === 0) {
      throw new Error(
        `Secret JSON field "${props.authTokenJsonField}" is missing, empty, or not a string; cannot use it as a bearer token.`,
      );
    }
    token = field;
  }

  // Spread additionalHeaders last so a caller can override the Authorization header if they need to.
  return {
    Authorization: `Bearer ${token}`,
    ...additionalHeaders,
  };
}

export async function listServiceArns(ecs: ECSClient, clusterArn: string): Promise<string[]> {
  const serviceArns: string[] = [];
  let nextToken: string | undefined;

  do {
    const response = await ecs.send(
      new ListServicesCommand({
        cluster: clusterArn,
        ...(nextToken !== undefined ? { nextToken } : {}),
      }),
    );
    serviceArns.push(...(response.serviceArns ?? []));
    nextToken = response.nextToken ?? undefined;
  } while (nextToken !== undefined);

  return serviceArns;
}

export async function describeServices(ecs: ECSClient, clusterArn: string, serviceArns: string[]): Promise<Service[]> {
  const services: Service[] = [];

  for (let offset = 0; offset < serviceArns.length; offset += DESCRIBE_SERVICES_BATCH_SIZE) {
    const batch = serviceArns.slice(offset, offset + DESCRIBE_SERVICES_BATCH_SIZE);
    const response = await ecs.send(
      new DescribeServicesCommand({
        cluster: clusterArn,
        services: batch,
        include: ["TAGS"],
      }),
    );
    services.push(...(response.services ?? []));

    if ((response.failures?.length ?? 0) > 0) {
      throw new Error(
        `Failed to describe ECS services: ${response
          .failures!.map((failure) => `${failure.arn ?? "<unknown>"}: ${failure.reason ?? "unknown"}`)
          .join(", ")}`,
      );
    }
  }

  return services;
}

export async function listRules(client: ElasticLoadBalancingV2Client, listenerArn: string): Promise<Rule[]> {
  const rules: Rule[] = [];
  let marker: string | undefined;

  do {
    const response = await client.send(
      new DescribeRulesCommand({
        ListenerArn: listenerArn,
        ...(marker !== undefined ? { Marker: marker } : {}),
      }),
    );
    rules.push(...(response.Rules ?? []));
    marker = response.NextMarker ?? undefined;
  } while (marker !== undefined);

  return rules;
}

export async function deleteRulesForTargetGroups(
  client: ElasticLoadBalancingV2Client,
  listenerArn: string,
  targetGroupArns: Set<string>,
  pathPrefix: string,
): Promise<void> {
  if (targetGroupArns.size === 0) return;

  const rules = await listRules(client, listenerArn);
  for (const rule of rules) {
    if (!rule.RuleArn || rule.IsDefault || rule.Priority === "default") continue;
    if (!(rule.Actions ?? []).some((action) => actionTargetsTargetGroup(action, targetGroupArns))) continue;
    if (!hasMatchingPathPrefix(rule, pathPrefix)) {
      console.warn(`Skipping listener rule ${rule.RuleArn}: path-pattern does not start with ${pathPrefix}.`);
      continue;
    }

    console.log(`Deleting listener rule ${rule.RuleArn}.`);
    await client.send(new DeleteRuleCommand({ RuleArn: rule.RuleArn }));
  }
}

function hasMatchingPathPrefix(rule: Rule, pathPrefix: string): boolean {
  const pathConditions = (rule.Conditions ?? []).filter((condition) => condition.Field === "path-pattern");
  if (pathConditions.length === 0) return false;

  return pathConditions.every((condition) => {
    const values = condition.PathPatternConfig?.Values ?? condition.Values ?? [];
    return values.length > 0 && values.every((value) => value.startsWith(pathPrefix));
  });
}

export function actionTargetsTargetGroup(action: Action, targetGroupArns: Set<string>): boolean {
  if (action.TargetGroupArn !== undefined && targetGroupArns.has(action.TargetGroupArn)) {
    return true;
  }
  return (action.ForwardConfig?.TargetGroups ?? []).some(
    (target) => target.TargetGroupArn !== undefined && targetGroupArns.has(target.TargetGroupArn),
  );
}

export function serviceTargetGroupArns(service: Service): Set<string> {
  return new Set(
    (service.loadBalancers ?? [])
      .map((loadBalancer) => loadBalancer.targetGroupArn)
      .filter((arn): arn is string => typeof arn === "string" && arn.length > 0),
  );
}

export async function deleteTargetGroup(
  client: ElasticLoadBalancingV2Client,
  targetGroupArn: string,
): Promise<boolean> {
  console.log(`Deleting target group ${targetGroupArn}.`);
  try {
    await client.send(new DeleteTargetGroupCommand({ TargetGroupArn: targetGroupArn }));
    return true;
  } catch (e) {
    if (isResourceInUse(e)) {
      console.warn(`Target group ${targetGroupArn} is still in use; leaving it for a later prune.`);
      return false;
    }
    throw e;
  }
}

export function scalableTarget(service: Service): { clusterName: string; serviceName: string; resourceId: string } {
  const clusterName = clusterNameFromArn(service.clusterArn);
  const serviceName = service.serviceName;
  if (!clusterName || !serviceName) {
    throw new Error(
      `Cannot derive the ECS cluster and service names from ${JSON.stringify({
        clusterArn: service.clusterArn,
        serviceName: service.serviceName,
      })}.`,
    );
  }
  return { clusterName, serviceName, resourceId: `service/${clusterName}/${serviceName}` };
}

function clusterNameFromArn(clusterArn: string | undefined): string | undefined {
  if (!clusterArn) return undefined;
  const name = clusterArn.slice(clusterArn.lastIndexOf("/") + 1);
  return name.length > 0 ? name : undefined;
}

export function tagValue(tags: TagLike[] | undefined, key: string): string | undefined {
  const tag = tags?.find((candidate) => (candidate.key ?? candidate.Key) === key);
  return tag?.value ?? tag?.Value;
}

export async function isInStack(cloudFormation: CloudFormationClient, physicalResourceId: string): Promise<boolean> {
  try {
    const response = await cloudFormation.send(
      new DescribeStackResourcesCommand({ PhysicalResourceId: physicalResourceId }),
    );
    return (response.StackResources?.length ?? 0) > 0;
  } catch (e) {
    const error = e as { name?: string; message?: string; Message?: string };
    const message = error.message ?? error.Message ?? "";
    if (
      error.name === "ValidationError" &&
      /does not exist|not found|not in a stack|not yet in a stack/i.test(message)
    ) {
      return false;
    }
    throw e;
  }
}

export async function ignoreObjectNotFound(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (e) {
    if (isObjectNotFound(e)) {
      console.log("Scalable target or scaling policy is already absent; continuing.");
      return;
    }
    throw e;
  }
}

export function isObjectNotFound(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; code?: string };
  return (
    e.name === "ObjectNotFoundException" || e.Code === "ObjectNotFoundException" || e.code === "ObjectNotFoundException"
  );
}

export function isResourceInUse(error: unknown): boolean {
  const e = error as { name?: string; Code?: string; code?: string };
  return (
    e.name === "ResourceInUse" ||
    e.name === "ResourceInUseException" ||
    e.Code === "ResourceInUse" ||
    e.code === "ResourceInUse"
  );
}

export function parseNumber(raw: string | number | undefined, propertyName: string): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid value for ${propertyName}: expected a number, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}
