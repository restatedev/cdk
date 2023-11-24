import { CloudFormationCustomResourceResponse } from "aws-lambda";
import { Handler } from "aws-lambda/handler";
import { CloudFormationCustomResourceEvent } from "aws-lambda/trigger/cloudformation-custom-resource";
import fetch from "node-fetch";

export interface RegistrationProperties {
  metaEndpoint?: string;
  serviceEndpoint?: string;
  serviceLambdaArn?: string;
}

/**
 * Custom Resource event handler for Restate service registration. This handler backs the custom resources created by
 * {@link RestateLambdaServiceCollection} to facilitate Lambda service handler discovery.
 */
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

    const props = event.ResourceProperties as RegistrationProperties;

    const controller = new AbortController();
    const healthCheckTimeout = setTimeout(() => controller.abort("timeout"), 5_000);
    const healthCheckUrl = `${props.metaEndpoint}/health`;
    console.log(`Performing health check against: ${healthCheckUrl}`);
    const healthResponse = await fetch(healthCheckUrl,
      {
        signal: controller.signal,
      })
      .finally(() => clearTimeout(healthCheckTimeout));
    console.log(`Got health check response back: ${await healthResponse.text()}`);

    if (!(healthResponse.status >= 200 && healthResponse.status < 300)) {
      console.error(`Restate health check failed: ${healthResponse.statusText} (${healthResponse.status})`);
      return {
        Reason: `Restate health check failed: ${healthResponse.statusText} (${healthResponse.status})`,
        Status: "FAILED",
      };
    }

    let attempt = 1;
    const registerCallTimeout = setTimeout(() => controller.abort("timeout"), 10_000);
    const discoveryEndpointUrl = `${props.metaEndpoint}/endpoints`;
    const registrationRequest = JSON.stringify({ arn: props.serviceLambdaArn });
    console.log(`Triggering registration at ${discoveryEndpointUrl}: ${registrationRequest} (attempt ${attempt})`);
    while (true) {
      try {
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
        if (!(discoveryResponse.status >= 200 && discoveryResponse.status < 300)) {
          // TODO: assert service name we get back matches what we expected to detect misconfigurations
          // Sample response: {"id":"YXJuOmF3czpsYW1iZGE6ZXUtY2VudHJhbC0xOjY2MzQ4Nzc4MDA0MTpmdW5jdGlvbjpwYXZlbC1Ib2xpZGF5VHJpcHNTZXJ2aWNlU3RhY2stVHJpcEhhbmRsZXI2QjQ2NDRCRC1KU0Y0YTRBNGphTW46NQ==","services":[{"name":"trips","revision":1}]}
          return {
            Data: {
              // it would be neat if we could return a unique Restate event id back to CloudFormation to close the loop
            },
            Status: "SUCCESS",
          } satisfies Partial<CloudFormationCustomResourceResponse>;
        }
      } catch (e) {
        console.log(`Service registration call failed: ${(e as Error)?.message} (attempt ${attempt})`);
      }

      attempt += 1;
      if (attempt >= 3) {
        console.error(`Service registration failed after ${attempt} attempts.`);
        break;
      }
    }

    return {
      Reason: `Restate service registration failed: ${healthResponse.statusText} (${healthResponse.status})`,
      Status: "FAILED",
    };
  };