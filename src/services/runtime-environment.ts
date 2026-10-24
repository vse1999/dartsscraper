export interface RuntimeEnvironment {
  readonly VERCEL?: string;
  readonly VERCEL_ENV?: string;
  readonly VERCEL_URL?: string;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string;
  readonly AWS_LAMBDA_FUNCTION_NAME?: string;
}

/** Detect Vercel when any exposed platform marker is present, not only VERCEL=1. */
export function isVercelRuntime(environment: RuntimeEnvironment): boolean {
  return environment.VERCEL === "1"
    || environment.VERCEL_ENV !== undefined
    || environment.VERCEL_URL !== undefined
    || environment.VERCEL_PROJECT_PRODUCTION_URL !== undefined;
}

export function isServerlessRuntime(environment: RuntimeEnvironment): boolean {
  return isVercelRuntime(environment) || environment.AWS_LAMBDA_FUNCTION_NAME !== undefined;
}
