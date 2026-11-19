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

import * as crypto from "node:crypto";
import { Construct, IConstruct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import { IRestateEnvironment } from "./restate-environment";
import { ServiceDeployer, ServiceRegistrationProps } from "./service-deployer";

const DEFAULT_CONTAINER_PORT = 9080;
const DEFAULT_PRIORITY_RANGE = { min: 40000, max: 49999 };
const VERSION_ID_LENGTH = 16;
const DEFAULT_DRAIN_DELAY = cdk.Duration.minutes(5);
const DEFAULT_PRUNE_SCHEDULE = events.Schedule.rate(cdk.Duration.hours(1));
const DEFAULT_SUPERSEDED_TARGET_UTILIZATION_PERCENT = 70;
const MAX_LOGICAL_ID_LENGTH = 255;

/** Restate's default inactivity timeout (60 s) plus abort timeout (600 s). */
const MIN_RECOMMENDED_IDLE_TIMEOUT_SECONDS = 660;
const ALB_DEFAULT_IDLE_TIMEOUT_SECONDS = 60;

/**
 * Task definition properties that define what code a version runs. Tags and the family are left out, so stack-level
 * tags (a commit SHA, say) do not create new versions.
 */
const VERSIONED_TASK_DEFINITION_PROPERTIES = [
  "ContainerDefinitions",
  "Cpu",
  "Memory",
  "RuntimePlatform",
  "EphemeralStorage",
  "Volumes",
  "TaskRoleArn",
  "ExecutionRoleArn",
];

/** Registration options that apply to HTTP deployments. The construct owns the rest. */
export type RestateFargateServiceRegistrationProps = Pick<
  ServiceRegistrationProps,
  | "private"
  | "breaking"
  | "additionalHeaders"
  | "authToken"
  | "adminUrl"
  | "insecure"
  | "healthCheckRetryAttempts"
  | "healthCheckMaxBackoff"
>;

export interface RestateFargateServiceProps extends Pick<
  ecs.BaseServiceOptions,
  | "capacityProviderStrategies"
  | "circuitBreaker"
  | "enableExecuteCommand"
  | "healthCheckGracePeriod"
  | "minHealthyPercent"
  | "maxHealthyPercent"
  | "propagateTags"
> {
  readonly cluster: ecs.ICluster;

  /**
   * The task definition every version runs. Container images must be CDK assets or pinned by digest, so that a code
   * change always produces a new version.
   */
  readonly taskDefinition: ecs.FargateTaskDefinition;

  /** @default the task definition's default container */
  readonly containerName?: string;

  /** @default 9080 */
  readonly containerPort?: number;

  /** Number of tasks for the current version. @default 1 */
  readonly desiredCount?: number;

  readonly platformVersion?: ecs.FargatePlatformVersion;
  readonly vpcSubnets?: ec2.SubnetSelection;

  /** @default a security group shared by all versions */
  readonly securityGroups?: ec2.ISecurityGroup[];

  /** @default false */
  readonly assignPublicIp?: boolean;

  /**
   * HTTPS listener of an Application Load Balancer that Restate can reach. Each version adds one rule to it. The load
   * balancer's idle timeout must exceed Restate's inactivity plus abort timeouts (660 s by default), or long steps are
   * reset mid-stream.
   */
  readonly listener: elbv2.IApplicationListener;

  /** URL Restate uses to reach the listener, for example `https://handlers.internal.example.com`. */
  readonly baseUrl: string;

  /**
   * Path segment that groups this construct's versions on the listener.
   *
   * @default a unique name derived from the construct path
   */
  readonly pathPrefix?: string;

  /** Listener rule priorities this construct may use. @default 40000 to 49999 */
  readonly listenerRulePriorityRange?: { readonly min: number; readonly max: number };

  /** Overrides for the target group health check. @default HTTP GET /health */
  readonly healthCheck?: elbv2.HealthCheck;

  /** @default Duration.seconds(60) */
  readonly deregistrationDelay?: cdk.Duration;

  readonly environment: IRestateEnvironment;
  readonly deployer: ServiceDeployer;
  readonly registration?: RestateFargateServiceRegistrationProps;

  /** Scaling for a version once it is superseded and drains. */
  readonly supersededVersionScaling?: SupersededVersionScalingProps;

  /** How long a superseded version must stay drained before it is removed. @default Duration.minutes(5) */
  readonly drainDelay?: cdk.Duration;

  /**
   * How often superseded versions are checked, scaled down and removed, in addition to after every release.
   *
   * @default Schedule.rate(Duration.hours(1))
   */
  readonly pruneSchedule?: events.Schedule;

  /**
   * Register a new version only after every other resource in the stack is in place, so that a failure elsewhere
   * rarely rolls back a version Restate already routes to. Turn it off if a resource of yours must depend on this
   * construct, which would otherwise form a dependency cycle.
   *
   * @default true
   */
  readonly registerAfterAllResources?: boolean;

  /**
   * What happens to every version when this construct is removed from the stack. `RETAIN` leaves all versions running
   * and registered. `DESTROY` deregisters them from Restate and deletes their resources without waiting for
   * invocations to finish; use it for test stacks.
   *
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

export interface SupersededVersionScalingProps {
  /** @default 1. A superseded version keeps at least one task, so suspended invocations can resume. */
  readonly minCapacity?: number;
  /** @default the construct's `desiredCount` */
  readonly maxCapacity?: number;
  /** CPU target tracking. @default 70 */
  readonly targetUtilizationPercent?: number;
  readonly scaleInCooldown?: cdk.Duration;
  readonly scaleOutCooldown?: cdk.Duration;
}

/**
 * A Restate service endpoint on ECS Fargate whose every version runs as its own ECS service, at its own URI.
 *
 * Each change to the task definition creates a new {@link RestateFargateServiceVersion}: a new ECS service, target
 * group and listener rule, registered with Restate as a new deployment. CloudFormation never deletes a version; when a
 * version leaves the template it keeps running, so the invocations pinned to it can finish there.
 *
 * After each release and on `pruneSchedule`, superseded versions are scaled down to `supersededVersionScaling` and,
 * once Restate reports nothing pinned to them for `drainDelay`, deregistered and deleted.
 */
export class RestateFargateService extends Construct implements ec2.IConnectable {
  readonly currentVersion: RestateFargateServiceVersion;
  readonly connections: ec2.Connections;

  private readonly props: RestateFargateServiceProps;
  private readonly containerName: string;
  private readonly containerPort: number;
  private readonly pathPrefix: string;
  private readonly versionInputs: string[] = [];
  private computedVersionId?: string;

  constructor(scope: Construct, id: string, props: RestateFargateServiceProps) {
    super(scope, id);
    this.props = props;

    const container = props.containerName
      ? props.taskDefinition.findContainer(props.containerName)
      : props.taskDefinition.defaultContainer;
    if (!container) {
      throw new Error(
        props.containerName
          ? `Container "${props.containerName}" not found in the task definition.`
          : "The task definition has no containers; add one before creating the RestateFargateService.",
      );
    }
    this.containerName = container.containerName;
    this.containerPort = props.containerPort ?? DEFAULT_CONTAINER_PORT;

    this.pathPrefix =
      props.pathPrefix ?? cdk.Names.uniqueResourceName(this, { maxLength: 48, separator: "-" }).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(this.pathPrefix)) {
      throw new Error(`pathPrefix must contain only lowercase letters, digits and dashes, got "${this.pathPrefix}".`);
    }

    const priorities = props.listenerRulePriorityRange ?? DEFAULT_PRIORITY_RANGE;
    if (!(1 <= priorities.min && priorities.min <= priorities.max && priorities.max <= 50000)) {
      throw new Error("listenerRulePriorityRange must satisfy 1 <= min <= max <= 50000.");
    }

    const securityGroups = props.securityGroups ?? [
      new ec2.SecurityGroup(this, "SecurityGroup", {
        vpc: props.cluster.vpc,
        description: `Tasks of every version of ${this.node.path}`,
      }),
    ];
    this.connections = new ec2.Connections({ securityGroups });
    this.connections.allowFrom(props.listener, ec2.Port.tcp(this.containerPort), "Restate through the load balancer");
    for (const sg of securityGroups) {
      if (sg instanceof ec2.SecurityGroup) {
        sg.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
      }
    }

    const versionId = cdk.Lazy.string({ produce: () => this.versionId() });

    this.currentVersion = new RestateFargateServiceVersion(this, "Version", {
      versionId,
      deploymentUri: `${props.baseUrl.replace(/\/+$/, "")}/${this.pathPrefix}/${versionId}`,
      pathPrefix: this.pathPrefix,
      priorityRange: priorities,
      prioritySeed: this.node.addr,
      deployer: props.deployer,
      serviceProps: props,
      securityGroups,
      containerName: this.containerName,
      containerPort: this.containerPort,
    });

    // A superseded version keeps running on its task definition revision and roles.
    cdk.Aspects.of(props.taskDefinition).add(new RetainResources());
    cdk.Aspects.of(this.currentVersion).add(new VersionedResources(() => this.versionId()));
    const serviceTag = `${cdk.Stack.of(this).stackName}/${this.node.addr}`;
    cdk.Tags.of(this.currentVersion).add("restate:service", serviceTag);
    cdk.Tags.of(this.currentVersion).add("restate:version", versionId);

    const endpointPrefix = `${props.baseUrl.replace(/\/+$/, "")}/${this.pathPrefix}/`;
    const pruneConfig = this.pruneConfig(endpointPrefix, serviceTag);
    this.grantLifecyclePermissions(serviceTag);
    new events.Rule(this, "PruneSchedule", {
      schedule: props.pruneSchedule ?? DEFAULT_PRUNE_SCHEDULE,
      description: `Scale down and remove drained versions of ${this.node.path}`,
      targets: [
        new events_targets.LambdaFunction(props.deployer.eventHandler, {
          event: events.RuleTargetInput.fromObject({ restateFargatePrune: pruneConfig }),
        }),
      ],
    });

    const release = props.deployer._registerHttpEndpoint(
      this,
      "Release",
      this.currentVersion.deploymentUri,
      endpointPrefix,
      props.environment,
      { ...props.registration, removalPolicy: props.removalPolicy },
      {
        serviceArn: this.currentVersion.service.serviceArn,
        versionId,
        prune: pruneConfig,
      },
    );
    // Register as late as CloudFormation allows, so a failure elsewhere in the stack rarely rolls back a version that
    // Restate already routes to. Other releases are left out to avoid cycles between two of these constructs.
    const releaseResource = release.node.defaultChild as cdk.CfnResource;
    if (props.registerAfterAllResources ?? true)
      cdk.Aspects.of(cdk.Stack.of(this)).add({
        visit: (node) => {
          if (
            node instanceof cdk.CfnResource &&
            node !== releaseResource &&
            node.cfnResourceType !== "Custom::RestateFargateService"
          ) {
            releaseResource.node.addDependency(node);
          }
        },
      });

    this.node.addValidation({ validate: () => [...this.validateImages(), ...this.validateNoDeployTimeInputs()] });
    cdk.Aspects.of(this).add({
      visit: (node) => {
        if (node === this) this.warnOnShortIdleTimeout();
      },
    });
  }

  /**
   * Make the version depend on an extra value, for example a configuration change the task definition does not
   * capture. Like `lambda.Function.invalidateVersionBasedOn`, the value must not be a token.
   */
  invalidateVersionBasedOn(trigger: string): void {
    if (cdk.Token.isUnresolved(trigger)) {
      throw new Error("invalidateVersionBasedOn() does not accept tokens; pass a plain string.");
    }
    if (this.computedVersionId !== undefined) {
      throw new Error("invalidateVersionBasedOn() was called after the version id was computed.");
    }
    this.versionInputs.push(trigger);
  }

  private versionId(): string {
    if (this.computedVersionId === undefined) {
      const input = canonicalJson({
        taskDefinition: this.versionedTaskDefinitionProperties(),
        containerName: this.containerName,
        containerPort: this.containerPort,
        pathPrefix: this.pathPrefix,
        constructPath: this.node.path,
        triggers: this.versionInputs,
      });
      this.computedVersionId = crypto.createHash("sha256").update(input).digest("hex").slice(0, VERSION_ID_LENGTH);
    }
    return this.computedVersionId;
  }

  /** What the prune path needs; the handler's FargatePruneConfig. */
  private pruneConfig(endpointPrefix: string, serviceTag: string): Record<string, unknown> {
    const p = this.props;
    const environment = p.environment;
    const authToken = p.registration?.authToken ?? environment.authToken;
    authToken?.grantRead(p.deployer.eventHandler);
    const scaling = p.supersededVersionScaling ?? {};
    const minCapacity = scaling.minCapacity ?? 1;
    if (minCapacity < 1) {
      throw new Error("supersededVersionScaling.minCapacity must be at least 1, so suspended invocations can resume.");
    }
    return {
      adminUrl: p.registration?.adminUrl ?? environment.adminUrl,
      ...(authToken ? { authTokenSecretArn: authToken.secretArn } : {}),
      // The JSON field describes the environment's secret, so it does not apply to a registration-level token.
      ...(p.registration?.authToken === undefined && environment.authTokenJsonField !== undefined
        ? { authTokenJsonField: environment.authTokenJsonField }
        : {}),
      ...(p.registration?.additionalHeaders ? { additionalHeaders: p.registration.additionalHeaders } : {}),
      insecure: (p.registration?.insecure ?? false).toString(),
      serviceTag,
      endpointPrefix,
      clusterArn: p.cluster.clusterArn,
      listenerArn: p.listener.listenerArn,
      drainDelaySeconds: (p.drainDelay ?? DEFAULT_DRAIN_DELAY).toSeconds(),
      supersededScaling: {
        minCapacity,
        maxCapacity: Math.max(minCapacity, scaling.maxCapacity ?? p.desiredCount ?? 1),
        targetUtilizationPercent: scaling.targetUtilizationPercent ?? DEFAULT_SUPERSEDED_TARGET_UTILIZATION_PERCENT,
        ...(scaling.scaleInCooldown ? { scaleInCooldownSeconds: scaling.scaleInCooldown.toSeconds() } : {}),
        ...(scaling.scaleOutCooldown ? { scaleOutCooldownSeconds: scaling.scaleOutCooldown.toSeconds() } : {}),
      },
    };
  }

  /** Lets the deployer's Lambda manage this construct's versions; mutations are limited to its tagged resources. */
  private grantLifecyclePermissions(serviceTag: string): void {
    const role = this.props.deployer.eventHandler;
    const ownResources = { StringEquals: { "aws:ResourceTag/restate:service": serviceTag } };
    role.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:DescribeServices",
          "ecs:ListServices",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTags",
          "application-autoscaling:DescribeScalableTargets",
          "application-autoscaling:DescribeScalingPolicies",
          "cloudformation:DescribeStackResources",
          "tag:GetResources",
        ],
        resources: ["*"],
      }),
    );
    role.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:UpdateService",
          "ecs:DeleteService",
          "ecs:TagResource",
          "ecs:UntagResource",
          "elasticloadbalancing:DeleteTargetGroup",
        ],
        resources: ["*"],
        conditions: ownResources,
      }),
    );
    // Listener rules carry no tags in CloudFormation, so limit deletion to the rules of this listener.
    role.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["elasticloadbalancing:DeleteRule"],
        resources: [
          cdk.Fn.join("", [
            cdk.Fn.join("listener-rule/", cdk.Fn.split("listener/", this.props.listener.listenerArn)),
            "/*",
          ]),
        ],
      }),
    );
    // Application Auto Scaling conditions read the scalable target's own tags, which CloudFormation cannot set.
    role.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "application-autoscaling:RegisterScalableTarget",
          "application-autoscaling:DeregisterScalableTarget",
          "application-autoscaling:PutScalingPolicy",
          "application-autoscaling:DeleteScalingPolicy",
          "cloudwatch:DescribeAlarms",
        ],
        resources: ["*"],
      }),
    );
    // Target tracking creates and deletes its alarms with the caller's permissions; they are named after the service.
    const stack = cdk.Stack.of(this);
    role.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricAlarm", "cloudwatch:DeleteAlarms"],
        resources: [
          stack.formatArn({
            service: "cloudwatch",
            resource: "alarm",
            resourceName: `TargetTracking-service/${this.props.cluster.clusterName}/*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      }),
    );
    role.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:CreateServiceLinkedRole"],
        resources: ["*"],
        conditions: { StringEquals: { "iam:AWSServiceName": "ecs.application-autoscaling.amazonaws.com" } },
      }),
    );
  }

  /** The same approach as lambda.Function.currentVersion: the resolved CloudFormation properties that define a version. */
  private versionedTaskDefinitionProperties(): Record<string, unknown> {
    const stack = cdk.Stack.of(this);
    const taskDefinition = this.props.taskDefinition.node.defaultChild as cdk.CfnResource;
    const rendered = stack.resolve((taskDefinition as any)._toCloudFormation());
    const properties = Object.values(rendered.Resources as Record<string, { Properties?: Record<string, unknown> }>)[0]
      ?.Properties;
    return Object.fromEntries(
      VERSIONED_TASK_DEFINITION_PROPERTIES.filter((key) => properties?.[key] !== undefined).map((key) => [
        key,
        properties![key],
      ]),
    );
  }

  private validateImages(): string[] {
    const stack = cdk.Stack.of(this);
    return this.props.taskDefinition.node
      .findAll()
      .filter((node): node is ecs.ContainerDefinition => node instanceof ecs.ContainerDefinition)
      .flatMap((container) => {
        const image = JSON.stringify(stack.resolve(container.imageName));
        // Content addressed: a digest, or the asset-hash tag that CDK image assets use.
        const contentAddressed = /@sha256:[0-9a-f]{64}/.test(image) || /:[0-9a-f]{64}"/.test(image);
        return contentAddressed
          ? []
          : [
              `Container "${container.containerName}" uses image ${image}, which can change without changing the ` +
                "task definition. RestateFargateService needs a CDK image asset or an image pinned by digest " +
                "(@sha256:...), so that new code always becomes a new version.",
            ];
      });
  }

  /**
   * Values resolved at deploy time (parameters, imports, dynamic references) can change what a version runs without
   * changing its hash, so CloudFormation would update a registered version in place.
   */
  private validateNoDeployTimeInputs(): string[] {
    const stack = cdk.Stack.of(this);
    const parameterIds = new Set(
      stack.node
        .findAll()
        .filter((node): node is cdk.CfnParameter => node instanceof cdk.CfnParameter)
        .map((parameter) => stack.resolve(parameter.logicalId) as string),
    );
    const found = new Set<string>();
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        if (value.includes("{{resolve:")) found.add(`dynamic reference ${value}`);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          if (key === "Ref" && typeof inner === "string" && parameterIds.has(inner)) found.add(`parameter ${inner}`);
          if (key === "Fn::ImportValue") found.add(`import ${JSON.stringify(inner)}`);
          walk(inner);
        }
      }
    };
    walk(this.versionedTaskDefinitionProperties());
    return [...found].map(
      (input) =>
        `The task definition reads ${input}, which can change at deploy time without changing the version. ` +
        "Resolve it at synth time, or read it at runtime from inside the container.",
    );
  }

  private warnOnShortIdleTimeout(): void {
    const listener = this.props.listener;
    if (!(listener instanceof elbv2.ApplicationListener)) return;
    const loadBalancer = listener.loadBalancer.node.defaultChild;
    if (!(loadBalancer instanceof elbv2.CfnLoadBalancer)) return;

    const attributes = (cdk.Stack.of(this).resolve(loadBalancer.loadBalancerAttributes) ?? []) as Array<
      Record<string, string>
    >;
    const idleTimeout = attributes.find((a) => (a.key ?? a.Key) === "idle_timeout.timeout_seconds");
    const seconds = Number(idleTimeout?.value ?? idleTimeout?.Value ?? ALB_DEFAULT_IDLE_TIMEOUT_SECONDS);
    if (seconds < MIN_RECOMMENDED_IDLE_TIMEOUT_SECONDS) {
      cdk.Annotations.of(this).addWarningV2(
        "@restatedev/restate-cdk:loadBalancerIdleTimeout",
        `The load balancer's idle timeout is ${seconds} s. A step that sends nothing for longer is reset by the load ` +
          `balancer and retried. Set it above Restate's inactivity plus abort timeouts ` +
          `(${MIN_RECOMMENDED_IDLE_TIMEOUT_SECONDS} s by default), for example idleTimeout: Duration.seconds(900).`,
      );
    }
  }
}

