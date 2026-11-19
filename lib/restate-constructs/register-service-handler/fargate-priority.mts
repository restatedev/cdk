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

import { createHash } from "node:crypto";

import type { CloudFormationCustomResourceEvent } from "aws-lambda/trigger/cloudformation-custom-resource";

import { DescribeRulesCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";

import type { ListenerRulePriorityProperties } from "./fargate-contract.mjs";

const PHYSICAL_ID_PREFIX = "priority:";

/**
 * Allocates a listener rule priority from a range, using the listener's real rules so retained rules keep their
 * priorities. A changed range or seed produces a new physical id, which makes CloudFormation replace the rule.
 */
export async function allocateListenerRulePriority(event: CloudFormationCustomResourceEvent) {
  if (event.RequestType === "Delete") {
    return;
  }

  const props = event.ResourceProperties as unknown as ListenerRulePriorityProperties;

  if (event.RequestType === "Update") {
    const old = event.OldResourceProperties as Partial<ListenerRulePriorityProperties> | undefined;
    if (
      old &&
      old.listenerArn === props.listenerArn &&
      Number(old.min) === Number(props.min) &&
      Number(old.max) === Number(props.max) &&
      old.seed === props.seed
    ) {
      const priority = parsePhysicalResourceId(event.PhysicalResourceId);
      return { PhysicalResourceId: event.PhysicalResourceId, Data: { Priority: String(priority) } };
    }
  }

  if (!props.listenerArn) {
    throw new Error("Listener rule priority allocation requires listenerArn.");
  }

  const min = parseInteger(props.min, "min");
  const max = parseInteger(props.max, "max");
  if (min > max) {
    throw new Error(`Invalid listener rule priority range: min (${min}) is greater than max (${max}).`);
  }

  const client = new ElasticLoadBalancingV2Client({});
  const used = await listUsedPriorities(client, props.listenerArn);

  const span = max - min + 1;
  const usedInRange = [...used].filter((priority) => priority >= min && priority <= max);
  if (usedInRange.length >= span) {
    throw new Error(`No free listener rule priority in [${min}, ${max}] on ${props.listenerArn}.`);
  }

  const hash = parseInt(
    createHash("sha256")
      .update(String(props.seed ?? ""))
      .digest("hex")
      .slice(0, 8),
    16,
  );
  const start = min + (hash % span);

  for (let offset = 0; offset < span; offset++) {
    const candidate = min + ((start - min + offset) % span);
    if (!used.has(candidate)) {
      console.log(`Allocating listener rule priority ${candidate} on ${props.listenerArn}.`);
      return { PhysicalResourceId: `${PHYSICAL_ID_PREFIX}${candidate}`, Data: { Priority: String(candidate) } };
    }
  }

  throw new Error(`No free listener rule priority in [${min}, ${max}] on ${props.listenerArn}.`);
}

async function listUsedPriorities(client: ElasticLoadBalancingV2Client, listenerArn: string): Promise<Set<number>> {
  const used = new Set<number>();
  let marker: string | undefined;

  do {
    const response = await client.send(
      new DescribeRulesCommand({
        ListenerArn: listenerArn,
        ...(marker !== undefined ? { Marker: marker } : {}),
      }),
    );

    for (const rule of response.Rules ?? []) {
      if (!rule.Priority || rule.Priority === "default") continue;
      const priority = Number(rule.Priority);
      if (Number.isInteger(priority)) used.add(priority);
    }

    marker = response.NextMarker ?? undefined;
  } while (marker !== undefined);

  return used;
}

function parsePhysicalResourceId(physicalResourceId: string | undefined): number {
  if (!physicalResourceId?.startsWith(PHYSICAL_ID_PREFIX)) {
    throw new Error(
      `Cannot read a listener rule priority from physical resource id ${JSON.stringify(physicalResourceId)}.`,
    );
  }
  return parseInteger(physicalResourceId.slice(PHYSICAL_ID_PREFIX.length), "physical resource id priority");
}

function parseInteger(raw: number | string | undefined, propertyName: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid value for ${propertyName}: expected an integer, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}
