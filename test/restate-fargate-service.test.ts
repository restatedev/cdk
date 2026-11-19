/*
 * Copyright (c) 2023-2026 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate CDK Construct Library,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/cdk/blob/main/LICENSE
 */

import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as sqs from "aws-cdk-lib/aws-sqs";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import {
  RestateEnvironment,
  RestateFargateService,
  ServiceDeployer,
  SupersededVersionScalingProps,
} from "../lib/restate-constructs";

const DIGEST_IMAGE = "public.ecr.aws/example/app@sha256:" + "a".repeat(64);
const BASE_URL = "https://handlers.example.com";

interface FixtureOptions {
  /** Environment variables of the "app" container. */
  readonly containerEnvironment?: Record<string, string>;
  /** @default an image pinned by digest */
  readonly image?: ecs.ContainerImage;
  readonly desiredCount?: number;
  /** @default the load balancer's default idle timeout */
  readonly idleTimeout?: cdk.Duration;
  /** @default true */
  readonly withContainer?: boolean;
  /** Value of a deploy-time expression used as a container environment variable. */
  readonly containerEnvironmentValue?: (stack: cdk.Stack) => string;
  readonly supersededVersionScaling?: SupersededVersionScalingProps;
  readonly pruneSchedule?: events.Schedule;
  readonly removalPolicy?: cdk.RemovalPolicy;
  readonly registerAfterAllResources?: boolean;
  /** Adds an unrelated queue to the stack, after the construct. */
  readonly withQueue?: boolean;
}

interface Infrastructure {
  readonly app: cdk.App;
  readonly stack: cdk.Stack;
  readonly cluster: ecs.Cluster;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly listener: elbv2.ApplicationListener;
  readonly environment: RestateEnvironment;
  readonly deployer: ServiceDeployer;
}

function infrastructure(options: FixtureOptions = {}): Infrastructure {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, "RestateFargateServiceStack", {
    env: { account: "123456789012", region: "eu-central-1" },
  });

  const vpc = new ec2.Vpc(stack, "Vpc");
  const cluster = new ecs.Cluster(stack, "Cluster", { vpc });

  const loadBalancer = new elbv2.ApplicationLoadBalancer(stack, "LoadBalancer", {
    vpc,
    internetFacing: false,
    ...(options.idleTimeout ? { idleTimeout: options.idleTimeout } : {}),
  });
  const certificate = acm.Certificate.fromCertificateArn(
    stack,
    "Certificate",
    "arn:aws:acm:eu-central-1:123456789012:certificate/11111111-2222-3333-4444-555555555555",
  );
  const listener = loadBalancer.addListener("HttpsListener", {
    port: 443,
    protocol: elbv2.ApplicationProtocol.HTTPS,
    certificates: [certificate],
    defaultAction: elbv2.ListenerAction.fixedResponse(404, {
      contentType: "text/plain",
      messageBody: "Not found",
    }),
  });

  const deployer = new ServiceDeployer(stack, "ServiceDeployer");
  const environment = RestateEnvironment.fromAttributes({ adminUrl: "https://restate.example.com:9070" });

  const taskDefinition = new ecs.FargateTaskDefinition(stack, "TaskDefinition");
  if (options.withContainer !== false) {
    taskDefinition.addContainer("app", {
      image: options.image ?? ecs.ContainerImage.fromRegistry(DIGEST_IMAGE),
      portMappings: [{ containerPort: 9080 }],
      environment:
        options.containerEnvironment ??
        (options.containerEnvironmentValue ? { DEPLOY_TIME: options.containerEnvironmentValue(stack) } : undefined),
    });
  }

  return { app, stack, cluster, taskDefinition, listener, environment, deployer };
}

interface Fixture extends Infrastructure {
  readonly service: RestateFargateService;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const infra = infrastructure(options);
  const service = new RestateFargateService(infra.stack, "Greeter", {
    cluster: infra.cluster,
    taskDefinition: infra.taskDefinition,
    listener: infra.listener,
    baseUrl: BASE_URL,
    environment: infra.environment,
    deployer: infra.deployer,
    desiredCount: options.desiredCount,
    supersededVersionScaling: options.supersededVersionScaling,
    pruneSchedule: options.pruneSchedule,
    removalPolicy: options.removalPolicy,
    registerAfterAllResources: options.registerAfterAllResources,
  });
  if (options.withQueue) new sqs.Queue(infra.stack, "Q");
  return { ...infra, service };
}

/** The version id the construct hashes from its inputs, resolved as CloudFormation sees it. */
function versionId(stack: cdk.Stack, service: RestateFargateService): string {
  return stack.resolve(service.currentVersion.versionId) as string;
}

