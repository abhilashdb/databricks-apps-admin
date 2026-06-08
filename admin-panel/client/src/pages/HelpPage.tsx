import { ExternalLink, AlertTriangle, CheckCircle, Terminal, FileCode } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@databricks/appkit-ui/react';

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex-shrink-0 w-7 h-7 rounded-full bg-primary text-primary-foreground text-sm font-bold flex items-center justify-center">
        {n}
      </div>
      <div className="flex-1 space-y-2">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-muted rounded-md px-3 py-2 text-xs font-mono whitespace-pre-wrap overflow-x-auto">
      {children}
    </pre>
  );
}

export function HelpPage() {
  return (
    <div className="space-y-8 max-w-3xl">
      <div>
        <h2 className="text-2xl font-bold">Admin Setup Guide</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Instructions to share with app developers for enabling telemetry and idle monitoring.
        </p>
        <a
          href="https://docs.databricks.com/aws/en/dev-tools/databricks-apps/observability"
          target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 mt-2 text-sm text-primary hover:underline"
        >
          Official Databricks Apps Observability docs <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Why telemetry matters */}
      <Card className="border-amber-200 bg-amber-50">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-amber-800 text-base">
            <AlertTriangle className="h-4 w-4" />
            Why this matters
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-amber-900 space-y-1">
          <p>Without telemetry, the scale-to-zero monitor cannot detect when your app is idle.</p>
          <p>Apps without telemetry will <strong>never be automatically stopped</strong> — compute keeps running and billing continues even with zero users.</p>
        </CardContent>
      </Card>

      {/* Two missing states */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="border-red-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-red-700">
              <AlertTriangle className="h-4 w-4" /> No OTel config
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-1">
            <p>No metrics at all. The app is missing <code>opentelemetry-instrument</code> in its <code>app.yaml</code> command.</p>
            <p className="font-medium text-foreground">Fix: Steps 1–3 below.</p>
          </CardContent>
        </Card>
        <Card className="border-yellow-200">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2 text-yellow-700">
              <AlertTriangle className="h-4 w-4" /> No HTTP instrumentation
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground space-y-1">
            <p>System metrics are flowing (OTel is running) but HTTP traffic isn't captured. A framework-specific package is missing.</p>
            <p className="font-medium text-foreground">Fix: Step 2 below (add the right package).</p>
          </CardContent>
        </Card>
      </div>

      {/* Setup steps */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4" /> Setup instructions (share with app developer)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">

          <Step n={1} title="Add OTel packages to requirements.txt">
            <p className="text-sm text-muted-foreground">Choose the packages for your framework:</p>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Dash / Flask:</p>
              <Code>{`opentelemetry-distro[otlp]
opentelemetry-instrumentation-flask
opentelemetry-exporter-otlp-proto-grpc
opentelemetry-instrumentation-system-metrics`}</Code>

              <p className="text-xs font-medium text-muted-foreground">Streamlit:</p>
              <Code>{`opentelemetry-distro
opentelemetry-exporter-otlp-proto-grpc
opentelemetry-instrumentation-tornado
opentelemetry-instrumentation-system-metrics`}</Code>
            </div>
          </Step>

          <Step n={2} title="Update app.yaml to use opentelemetry-instrument">
            <p className="text-sm text-muted-foreground">Wrap your start command with the OTel launcher:</p>
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Dash:</p>
              <Code>{`command: ['opentelemetry-instrument', 'python', 'app.py']
env:
  - name: OTEL_TRACES_SAMPLER
    value: 'always_on'`}</Code>

              <p className="text-xs font-medium text-muted-foreground">Flask:</p>
              <Code>{`command: ['opentelemetry-instrument', 'flask', '--app', 'app.py', 'run', '--no-reload']
env:
  - name: OTEL_TRACES_SAMPLER
    value: 'always_on'`}</Code>

              <p className="text-xs font-medium text-muted-foreground">Streamlit:</p>
              <Code>{`command: ['opentelemetry-instrument', 'streamlit', 'run', 'app.py',
          '--server.enableCORS', 'false',
          '--server.enableXsrfProtection', 'false']
env:
  - name: OTEL_TRACES_SAMPLER
    value: 'always_on'`}</Code>
            </div>
          </Step>

          <Step n={3} title="Enable telemetry export destinations">
            <p className="text-sm text-muted-foreground">
              Configure the app to export to Unity Catalog. This can also be done via the Databricks Apps UI → Settings → App telemetry configuration.
            </p>
            <Code>{`databricks apps update <app-name> --json '{
  "telemetry_export_destinations": [{
    "unity_catalog": {
      "logs_table":    "serverless_stable_3rlc3e_catalog.app_telemetry.otel_logs",
      "metrics_table": "serverless_stable_3rlc3e_catalog.app_telemetry.otel_metrics",
      "traces_table":  "serverless_stable_3rlc3e_catalog.app_telemetry.otel_traces"
    }
  }]
}'`}</Code>
            <p className="text-xs text-muted-foreground">
              The monitor auto-configures this step when it first encounters the app.
            </p>
          </Step>

          <Step n={4} title="Redeploy the app">
            <Code>{`databricks apps deploy <app-name> --source-code-path <workspace-path>`}</Code>
            <div className="flex items-center gap-2 text-sm text-green-700 mt-1">
              <CheckCircle className="h-4 w-4 flex-shrink-0" />
              After deployment, <code>http.server.duration</code> metrics will appear within 2–3 minutes of user traffic.
            </div>
          </Step>

        </CardContent>
      </Card>

      {/* Links */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileCode className="h-4 w-4" /> Reference links
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {[
            ['Databricks Apps Observability', 'https://docs.databricks.com/aws/en/dev-tools/databricks-apps/observability'],
            ['Custom Instrumentation Guide', 'https://docs.databricks.com/aws/en/dev-tools/databricks-apps/observability#add-custom-instrumentation'],
            ['App Telemetry Configuration', 'https://docs.databricks.com/aws/en/dev-tools/databricks-apps/observability#enable-telemetry'],
            ['OpenTelemetry Python Docs', 'https://opentelemetry.io/docs/languages/python/'],
          ].map(([label, url]) => (
            <a key={url} href={url} target="_blank" rel="noreferrer"
               className="flex items-center gap-1.5 text-primary hover:underline">
              <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
              {label}
            </a>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
