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

import * as os from "os";
import * as restate from "@restatedev/restate-sdk";

const spike = restate.service({
  name: "Spike",
  handlers: {
    steps: async (ctx, n) => {
      for (let i = 0; i < n; i++) {
        await ctx.run(`step-${i}`, () => i);
      }
      return `done ${n}`;
    },

    hold: async (ctx, seconds) => {
      const host = await ctx.run("hold", async () => {
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        return os.hostname();
      });
      return `held ${seconds}s on ${host}`;
    },

    whoami: async (ctx) => ctx.run("whoami", () => os.hostname()),

    // Suspends for a while, then resumes on the version that started it.
    nap: async (ctx, seconds) => {
      await ctx.sleep(seconds * 1000);
      const host = await ctx.run("wake", () => os.hostname());
      return `woke after ${seconds}s on ${host}`;
    },
  },
});

restate.serve({ services: [spike], port: 9080 });