/** The version id and the path prefix, both taken from the registered deployment URI. */
function deployment(
  stack: cdk.Stack,
  service: RestateFargateService,
): {
  uri: string;
  versionId: string;
  pathPrefix: string;
} {
  const version = versionId(stack, service);
  const uri = stack.resolve(service.currentVersion.deploymentUri) as string;
  expect(uri.startsWith(`${BASE_URL}/`)).toBe(true);
  expect(uri.endsWith(`/${version}`)).toBe(true);
  // Strip the base URL, the trailing version id and the slashes around the path prefix.
  const pathPrefix = uri.slice(BASE_URL.length + 1, uri.length - version.length - 1);
  return { uri, versionId: version, pathPrefix };
}

function onlyResource(template: Template, type: string): Record<string, any> {
  const resources = Object.entries(template.findResources(type));
  expect(resources).toHaveLength(1);
  return resources[0]![1] as Record<string, any>;
}

/** Concatenates a CloudFormation `Fn::Join` into JSON, replacing deploy-time tokens with placeholders. */
function flattenTemplateString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && Array.isArray((value as any)["Fn::Join"])) {
    const [delimiter, parts] = (value as any)["Fn::Join"] as [string, unknown[]];
    return parts.map(flattenTemplateString).join(delimiter);
  }
  return "TOKEN";
}

/** The prune configuration embedded in the schedule's target input. */
function pruneConfig(template: Template): Record<string, any> {
  const rule = onlyResource(template, "AWS::Events::Rule");
  const input = JSON.parse(flattenTemplateString(rule.Properties.Targets[0].Input)) as Record<string, any>;
  return input.restateFargatePrune as Record<string, any>;
}

