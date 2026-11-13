import {defineConfig} from "vitest/config";
export default defineConfig({test:{
 environment:"node",include:["tests/integration/**/*.integration.ts"],
 setupFiles:["./tests/setup.ts"],fileParallelism:false,
 clearMocks:true,unstubEnvs:true,unstubGlobals:true,testTimeout:15000,hookTimeout:30000
}});
