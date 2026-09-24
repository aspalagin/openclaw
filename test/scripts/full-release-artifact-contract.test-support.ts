import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { createPluginSdkApiReleaseEvidence } from "../../scripts/plugin-sdk-api-release-evidence.mjs";

/** Serve external evidence to the real workflow command without credentials or network. */
export async function publicationWriterFixture(
  directory: string,
  context: { runId: string; runAttempt: string; workflowSha: string; targetSha: string },
) {
  const repository = "openclaw/openclaw";
  const workflow = ".github/workflows/full-release-validation.yml";
  const producer = {
    repository,
    workflowRef: `${repository}/${workflow}@refs/heads/release-ci/test`,
    workflowSha: context.workflowSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    jobId: "999",
    jobName: "Qualify prepared npm package",
    producerWorkflowPath: ".github/workflows/openclaw-npm-preflight.yml",
  };
  const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const diff = { entrypointsAdded: [], entrypointsRemoved: [], exports: [] };
  const manifest = JSON.stringify({
    releaseSha: context.targetSha,
    pluginSdkApi: createPluginSdkApiReleaseEvidence({
      baseRef: "v2026.9.8",
      baseSha: "c".repeat(40),
      headSha: context.targetSha,
      workflowSha: context.workflowSha,
      diff: { ...diff, digest: hash(JSON.stringify(diff)) },
    }),
  });
  const zip = new JSZip();
  zip.file("preflight-manifest.json", manifest);
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
  const descriptor = {
    schema: "openclaw.qualified-npm-preflight/v1",
    source: { sha: context.targetSha },
    producer,
    manifestSha256: hash(manifest),
    artifact: {
      id: "555",
      name: "openclaw-npm-preflight-fixture",
      digest: hash(archive),
      runId: context.runId,
      runAttempt: context.runAttempt,
    },
  };
  const metadata = {
    id: 555,
    name: descriptor.artifact.name,
    digest: `sha256:${descriptor.artifact.digest}`,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2099-10-01T00:00:00Z",
    workflow_run: { id: Number(context.runId), head_sha: context.workflowSha },
  };
  const run = {
    id: Number(context.runId),
    run_attempt: Number(context.runAttempt),
    head_sha: context.workflowSha,
    path: workflow,
    head_branch: "release-ci/test",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    repository: { full_name: repository },
    head_repository: { full_name: repository },
  };
  const job = {
    id: 999,
    name: producer.jobName,
    run_id: run.id,
    run_attempt: run.run_attempt,
    head_sha: context.workflowSha,
    status: "completed",
    conclusion: "success",
  };
  const prefix = `repos/${repository}/actions`;
  const responses = {
    [`${prefix}/runs/${context.runId}`]: run,
    [`${prefix}/runs/${context.runId}/attempts/${context.runAttempt}`]: run,
    [`${prefix}/runs/${context.runId}/attempts/${context.runAttempt}/jobs?per_page=100&page=1`]: {
      total_count: 1,
      jobs: [job],
    },
    [`${prefix}/artifacts/555`]: metadata,
  };
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const responses = ${JSON.stringify(responses)};
const endpoint = process.argv[3];
if (process.argv[2] !== "api" || !Object.hasOwn(responses, endpoint)) {
  throw new Error("Unexpected GitHub fixture request: " + process.argv.slice(2).join(" "));
}
process.stdout.write(JSON.stringify(responses[endpoint]));
`,
    { mode: 0o755 },
  );
  const archivePath = join(directory, "preflight.zip");
  writeFileSync(archivePath, archive);
  const preloadPath = join(directory, "publication-fetch.mjs");
  writeFileSync(
    preloadPath,
    `import { readFileSync } from "node:fs";
const artifactUrl = "https://api.github.com/${prefix}/artifacts/555";
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url === artifactUrl) return Response.json(${JSON.stringify(metadata)});
  if (url === artifactUrl + "/zip") return new Response(readFileSync(${JSON.stringify(archivePath)}));
  if (url === "https://registry.npmjs.org/openclaw") {
    return Response.json({ versions: { "2026.9.8": {} }, "dist-tags": { latest: "2026.9.8", beta: "2026.9.8" } });
  }
  throw new Error("Unexpected publication fixture fetch: " + url);
};
`,
  );
  return {
    GH_TOKEN: "synthetic-artifact-token",
    QUALIFIED_NPM_BUNDLE_JSON: JSON.stringify(descriptor),
    NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
    PATH: `${bin}:${process.env.PATH}`,
  };
}