describe("RestateFargateService", () => {
  test("versions its resources and retains them", () => {
    const { stack, service } = fixture();
    const { versionId: versionIdValue, pathPrefix } = deployment(stack, service);
    expect(versionIdValue).toMatch(/^[0-9a-f]{16}$/);

    const template = Template.fromStack(stack);

    for (const type of [
      "AWS::ECS::Service",
      "AWS::ElasticLoadBalancingV2::TargetGroup",
      "AWS::ElasticLoadBalancingV2::ListenerRule",
    ]) {
      const [logicalId, resource] = Object.entries(template.findResources(type))[0]!;
      expect(logicalId).toMatch(new RegExp(`${versionIdValue}$`));
      expect(resource).toMatchObject({
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    }

    const taskDefinition = onlyResource(template, "AWS::ECS::TaskDefinition");
    expect(taskDefinition.DeletionPolicy).toBe("Retain");
    expect(taskDefinition.UpdateReplacePolicy).toBe("Retain");

    const targetGroup = onlyResource(template, "AWS::ElasticLoadBalancingV2::TargetGroup");
    expect(targetGroup.Properties).toMatchObject({
      ProtocolVersion: "HTTP2",
      TargetType: "ip",
      HealthCheckPath: "/health",
    });

    const listenerRule = onlyResource(template, "AWS::ElasticLoadBalancingV2::ListenerRule");
    expect(listenerRule.Properties.Conditions).toEqual([
      { Field: "path-pattern", PathPatternConfig: { Values: [`/${pathPrefix}/${versionIdValue}/*`] } },
    ]);
    expect(listenerRule.Properties.Transforms).toEqual([
      {
        Type: "url-rewrite",
        UrlRewriteConfig: {
          Rewrites: [{ Regex: `^/${pathPrefix}/${versionIdValue}/(.*)$`, Replace: "/$1" }],
        },
      },
    ]);
    const priority = onlyResource(template, "Custom::RestateListenerRulePriority");
    expect(priority.Properties).toMatchObject({ min: 40000, max: 49999 });
    expect(listenerRule.Properties.Priority).toEqual({
      "Fn::GetAtt": [expect.stringMatching(/ListenerRulePriority/), "Priority"],
    });
  });

  test("allocates listener rule priorities with a retained custom resource", () => {
    const { stack, service } = fixture();
    const { versionId: versionIdValue } = deployment(stack, service);
    const template = Template.fromStack(stack);

    const [priorityLogicalId, priority] = Object.entries(
      template.findResources("Custom::RestateListenerRulePriority"),
    )[0]! as [string, Record<string, any>];
    expect(priorityLogicalId).toMatch(new RegExp(`${versionIdValue}$`));
    expect(priority).toMatchObject({
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
      Properties: {
        listenerArn: expect.anything(),
        min: 40000,
        max: 49999,
        seed: expect.stringMatching(/^[0-9a-f]+$/),
      },
    });

    const listenerRule = onlyResource(template, "AWS::ElasticLoadBalancingV2::ListenerRule");
    expect(listenerRule.Properties.Priority).toEqual({ "Fn::GetAtt": [priorityLogicalId, "Priority"] });
  });

  test("schedules pruning of superseded versions", () => {
    const byDefault = fixture({ desiredCount: 2 });
    const defaultTemplate = Template.fromStack(byDefault.stack);
    const defaultRule = onlyResource(defaultTemplate, "AWS::Events::Rule");
    expect(defaultRule.Properties.ScheduleExpression).toBe("rate(1 hour)");

    const defaultPrune = pruneConfig(defaultTemplate);
    expect(defaultPrune.serviceTag).toEqual(expect.stringContaining("/"));
    expect(defaultPrune.endpointPrefix).toMatch(/\/$/);
    expect(defaultPrune.drainDelaySeconds).toBe(300);
    expect(defaultPrune.supersededScaling).toEqual({
      minCapacity: 1,
      maxCapacity: 2,
      targetUtilizationPercent: 70,
    });

    const frequent = fixture({ pruneSchedule: events.Schedule.rate(cdk.Duration.minutes(5)) });
    const frequentRule = onlyResource(Template.fromStack(frequent.stack), "AWS::Events::Rule");
    expect(frequentRule.Properties.ScheduleExpression).toBe("rate(5 minutes)");
  });

  test("registers the service with lifecycle properties", () => {
    const { stack, service } = fixture();
    const { versionId: versionIdValue, pathPrefix } = deployment(stack, service);
    const template = Template.fromStack(stack);
    const customResource = onlyResource(template, "Custom::RestateFargateService");
    const endpointPrefix = `${BASE_URL}/${pathPrefix}/`;

    expect(customResource.Properties.serviceArn).toBeDefined();
    expect(customResource.Properties.versionId).toBe(versionIdValue);
    expect(customResource.Properties.ownedEndpointPrefix).toBe(endpointPrefix);
    expect(customResource.Properties.prune).toMatchObject({
      endpointPrefix,
      drainDelaySeconds: 300,
      supersededScaling: { minCapacity: 1, maxCapacity: 1, targetUtilizationPercent: 70 },
    });
    expect(customResource.Properties.removalPolicy).toBe("retain");

    const destroyTemplate = Template.fromStack(fixture({ removalPolicy: cdk.RemovalPolicy.DESTROY }).stack);
    const destroyResource = onlyResource(destroyTemplate, "Custom::RestateFargateService");
    expect(destroyResource.Properties.removalPolicy).toBe("destroy");
  });

  test("limits lifecycle permissions to this construct's resources", () => {
    const { stack } = fixture();
    const template = Template.fromStack(stack);
    const listenerId = template.getResourceId("AWS::ElasticLoadBalancingV2::Listener");

    template.hasResourceProperties(
      "AWS::IAM::Policy",
      Match.objectLike({
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(["ecs:DeleteService"]),
              Condition: Match.objectLike({
                StringEquals: Match.objectLike({
                  "aws:ResourceTag/restate:service": Match.anyValue(),
                }),
              }),
            }),
            Match.objectLike({
              Action: "elasticloadbalancing:DeleteRule",
              Resource: Match.objectLike({
                "Fn::Join": Match.arrayWith([
                  "",
                  Match.arrayWith([
                    Match.objectLike({
                      "Fn::Join": Match.arrayWith([
                        "listener-rule/",
                        Match.objectLike({
                          "Fn::Split": Match.arrayWith(["listener/", { Ref: listenerId }]),
                        }),
                      ]),
                    }),
                    "/*",
                  ]),
                ]),
              }),
            }),
            Match.objectLike({
              Action: Match.arrayWith(["cloudwatch:DeleteAlarms"]),
              Resource: Match.objectLike({
                "Fn::Join": Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp("TargetTracking-service/")])]),
              }),
            }),
          ]),
        }),
      }),
    );
  });

  test("rejects deploy-time inputs and invalid superseded scaling", () => {
    expect(() => fixture({ supersededVersionScaling: { minCapacity: 0 } })).toThrow(/minCapacity must be at least 1/);

    const parameter = fixture({
      containerEnvironmentValue: (stack) => new cdk.CfnParameter(stack, "P").valueAsString,
    });
    expect(() => Template.fromStack(parameter.stack)).toThrow(/parameter P/);

    const imported = fixture({ containerEnvironmentValue: () => cdk.Fn.importValue("x") });
    expect(() => Template.fromStack(imported.stack)).toThrow(/import "x"/);

    // Every versioned property is checked, not only the container definitions.
    const volume = fixture();
    volume.taskDefinition.addVolume({ name: cdk.Fn.importValue("volume-name") });
    expect(() => Template.fromStack(volume.stack)).toThrow(/import "volume-name"/);
  });

  test("registers after all resources by default", () => {
    const byDefault = fixture({ withQueue: true });
    const template = Template.fromStack(byDefault.stack);
    const queueId = Object.keys(template.findResources("AWS::SQS::Queue"))[0]!;
    const serviceId = Object.keys(template.findResources("AWS::ECS::Service"))[0]!;
    const ruleId = Object.keys(template.findResources("AWS::ElasticLoadBalancingV2::ListenerRule"))[0]!;
    const customResource = onlyResource(template, "Custom::RestateFargateService");
    expect(customResource.DependsOn).toEqual(expect.arrayContaining([queueId, serviceId, ruleId]));

    const immediate = fixture({ withQueue: true, registerAfterAllResources: false });
    const immediateTemplate = Template.fromStack(immediate.stack);
    const immediateQueueId = Object.keys(immediateTemplate.findResources("AWS::SQS::Queue"))[0]!;
    const immediateCustomResource = onlyResource(immediateTemplate, "Custom::RestateFargateService");
    expect(immediateCustomResource.DependsOn ?? []).not.toContain(immediateQueueId);
  });

  test("registers the version as an HTTP deployment", () => {
    const { stack, service } = fixture();
    const { uri, versionId: versionIdValue, pathPrefix } = deployment(stack, service);
    expect(uri).toBe(`${BASE_URL}/${pathPrefix}/${versionIdValue}`);

    const customResource = onlyResource(Template.fromStack(stack), "Custom::RestateFargateService");
    expect(customResource.Properties.serviceUri).toBe(uri);
    expect(customResource.Properties.promoteToLatest).toBe("true");
    expect(customResource.Properties.serviceLambdaArn).toBeUndefined();
    expect("serviceLambdaArn" in customResource.Properties).toBe(false);
  });

  test("derives the version id from the task definition", () => {
    const base = fixture({ containerEnvironment: { GREETING: "hello" } });
    const baseVersionId = versionId(base.stack, base.service);

    const changedEnvironment = fixture({ containerEnvironment: { GREETING: "goodbye" } });
    expect(versionId(changedEnvironment.stack, changedEnvironment.service)).not.toBe(baseVersionId);

    const changedDesiredCount = fixture({ containerEnvironment: { GREETING: "hello" }, desiredCount: 3 });
    expect(versionId(changedDesiredCount.stack, changedDesiredCount.service)).toBe(baseVersionId);

    const tagged = fixture({ containerEnvironment: { GREETING: "hello" } });
    cdk.Tags.of(tagged.stack).add("commit", "abc");
    expect(versionId(tagged.stack, tagged.service)).toBe(baseVersionId);

    const invalidated = fixture({ containerEnvironment: { GREETING: "hello" } });
    invalidated.service.invalidateVersionBasedOn("x");
    expect(versionId(invalidated.stack, invalidated.service)).not.toBe(baseVersionId);
    expect(versionId(invalidated.stack, invalidated.service)).toMatch(/^[0-9a-f]{16}$/);

    const tokenInvalidated = fixture();
    expect(() => tokenInvalidated.service.invalidateVersionBasedOn(cdk.Lazy.string({ produce: () => "lazy" }))).toThrow(
      "invalidateVersionBasedOn() does not accept tokens; pass a plain string.",
    );
  });

  test("requires content-addressed container images", () => {
    const mutableImage = fixture({ image: ecs.ContainerImage.fromRegistry("nginx:latest") });
    expect(() => Template.fromStack(mutableImage.stack)).toThrow(/Container "app"/);

    const digestImage = fixture();
    expect(() => Template.fromStack(digestImage.stack)).not.toThrow();
  });

  test("warns about a short load balancer idle timeout", () => {
    const defaultTimeout = fixture();
    expect(
      Annotations.fromStack(defaultTimeout.stack).findWarning("*", Match.stringLikeRegexp("idle timeout")),
    ).not.toHaveLength(0);

    const longTimeout = fixture({ idleTimeout: cdk.Duration.seconds(900) });
    expect(
      Annotations.fromStack(longTimeout.stack).findWarning("*", Match.stringLikeRegexp("idle timeout")),
    ).toHaveLength(0);
  });

  test("rejects a task definition without containers", () => {
    const { stack, cluster, taskDefinition, listener, environment, deployer } = infrastructure({
      withContainer: false,
    });
    expect(
      () =>
        new RestateFargateService(stack, "Greeter", {
          cluster,
          taskDefinition,
          listener,
          baseUrl: BASE_URL,
          environment,
          deployer,
        }),
    ).toThrow(/task definition has no containers/);
  });
});
