#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { RestateSelfHostedStack } from "../lib/restate-self-hosted-stack";

const app = new cdk.App();

const githubPat = app.node.tryGetContext("githubTokenSecretName");
const prefix = app.node.tryGetContext("prefix") ?? process.env["USER"];

new RestateSelfHostedStack(app, [prefix, "RestateStack"].filter(Boolean).join("-"), {
  githubTokenSecretName: githubPat,
});