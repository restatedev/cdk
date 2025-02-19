import { $, cd } from "zx";
import * as path from "path";
import { fileURLToPath } from 'url';

$.verbose = true;

cd(path.dirname(fileURLToPath(import.meta.url)));
await $`npx esbuild --bundle --platform=node handler.js --outfile=dist/bundle.js`;
