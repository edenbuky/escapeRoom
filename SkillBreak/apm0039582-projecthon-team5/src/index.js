/**
 * Simple Hello World HTTP server for the TDP 2026 project.
 */

// --- Application Insights (must be initialized before other requires) ---
if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
  // eslint-disable-next-line global-require
  const appInsights = require('applicationinsights');
  appInsights
    .setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(true)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true, true)
    .setSendLiveMetrics(true)
    .start();
  appInsights.defaultClient.context.tags[
    appInsights.defaultClient.context.keys.cloudRole
  ] = 'projecthon-team5';
}

const http = require('http');

const PORT = process.env.PORT || 3000;

function helloWorld(name = 'World') {
  return `Hello, ${name}!`;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(helloWorld());
});

if (require.main === module) {
  // The deployment image keeps this JavaScript entrypoint and loads compiled Nest output.
  require('./runtime/main').bootstrap().catch((error) => {
    process.stderr.write(`API startup failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  });
}

module.exports = { helloWorld, server };
