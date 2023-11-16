import { CloudFormationCustomResourceResponse } from "aws-lambda";
import { Handler } from "aws-lambda/handler";
import { CloudFormationCustomResourceEvent } from "aws-lambda/trigger/cloudformation-custom-resource";
import fetch from "node-fetch";

interface RegistrationProperties {
  ingressEndpoint?: string;
  metaEndpoint?: string;
  serviceEndpoint?: string;
  functionVersion?: number;
}

export const handler: Handler<CloudFormationCustomResourceEvent, Partial<CloudFormationCustomResourceResponse>> =
  async function(event) {
    console.log({ event });

    if (event.RequestType === "Delete") {
      return {
        // TODO do we want to actually deregister the service here?
        Reason: "No-op",
        Status: "SUCCESS",
      } satisfies Partial<CloudFormationCustomResourceResponse>;
    }

    try {
      const props = event.ResourceProperties as RegistrationProperties;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const healthCheckUrl = `${props.ingressEndpoint}/grpc.health.v1.Health/Check`;
      console.log(`Performing health check against: ${healthCheckUrl}`);
      const healthResponse = await fetch(healthCheckUrl,
        {
          signal: controller.signal,
        })
        .finally(() => clearTimeout(timeout));
      console.log(`Got health response back: ${await healthResponse.text()}`);

      if (!(healthResponse.status >= 200 && healthResponse.status < 300)) {
        // TODO: add retry until service is healthy, or an overall timeout is reached
        throw new Error(`Health check failed: ${healthResponse.statusText} (${healthResponse.status})`);
      }

      console.log("Triggering registration at ");
      const discoveryResponse = await fetch(`${props.metaEndpoint}/endpoints`, {
        method: "POST",
        body: JSON.stringify({
          uri: props.serviceEndpoint,
        }),
        headers: {
          "Content-Type": "application/json",
        },
      });
      console.log(`Got registration response back: ${await discoveryResponse.text()} (${discoveryResponse.status})`);

      if (!(healthResponse.status >= 200 && healthResponse.status < 300)) {
        // TODO: add retry until service is healthy, or an overall timeout is reached
        throw new Error(`Health check failed: ${healthResponse.statusText} (${healthResponse.status})`);
      }

      console.log("Returning success.");
    } catch (err) {
      console.error("Ignoring unhandled error: " + err);
    }

    return {
      Data: {
        // TODO: it would be neat if we could return a Restate service handler id back to CloudFormation
      },
      Status: "SUCCESS",
    } satisfies Partial<CloudFormationCustomResourceResponse>;
  };