import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import * as r53 from "aws-cdk-lib/aws-route53";
import { FargateRestateDeployment } from "../../lib/restate-constructs";

const app = new cdk.App();
const stack = new cdk.Stack(app, "e2e-RestateOnFargate", {
  env: { account: app.node.getContext("account"), region: app.node.getContext("region") },
});

const hostedZone = r53.HostedZone.fromLookup(stack, "HostedZone", {
  domainName: app.node.getContext("domainName"),
});

const restate = new FargateRestateDeployment(stack, "Restate", {
  dnsName: `${app.node.getContext("name")}.${hostedZone.zoneName}`,
  hostedZone: hostedZone,
});

new cdk.CfnOutput(stack, "RestateIngressUrl", { value: restate.ingressUrl });

app.synth();