interface RestateFargateServiceVersionProps {
  readonly versionId: string;
  readonly deploymentUri: string;
  readonly pathPrefix: string;
  readonly priorityRange: { readonly min: number; readonly max: number };
  readonly prioritySeed: string;
  readonly deployer: ServiceDeployer;
  readonly serviceProps: RestateFargateServiceProps;
  readonly securityGroups: ec2.ISecurityGroup[];
  readonly containerName: string;
  readonly containerPort: number;
}

/**
 * One immutable version of a {@link RestateFargateService}: an ECS service, a target group and a listener rule, all
 * registered with Restate as one deployment at {@link deploymentUri}.
 */
export class RestateFargateServiceVersion extends Construct {
  /** Short content hash of what the version runs. Used in the URI, logical ids and tags. */
  readonly versionId: string;
  /** The URI registered with Restate: `${baseUrl}/${pathPrefix}/${versionId}`. */
  readonly deploymentUri: string;
  readonly service: ecs.FargateService;
  readonly targetGroup: elbv2.ApplicationTargetGroup;

  /** @internal */
  constructor(scope: Construct, id: string, props: RestateFargateServiceVersionProps) {
    super(scope, id);
    this.versionId = props.versionId;
    this.deploymentUri = props.deploymentUri;
    const p = props.serviceProps;

    this.service = new ecs.FargateService(this, "Service", {
      cluster: p.cluster,
      taskDefinition: p.taskDefinition,
      desiredCount: p.desiredCount ?? 1,
      platformVersion: p.platformVersion,
      vpcSubnets: p.vpcSubnets,
      securityGroups: props.securityGroups,
      assignPublicIp: p.assignPublicIp,
      capacityProviderStrategies: p.capacityProviderStrategies,
      circuitBreaker: p.circuitBreaker,
      enableExecuteCommand: p.enableExecuteCommand,
      healthCheckGracePeriod: p.healthCheckGracePeriod,
      minHealthyPercent: p.minHealthyPercent ?? 100,
      maxHealthyPercent: p.maxHealthyPercent,
      propagateTags: p.propagateTags,
    });

    this.targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: p.cluster.vpc,
      targetType: elbv2.TargetType.IP,
      protocol: elbv2.ApplicationProtocol.HTTP,
      // Restate's bidirectional protocol needs HTTP/2 all the way to the task.
      protocolVersion: elbv2.ApplicationProtocolVersion.HTTP2,
      port: props.containerPort,
      healthCheck: {
        path: "/health",
        interval: cdk.Duration.seconds(10),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        ...p.healthCheck,
      },
      deregistrationDelay: p.deregistrationDelay ?? cdk.Duration.seconds(60),
    });
    this.targetGroup.addTarget(
      this.service.loadBalancerTarget({ containerName: props.containerName, containerPort: props.containerPort }),
    );

    // A retained rule keeps its priority after its version leaves the stack, so ask the listener for a free one.
    const listenerRulePriority = cdk.Token.asNumber(
      new cdk.CustomResource(this, "ListenerRulePriority", {
        serviceToken: props.deployer.eventHandler.functionArn,
        resourceType: "Custom::RestateListenerRulePriority",
        properties: {
          listenerArn: p.listener.listenerArn,
          min: props.priorityRange.min,
          max: props.priorityRange.max,
          seed: props.prioritySeed,
        },
      }).getAttString("Priority"),
    );

    const versionPath = `/${props.pathPrefix}/${props.versionId}`;
    const rule = new elbv2.ApplicationListenerRule(this, "ListenerRule", {
      listener: p.listener,
      priority: listenerRulePriority,
      conditions: [elbv2.ListenerCondition.pathPatterns([`${versionPath}/*`])],
      action: elbv2.ListenerAction.forward([this.targetGroup]),
    });
    // The SDK serves /discover, /invoke/... and /health at the root, so strip the version path. The L2 construct has
    // no transforms yet.
    (rule.node.defaultChild as elbv2.CfnListenerRule).addPropertyOverride("Transforms", [
      {
        Type: "url-rewrite",
        UrlRewriteConfig: { Rewrites: [{ Regex: `^${versionPath}/(.*)$`, Replace: "/$1" }] },
      },
    ]);
  }
}

/**
 * Gives every resource of a version a logical id that ends in the version id, and keeps it when it leaves the
 * template, as `lambda.Function.currentVersion` does for `AWS::Lambda::Version`.
 */
class VersionedResources implements cdk.IAspect {
  private readonly visited = new WeakSet<IConstruct>();

  constructor(private readonly versionId: () => string) {}

  visit(node: IConstruct): void {
    if (!(node instanceof cdk.CfnResource) || this.visited.has(node)) return;
    this.visited.add(node);

    const originalLogicalId = cdk.Stack.of(node).resolve(node.logicalId) as string;
    node.overrideLogicalId(
      cdk.Lazy.uncachedString({
        produce: () => `${originalLogicalId.slice(0, MAX_LOGICAL_ID_LENGTH - VERSION_ID_LENGTH)}${this.versionId()}`,
      }),
    );
    node.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  }
}

class RetainResources implements cdk.IAspect {
  visit(node: IConstruct): void {
    if (node instanceof cdk.CfnResource) {
      node.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
