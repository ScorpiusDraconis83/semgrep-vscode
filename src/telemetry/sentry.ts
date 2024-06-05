import * as Sentry from "@sentry/node";
import * as vscode from "vscode";
import { Attachment, Integration } from "@sentry/types";
import {
  CloseAction,
  CloseHandlerResult,
  ErrorAction,
  ErrorHandler,
  ErrorHandlerResult,
  Message,
} from "vscode-languageclient";
import { Environment } from "../env";
import * as fs from "fs";

// global here so if user opts out the functions below don't do anything
let sentryEnabled = false;
const SENTRY_DSN =
  "https://01c918981c1d900a22d02793e241de70@o77510.ingest.us.sentry.io/4507352931434496";
export function initSentry(environment: string): void {
  if (sentryEnabled) {
    return;
  }
  sentryEnabled = true;
  // don't use default integrations so we don't use onuncaughtexception and onunhandledrejection
  // see: https://github.com/getsentry/sentry-electron/issues/611#issuecomment-1368016650
  const skipIntegrations = ["OnUnhandledRejection", "OnUncaughtException"];
  Sentry.init({
    dsn: SENTRY_DSN,
    // https://docs.sentry.io/platforms/javascript/guides/node/configuration/integrations/#removing-a-default-integration
    // javascript why do you look like this
    integrations: function (defaultIntegrations: Integration[]) {
      const filteredDefaultIntegrations = defaultIntegrations.filter(
        (integration) => {
          return !skipIntegrations.includes(integration.name);
        },
      );
      // TODO: Profiling, but to do so requires shipping a native module which is super non-trivial
      return [...filteredDefaultIntegrations];
    },
    tracesSampleRate: 1.0,
    profilesSampleRate: 1.0,
    attachStacktrace: true,
    environment,
  });
  Sentry.setUser({
    id: vscode.env.machineId,
  });
}
const skipFields = [
  // if it's a file path let's just skip it
  "scan.include",
  "scan.exclude",
  "scan.configuration",
  "path",
];
export function setSentryContext(env: Environment): void {
  if (!sentryEnabled) {
    return;
  }

  const packageJSON = env.context.extension.packageJSON;
  const settingKeys = Object.keys(
    packageJSON.contributes.configuration.properties,
  ).map((key) => key.replace(/^semgrep\./, ""));
  const allSettings = settingKeys
    .map((key: string) => {
      if (skipFields.includes(key)) {
        return {};
      }
      let value = env.config.get(key);
      // if it's an object/array something let's just stringify it
      if (typeof value === "object") {
        value = JSON.stringify(value);
      }
      return { [key]: value };
    })
    .reduce((acc, setting) => {
      return { ...acc, ...setting };
    });
  Sentry.setTags({
    semgrepVersion: env.semgrepVersion,
    isNewAppInstall: env.newInstall,
    sessionId: vscode.env.sessionId,
    extensionVersion: env.context.extension.packageJSON.version,
    loggedIn: env.loggedIn,
    ...allSettings,
  });
}

export async function stopSentry(): Promise<void> {
  if (!sentryEnabled) {
    return;
  }
  sentryEnabled = false;
  await Sentry.close();
}

export function withSentry(callback: () => any): any {
  if (!sentryEnabled) {
    return callback();
  }
  try {
    return callback();
  } catch (error) {
    Sentry.captureException(error);
    //rethrow error
    throw error;
  }
}
export async function withSentryAsync(
  callback: () => Promise<any>,
): Promise<any> {
  if (!sentryEnabled) {
    return await callback();
  }
  try {
    return await callback();
  } catch (error) {
    Sentry.captureException(error);
    //rethrow error
    throw error;
  }
}

export class SentryErrorHandler implements ErrorHandler {
  restartCount = 0;
  constructor(
    public readonly maxRestartCount: number = 5,
    // Allow for additional attachments to be added on crash
    private attachOnCrash: () => Attachment[] = () => [],
  ) {}
  error(
    error: Error,
    message: Message | undefined,
    count: number | undefined,
  ): ErrorHandlerResult | Promise<ErrorHandlerResult> {
    if (!sentryEnabled) {
      return { action: ErrorAction.Continue, handled: false };
    }
    Sentry.captureException(error, { data: { message, count } });
    // Just log the error to sentry, and continue
    return { action: ErrorAction.Continue, handled: false };
  }
  closed(): CloseHandlerResult | Promise<CloseHandlerResult> {
    if (!sentryEnabled) {
      return { action: CloseAction.Restart, handled: false };
    }
    Sentry.captureException("Language client connection closed", {
      data: { restartCount: this.restartCount },
      attachments: this.attachOnCrash(),
    });
    this.restartCount++;
    // Again, just log the event and continue
    if (this.restartCount < this.maxRestartCount) {
      return { action: CloseAction.Restart, handled: false };
    } else {
      return {
        action: CloseAction.DoNotRestart,
        handled: false,
        message:
          "The language server crashed 5 times, not restarting. Please check the output for more information.",
      };
    }
  }
}

// ProxyOutputChannel is just a proxy to a normal output channel
// This is needed as outputChannels have no way of grabbing their full log
// There's a Github issue that confirms this is impossible that I can no longer find
export class ProxyOutputChannel implements vscode.OutputChannel {
  readonly name: string;
  private logFile: string;
  constructor(
    public readonly baseOutputChannel: vscode.OutputChannel,
    private readonly logPath: string,
  ) {
    this.baseOutputChannel = baseOutputChannel;
    this.name = baseOutputChannel.name;
    this.logFile = `${logPath}/lsp-output.log`;
    // ensure parent directory exists
    fs.mkdirSync(logPath, { recursive: true });
    // create/clear log file
    fs.writeFileSync(this.logFile, "");
  }

  logAsAttachment(): Attachment {
    const timestamp = new Date().toISOString();
    const filename = `lsp-output-${timestamp}.log`;
    const data = fs.readFileSync(this.logFile, "utf8");
    const attachment = {
      filename,
      data,
      contentType: "text/plain",
    };
    // clear log file
    fs.writeFileSync(this.logFile, "");
    return attachment;
  }

  append(value: string): void {
    this.baseOutputChannel.append(value);
    // write to log file
    fs.appendFileSync(this.logFile, value);
  }

  appendLine(value: string): void {
    this.baseOutputChannel.appendLine(value);
    // write to log file
    fs.appendFileSync(this.logFile, `${value}\n`);
  }

  clear = this.baseOutputChannel.clear;
  show = this.baseOutputChannel.show;
  hide = this.baseOutputChannel.hide;
  dispose = this.baseOutputChannel.dispose;
  replace = this.baseOutputChannel.replace;
}
