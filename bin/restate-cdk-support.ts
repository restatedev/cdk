#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { RestateDemoStack } from "../lib/restate-demo-stack";

const app = new cdk.App();

// Yuck! Temporary workaround for not having permissions to store secrets in Restate AWS account
const githubPat = app.node.tryGetContext("githubPat") ?? process.env["GITHUB_PAT"];
if (!githubPat) {
  throw new Error("Please provide a GitHub PAT via the context variable githubPat or the environment variable GITHUB_PAT");
}

const prefix = app.node.tryGetContext("prefix") ?? process.env["USER"];

new RestateDemoStack(app, `${prefix}-RestateStack`, {
  githubPat,
});