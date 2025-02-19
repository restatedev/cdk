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

"use strict";

import * as restate from "@restatedev/restate-sdk/lambda";

const greet = async (ctx, name) => {
  return `Hello ${name ?? "from Restate"}!`;
};

export const handler = restate
  .endpoint()
  .bind(
    restate.service({
      name: "Greeter",
      handlers: { greet },
    }),
  )
  .handler();
