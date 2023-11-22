import { CloudFormationCustomResourceResponse } from "aws-lambda";
import { Handler } from "aws-lambda/handler";
import { CloudFormationCustomResourceEvent } from "aws-lambda/trigger/cloudformation-custom-resource";
import fetch from "node-fetch";

export interface RegistrationProperties {
  metaEndpoint?: string;
  serviceEndpoint?: string;
  serviceLambdaArn?: string;
}

export const handler: Handler<CloudFormationCustomResourceEvent, Partial<CloudFormationCustomResourceResponse>> =
  async function(event) {
    console.log({ event });

    if (event.RequestType === "Delete") {
      return {
        // TODO: deregister service on delete (https://github.com/restatedev/restate-cdk-support/issues/5)
        Reason: "No-op",
        Status: "SUCCESS",
      } satisfies Partial<CloudFormationCustomResourceResponse>;
    }

    try {
      const props = event.ResourceProperties as RegistrationProperties;

      const controller = new AbortController();
      const healthCheckTimeout = setTimeout(() => controller.abort(), 3000);
      const healthCheckUrl = `${props.metaEndpoint}/health`;
      console.log(`Performing health check against: ${healthCheckUrl}`);
      const healthResponse = await fetch(healthCheckUrl,
        {
          signal: controller.signal,
        })
        .finally(() => clearTimeout(healthCheckTimeout));
      console.log(`Got health response back: ${await healthResponse.text()}`);

      if (!(healthResponse.status >= 200 && healthResponse.status < 300)) {
        // TODO: retry until service is healthy, or some overall timeout is reached
        throw new Error(`Health check failed: ${healthResponse.statusText} (${healthResponse.status})`);
      }

      const registerCallTimeout = setTimeout(() => controller.abort(), 3000);
      const discoveryEndpointUrl = `${props.metaEndpoint}/endpoints`;
      // const registrationRequest = JSON.stringify({ uri: props.serviceEndpoint });
      const registrationRequest = JSON.stringify({ arn: props.serviceLambdaArn });
      console.log(`Triggering registration at ${discoveryEndpointUrl}: ${registrationRequest}`);
      const discoveryResponse = await fetch(discoveryEndpointUrl,
        {
          signal: controller.signal,
          method: "POST",
          body: registrationRequest,
          headers: {
            "Content-Type": "application/json",
          },
        })
        .finally(() => clearTimeout(registerCallTimeout));
      console.log(`Got registration response back: ${discoveryResponse.status}`);

      if (!(healthResponse.status >= 200 && healthResponse.status < 300)) {
        // TODO: retry until successful, or some overall timeout is reached
        throw new Error(`Service registration failed: ${healthResponse.statusText} (${healthResponse.status})`);
      }

      console.log("Returning success.");
    } catch (err) {
      console.error("Ignoring unhandled error: " + err);
    }

    return {
      Data: {
        // it would be neat if we could return a unique Restate event id back to CloudFormation to close the loop
      },
      Status: "SUCCESS",
    } satisfies Partial<CloudFormationCustomResourceResponse>;
  };