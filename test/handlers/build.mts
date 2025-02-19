/*
 * Copyright (c) 2023 - 2025 - Restate Software, Inc., Restate GmbH
 *
 * This file is part of the Restate SDK for Node.js/TypeScript,
 * which is released under the MIT license.
 *
 * You can find a copy of the license in file LICENSE in the root
 * directory of this repository or package, or at
 * https://github.com/restatedev/sdk-typescript/blob/main/LICENSE
 */

import { $, cd } from "zx";
import * as path from "path";
import { fileURLToPath } from "url";

$.verbose = true;

cd(path.dirname(fileURLToPath(import.meta.url)));
await $`npx esbuild --bundle --platform=node handler.js --outfile=dist/bundle.js`;
