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

"use strict";

import * as restate from "@restatedev/restate-sdk/lambda";

const greet = async (ctx, name) => {
  return `Hello ${name ?? "from Restate"}!`;
};

const endpoint = restate.endpoint().bind(
  restate.service({
    name: "Greeter",
    handlers: { greet },
  }),
);

// Visibility tests set a name unique to their stack, so stacks sharing a Restate environment don't race over it.
if (process.env.PRIVATE_SERVICE_NAME) {
  endpoint.bind(
    restate.service({
      name: process.env.PRIVATE_SERVICE_NAME,
      handlers: { greet },
      options: { ingressPrivate: true },
    }),
  );
}

export const handler = endpoint.handler();
